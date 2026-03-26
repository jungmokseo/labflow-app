import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Message } from '../types';
import { colors, spacing, fontSize, borderRadius } from '../constants/theme';

interface Props {
  message: Message;
}

export default function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user';
  const time = message.timestamp.toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <View style={[styles.container, isUser ? styles.userContainer : styles.aiContainer]}>
      <View style={[styles.bubble, isUser ? styles.userBubble : styles.aiBubble]}>
        <Text style={[styles.content, isUser ? styles.userText : styles.aiText]}>
          {message.content}
        </Text>
        {message.tags && message.tags.length > 0 && (
          <View style={styles.tagsRow}>
            {message.tags.map((tag, idx) => (
              <View key={idx} style={styles.tag}>
                <Text style={styles.tagText}>#{tag}</Text>
              </View>
            ))}
          </View>
        )}
        <Text style={[styles.time, isUser ? styles.userTime : styles.aiTime]}>{time}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: spacing.xs,
    marginHorizontal: spacing.lg,
  },
  userContainer: {
    alignItems: 'flex-end',
  },
  aiContainer: {
    alignItems: 'flex-start',
  },
  bubble: {
    maxWidth: '82%',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.lg,
  },
  userBubble: {
    backgroundColor: colors.bubbleUser,
    borderBottomRightRadius: spacing.xs,
  },
  aiBubble: {
    backgroundColor: colors.bubbleAI,
    borderWidth: 1,
    borderColor: colors.bubbleBorder,
    borderBottomLeftRadius: spacing.xs,
  },
  content: {
    fontSize: fontSize.md,
    lineHeight: 22,
  },
  userText: {
    color: colors.white,
  },
  aiText: {
    color: colors.text,
  },
  tagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: spacing.sm,
    gap: spacing.xs,
  },
  tag: {
    backgroundColor: 'rgba(99, 102, 241, 0.2)',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
  tagText: {
    color: colors.primaryLight,
    fontSize: fontSize.xs,
    fontWeight: '500',
  },
  time: {
    fontSize: fontSize.xs,
    marginTop: spacing.xs,
  },
  userTime: {
    color: 'rgba(255,255,255,0.6)',
    textAlign: 'right',
  },
  aiTime: {
    color: colors.textMuted,
  },
});
