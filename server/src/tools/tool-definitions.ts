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
  | 'get_weekly_review'
  | 'link_paper_grants'
  | 'import_structured_data'
  | 'register_uploaded_papers'
  | 'reindex_papers';

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
    description: 'Gmail에서 최근 이메일을 가져와 중요도별 브리핑을 생성합니다. 결과는 완성된 양식이므로 그대로 전달하세요. 사용자가 "12시간", "6시간" 등 특정 시간 범위를 지정하면 hours_ago를 설정하세요.',
    input_schema: {
      type: 'object' as const,
      properties: {
        max_results: {
          type: 'number',
          description: '가져올 이메일 수 (기본 150)',
        },
        hours_ago: {
          type: 'number',
          description: '몇 시간 전부터의 이메일을 가져올지. 예: "12시간" → 12, "6시간" → 6. 지정하지 않으면 마지막 브리핑 이후 모든 이메일.',
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
    description: 'Google Calendar에서 일정을 조회합니다. 날짜 범위를 지정할 수 있습니다.',
    input_schema: {
      type: 'object' as const,
      properties: {
        start_date: {
          type: 'string',
          description: '조회 시작 날짜 (YYYY-MM-DD). 생략하면 오늘.',
        },
        end_date: {
          type: 'string',
          description: '조회 종료 날짜 (YYYY-MM-DD). 생략하면 시작일+7일.',
        },
      },
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
  {
    name: 'import_structured_data',
    description: '업로드된 엑셀/문서에서 파싱된 데이터를 DB에 저장합니다. 과제, 구성원, 논문, 참여율, 규정 등을 자동 분류하여 적절한 테이블에 저장합니다. 사용자가 파일을 업로드한 후 "저장해줘"라고 하면 사용하세요.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_id: { type: 'string', description: '업로드된 파일의 memo ID (fileId)' },
        data_type: {
          type: 'string',
          enum: ['project', 'member', 'publication', 'regulation', 'participation_rate', 'acknowledgment', 'auto'],
          description: '데이터 유형. auto면 AI가 자동 판별.',
        },
        items: {
          type: 'array',
          items: { type: 'object' },
          description: '저장할 데이터 배열. 각 항목은 해당 타입의 필드를 포함. 파싱된 structured.rows를 그대로 넘기거나, 대화에서 추출한 데이터를 정리해서 넘기세요.',
        },
      },
      required: ['data_type', 'items'],
    },
  },
  {
    name: 'link_paper_grants',
    description: '논문에 사사(acknowledgment) 과제를 연결합니다. "이 논문은 A, B 과제 사사했어" 같은 요청에 사용합니다. 논문이 DB에 없으면 자동 생성합니다.',
    input_schema: {
      type: 'object' as const,
      properties: {
        paper_title: { type: 'string', description: '논문 제목 또는 별칭 (정확하지 않아도 됨)' },
        grant_names: {
          type: 'array',
          items: { type: 'string' },
          description: '사사 과제명 또는 약칭 목록 (예: ["뇌선도", "BRL"])',
        },
        paper_journal: { type: 'string', description: '게재 저널 (선택)' },
        paper_year: { type: 'number', description: '발표 연도 (선택)' },
        paper_authors: { type: 'string', description: '저자 (선택)' },
        paper_doi: { type: 'string', description: 'DOI (선택)' },
      },
      required: ['paper_title', 'grant_names'],
    },
  },
  {
    name: 'register_uploaded_papers',
    description: '업로드된 논문 PDF를 연구실 논문 DB에 등록합니다. 메타데이터(제목/저자/저널/연도) 자동 추출 + 벡터 임베딩 + 지식 그래프 연결까지 수행합니다. 사용자가 논문을 올리고 "등록해줘", "우리 논문이야", "DB에 넣어줘" 등의 의도를 표현하면 사용합니다.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '등록할 파일의 memo ID 목록 (업로드 시 받은 fileId)',
        },
      },
      required: ['file_ids'],
    },
  },
  {
    name: 'reindex_papers',
    description: '아직 벡터 인덱싱이 안 된 논문들을 인덱싱합니다. "논문 인덱싱해줘", "논문 검색 안 돼", "등록된 논문 인덱싱" 등의 요청에 사용합니다.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];
