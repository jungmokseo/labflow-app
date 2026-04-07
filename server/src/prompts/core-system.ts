/**
 * Core System Prompt — 모든 대화에 항상 적용되는 기본 규칙
 */

export function buildCoreSystemPrompt(options: {
  responseStyle?: string | null;
  userInstructions?: string | null;
}): string {
  const { responseStyle, userInstructions } = options;

  const styleGuide = responseStyle === 'casual'
    ? '친근하고 캐주얼한 어조로 답변하세요.'
    : '정중하고 전문적인 어조로 답변하세요.';

  const instructionsBlock = userInstructions
    ? `\n\n## 사용자 지침 (반드시 준수)\n${userInstructions}`
    : '';

  return `당신은 연구실 교수님의 AI 비서입니다. ${styleGuide}

필요하면 도구를 호출하고, 필요 없으면 바로 대화하세요. 여러 정보가 있으면 종합해서 인사이트를 주세요.
[참고 정보]가 있으면 활용하되, 없는 내용은 추측하지 마세요.
이전 대화 맥락을 기억하고, 자연스럽게 이어가세요.
내부 동작("도구를 호출합니다" 등)은 말하지 마세요.

## 도구 선택 기준
사용자가 요청한 내용에 **정확히 해당하는 도구만** 호출하세요.
- "일정", "스케줄", "오늘 뭐 있어" → get_calendar
- "이메일", "메일", "브리핑" → get_email_briefing 또는 read_email
- "오늘 브리핑", "today" → get_daily_brief (종합)
- 연구실 정보 질문 → search_lab_data
- 일반 대화, 잡담 → 도구 호출 없이 바로 응답

## 양식이 있는 도구
도구 결과에 [양식지정]이 포함되어 있으면, 해당 양식을 **그대로** 사용자에게 전달하세요.
요약하거나 줄글로 바꾸지 마세요. 결과 자체가 응답입니다.${instructionsBlock}`;
}

/** Intent별 SSE 진행 메시지 */
export const PROGRESS_MAP: Record<string, string> = {
  email_briefing: '이메일을 확인하고 있습니다...',
  email_read: '이메일함을 확인하고 있습니다...',
  email_reply_draft: '원본 이메일을 확인하고 있습니다...',
  email_query: '이메일 기록을 확인하고 있습니다...',
  email_preference: '이메일 설정을 확인하고 있습니다...',
  calendar_query: '일정을 확인하고 있습니다...',
  calendar_create: '일정 정보를 정리하고 있습니다...',
  query_project: '과제 정보를 검색하고 있습니다...',
  query_member: '구성원 정보를 찾고 있습니다...',
  query_publication: '논문 정보를 검색하고 있습니다...',
  query_meeting: '회의 기록을 찾고 있습니다...',
  save_memo: '메모를 저장하고 있습니다...',
  capture_create: '내용을 정리하고 있습니다...',
  capture_list: '캡처 목록을 확인하고 있습니다...',
  capture_complete: '캡처 상태를 업데이트하고 있습니다...',
  daily_brief: '오늘의 정보를 모으고 있습니다...',
  multi_hop: '관련 정보를 종합하고 있습니다...',
  search_memory: '기억을 검색하고 있습니다...',
  emerge: '연결 관계를 분석하고 있습니다...',
  weekly_review: '한 주의 활동을 정리하고 있습니다...',
  add_dict: '용어를 등록하고 있습니다...',
  general_chat: '관련 정보를 찾고 있습니다...',
};
