import { useState, useCallback } from 'react';
import { Message, ChannelType } from '../types';

// 목업 AI 응답 — 나중에 실제 API로 교체
function generateMockResponse(channelType: ChannelType, userMessage: string): { content: string; tags: string[] } {
  const lower = userMessage.toLowerCase();

  if (channelType === 'idea') {
    // 아이디어를 정리하고 태그를 자동 생성
    const tags: string[] = [];

    if (lower.includes('논문') || lower.includes('paper') || lower.includes('연구')) tags.push('연구');
    if (lower.includes('실험') || lower.includes('experiment')) tags.push('실험');
    if (lower.includes('미팅') || lower.includes('회의')) tags.push('미팅');
    if (lower.includes('코드') || lower.includes('프로그래밍') || lower.includes('개발')) tags.push('개발');
    if (lower.includes('데이터') || lower.includes('분석')) tags.push('데이터');
    if (lower.includes('아이디어') || lower.includes('idea')) tags.push('아이디어');
    if (lower.includes('할일') || lower.includes('todo') || lower.includes('해야')) tags.push('할일');
    if (lower.includes('센서') || lower.includes('sensor')) tags.push('센서');
    if (lower.includes('바이오') || lower.includes('bio')) tags.push('바이오');
    if (lower.includes('pcb') || lower.includes('회로')) tags.push('하드웨어');

    if (tags.length === 0) tags.push('일반');

    return {
      content: `💡 **아이디어 정리 완료**\n\n"${userMessage}"\n\n📋 자동 분류된 태그: ${tags.map(t => `#${t}`).join(' ')}\n\n💬 이 아이디어를 더 구체화하시겠어요? 관련 메모나 논문을 연결할 수도 있습니다.`,
      tags,
    };
  }

  return { content: `메시지를 받았습니다: "${userMessage}"`, tags: [] };
}

export function useChat(channelType: ChannelType) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);

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

    // 목업 딜레이 (실제 API 호출 시뮬레이션)
    await new Promise(resolve => setTimeout(resolve, 800 + Math.random() * 1200));

    // AI 응답 생성
    const { content, tags } = generateMockResponse(channelType, text);
    const aiMsg: Message = {
      id: `ai-${Date.now()}`,
      role: 'assistant',
      content,
      timestamp: new Date(),
      tags,
      modelUsed: 'claude-haiku',
      creditsConsumed: 1,
    };

    setMessages(prev => [...prev, aiMsg]);
    setIsLoading(false);
  }, [channelType]);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return { messages, isLoading, sendMessage, clearMessages };
}
