/**
 * Tool Definitions — Claude tool-use API용 도구 정의
 *
 * Intent classifier를 제거하고, Claude가 직접 필요한 도구를 판단·호출하는 구조.
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
    description: `연구실 DB에서 구성원, 과제, 논문, 미팅, 메모를 검색합니다. 여러 종류의 데이터를 동시에 검색할 수 있습니다.
예시: "김태영 과제 뭐야?" → 구성원+과제 검색, "TIPS 과제 담당자 연락처" → 과제+구성원 검색
사용자가 연구실 정보(구성원, 과제, 논문, 사사문구 등)에 대해 물어볼 때 사용하세요.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: '검색할 내용 (자연어 그대로)',
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
    description: `벡터 검색(RAG) + 지식그래프를 활용한 깊은 검색입니다. 단순 DB 조회로는 답할 수 없는 복합적인 질문에 사용하세요.
예시: "hydrogel 관련 연구 현황", "최근 논의된 실험 방법", "누가 어떤 장비를 쓰고 있지?"
과거 대화, 메모, 논문에서 맥락 정보를 찾을 때 유용합니다.`,
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
    description: `Gmail에서 최근 이메일을 가져와 중요도별로 브리핑합니다. 사용자가 이메일/메일/Gmail 확인을 요청할 때 사용하세요.
예시: "이메일 확인해줘", "메일 뭐 왔어?", "오늘 이메일"`,
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
    description: `특정 이메일의 전문(전체 내용)을 가져옵니다. 발신자, 제목, 키워드로 검색합니다.
예시: "GitHub에서 온 이메일 보여줘", "가장 최근 이메일 전체 내용", "OO교수 메일 읽어줘"`,
    input_schema: {
      type: 'object' as const,
      properties: {
        search_query: {
          type: 'string',
          description: '발신자, 제목, 키워드 등 검색어. 비우면 가장 최근 이메일.',
        },
      },
      required: [],
    },
  },
  {
    name: 'draft_email_reply',
    description: `이메일 답장 초안을 작성하여 Gmail 임시보관함에 저장합니다.
예시: "그 이메일에 답장 써줘", "OO에게 회신 초안", "감사 답장 작성해줘"`,
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
    description: `Google Calendar에서 오늘/이번 주 일정을 가져옵니다. 사용자가 일정, 스케줄, 미팅 시간을 물어볼 때 사용하세요.
예시: "오늘 일정", "이번주 스케줄", "다음 미팅 언제?", "오늘 뭐 있어?"`,
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'create_calendar_event',
    description: `Google Calendar에 새 일정을 등록합니다.
예시: "내일 오후 2시에 팀 미팅 일정 등록해줘", "금요일 세미나 캘린더에 넣어줘"`,
    input_schema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: '일정 제목',
        },
        date: {
          type: 'string',
          description: '날짜 (YYYY-MM-DD 형식)',
        },
        time: {
          type: 'string',
          description: '시작 시간 (HH:mm 형식). 종일 일정이면 생략.',
        },
        duration: {
          type: 'number',
          description: '일정 길이(분). 기본 60.',
        },
        location: {
          type: 'string',
          description: '장소 (선택)',
        },
        description: {
          type: 'string',
          description: '메모 (선택)',
        },
      },
      required: ['title', 'date'],
    },
  },
  {
    name: 'save_capture',
    description: `할일(task), 아이디어(idea), 메모(memo)를 빠르게 저장합니다. 사용자가 무언가를 기억/기록/저장하고 싶어할 때 사용하세요.
예시: "이거 메모해줘", "할 일 추가", "아이디어 저장", "논문 리뷰 금요일까지 해야 해"`,
    input_schema: {
      type: 'object' as const,
      properties: {
        content: {
          type: 'string',
          description: '저장할 내용 (사용자 원문 그대로)',
        },
        type: {
          type: 'string',
          enum: ['task', 'idea', 'memo'],
          description: '캡처 유형. 행동이 필요하면 task, 아이디어/제안이면 idea, 순수 정보면 memo.',
        },
      },
      required: ['content', 'type'],
    },
  },
  {
    name: 'get_daily_brief',
    description: `오늘의 종합 브리핑: 미팅, 마감 태스크, 논문 알림, 최근 메모를 한눈에 정리합니다.
예시: "오늘 브리핑", "오늘 뭐 해야 해?", "today"`,
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_weekly_review',
    description: `이번 주 활동 리뷰: 미팅, 캡처, 메모, 완료 태스크, 지식 성장 등을 정리합니다.
예시: "이번 주 정리", "주간 리뷰", "weekly"`,
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];
