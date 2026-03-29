export type ChannelType = 'capture' | 'email' | 'meeting' | 'idea' | 'memo';

// AI 자동분류 카테고리 (Make.com 방식)
export type CaptureCategory = 'idea' | 'task' | 'memo';

export interface CaptureItem {
  id: string;
  content: string;           // 원본 입력
  summary: string;           // AI가 정리한 요약
  category: CaptureCategory; // AI 자동분류
  tags: string[];            // AI 자동 태그
  timestamp: Date;
  isProcessing?: boolean;
  // AI 분류 메타 (Make.com 패턴)
  confidence?: number;       // 분류 신뢰도 0~1
  priority?: 'high' | 'medium' | 'low';  // 할일 우선순위
  actionDate?: string;       // 할일 기한 (YYYY-MM-DD)
  modelUsed?: string;        // 사용된 AI 모델
  // 할일 완료 상태
  completed?: boolean;       // task 카테고리에서 완료 여부
  completedAt?: Date;        // 완료 시각
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  // 캡처 전용 필드
  captureItem?: CaptureItem;
  // AI 메타데이터
  tags?: string[];
  modelUsed?: string;
  creditsConsumed?: number;
}

export interface Channel {
  id: string;
  type: ChannelType;
  name: string;
  icon: string;
  description: string;
  color: string;
  messages: Message[];
}

export interface User {
  id: string;
  name: string;
  email: string;
  labName?: string;
  plan: 'basic' | 'pro' | 'max';
  creditsRemaining: number;
}
