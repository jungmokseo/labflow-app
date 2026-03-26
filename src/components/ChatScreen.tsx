import React, { useRef, useEffect } from 'react';
import { View, FlatList, StyleSheet, Text } from 'react-native';
import { ChannelType } from '../types';
import { useChat } from '../hooks/useChat';
import MessageBubble from './MessageBubble';
import ChatInput from './ChatInput';
import TypingIndicator from './TypingIndicator';
import { colors, spacing, fontSize } from '../constants/theme';

interface Props {
  channelType: ChannelType;
  placeholder?: string;
  welcomeMessage?: string;
}

export default function ChatScreen({ channelType, placeholder, welcomeMessage }: Props) {
  const { messages, isLoading, sendMessage } = useChat(channelType);
  const flatListRef = useRef<FlatList>(null);

  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages.length, isLoading]);

  return (
    <View style={styles.container}>
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <MessageBubble message={item} />}
        contentContainerStyle={styles.messageList}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyEmoji}>
              {channelType === 'idea' ? '💡' : channelType === 'memo' ? '📝' : channelType === 'email' ? '✉️' : '🎙️'}
            </Text>
            <Text style={styles.emptyTitle}>
              {welcomeMessage || '대화를 시작해보세요'}
            </Text>
            <Text style={styles.emptySubtitle}>
              {channelType === 'idea'
                ? '떠오르는 아이디어, 실험 메모, 할 일을\n음성이나 텍스트로 빠르게 캡처하세요'
                : channelType === 'memo'
                ? '중요한 정보를 저장하고\n자연어로 검색할 수 있습니다'
                : channelType === 'email'
                ? 'Gmail을 연결하면\nAI가 매일 브리핑을 준비합니다'
                : '회의 녹음을 올리면\nAI가 요약과 액션아이템을 정리합니다'}
            </Text>
          </View>
        }
        ListFooterComponent={isLoading ? <TypingIndicator /> : null}
      />
      <ChatInput
        onSend={sendMessage}
        placeholder={placeholder}
        isLoading={isLoading}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  messageList: {
    flexGrow: 1,
    justifyContent: 'flex-end',
    paddingVertical: spacing.sm,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xxl,
    paddingTop: 120,
  },
  emptyEmoji: {
    fontSize: 56,
    marginBottom: spacing.lg,
  },
  emptyTitle: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  emptySubtitle: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
  },
});
