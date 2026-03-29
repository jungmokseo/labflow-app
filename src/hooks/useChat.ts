import { useState, useCallback, useRef } from 'react';
import { Message, ChannelType } from '../types';
import { brainChat, checkHealth } from '../services/api-client';

export function useChat(channelType: ChannelType) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const channelIdRef = useRef<string | undefined>(undefined);

  const sendMessage = useCallback(async (text: string) => {
    // 사용자 메시지 추가
    const userMsg: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, userMsg]);
    setIsLoading(true);

    try {
      const result = await brainChat({
        message: text,
        channelId: channelIdRef.current,
      });

      // 서버에서 반환한 channelId 저장 (세션 유지)
      if (result.channelId) {
        channelIdRef.current = result.channelId;
      }

      const aiMsg: Message = {
        id: `ai-${Date.now()}`,
        role: 'assistant',
        content: result.reply,
        timestamp: new Date(),
        tags: result.sources?.map((s: any) => s.type || s.source).filter(Boolean) || [],
        modelUsed: 'gemini-2.0-flash',
      };

      setMessages(prev => [...prev, aiMsg]);
    } catch (error: any) {
      // API 실패 시 에러 메시지 표시
      const errorMsg: Message = {
        id: `error-${Date.now()}`,
        role: 'assistant',
        content: `서버 연결에 실패했습니다. 잠시 후 다시 시도해주세요.\n\n(${error.message || '알 수 없는 오류'})`,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  }, [channelType]);

  const clearMessages = useCallback(() => {
    setMessages([]);
    channelIdRef.current = undefined;
  }, []);

  return { messages, isLoading, sendMessage, clearMessages };
}
