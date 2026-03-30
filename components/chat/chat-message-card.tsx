import Markdown from 'react-native-markdown-display';
import { Image, StyleSheet, Text, type ImageSourcePropType, View } from 'react-native';

import { sketchTheme } from '@/constants/theme';
import type { ChatMessageKind } from '@/services/backend-api';

export type ChatCardKind = ChatMessageKind | 'user';

export type ChatMessageCardData = {
  createdAt: Date | number;
  kind: ChatCardKind;
  text: string;
  title?: string;
};

type ChatMessageCardProps = {
  message: ChatMessageCardData;
};

const CARD_META: Record<
  ChatCardKind,
  {
    backgroundColor: string;
    eyebrow: string;
    eyebrowColor: string;
    icon?: ImageSourcePropType;
    pinColor: string;
    textColor: string;
  }
> = {
  answer: {
    backgroundColor: sketchTheme.colors.white,
    eyebrow: '教练回复',
    eyebrowColor: sketchTheme.colors.penBlue,
    pinColor: sketchTheme.colors.penBlue,
    textColor: sketchTheme.colors.ink,
  },
  thought: {
    backgroundColor: '#FFF1D9',
    eyebrow: '思路整理',
    eyebrowColor: '#9A5A00',
    icon: require('../../assets/icons/thinking-ui-line.png'),
    pinColor: '#FFC56E',
    textColor: sketchTheme.colors.ink,
  },
  tool: {
    backgroundColor: '#EDF5FF',
    eyebrow: '处理中',
    eyebrowColor: sketchTheme.colors.penBlue,
    icon: require('../../assets/icons/tool-ui-line.png'),
    pinColor: '#8BB5F0',
    textColor: sketchTheme.colors.ink,
  },
  user: {
    backgroundColor: sketchTheme.colors.accent,
    eyebrow: '你',
    eyebrowColor: sketchTheme.colors.white,
    pinColor: sketchTheme.colors.noteYellow,
    textColor: sketchTheme.colors.white,
  },
};

export function ChatMessageCard({ message }: ChatMessageCardProps) {
  const meta = CARD_META[message.kind];
  const isUser = message.kind === 'user';

  return (
    <View style={[styles.wrap, isUser ? styles.wrapRight : styles.wrapLeft]}>
      <View pointerEvents="none" style={styles.shadow} />
      <View
        style={[
          styles.card,
          {
            backgroundColor: meta.backgroundColor,
          },
          isUser ? styles.userCard : styles.assistantCard,
        ]}>
        <View
          style={[
            styles.pin,
            {
              backgroundColor: meta.pinColor,
            },
          ]}
        />

        <View style={styles.headerRow}>
          <View style={styles.headerLead}>
            {meta.icon ? (
              <View style={styles.iconBadge}>
                <Image resizeMode="contain" source={meta.icon} style={styles.icon} />
              </View>
            ) : null}
            <Text
              style={[
                styles.eyebrow,
                {
                  color: meta.eyebrowColor,
                },
              ]}>
              {meta.eyebrow}
            </Text>
          </View>
          <Text
            style={[
              styles.time,
              {
                color: isUser ? 'rgba(255,255,255,0.84)' : 'rgba(45,45,45,0.58)',
              },
            ]}>
            {formatTime(message.createdAt)}
          </Text>
        </View>

        {message.title ? <Text style={styles.title}>{message.title}</Text> : null}

        {isUser ? (
          <Text
            style={[
              styles.userText,
              {
                color: meta.textColor,
              },
            ]}>
            {message.text}
          </Text>
        ) : (
          <Markdown style={markdownStyles}>{message.text}</Markdown>
        )}
      </View>
    </View>
  );
}

function formatTime(value: Date | number): string {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

const markdownStyles = StyleSheet.create({
  body: {
    color: sketchTheme.colors.ink,
    fontSize: 16,
    lineHeight: 24,
    margin: 0,
  },
  paragraph: {
    color: sketchTheme.colors.ink,
    fontSize: 16,
    lineHeight: 24,
    marginBottom: 10,
    marginTop: 0,
  },
  heading1: {
    color: sketchTheme.colors.ink,
    fontSize: 26,
    lineHeight: 32,
    marginBottom: 12,
    marginTop: 0,
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  heading2: {
    color: sketchTheme.colors.ink,
    fontSize: 22,
    lineHeight: 28,
    marginBottom: 10,
    marginTop: 0,
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  bullet_list: {
    marginBottom: 8,
    marginTop: 0,
  },
  ordered_list: {
    marginBottom: 8,
    marginTop: 0,
  },
  list_item: {
    marginBottom: 4,
  },
  hr: {
    backgroundColor: 'rgba(45,45,45,0.18)',
    height: 2,
    marginBottom: 14,
    marginTop: 6,
  },
  blockquote: {
    backgroundColor: 'rgba(255,255,255,0.62)',
    borderLeftColor: sketchTheme.colors.penBlue,
    borderLeftWidth: 4,
    marginBottom: 12,
    marginTop: 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  code_inline: {
    backgroundColor: 'rgba(45,93,161,0.12)',
    borderRadius: 8,
    color: sketchTheme.colors.penBlue,
    overflow: 'hidden',
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  code_block: {
    backgroundColor: 'rgba(45,93,161,0.08)',
    borderColor: 'rgba(45,45,45,0.1)',
    borderWidth: 1,
    color: sketchTheme.colors.ink,
    marginBottom: 12,
    marginTop: 2,
    padding: 12,
    ...sketchTheme.radius.note,
  },
  fence: {
    backgroundColor: 'rgba(45,93,161,0.08)',
    borderColor: 'rgba(45,45,45,0.1)',
    borderWidth: 1,
    color: sketchTheme.colors.ink,
    marginBottom: 12,
    marginTop: 2,
    padding: 12,
    ...sketchTheme.radius.note,
  },
  link: {
    color: sketchTheme.colors.penBlue,
    textDecorationLine: 'underline',
  },
});

const styles = StyleSheet.create({
  wrap: {
    marginVertical: 7,
    maxWidth: '92%',
    minWidth: 160,
    position: 'relative',
  },
  wrapLeft: {
    alignSelf: 'flex-start',
  },
  wrapRight: {
    alignSelf: 'flex-end',
  },
  shadow: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: sketchTheme.colors.ink,
    transform: [{ translateX: 4 }, { translateY: 4 }],
    ...sketchTheme.radius.note,
  },
  card: {
    borderColor: sketchTheme.colors.ink,
    borderWidth: sketchTheme.border.regular,
    gap: 6,
    paddingBottom: 14,
    paddingHorizontal: 14,
    paddingTop: 14,
    ...sketchTheme.radius.note,
  },
  assistantCard: {
    borderTopRightRadius: 18,
  },
  userCard: {
    borderBottomRightRadius: 12,
    borderTopLeftRadius: 18,
  },
  pin: {
    borderColor: sketchTheme.colors.ink,
    borderRadius: 999,
    borderWidth: 2,
    height: 12,
    position: 'absolute',
    right: 12,
    top: 10,
    width: 12,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    paddingRight: 20,
  },
  headerLead: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    minWidth: 0,
  },
  iconBadge: {
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderColor: sketchTheme.colors.ink,
    borderWidth: 2,
    height: 28,
    justifyContent: 'center',
    width: 28,
    ...sketchTheme.radius.pill,
  },
  icon: {
    height: 16,
    width: 16,
  },
  eyebrow: {
    fontSize: 12,
    letterSpacing: 1,
    textTransform: 'uppercase',
    ...(sketchTheme.fonts.body ? { fontFamily: sketchTheme.fonts.body } : null),
  },
  time: {
    fontSize: 12,
    lineHeight: 14,
  },
  title: {
    color: sketchTheme.colors.ink,
    fontSize: 18,
    lineHeight: 24,
    ...(sketchTheme.fonts.heading ? { fontFamily: sketchTheme.fonts.heading } : null),
  },
  userText: {
    fontSize: 16,
    lineHeight: 24,
  },
});
