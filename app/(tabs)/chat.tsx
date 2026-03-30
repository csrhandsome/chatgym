import { startTransition, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import {
  Composer,
  GiftedChat,
  InputToolbar,
  Send,
  type IMessage,
  type InputToolbarProps,
  type MessageProps,
  type SendProps,
} from 'react-native-gifted-chat';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  AGENT_PLAN_API_PATH_LABEL,
  sendAgentMessage,
  type ChatHistoryItem,
  type ChatResponseChunk,
} from '@/services/agent-api';
import {
  ChatMessageCard,
  type ChatMessageCardData,
} from '@/components/chat/chat-message-card';
import { sketchTheme } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { storeFitnessPlan } from '@/services/fitness-plan';

const CURRENT_USER = {
  _id: 'chatgym-user',
  name: '你',
} as const;

const ASSISTANT_USER = {
  _id: 'chatgym-agent',
  name: 'ChatGym Agent',
} as const;

type ChatUiMessage = IMessage & {
  kind: ChatMessageCardData['kind'];
  title?: string;
};

export default function ChatScreen() {
  const { isAuthenticated, isHydrating, token } = useAuth();
  const [messages, setMessages] = useState<ChatUiMessage[]>(() => createInitialMessages());
  const [draftText, setDraftText] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSend(outgoingMessages: ChatUiMessage[] = []) {
    const draft = outgoingMessages[0];
    const messageText = draft?.text?.trim();

    if (!messageText) {
      return;
    }

    const userMessage: ChatUiMessage = {
      ...draft,
      createdAt: new Date(),
      kind: 'user',
      text: messageText,
      title: undefined,
      user: CURRENT_USER,
    };

    setFeedback(null);
    setDraftText('');
    setMessages((currentMessages) => GiftedChat.append(currentMessages, [userMessage]));
    setIsSubmitting(true);

    try {
      const response = await sendAgentMessage(
        token,
        {
          history: buildChatHistory([userMessage, ...messages]),
          message: messageText,
        },
        {
          onChunk(chunk) {
            startTransition(() => {
              setMessages((currentMessages) =>
                GiftedChat.append(currentMessages, [createAssistantMessage(chunk)])
              );
            });
          },
        }
      );

      const latestFitnessPlan = [...response.chunks]
        .reverse()
        .find((chunk) => chunk.fitnessPlan)?.fitnessPlan;

      if (latestFitnessPlan) {
        try {
          await storeFitnessPlan(latestFitnessPlan);
        } catch {
          setFeedback('训练计划已经生成，但同步到 Fitness 页失败。');
        }
      }

      if (response.delivery === 'json') {
        const assistantMessages = response.chunks.map((chunk, index) =>
          createAssistantMessage(chunk, Date.now() + index)
        );

        setMessages((currentMessages) => GiftedChat.append(currentMessages, assistantMessages));
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      setFeedback(errorMessage);
      setMessages((currentMessages) =>
        GiftedChat.append(currentMessages, [
          createAssistantMessage({
            id: `chat-error-${Date.now()}`,
            kind: 'tool',
            text: `错误\n${errorMessage}`,
            title: '请求失败',
          }),
        ])
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  function renderMessage(props: MessageProps<ChatUiMessage>) {
    const message = props.currentMessage;

    if (!message) {
      return <View />;
    }

    return (
      <ChatMessageCard
        message={{
          createdAt: message.createdAt,
          kind: message.kind,
          text: message.text,
          title: message.title,
        }}
      />
    );
  }

  function renderInputToolbar(props: InputToolbarProps<ChatUiMessage>) {
    return (
      <View style={styles.toolbarWrap}>
        <View pointerEvents="none" style={styles.toolbarShadow} />
        <InputToolbar
          {...props}
          containerStyle={styles.toolbar}
          primaryStyle={styles.toolbarPrimary}
          renderComposer={(composerProps) => (
            <Composer
              {...composerProps}
              textInputProps={{
                ...composerProps.textInputProps,
                editable: !isSubmitting,
                placeholder: '描述你的目标、频率、器械条件，页面会实时显示 agent 过程',
                placeholderTextColor: '#8C857A',
                style: [styles.composerText, composerProps.textInputProps?.style],
              }}
            />
          )}
          renderSend={(sendProps) => renderSend(sendProps)}
        />
      </View>
    );
  }

  function renderSend(sendProps: SendProps<ChatUiMessage>) {
    const isDisabled = isSubmitting || !sendProps.text?.trim();

    if (isDisabled) {
      return (
        <View style={styles.sendContainer}>
          <View style={[styles.sendButton, styles.sendButtonDisabled]}>
            {isSubmitting ? (
              <ActivityIndicator color={sketchTheme.colors.white} size="small" />
            ) : (
              <Text style={styles.sendButtonText}>发送</Text>
            )}
          </View>
        </View>
      );
    }

    return (
      <Send {...sendProps} containerStyle={styles.sendContainer}>
        <View style={styles.sendButton}>
          <Text style={styles.sendButtonText}>发送</Text>
        </View>
      </Send>
    );
  }

  return (
    <SafeAreaView edges={['top']} style={styles.safeArea}>
      <View style={styles.page}>
        <View pointerEvents="none" style={[styles.doodleCircle, styles.doodleCircleTop]} />
        <View pointerEvents="none" style={[styles.doodleCircle, styles.doodleCircleBottom]} />
        <View pointerEvents="none" style={styles.dashedLoop} />

        <View style={styles.topSection}>
          <View style={[styles.card, styles.heroCard]}>
            <View style={styles.pin} />
            <View style={styles.tapeStrip} />

            <View style={styles.heroContent}>
              <Text style={styles.label}>agent workspace</Text>
              <Text style={styles.title}>训练规划台</Text>
              <Text style={styles.note}>
                这里直接连到训练计划 agent。后端如果返回流式事件，思考、tool 和最终计划会按时间顺序实时出现。
              </Text>
            </View>

            <View style={styles.metaRow}>
              <View style={styles.metaChip}>
                <Text style={styles.metaChipText}>
                  {isHydrating
                    ? '正在恢复登录态'
                    : isAuthenticated
                      ? '已登录，将自动附带 Bearer token'
                      : '未登录，按当前接口配置也可直接尝试'}
                </Text>
              </View>
              <View style={[styles.metaChip, styles.metaChipAlt]}>
                <Text style={styles.metaChipText}>{AGENT_PLAN_API_PATH_LABEL}</Text>
              </View>
            </View>
          </View>

          {feedback ? (
            <View style={[styles.card, styles.feedbackCard]}>
              <Text style={styles.feedbackTitle}>当前反馈</Text>
              <Text style={styles.feedbackText}>{feedback}</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.chatShell}>
          <View pointerEvents="none" style={styles.chatShellShadow} />
          <View style={styles.chatSurface}>
            <GiftedChat<ChatUiMessage>
              isTyping={isSubmitting}
              isScrollToBottomEnabled
              isSendButtonAlwaysVisible
              listProps={{
                contentContainerStyle: styles.messageList,
                keyboardShouldPersistTaps: 'handled',
                showsVerticalScrollIndicator: false,
              }}
              maxComposerHeight={120}
              messages={messages}
              messagesContainerStyle={styles.messagesContainer}
              minComposerHeight={48}
              minInputToolbarHeight={72}
              onSend={(nextMessages) => {
                void handleSend(nextMessages as ChatUiMessage[]);
              }}
              renderAvatar={null}
              renderInputToolbar={renderInputToolbar}
              renderMessage={renderMessage}
              text={draftText}
              textInputProps={{
                onChangeText: setDraftText,
              }}
              user={CURRENT_USER}
            />
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

function createInitialMessages(): ChatUiMessage[] {
  const now = Date.now();

  return [
    createAssistantMessage(
      {
        id: 'seed-answer',
        kind: 'answer',
        text:
          '你好，我是 ChatGym 训练 agent。\n\n直接告诉我你的训练目标、频率、器械条件或限制，我会把过程拆成思考、tool 和最终计划。',
        title: 'Agent Ready',
      },
      now
    ),
    createAssistantMessage(
      {
        id: 'seed-tool',
        kind: 'tool',
        text:
          '说明\n这里会展示工具调用和返回结果。\n\n输出\n例如检索训练记忆、读取编排约束、推荐动作。',
        title: 'Tool Console',
      },
      now - 1_000
    ),
    createAssistantMessage(
      {
        id: 'seed-thought',
        kind: 'thought',
        text: '如果后端已切到流式返回，新的步骤会一条条插进来，而不是等全部跑完才一起显示。',
        title: 'Streaming',
      },
      now - 2_000
    ),
  ];
}

function createAssistantMessage(
  chunk: Pick<ChatResponseChunk, 'id' | 'kind' | 'text' | 'title'>,
  createdAt: Date | number = Date.now()
): ChatUiMessage {
  return {
    _id: chunk.id,
    createdAt,
    kind: chunk.kind,
    text: chunk.text,
    title: chunk.title,
    user: ASSISTANT_USER,
  };
}

function buildChatHistory(messages: ChatUiMessage[]): ChatHistoryItem[] {
  return [...messages]
    .sort((left, right) => toTimestamp(left.createdAt) - toTimestamp(right.createdAt))
    .slice(-14)
    .map((message) => ({
      kind: message.kind === 'user' ? 'user' : message.kind,
      role: message.kind === 'user' ? 'user' : 'assistant',
      text: message.text,
      title: message.title,
    }));
}

function toTimestamp(value: Date | number): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '发生未知错误，请稍后再试。';
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: sketchTheme.colors.paper,
    flex: 1,
  },
  page: {
    backgroundColor: sketchTheme.colors.paper,
    flex: 1,
    gap: 18,
    overflow: 'hidden',
    paddingBottom: 12,
    paddingHorizontal: sketchTheme.spacing.page,
    paddingTop: 12,
  },
  topSection: {
    gap: 14,
  },
  doodleCircle: {
    backgroundColor: '#FFE0C2',
    borderRadius: 999,
    opacity: 0.72,
    position: 'absolute',
  },
  doodleCircleTop: {
    height: 18,
    left: 32,
    top: 20,
    width: 18,
  },
  doodleCircleBottom: {
    bottom: 180,
    height: 14,
    right: 24,
    width: 14,
  },
  dashedLoop: {
    borderColor: sketchTheme.colors.ink,
    borderRadius: 999,
    borderStyle: 'dashed',
    borderWidth: 2,
    height: 56,
    opacity: 0.3,
    position: 'absolute',
    right: 18,
    top: 96,
    transform: [{ rotate: '12deg' }],
    width: 108,
  },
  card: {
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.strong,
    ...sketchTheme.radius.card,
  },
  heroCard: {
    backgroundColor: sketchTheme.colors.white,
    gap: 14,
    paddingBottom: 22,
    paddingHorizontal: 20,
    paddingTop: 24,
    position: 'relative',
  },
  heroContent: {
    gap: 8,
    paddingRight: 28,
  },
  pin: {
    backgroundColor: sketchTheme.colors.accent,
    borderColor: sketchTheme.colors.ink,
    borderRadius: 999,
    borderWidth: 2,
    height: 18,
    position: 'absolute',
    right: 18,
    top: 16,
    width: 18,
  },
  tapeStrip: {
    alignSelf: 'center',
    backgroundColor: '#D9D4CD',
    borderRadius: 8,
    height: 16,
    opacity: 0.92,
    position: 'absolute',
    top: -8,
    transform: [{ rotate: '-7deg' }],
    width: 96,
  },
  label: {
    color: sketchTheme.colors.penBlue,
    fontSize: 15,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  title: {
    color: sketchTheme.colors.ink,
    fontSize: 36,
    lineHeight: 42,
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  note: {
    color: sketchTheme.colors.ink,
    fontSize: 17,
    lineHeight: 25,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  metaChip: {
    backgroundColor: '#FFF4E8',
    borderColor: sketchTheme.colors.ink,
    borderStyle: 'dashed',
    borderWidth: 2,
    paddingHorizontal: 12,
    paddingVertical: 7,
    ...sketchTheme.radius.pill,
  },
  metaChipAlt: {
    backgroundColor: '#EEF5FF',
  },
  metaChipText: {
    color: sketchTheme.colors.ink,
    fontSize: 13,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  feedbackCard: {
    backgroundColor: '#FFF1D9',
    gap: 6,
    padding: 16,
  },
  feedbackTitle: {
    color: '#9A5A00',
    fontSize: 18,
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  feedbackText: {
    color: sketchTheme.colors.ink,
    fontSize: 15,
    lineHeight: 22,
  },
  chatShell: {
    flex: 1,
    minHeight: 0,
    position: 'relative',
  },
  chatShellShadow: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: sketchTheme.colors.ink,
    transform: [{ translateX: 6 }, { translateY: 6 }],
    ...sketchTheme.radius.card,
  },
  chatSurface: {
    backgroundColor: '#FFF8EF',
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.strong,
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    ...sketchTheme.radius.card,
  },
  messagesContainer: {
    backgroundColor: '#FFF8EF',
  },
  messageList: {
    paddingBottom: 12,
    paddingHorizontal: 14,
    paddingTop: 18,
  },
  toolbarWrap: {
    marginBottom: 12,
    marginHorizontal: 12,
    marginTop: 8,
    minHeight: 72,
    position: 'relative',
  },
  toolbarShadow: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: sketchTheme.colors.ink,
    transform: [{ translateX: 4 }, { translateY: 4 }],
    ...sketchTheme.radius.card,
  },
  toolbar: {
    backgroundColor: sketchTheme.colors.white,
    borderColor: sketchTheme.colors.ink,
    borderTopWidth: sketchTheme.border.strong,
    borderWidth: sketchTheme.border.strong,
    minHeight: 72,
    paddingHorizontal: 10,
    paddingTop: 8,
    ...sketchTheme.radius.card,
  },
  toolbarPrimary: {
    alignItems: 'center',
  },
  composerText: {
    color: sketchTheme.colors.ink,
    fontSize: 16,
    lineHeight: 22,
    marginTop: 8,
    minHeight: 44,
    paddingHorizontal: 8,
    paddingTop: 10,
  },
  sendContainer: {
    justifyContent: 'center',
    marginBottom: 8,
    marginRight: 4,
  },
  sendButton: {
    alignItems: 'center',
    backgroundColor: sketchTheme.colors.accent,
    borderColor: sketchTheme.colors.ink,
    borderWidth: 2,
    justifyContent: 'center',
    minWidth: 68,
    paddingHorizontal: 16,
    paddingVertical: 11,
    ...sketchTheme.radius.pill,
  },
  sendButtonDisabled: {
    opacity: 0.58,
  },
  sendButtonText: {
    color: sketchTheme.colors.white,
    fontSize: 15,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
});
