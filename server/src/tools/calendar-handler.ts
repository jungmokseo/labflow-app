/**
 * Calendar Handler — 캘린더 조회/생성
 */

import { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { getOrCreateShadow, saveShadowMessage } from './shadow-session.js';

/**
 * 캘린더 조회 — 오늘/이번주 일정
 */
export async function handleCalendarQuery(
  message: string,
  userId: string,
): Promise<{ response: string; intent: string; metadata?: any }> {
  try {
    const userProfile = await prisma.emailProfile.findUnique({ where: { userId } });
    const userTimezone = (userProfile as any)?.timezone || 'America/New_York';

    const { getTodayEvents, getWeekEvents } = await import('../services/calendar.js');
    const [todayEvents, weekEvents] = await Promise.all([
      getTodayEvents(userId, userTimezone),
      getWeekEvents(userId, userTimezone),
    ]);

    const pending = await prisma.memo.findMany({
      where: { userId, source: 'pending-event', tags: { has: 'pending' } },
      take: 5,
    });
    const pendingInfo = pending.map(m => {
      try { const e = JSON.parse(m.content); return `[대기] ${e.title} (${e.date})`; } catch { return ''; }
    }).filter(Boolean).join('\n');

    const tzLabel = userTimezone.includes('New_York') ? 'EDT' : userTimezone.includes('Seoul') ? 'KST' : userTimezone;
    const todayStr = new Date().toLocaleDateString('ko-KR', { timeZone: userTimezone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    const formatEventTime = (isoStr: string) => {
      if (!isoStr.includes('T')) return '종일';
      return new Date(isoStr).toLocaleTimeString('ko-KR', { timeZone: userTimezone, hour: '2-digit', minute: '2-digit', hour12: false });
    };
    const formatEventDate = (isoStr: string) => {
      if (!isoStr.includes('T')) {
        return new Date(isoStr + 'T12:00:00').toLocaleDateString('ko-KR', { timeZone: userTimezone, month: 'numeric', day: 'numeric', weekday: 'short' }) + ' 종일';
      }
      return new Date(isoStr).toLocaleDateString('ko-KR', { timeZone: userTimezone, month: 'numeric', day: 'numeric', weekday: 'short' })
        + ' ' + new Date(isoStr).toLocaleTimeString('ko-KR', { timeZone: userTimezone, hour: '2-digit', minute: '2-digit', hour12: false });
    };
    const calContext = [
      `오늘: ${todayStr} (${tzLabel} 기준)`,
      todayEvents.length > 0
        ? `\n[오늘 일정 ${todayEvents.length}건]\n${todayEvents.map(e => {
            const time = formatEventTime(e.start);
            const endTime = e.end && e.end.includes('T') ? formatEventTime(e.end) : '';
            const timeRange = endTime ? `${time}~${endTime}` : time;
            return `- ${timeRange} | ${e.title}${e.location ? ` | 장소: ${e.location}` : ''}${e.description ? ` | 메모: ${e.description.slice(0, 100)}` : ''}`;
          }).join('\n')}`
        : '\n[오늘 일정 없음]',
      weekEvents.length > todayEvents.length
        ? `\n[이번주 일정 ${weekEvents.length}건]\n${weekEvents.slice(0, 15).map(e => {
            const date = formatEventDate(e.start);
            return `- ${date} | ${e.title}${e.location ? ` | ${e.location}` : ''}`;
          }).join('\n')}`
        : '',
      pendingInfo ? `\n[등록 대기 중 일정]\n${pendingInfo}` : '',
    ].filter(Boolean).join('\n');

    const calendarData = `## 캘린더 데이터 (${tzLabel} 기준, ${todayStr})

${calContext}

[형식 지시] 위 일정 데이터를 아래 형식으로 정리하여 사용자에게 답변하세요:
- 각 일정은 별도 불릿(-)으로, 빈 줄로 구분
- 시간은 24시간제, **볼드** 강조
- 이모지 사용 금지
- 오늘 일정 → 이번 주 예정 순서로 정리
- 일정이 없으면 "오늘 등록된 일정이 없습니다"`;

    return { response: calendarData, intent: 'calendar_tool', metadata: { todayCount: todayEvents.length, weekCount: weekEvents.length, pendingCount: pending.length } };
  } catch (err: any) {
    const msg = err?.message || '';
    console.error('[brain] calendar tool error:', msg);
    if (msg.includes('invalid_grant') || msg.includes('Token has been expired')) {
      return { response: '**Google Calendar 토큰이 만료되었습니다.**\n\n설정 → Gmail 재연동 버튼을 눌러 다시 인증해주세요.', intent: 'calendar_tool' };
    }
    if (msg.includes('Calendar API') || msg.includes('has not been used') || msg.includes('is disabled')) {
      return { response: '**Google Calendar API가 활성화되지 않았습니다.**\n\nGoogle Cloud Console → API 및 서비스 → Calendar API를 활성화해주세요.', intent: 'calendar_tool' };
    }
    if (msg.includes('Insufficient Permission') || msg.includes('insufficient authentication scopes') || msg.includes('Access Not Configured')) {
      return { response: '**Calendar 접근 권한이 없습니다.**\n\n설정 → Gmail 재연동 버튼을 눌러 Calendar 권한을 포함해서 다시 인증해주세요.', intent: 'calendar_tool' };
    }
    return { response: `일정 조회 실패: ${msg}`, intent: 'calendar_tool' };
  }
}

/**
 * 캘린더 이벤트 생성
 */
export async function handleCalendarCreate(
  app: FastifyInstance,
  request: FastifyRequest,
  message: string,
  userId: string,
  sendProgress: (step: string) => void,
): Promise<string> {
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const calModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const today = new Date().toISOString().split('T')[0];
    const extractPrompt = `오늘 날짜: ${today}
다음 메시지에서 일정 정보를 추출하세요. JSON으로만 응답:
{"title": "일정 제목", "date": "YYYY-MM-DD", "time": "HH:mm" 또는 null, "duration": 60, "location": "" 또는 null, "description": "" 또는 null}

메시지: "${message}"`;

    const extractResult = await calModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: extractPrompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 500 },
    });

    const extractText = extractResult.response.text().trim();
    const jsonMatch = extractText.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const eventData = JSON.parse(jsonMatch[0]);

      if (!eventData.title || !eventData.date) {
        return '일정 제목과 날짜를 알려주세요. 예: "내일 오후 2시에 팀 미팅 일정 등록해줘"';
      }

      sendProgress('캘린더에 등록하고 있습니다...');
      const calRes = await app.inject({
        method: 'POST',
        url: '/api/email/calendar-event',
        headers: {
          authorization: request.headers.authorization || '',
          'content-type': 'application/json',
          'x-dev-user-id': request.headers['x-dev-user-id'] as string || '',
        },
        body: JSON.stringify(eventData),
      });

      const calData = JSON.parse(calRes.body);

      const shadowChannelId = await getOrCreateShadow(userId, 'calendar');
      const resultMsg = calData.eventId
        ? `**일정이 Google Calendar에 등록되었습니다.**

- **제목:** ${eventData.title}
- **날짜:** ${eventData.date}${eventData.time ? ` ${eventData.time}` : ' (종일)'}
- **시간:** ${eventData.duration}분
${eventData.location ? `- **장소:** ${eventData.location}` : ''}

${calData.htmlLink ? `[Google Calendar에서 보기](${calData.htmlLink})` : ''}`
        : `일정 등록 실패: ${calData.error || '알 수 없는 오류'}`;

      saveShadowMessage(shadowChannelId, message, resultMsg).catch(() => {});
      return resultMsg;
    } else {
      return '일정 정보를 추출할 수 없습니다. 제목, 날짜, 시간을 포함해서 다시 말씀해주세요.';
    }
  } catch (err: any) {
    console.error('[brain] calendar_create error:', err.message);
    return `일정 등록 실패: ${err.message}`;
  }
}

/**
 * handleToolMessage의 papers case
 */
export async function handlePapersToolMessage(
  message: string,
  userId: string,
  labId: string | undefined,
): Promise<{ response: string; intent: string; metadata?: any }> {
  const publications = labId ? await prisma.publication.findMany({
    where: { labId },
    orderBy: { year: 'desc' },
  }) : [];
  const pubList = publications.length > 0
    ? publications.map(p => `- "${p.title}" (${p.journal || '?'}, ${p.year || '?'})${p.nickname ? ` [${p.nickname}]` : ''}${p.indexed ? ' [indexed]' : ''}`).join('\n')
    : '';

  let ragContext = '';
  try {
    const { generateEmbedding: genEmbed, searchPapers: searchP } = await import('../services/embedding-service.js');
    const { embedding } = await genEmbed(message);
    const ragResults = await searchP(prisma, embedding, 5, 0.5);
    if (ragResults.length > 0) {
      ragContext = '\n\n[관련 논문 내용 (벡터 검색)]\n' + ragResults.map(r =>
        `"${r.title}" — ${r.chunkText.slice(0, 300)}`
      ).join('\n\n');
    }
  } catch { /* 임베딩 서비스 미설정 시 무시 */ }

  const alerts = labId ? await prisma.paperAlertResult.findMany({
    where: { alert: { labId } },
    orderBy: [{ stars: 'desc' }, { createdAt: 'desc' }],
    take: 5,
  }) : [];
  const alertList = alerts.length > 0
    ? alerts.map(r => `[${r.stars === 3 ? '★★★' : r.stars === 2 ? '★★' : '★'}] ${r.title} (${r.journal})\n  ${r.aiSummary || ''}`).join('\n\n')
    : '';

  const context = [
    pubList ? `[연구실 핵심 논문 ${publications.length}편]\n${pubList}` : '',
    ragContext,
    alertList ? `\n[최신 논문 알림]\n${alertList}` : '',
  ].filter(Boolean).join('\n');

  if (!context) return { response: '등록된 논문이 없습니다. PDF를 업로드하거나 논문 알림을 설정해주세요.', intent: 'papers_tool' };

  const systemPrompt = `당신은 연구 논문 전문 비서입니다. 연구실의 핵심 논문과 최신 동향을 참고하여 답변하세요.

핵심 규칙:
1. 핵심 논문의 별칭(예: "LM 논문", "핵심 논문 1번")이 있으면 해당 논문을 참조하세요.
2. 벡터 검색 결과가 있으면 실제 논문 내용을 기반으로 구체적으로 답변하세요.
3. 논문 비교 시: novelty, 방법론, 결과, 한계점을 체계적으로 분석하세요.
4. 추측하지 마세요. 제공된 데이터에 없는 내용은 "해당 정보가 없습니다"라고 답하세요.

${context}`;

  if (env.ANTHROPIC_API_KEY) {
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const response = await anthropic.messages.create({
        model: 'claude-opus-4-20250514',
        max_tokens: 4096,
        temperature: 0.3,
        system: systemPrompt,
        messages: [{ role: 'user', content: message }],
      });
      const { trackAICost, COST_PER_CALL } = await import('../middleware/rate-limiter.js');
      trackAICost(userId, 'claude-sonnet', COST_PER_CALL['claude-sonnet']);
      const text = response.content.find(b => b.type === 'text');
      if (text && text.type === 'text') {
        return { response: text.text, intent: 'papers_tool', metadata: { publicationCount: publications.length, alertCount: alerts.length, model: 'opus' } };
      }
    } catch (err) {
      console.warn('Opus papers tool failed, fallback to Gemini:', err);
    }
  }

  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: message }] }],
    systemInstruction: { role: 'user', parts: [{ text: systemPrompt }] },
  });
  const { trackAICost: trackCost, COST_PER_CALL: costs } = await import('../middleware/rate-limiter.js');
  trackCost(userId, 'gemini-flash', costs['gemini-flash']);
  return { response: result.response.text(), intent: 'papers_tool', metadata: { publicationCount: publications.length, alertCount: alerts.length, model: 'gemini-fallback' } };
}

/**
 * handleToolMessage의 meeting case
 */
export async function handleMeetingToolMessage(
  message: string,
  userId: string,
): Promise<{ response: string; intent: string }> {
  const meetings = await prisma.meeting.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  if (meetings.length === 0) return { response: '기록된 미팅이 없습니다.', intent: 'meeting_tool' };

  const meetingList = meetings.map(m =>
    `[${m.createdAt.toISOString().split('T')[0]}] ${m.title}\n  ${m.summary?.slice(0, 200) || ''}`
  ).join('\n\n');

  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: message }] }],
    systemInstruction: { role: 'user', parts: [{ text: `당신은 미팅 기록 비서입니다. 최근 미팅 기록을 참고하여 답변하세요.\n\n최근 미팅:\n${meetingList}` }] },
  });
  return { response: result.response.text(), intent: 'meeting_tool' };
}
