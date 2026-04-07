/**
 * Tool Definitions — Claude tool-use API용 도구 정의
 *
 * 철학: 도구 설명은 간결하게, 양식은 도구 결과 안에서 지정.
 */

import type Anthropic from '@anthropic-ai/sdk';

export type ToolName =
  | 'search_lab_data'
  | 'search_knowledge'
  | 'get_email_briefing'
  | 'read_email'
  | 'draft_email_reply'
  | 'get_calendar'
  | 'create_calendar_event'
  | 'save_capture'
  | 'get_daily_brief'
  | 'get_weekly_review';

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: 'search_lab_data',
    description: '연구실 DB에서 구성원, 과제, 논문, 미팅, 메모를 검색합니다.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: '검색할 내용 (자연어)',
        },
        types: {
          type: 'array',
          items: { type: 'string', enum: ['member', 'project', 'publication', 'meeting', 'memo', 'all'] },
          description: '검색할 데이터 종류. 불확실하면 ["all"]',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_knowledge',
    description: '벡터 검색(RAG) + 지식그래프로 깊은 검색. 과거 대화, 메모, 논문에서 맥락 정보를 찾습니다.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: '검색할 질문이나 키워드',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_email_briefing',
    description: 'Gmail에서 최근 이메일을 가져와 중요도별 브리핑을 생성합니다. 결과는 완성된 양식이므로 그대로 전달하세요.',
    input_schema: {
      type: 'object' as const,
      properties: {
        max_results: {
          type: 'number',
          description: '가져올 이메일 수 (기본 30)',
        },
      },
      required: [],
    },
  },
  {
    name: 'read_email',
    description: '특정 이메일의 전문을 가져옵니다. 발신자, 제목, 키워드로 검색합니다.',
    input_schema: {
      type: 'object' as const,
      properties: {
        search_query: {
          type: 'string',
          description: '발신자, 제목, 키워드 등 검색어. 비우면 가장 최근 이메일.',
        },
        limit: {
          type: 'number',
          description: '가져올 이메일 수 (기본 5). 사용자가 "1건", "하나만" 등이면 1.',
        },
      },
      required: [],
    },
  },
  {
    name: 'draft_email_reply',
    description: '이메일 답장 초안을 작성하여 Gmail 임시보관함에 저장합니다.',
    input_schema: {
      type: 'object' as const,
      properties: {
        search_query: {
          type: 'string',
          description: '답장할 이메일을 찾기 위한 검색어 (발신자, 제목 등)',
        },
        instructions: {
          type: 'string',
          description: '답장에 포함할 내용이나 어조에 대한 지시',
        },
      },
      required: ['instructions'],
    },
  },
  {
    name: 'get_calendar',
    description: 'Google Calendar에서 오늘부터 7일간의 일정을 가져옵니다. 결과에서 원하는 날짜의 일정을 찾아 답변하세요.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'create_calendar_event',
    description: 'Google Calendar에 새 일정을 등록합니다.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: '일정 제목' },
        date: { type: 'string', description: '날짜 (YYYY-MM-DD)' },
        time: { type: 'string', description: '시작 시간 (HH:mm). 종일이면 생략.' },
        duration: { type: 'number', description: '일정 길이(분). 기본 60.' },
        location: { type: 'string', description: '장소 (선택)' },
        description: { type: 'string', description: '메모 (선택)' },
      },
      required: ['title', 'date'],
    },
  },
  {
    name: 'save_capture',
    description: '할일(task), 아이디어(idea), 메모(memo)를 빠르게 저장합니다.',
    input_schema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: '저장할 내용 (사용자 원문 그대로)' },
        type: {
          type: 'string',
          enum: ['task', 'idea', 'memo'],
          description: '행동이 필요하면 task, 아이디어면 idea, 순수 정보면 memo.',
        },
      },
      required: ['content', 'type'],
    },
  },
  {
    name: 'get_daily_brief',
    description: '오늘의 종합 브리핑: 미팅, 마감 태스크, 논문 알림, 최근 메모를 정리합니다.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_weekly_review',
    description: '이번 주 활동 리뷰: 미팅, 캡처, 메모, 완료 태스크, 지식 성장 등을 정리합니다.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];
