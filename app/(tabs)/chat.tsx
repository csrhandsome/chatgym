import { startTransition, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import {
  Composer,
  GiftedChat,
  InputToolbar,
  Send,
  type IMessage,
  type InputToolbarProps,
  type MessageProps,
  type SendProps,
} from "react-native-gifted-chat";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  ChatMessageCard,
  type ChatMessageCardData,
} from "@/components/chat/chat-message-card";
import { sketchTheme } from "@/constants/theme";
import { useAuth } from "@/hooks/use-auth";
import {
  sendAgentMessage,
  MAX_CHAT_MESSAGE_LENGTH,
  type ChatHistoryItem,
  type ChatResponseChunk,
} from "@/services/agent-api";
import { storeFitnessPlan } from "@/services/fitness-plan";
import { BackendApiError } from "@/services/backend-api";

const CURRENT_USER = {
  _id: "chatgym-user",
  name: "你",
} as const;

const ASSISTANT_USER = {
  _id: "chatgym-agent",
  name: "ChatGym Agent",
} as const;

type ChatUiMessage = IMessage & Omit<ChatMessageCardData, "createdAt" | "text">;

export default function ChatScreen() {
  const { token, userId, signOut } = useAuth();
  const [messages, setMessages] = useState<ChatUiMessage[]>([]);
  const [draftText, setDraftText] = useState("");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const submittingRef = useRef(false);
  const requestRef = useRef<AbortController | null>(null);
  const sessionRef = useRef({ token, userId, generation: 0 });
  const belongsToSession = sessionRef.current.token === token && sessionRef.current.userId === userId;

  useLayoutEffect(() => {
    if (sessionRef.current.token !== token || sessionRef.current.userId !== userId) {
      requestRef.current?.abort();
      requestRef.current = null;
      sessionRef.current = { token, userId, generation: sessionRef.current.generation + 1 };
      submittingRef.current = false;
      setMessages([]);
      setDraftText("");
      setFeedback(null);
      setIsSubmitting(false);
      setIsSyncing(false);
    }
  }, [token, userId]);

  useEffect(() => () => {
    requestRef.current?.abort();
    requestRef.current = null;
    sessionRef.current.generation += 1;
    submittingRef.current = false;
  }, []);

  async function handleSend(outgoingMessages: ChatUiMessage[] = []) {
    const draft = outgoingMessages[0];
    const messageText = typeof draft?.text === "string" ? draft.text.trim() : "";

    if (!messageText) {
      return;
    }

    // An event from an earlier render cannot start work for a different account.
    if (sessionRef.current.token !== token || sessionRef.current.userId !== userId) {
      return;
    }

    if (!token) {
      setFeedback("请先到 Profile 页登录，再开始生成训练计划。");
      return;
    }

    if (!userId) {
      setFeedback("暂时无法验证账号身份，请到 Profile 页重新登录后再生成计划。");
      return;
    }

    if (submittingRef.current) {
      return;
    }
    if (messageText.length > MAX_CHAT_MESSAGE_LENGTH) {
      setFeedback(`聊天输入最多 ${MAX_CHAT_MESSAGE_LENGTH} 字，请缩短后发送。`);
      return;
    }
    submittingRef.current = true;
    const controller = new AbortController();
    requestRef.current = controller;
    const generation = sessionRef.current.generation;
    const isCurrentSession = () => sessionRef.current.token === token &&
      sessionRef.current.userId === userId &&
      sessionRef.current.generation === generation;

    const userMessage: ChatUiMessage = {
      ...draft,
      createdAt: new Date(),
      kind: "user",
      text: messageText,
      title: undefined,
      user: CURRENT_USER,
    };

    setFeedback(null);
    setDraftText("");
    setMessages((currentMessages) =>
      GiftedChat.append(currentMessages, [userMessage]),
    );
    setIsSubmitting(true);
    const streamedMessageIds = new Set<string>();

    try {
      const response = await sendAgentMessage(
        token,
        {
          history: buildChatHistory(messages),
          message: messageText,
        },
        {
          signal: controller.signal,
          onChunk(chunk) {
            if (!isCurrentSession()) return;
            streamedMessageIds.add(chunk.id);
            startTransition(() => {
              setMessages((currentMessages) => !isCurrentSession() ? currentMessages : GiftedChat.append(
                currentMessages.map((message) =>
                  chunk.toolCallId && message.toolCallId === chunk.toolCallId &&
                  streamedMessageIds.has(String(message._id)) && message.status === "running" && chunk.status !== "running"
                    ? { ...message, status: chunk.status }
                    : message,
                ),
                [createAssistantMessage({
                  ...chunk,
                  status: chunk.status === "running" && chunk.toolCallId
                    ? currentMessages.find((message) => message.toolCallId === chunk.toolCallId &&
                      streamedMessageIds.has(String(message._id)) && message.status && message.status !== "running")?.status ?? chunk.status
                    : chunk.status,
                })],
              ));
            });
          },
        },
      );

      if (!isCurrentSession() || controller.signal.aborted) return;

      const toolStatuses = new Map(response.chunks
        .filter((chunk) => chunk.toolCallId && chunk.status && chunk.status !== "running")
        .map((chunk) => [chunk.toolCallId, chunk.status]));
      const finishStatus = (message: Pick<ChatResponseChunk, "status" | "toolCallId">) =>
        message.status === "running"
          ? (message.toolCallId ? toolStatuses.get(message.toolCallId) : undefined) ?? "failed"
          : message.status;

      const latestFitnessPlan = [...response.chunks]
        .reverse()
        .find((chunk) => chunk.fitnessPlan && chunk.status !== "failed")?.fitnessPlan;

      // Resolve every call in this request, including results received before
      // their calls and calls whose result never arrived.
      if (response.delivery === "stream") {
        setMessages((currentMessages) => !isCurrentSession() ? currentMessages : currentMessages.map((message) =>
          streamedMessageIds.has(String(message._id)) ? { ...message, status: finishStatus(message) } : message,
        ));
      }

      if (latestFitnessPlan) {
        setIsSyncing(true);
        try {
          await storeFitnessPlan(latestFitnessPlan, userId);
        } catch {
          if (isCurrentSession()) {
            setFeedback("训练计划已经生成，但同步到 Fitness 页失败。");
          }
        }
      }

      if (!isCurrentSession()) return;

      if (response.delivery === "json") {
        const assistantMessages = response.chunks.map((chunk, index) =>
          createAssistantMessage({
            ...chunk,
            status: finishStatus(chunk),
          }, Date.now() + index),
        ).reverse();

        setMessages((currentMessages) =>
          isCurrentSession() ? GiftedChat.append(currentMessages, assistantMessages) : currentMessages,
        );
      }
    } catch (error) {
      if (!isCurrentSession()) return;
      const wasCancelled = controller.signal.aborted;
      const errorMessage = wasCancelled ? "已取消生成，未同步训练计划。" : getErrorMessage(error);

      setFeedback(errorMessage);
      if (error instanceof BackendApiError && error.status === 401) {
        try {
          await signOut(token);
        } catch {
          if (isCurrentSession()) {
            setFeedback(`${errorMessage} 无法清理已保存的登录信息，请在 Profile 页重试退出。`);
          }
        }
      }
      if (!isCurrentSession()) return;
      setMessages((currentMessages) =>
        !isCurrentSession() ? currentMessages : GiftedChat.append(currentMessages.map((message) =>
          streamedMessageIds.has(String(message._id)) && (message.status === "running" || message.kind === "answer")
            ? { ...message, status: "failed" }
            : message,
        ), [
          createAssistantMessage({
            id: `chat-error-${Date.now()}`,
            kind: "tool",
            status: "failed",
            text: `错误\n${errorMessage}`,
            title: wasCancelled ? "已取消生成" : "请求失败",
          }),
        ]),
      );
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (isCurrentSession()) {
        submittingRef.current = false;
        setIsSubmitting(false);
        setIsSyncing(false);
      }
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
          eventId: message.eventId,
          status: message.status,
          toolCallId: message.toolCallId,
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
                editable: !(belongsToSession && isSubmitting) && Boolean(token && userId),
                placeholder: token && userId
                  ? "描述你的目标！准备开始健身计划的定制之旅吧～"
                  : "请先到 Profile 页登录",
                placeholderTextColor: "#8C857A",
                style: [
                  styles.composerText,
                  composerProps.textInputProps?.style,
                ],
              }}
            />
          )}
          renderSend={(sendProps) => renderSend(sendProps)}
        />
      </View>
    );
  }

  function renderSend(sendProps: SendProps<ChatUiMessage>) {
    const isDisabled = !token || !userId || (belongsToSession && isSubmitting) || !sendProps.text?.trim();

    if (isDisabled) {
      return (
        <View style={styles.sendContainer}>
          <View style={[styles.sendButton, styles.sendButtonDisabled]}>
            {belongsToSession && isSubmitting ? (
              <ActivityIndicator
                color={sketchTheme.colors.white}
                size="small"
              />
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
    <SafeAreaView edges={["top"]} style={styles.safeArea}>
      <View style={styles.page}>
        <View
          pointerEvents="none"
          style={[styles.doodleCircle, styles.doodleCircleTop]}
        />
        <View
          pointerEvents="none"
          style={[styles.doodleCircle, styles.doodleCircleBottom]}
        />
        <View pointerEvents="none" style={styles.dashedLoop} />

        <View style={styles.topSection}>
          <View style={[styles.card, styles.heroCard]}>
            <View style={styles.pin} />
            <View style={styles.tapeStrip} />

            <View style={styles.heroContent}>
              <Text style={styles.label}>ChatGym Agent</Text>
              <Text style={styles.title}>边聊边生成训练计划</Text>
              <Text style={styles.note}>
                说出你的目标、频率和器械条件，系统会把训练建议实时整理成可执行计划。
              </Text>
            </View>

            <View style={styles.metaRow}>
              <View style={styles.metaChip}>
                <Text style={styles.metaChipText}>
                  {token && userId ? "已登录，可以开始生成训练计划。" : "请先到 Profile 页登录，再开始对话。"}
                </Text>
              </View>
            </View>
          </View>

          {belongsToSession && feedback ? (
            <View style={[styles.card, styles.feedbackCard]}>
              <Text style={styles.feedbackTitle}>当前反馈</Text>
              <Text style={styles.feedbackText}>{feedback}</Text>
            </View>
          ) : null}
          {belongsToSession && isSubmitting && !isSyncing ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="取消生成"
              onPress={() => requestRef.current?.abort()}
              style={styles.cancelButton}>
              <Text style={styles.metaChipText}>取消生成</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={styles.chatShell}>
          <View pointerEvents="none" style={styles.chatShellShadow} />
          <View style={styles.chatSurface}>
            <GiftedChat<ChatUiMessage>
              isTyping={belongsToSession && isSubmitting}
              isScrollToBottomEnabled
              isSendButtonAlwaysVisible
              listProps={{
                contentContainerStyle: styles.messageList,
                keyboardShouldPersistTaps: "handled",
                showsVerticalScrollIndicator: false,
              }}
              maxComposerHeight={120}
              messages={belongsToSession ? messages : []}
              messagesContainerStyle={styles.messagesContainer}
              minComposerHeight={48}
              minInputToolbarHeight={76}
              onSend={(nextMessages) => {
                void handleSend(nextMessages as ChatUiMessage[]);
              }}
              renderAvatar={null}
              renderInputToolbar={renderInputToolbar}
              renderMessage={renderMessage}
              text={belongsToSession ? draftText : ""}
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

function createAssistantMessage(
  chunk: Pick<ChatResponseChunk, "id" | "kind" | "text" | "title" | "eventId" | "status" | "toolCallId">,
  createdAt: Date | number = Date.now(),
): ChatUiMessage {
  return {
    _id: chunk.id,
    createdAt,
    kind: chunk.kind,
    text: chunk.text,
    title: chunk.title,
    eventId: chunk.eventId,
    status: chunk.status,
    toolCallId: chunk.toolCallId,
    user: ASSISTANT_USER,
  };
}

function buildChatHistory(messages: ChatUiMessage[]): ChatHistoryItem[] {
  // GiftedChat stores newest first. Preserve insertion order even when several
  // messages share a timestamp or the device clock moves backwards.
  return [...messages]
    .reverse()
    .filter((message) => message.kind === "user" || (message.kind === "answer" && message.status !== "failed"))
    .slice(-14)
    .map((message) => ({
      kind: message.kind === "user" ? "user" : message.kind,
      role: message.kind === "user" ? "user" : "assistant",
      text: message.text,
      title: message.title,
    }));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "发生未知错误，请稍后再试。";
}

const styles = StyleSheet.create({
  cancelButton: {
    alignSelf: "flex-end",
    borderColor: sketchTheme.colors.ink,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: sketchTheme.colors.white,
  },
  safeArea: {
    backgroundColor: sketchTheme.colors.paper,
    flex: 1,
  },
  page: {
    backgroundColor: sketchTheme.colors.paper,
    flex: 1,
    gap: 18,
    overflow: "hidden",
    paddingBottom: 12,
    paddingHorizontal: sketchTheme.spacing.page,
    paddingTop: 12,
  },
  topSection: {
    gap: 14,
  },
  doodleCircle: {
    backgroundColor: "#FFE0C2",
    borderRadius: 999,
    opacity: 0.72,
    position: "absolute",
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
    borderStyle: "dashed",
    borderWidth: 2,
    height: 56,
    opacity: 0.3,
    position: "absolute",
    right: 18,
    top: 96,
    transform: [{ rotate: "12deg" }],
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
    position: "relative",
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
    position: "absolute",
    right: 18,
    top: 16,
    width: 18,
  },
  tapeStrip: {
    alignSelf: "center",
    backgroundColor: "#D9D4CD",
    borderRadius: 8,
    height: 16,
    opacity: 0.92,
    position: "absolute",
    top: -8,
    transform: [{ rotate: "-7deg" }],
    width: 96,
  },
  label: {
    color: sketchTheme.colors.penBlue,
    fontSize: 15,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  title: {
    color: sketchTheme.colors.ink,
    fontSize: 36,
    lineHeight: 42,
    ...(sketchTheme.fonts.heading
      ? { fontFamily: sketchTheme.fonts.heading }
      : null),
  },
  note: {
    color: sketchTheme.colors.ink,
    fontSize: 17,
    lineHeight: 25,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  metaChip: {
    backgroundColor: "#FFF4E8",
    borderColor: sketchTheme.colors.ink,
    borderStyle: "dashed",
    borderWidth: 2,
    paddingHorizontal: 12,
    paddingVertical: 7,
    ...sketchTheme.radius.pill,
  },
  metaChipAlt: {
    backgroundColor: "#EEF5FF",
  },
  metaChipText: {
    color: sketchTheme.colors.ink,
    fontSize: 13,
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  feedbackCard: {
    backgroundColor: "#FFF1D9",
    gap: 6,
    padding: 16,
  },
  feedbackTitle: {
    color: "#9A5A00",
    fontSize: 18,
    ...(sketchTheme.fonts.heading
      ? { fontFamily: sketchTheme.fonts.heading }
      : null),
  },
  feedbackText: {
    color: sketchTheme.colors.ink,
    fontSize: 15,
    lineHeight: 22,
  },
  chatShell: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  chatShellShadow: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: sketchTheme.colors.ink,
    transform: [{ translateX: 6 }, { translateY: 6 }],
    ...sketchTheme.radius.card,
  },
  chatSurface: {
    backgroundColor: "#FFF8EF",
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.strong,
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    ...sketchTheme.radius.card,
  },
  messagesContainer: {
    backgroundColor: "#FFF8EF",
  },
  messageList: {
    paddingBottom: 12,
    paddingHorizontal: 14,
    paddingTop: 18,
  },
  toolbarWrap: {
    marginBottom: 18,
    marginHorizontal: 8,
    marginTop: 4,
    minHeight: 76,
    position: "relative",
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
    minHeight: 76,
    paddingHorizontal: 12,
    paddingTop: 8,
    ...sketchTheme.radius.card,
  },
  toolbarPrimary: {
    alignItems: "center",
  },
  composerText: {
    color: sketchTheme.colors.ink,
    fontSize: 16,
    lineHeight: 22,
    marginTop: 6,
    minHeight: 44,
    paddingHorizontal: 10,
    paddingTop: 10,
  },
  sendContainer: {
    justifyContent: "center",
    marginBottom: 8,
    marginRight: 4,
  },
  sendButton: {
    alignItems: "center",
    backgroundColor: sketchTheme.colors.accent,
    borderColor: sketchTheme.colors.ink,
    borderWidth: 2,
    justifyContent: "center",
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
