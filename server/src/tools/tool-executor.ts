/**
 * Tool Executor — Claude tool-use 호출 결과를 실행하는 dispatcher
 *
 * 기존 핸들러(email-handler, calendar-handler, db-query-handler 등)를 재사용하면서
 * Claude의 tool_use 블록에 대한 결과를 반환합니다.
 */

import { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../config/prisma.js';
import { basePrismaClient } from '../config/prisma.js';
import { env } from '../config/env.js';
import { hybridSearch, rerank, isRagReady, embedAndStore } from '../services/rag-engine.js';
import { getGraphContextForQuery } from '../services/knowledge-graph.js';
import { calculateConfidence, getStaleWarning, trackAccess } from '../services/metamemory.js';
import { getOrCreateShadow, saveShadowMessage, compressForShadow } from './shadow-session.js';
import type { ToolName } from './tool-definitions.js';

interface ExecutorContext {
  app: FastifyInstance;
  request: FastifyRequest;
  userId: string;
  labId: string | null;
  sendProgress: (step: string) => void;
  stream: boolean;
  reply: any;
}

export async function executeToolCall(
  toolName: ToolName,
  input: Record<string, any>,
  ctx: ExecutorContext,
): Promise<string> {
  switch (toolName) {
    case 'search_lab_data':
      return executeSearchLabData(input, ctx);
    case 'search_knowledge':
      return executeSearchKnowledge(input, ctx);
    case 'get_email_briefing':
      return executeGetEmailBriefing(input, ctx);
    case 'read_email':
      return executeReadEmail(input, ctx);
    case 'draft_email_reply':
      return executeDraftEmailReply(input, ctx);
    case 'get_calendar':
      return executeGetCalendar(input, ctx);
    case 'create_calendar_event':
      return executeCreateCalendarEvent(input, ctx);
    case 'save_capture':
      return executeSaveCapture(input, ctx);
    case 'get_daily_brief':
      return executeGetDailyBrief(ctx);
    case 'get_weekly_review':
      return executeGetWeeklyReview(ctx);
    default:
      return `알 수 없는 도구: ${toolName}`;
  }
}

// ── search_lab_data ──────────────────────────────────

async function executeSearchLabData(
  input: Record<string, any>,
  ctx: ExecutorContext,
): Promise<string> {
  if (!ctx.labId) return '연구실이 설정되지 않았습니다.';

  ctx.sendProgress('연구실 정보를 검색하고 있습니다...');

  const query = input.query as string;
  const types: string[] = input.types || ['all'];
  const searchAll = types.includes('all');

  const [members, projects, publications, memos] = await Promise.all([
    (searchAll || types.includes('member'))
      ? prisma.labMember.findMany({ where: { labId: ctx.labId, active: true } })
      : Promise.resolve([]),
    (searchAll || types.includes('project'))
      ? prisma.project.findMany({ where: { labId: ctx.labId } })
      : Promise.resolve([]),
    (searchAll || types.includes('publication'))
      ? prisma.publication.findMany({ where: { labId: ctx.labId }, orderBy: { year: 'desc' } })
      : Promise.resolve([]),
    (searchAll || types.includes('memo'))
      ? prisma.memo.findMany({
          where: { OR: [{ userId: ctx.userId }, { labId: ctx.labId }] },
          orderBy: { createdAt: 'desc' },
          take: 50,
        })
      : Promise.resolve([]),
  ]);

  const meetings = (searchAll || types.includes('meeting'))
    ? await prisma.meeting.findMany({
        where: { userId: ctx.userId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      })
    : [];

  const queryLower = query.toLowerCase();
  const words = query.replace(/[?？！!을를이가에서의로는은해줘줘요알려정보보여뭐있어내]/g, ' ')
    .split(/\s+/).filter(w => w.length > 1);

  const fuzzy = (text: string, keyword: string) =>
    text.toLowerCase().includes(keyword.toLowerCase());

  const results: string[] = [];

  // 구성원 매칭
  if (members.length > 0) {
    const matched = members.filter(m =>
      words.some(w => fuzzy(m.name, w) || (m.email && fuzzy(m.email, w)))
    );
    if (matched.length > 0) {
      trackAccess('labMember', matched.map(m => m.id)).catch(() => {});
      results.push('[구성원]\n' + matched.map(m => {
        const conf = calculateConfidence(m);
        const warning = getStaleWarning(conf, m.createdAt, m.lastVerified);
        return `- **${m.name}** (${m.role})\n  이메일: ${m.email || '미등록'}\n  연락처: ${m.phone || '미등록'}${warning ? `\n  ${warning}` : ''}`;
      }).join('\n'));
    } else if (searchAll) {
      results.push(`[구성원] 총 ${members.length}명: ${members.map(m => `${m.name}(${m.role})`).join(', ')}`);
    }
  }

  // 과제 매칭
  if (projects.length > 0) {
    const matched = projects.filter(p =>
      words.some(w =>
        fuzzy(p.name, w) ||
        (p.funder && fuzzy(p.funder, w)) ||
        (p.pm && fuzzy(p.pm, w)) ||
        (p.number && fuzzy(p.number, w))
      )
    );
    if (matched.length > 0) {
      trackAccess('project', matched.map(p => p.id)).catch(() => {});
      results.push('[과제]\n' + matched.map(p => {
        const conf = calculateConfidence(p);
        const warning = getStaleWarning(conf, p.createdAt, p.lastVerified);
        return `- **${p.name}**\n  과제번호: ${p.number || '미등록'}\n  지원기관: ${p.funder || '미등록'}\n  기간: ${p.period || '미등록'}\n  PM: ${p.pm || '미등록'}\n  사사문구: ${p.acknowledgment || '미등록'}${warning ? `\n  ${warning}` : ''}`;
      }).join('\n'));
    } else if (searchAll) {
      results.push(`[과제] 총 ${projects.length}개: ${projects.map(p => `${p.name}(${p.funder || '?'})`).join(', ')}`);
    }
  }

  // 과제↔구성원 교차 연결 (multi-hop)
  const mentionedMembers = members.filter(m => words.some(w => fuzzy(m.name, w)));
  const mentionedProjects = projects.filter(p => words.some(w => fuzzy(p.name, w) || (p.funder && fuzzy(p.funder, w))));

  if (mentionedMembers.length > 0 && (queryLower.includes('과제') || queryLower.includes('프로젝트'))) {
    for (const member of mentionedMembers) {
      const relatedProjects = projects.filter(p =>
        p.pm?.includes(member.name) || p.pm?.includes(member.name.slice(1))
      );
      if (relatedProjects.length > 0) {
        results.push(`[${member.name}의 과제]\n` + relatedProjects.map(p =>
          `- **${p.name}** (${p.funder || '미등록'}) 기간: ${p.period || '미등록'}`
        ).join('\n'));
      }
    }
  }

  if (mentionedProjects.length > 0 && (queryLower.includes('담당') || queryLower.includes('학생') || queryLower.includes('이메일') || queryLower.includes('연락'))) {
    for (const proj of mentionedProjects) {
      const pmNames = (proj.pm || '').split(/[/,]/).map(s => s.trim()).filter(Boolean);
      const pmMembers = pmNames.flatMap(name =>
        members.filter(m => m.name.includes(name) || name.includes(m.name.slice(1)))
      );
      if (pmMembers.length > 0) {
        results.push(`[${proj.name} 담당자]\n` + pmMembers.map(m =>
          `- **${m.name}** (${m.role}) 이메일: ${m.email || '미등록'} 연락처: ${m.phone || '미등록'}`
        ).join('\n'));
      }
    }
  }

  // 사사 문구
  if (queryLower.includes('사사') || queryLower.includes('acknowledgment')) {
    const projsWithAck = projects.filter(p => p.acknowledgment);
    if (projsWithAck.length > 0) {
      results.push('[사사 문구]\n' + projsWithAck.map(p =>
        `- **${p.name}**: ${p.acknowledgment}`
      ).join('\n'));
    } else {
      const lab = await prisma.lab.findUnique({ where: { id: ctx.labId } });
      if (lab?.acknowledgment) {
        results.push(`[연구실 기본 사사 문구]\n"${lab.acknowledgment}"`);
      }
    }
  }

  // 논문 매칭
  if (publications.length > 0) {
    const matched = publications.filter(p =>
      words.some(w =>
        fuzzy(p.title, w) ||
        (p.journal && fuzzy(p.journal, w)) ||
        (p.authors && fuzzy(p.authors, w)) ||
        (p.nickname && fuzzy(p.nickname, w))
      )
    );
    if (matched.length > 0) {
      trackAccess('publication', matched.map(p => p.id)).catch(() => {});
      results.push('[논문]\n' + matched.map(p =>
        `- **${p.title}**${p.nickname ? ` [${p.nickname}]` : ''}\n  저널: ${p.journal || '미등록'} (${p.year || ''})\n  저자: ${p.authors || '미등록'}\n  DOI: ${p.doi || '미등록'}`
      ).join('\n'));
    } else if (searchAll && publications.length > 0) {
      results.push(`[논문] 총 ${publications.length}편 등록됨`);
    }
  }

  // 미팅 매칭
  if (meetings.length > 0) {
    const matched = meetings.filter((m: any) =>
      words.some(w => fuzzy(m.title, w) || (m.summary && fuzzy(m.summary, w)))
    );
    if (matched.length > 0) {
      results.push('[미팅 기록]\n' + matched.map((m: any) =>
        `- **${m.title}** (${m.createdAt.toISOString().split('T')[0]})\n  ${m.summary?.slice(0, 200) || ''}`
      ).join('\n'));
    }
  }

  // 메모 매칭
  if (memos.length > 0) {
    const matched = memos.filter(m =>
      words.some(w =>
        (m.title && fuzzy(m.title, w)) || fuzzy(m.content, w)
      )
    );
    if (matched.length > 0) {
      results.push('[메모]\n' + matched.slice(0, 5).map(m =>
        `- [${m.source || '메모'}] **${m.title || '(제목없음)'}**\n  ${m.content.substring(0, 300)}`
      ).join('\n'));
    }
  }

  if (results.length > 0) {
    return results.join('\n\n');
  }

  // Fallback: 단어별 전체 검색
  const fallbackResults: string[] = [];
  for (const word of words) {
    const matchedM = members.filter(m => m.name.includes(word));
    const matchedP = projects.filter(p => p.name.includes(word) || p.funder?.includes(word));
    if (matchedM.length) fallbackResults.push(`[구성원] ${matchedM.map(m => `${m.name}(${m.role})`).join(', ')}`);
    if (matchedP.length) fallbackResults.push(`[과제] ${matchedP.map(p => p.name).join(', ')}`);
  }

  return fallbackResults.length > 0
    ? fallbackResults.join('\n')
    : '해당 검색어와 일치하는 연구실 데이터가 없습니다.';
}

// ── search_knowledge ─────────────────────────────────

async function executeSearchKnowledge(
  input: Record<string, any>,
  ctx: ExecutorContext,
): Promise<string> {
  const query = input.query as string;
  ctx.sendProgress('지식 베이스를 검색하고 있습니다...');

  const results: string[] = [];

  // RAG 벡터 검색
  const useRag = env.OPENAI_API_KEY && await isRagReady(basePrismaClient);
  if (useRag) {
    try {
      const searchResults = await hybridSearch(basePrismaClient, query, ctx.userId, ctx.labId, { limit: 10 });
      if (searchResults.length > 0) {
        const ranked = await rerank(searchResults, query, { topK: 8 });
        if (ranked.length > 0) {
          results.push('[벡터 검색 결과]\n' + ranked.map(r => {
            const sourceLabel = { memo: '메모', member: '구성원', project: '과제', publication: '논문' }[r.sourceType] || r.sourceType;
            return `[${r.citation}] (${sourceLabel}) ${r.title || ''}\n${r.chunkText.substring(0, 500)}`;
          }).join('\n\n'));
        }
      }
    } catch (err) {
      console.warn('[tool] RAG search failed:', err);
    }
  }

  // 지식그래프 맥락
  if (ctx.labId) {
    try {
      const graphContext = await getGraphContextForQuery(query, ctx.userId, ctx.labId, { timeoutMs: 800 });
      if (graphContext.contextText) {
        results.push('[지식그래프 맥락]\n' + graphContext.contextText);
      }
    } catch (err) {
      console.warn('[tool] Graph context failed:', err);
    }
  }

  return results.length > 0
    ? results.join('\n\n')
    : '관련 지식 데이터를 찾지 못했습니다.';
}

// ── get_email_briefing ───────────────────────────────

async function executeGetEmailBriefing(
  input: Record<string, any>,
  ctx: ExecutorContext,
): Promise<string> {
  ctx.sendProgress('Gmail에서 이메일을 가져오고 있습니다...');

  const keepaliveId = ctx.stream
    ? setInterval(() => {
        try { ctx.reply.raw.write(`data: ${JSON.stringify({ type: 'progress', step: '이메일을 처리하고 있습니다...' })}\n\n`); } catch {}
      }, 12000)
    : null;

  try {
    const maxResults = input.max_results || 50;
    const briefingRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/email/narrative-briefing?maxResults=${maxResults}&includeBody=true`,
      headers: {
        authorization: ctx.request.headers.authorization || '',
        'content-type': 'application/json',
        'x-dev-user-id': ctx.request.headers['x-dev-user-id'] as string || '',
      },
    });

    if (briefingRes.statusCode === 200) {
      const briefingData = JSON.parse(briefingRes.body) as any;
      if (briefingData.success && briefingData.markdown) {
        const shadowChannelId = await getOrCreateShadow(ctx.userId, 'email');
        const shadowContent = await compressForShadow(briefingData.markdown, 'email');
        saveShadowMessage(shadowChannelId, 'email briefing', shadowContent).catch(() => {});
        return `[양식지정] 아래 브리핑을 그대로 전달하세요.\n\n${briefingData.markdown}`;
      }
    } else if (briefingRes.statusCode === 401) {
      return '**Gmail 토큰이 만료되었습니다.**\n\n설정 → Gmail 재연동 버튼을 눌러 다시 인증해주세요.';
    }

    // Fallback: 저장된 최근 브리핑
    const recentBriefing = await prisma.memo.findFirst({
      where: { userId: ctx.userId, source: 'email-briefing' },
      orderBy: { createdAt: 'desc' },
    });
    return recentBriefing?.content?.slice(0, 3000) || '이메일을 가져올 수 없습니다. Gmail 연동을 확인해주세요.';
  } finally {
    if (keepaliveId) clearInterval(keepaliveId);
  }
}

// ── read_email ───────────────────────────────────────

async function executeReadEmail(
  input: Record<string, any>,
  ctx: ExecutorContext,
): Promise<string> {
  ctx.sendProgress('이메일함을 확인하고 있습니다...');

  try {
    const searchTerms = input.search_query || '';
    const limit = input.limit || 5;
    const queryParam = searchTerms ? `&q=${encodeURIComponent(searchTerms)}` : '';

    const emailRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/email/messages/recent?limit=${limit}${queryParam}`,
      headers: {
        authorization: ctx.request.headers.authorization || '',
        'content-type': 'application/json',
        'x-dev-user-id': ctx.request.headers['x-dev-user-id'] as string || '',
      },
    });

    const emailData = JSON.parse(emailRes.body);
    if (!emailData.emails || emailData.emails.length === 0) {
      return searchTerms
        ? `"${searchTerms}" 관련 이메일을 찾을 수 없습니다.`
        : '최근 이메일이 없습니다.';
    }

    const emails = emailData.emails;

    if (emails.length === 1) {
      const e = emails[0];
      const result = formatEmailFull(e);
      const shadowChannelId = await getOrCreateShadow(ctx.userId, 'email');
      saveShadowMessage(shadowChannelId, `read: ${searchTerms}`, result.slice(0, 2000)).catch(() => {});
      return `[양식지정] 아래 이메일 내용을 양식 그대로 전달하세요.\n\n${result}`;
    }

    const listSection = emails.map((e: any, i: number) =>
      `${i + 1}. **${e.subject}** — ${(e.from || '').split('<')[0].trim()} (${e.date})`
    ).join('\n');

    const newest = emails[0];
    const fullSection = formatEmailFull(newest);

    const result = `"${searchTerms || '최근'}" 관련 이메일 **${emails.length}건** 발견:\n\n${listSection}\n\n---\n\n**가장 최신 이메일 전문:**\n\n${fullSection}\n\n---\n다른 이메일을 보려면 번호나 제목을 알려주세요.`;

    const shadowChannelId = await getOrCreateShadow(ctx.userId, 'email');
    saveShadowMessage(shadowChannelId, `read: ${searchTerms}`, result.slice(0, 2000)).catch(() => {});
    return `[양식지정] 아래 이메일 목록+전문을 양식 그대로 전달하세요.\n\n${result}`;
  } catch (err: any) {
    return `이메일 조회 실패: ${err.message}`;
  }
}

function formatEmailFull(e: any): string {
  return `**발신자:** ${e.from}
**수신자:** ${e.to}
**날짜:** ${e.date}
**제목:** ${e.subject}
${e.cc ? `**참조:** ${e.cc}` : ''}
**Message-ID:** ${e.messageId || e.id}
**Thread-ID:** ${e.threadId}

**본문:**
${e.body || '(본문 없음)'}`;
}

// ── draft_email_reply ────────────────────────────────

async function executeDraftEmailReply(
  input: Record<string, any>,
  ctx: ExecutorContext,
): Promise<string> {
  ctx.sendProgress('원본 이메일을 확인하고 있습니다...');

  try {
    const searchTerms = input.search_query || '';
    const queryParam = searchTerms ? `&q=${encodeURIComponent(searchTerms)}` : '';

    const emailRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/email/messages/recent?limit=1${queryParam}`,
      headers: {
        authorization: ctx.request.headers.authorization || '',
        'content-type': 'application/json',
        'x-dev-user-id': ctx.request.headers['x-dev-user-id'] as string || '',
      },
    });

    const emailData = JSON.parse(emailRes.body);
    if (!emailData.emails || emailData.emails.length === 0) {
      return '답장할 이메일을 찾을 수 없습니다.';
    }

    const email = emailData.emails[0];
    const instructions = input.instructions || '';

    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const draftModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    ctx.sendProgress('답장 초안을 작성하고 있습니다...');
    const draftPrompt = `다음 이메일에 대한 답장 초안을 작성해주세요.
사용자가 추가로 지시한 내용이 있으면 반영하세요.

원본 이메일:
- 발신자: ${email.from}
- 제목: ${email.subject}
- 본문: ${(email.body as string) || email.snippet}

사용자 지시: ${instructions}

답장 초안을 한국어로 작성하세요. 이모지를 사용하지 마세요. 정중하고 전문적인 어조로 작성하세요.
제목(Subject)과 본문(Body)을 구분하여 다음 JSON 형식으로만 응답하세요:
{"subject": "Re: 원본 제목", "body": "답장 본문"}`;

    const draftResult = await draftModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: draftPrompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2000 },
    });

    const draftText = draftResult.response.text().trim();
    const jsonMatch = draftText.match(/\{[\s\S]*\}/);

    if (!jsonMatch) return '답장 초안 생성에 실패했습니다.';

    const draft = JSON.parse(jsonMatch[0]);
    const senderEmail = (email.from as string).match(/<([^>]+)>/)?.[1] || email.from;

    const draftRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/email/draft',
      headers: {
        authorization: ctx.request.headers.authorization || '',
        'content-type': 'application/json',
        'x-dev-user-id': ctx.request.headers['x-dev-user-id'] as string || '',
      },
      body: JSON.stringify({
        to: senderEmail,
        subject: draft.subject || `Re: ${email.subject}`,
        body: draft.body,
        threadId: email.threadId,
        inReplyTo: email.messageId,
      }),
    });

    const draftData = JSON.parse(draftRes.body);

    const shadowChannelId = await getOrCreateShadow(ctx.userId, 'email');
    saveShadowMessage(shadowChannelId, `reply draft: ${email.subject}`, `답장 초안 작성: ${email.subject}`).catch(() => {});

    if (draftData.success) {
      return `**답장 초안이 Gmail 임시보관함에 저장되었습니다.**

**원본:** ${email.subject} (${email.from})
**제목:** ${draft.subject}

**초안 내용:**
${draft.body}

---
Gmail에서 확인하고 수정한 후 전송하세요.`;
    }
    return `답장 초안 생성은 완료했으나 Gmail 저장에 실패했습니다: ${draftData.error || '알 수 없는 오류'}\n\n**초안 내용:**\n${draft.body}`;
  } catch (err: any) {
    return `답장 초안 생성 실패: ${err.message}`;
  }
}

// ── get_calendar ─────────────────────────────────────

async function executeGetCalendar(
  input: Record<string, any>,
  ctx: ExecutorContext,
): Promise<string> {
  ctx.sendProgress('일정을 확인하고 있습니다...');

  try {
    const userProfile = await prisma.emailProfile.findUnique({ where: { userId: ctx.userId } });
    const userTimezone = (userProfile as any)?.timezone || 'America/New_York';

    const startDate = input.start_date || new Date().toLocaleDateString('en-CA', { timeZone: userTimezone });
    const endDateInput = input.end_date;
    const endDate = endDateInput || new Date(new Date(startDate).getTime() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA');

    // Google Calendar API 직접 호출 (임의 날짜 범위)
    const { getCalendarClient } = await import('../services/calendar.js');
    const calendar = await getCalendarClient(ctx.userId);
    if (!calendar) return 'Google Calendar가 연동되지 않았습니다. 설정에서 Gmail 연동을 해주세요.';

    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: `${startDate}T00:00:00`,
      timeMax: `${endDate}T23:59:59`,
      timeZone: userTimezone,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });

    const allEvents = (res.data.items || []).map((e: any) => ({
      title: e.summary || '(제목 없음)',
      start: e.start?.dateTime || e.start?.date || '',
      end: e.end?.dateTime || e.end?.date || '',
      location: e.location || undefined,
      description: e.description || undefined,
      allDay: !e.start?.dateTime,
    }));

    // 오늘 날짜 기준 분리
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: userTimezone });
    const todayEvents = allEvents.filter((e: any) => e.start.startsWith(todayStr));
    const otherEvents = allEvents.filter((e: any) => !e.start.startsWith(todayStr));

    const tzLabel = userTimezone.includes('New_York') ? 'EDT' : userTimezone.includes('Seoul') ? 'KST' : userTimezone;
    const todayLabel = new Date().toLocaleDateString('ko-KR', { timeZone: userTimezone, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
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

    const sections: string[] = [
      `오늘: ${todayLabel} (${tzLabel} 기준)`,
      `조회 범위: ${startDate} ~ ${endDate}`,
    ];

    if (todayEvents.length > 0) {
      sections.push(`\n[오늘 일정 ${todayEvents.length}건]\n${todayEvents.map((e: any) => {
        const time = formatEventTime(e.start);
        const endTime = e.end && e.end.includes('T') ? formatEventTime(e.end) : '';
        const timeRange = endTime ? `${time}~${endTime}` : time;
        return `- ${timeRange} | ${e.title}${e.location ? ` | 장소: ${e.location}` : ''}${e.description ? ` | 메모: ${e.description.slice(0, 100)}` : ''}`;
      }).join('\n')}`);
    } else {
      sections.push('\n[오늘 일정 없음]');
    }

    if (otherEvents.length > 0) {
      sections.push(`\n[기간 내 일정 ${otherEvents.length}건]\n${otherEvents.slice(0, 30).map((e: any) => {
        const date = formatEventDate(e.start);
        return `- ${date} | ${e.title}${e.location ? ` | ${e.location}` : ''}`;
      }).join('\n')}`);
    }

    const shadowChannelId = await getOrCreateShadow(ctx.userId, 'calendar');
    const rawResult = sections.join('\n');
    saveShadowMessage(shadowChannelId, 'calendar query', rawResult.slice(0, 1000)).catch(() => {});

    return `[양식지정] 아래 일정을 양식 그대로 전달하세요. 각 일정은 별도 불릿(-), 시간은 **볼드**, 빈 줄로 구분.\n\n${rawResult}`;
  } catch (err: any) {
    const msg = err?.message || '';
    console.error('[calendar] executeGetCalendar error:', msg);
    if (msg.includes('invalid_grant') || msg.includes('Token has been expired')) {
      return '**Google Calendar 토큰이 만료되었습니다.**\n\n설정 → Gmail 재연동 버튼을 눌러 다시 인증해주세요.';
    }
    if (msg.includes('Calendar API') || msg.includes('has not been used') || msg.includes('is disabled')) {
      return '**Google Calendar API가 활성화되지 않았습니다.**\n\nGoogle Cloud Console → API 및 서비스 → Calendar API를 활성화해주세요.';
    }
    if (msg.includes('Insufficient Permission') || msg.includes('insufficient authentication scopes') || msg.includes('Access Not Configured')) {
      return '**Calendar 접근 권한이 없습니다.**\n\n설정 → Gmail 재연동 버튼을 눌러 Calendar 권한을 포함해서 다시 인증해주세요.';
    }
    return `일정 조회 실패: ${msg}`;
  }
}

// ── create_calendar_event ────────────────────────────

async function executeCreateCalendarEvent(
  input: Record<string, any>,
  ctx: ExecutorContext,
): Promise<string> {
  ctx.sendProgress('캘린더에 등록하고 있습니다...');

  try {
    const eventData = {
      title: input.title,
      date: input.date,
      time: input.time || null,
      duration: input.duration || 60,
      location: input.location || null,
      description: input.description || null,
    };

    if (!eventData.title || !eventData.date) {
      return '일정 제목과 날짜를 알려주세요.';
    }

    const calRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/email/calendar-event',
      headers: {
        authorization: ctx.request.headers.authorization || '',
        'content-type': 'application/json',
        'x-dev-user-id': ctx.request.headers['x-dev-user-id'] as string || '',
      },
      body: JSON.stringify(eventData),
    });

    const calData = JSON.parse(calRes.body);

    const shadowChannelId = await getOrCreateShadow(ctx.userId, 'calendar');
    const resultMsg = calData.eventId
      ? `**일정이 Google Calendar에 등록되었습니다.**\n\n- **제목:** ${eventData.title}\n- **날짜:** ${eventData.date}${eventData.time ? ` ${eventData.time}` : ' (종일)'}\n- **시간:** ${eventData.duration}분${eventData.location ? `\n- **장소:** ${eventData.location}` : ''}\n\n${calData.htmlLink ? `[Google Calendar에서 보기](${calData.htmlLink})` : ''}`
      : `일정 등록 실패: ${calData.error || '알 수 없는 오류'}`;

    saveShadowMessage(shadowChannelId, `create: ${eventData.title}`, resultMsg).catch(() => {});
    return resultMsg;
  } catch (err: any) {
    return `일정 등록 실패: ${err.message}`;
  }
}

// ── save_capture ─────────────────────────────────────

async function executeSaveCapture(
  input: Record<string, any>,
  ctx: ExecutorContext,
): Promise<string> {
  if (!ctx.labId) return '연구실이 설정되지 않았습니다.';

  ctx.sendProgress('내용을 정리하고 있습니다...');

  const content = input.content as string;
  const type = input.type as 'task' | 'idea' | 'memo';

  try {
    const { classifyCapture, typeToCategory, urgencyToPriority } = await import('../services/capture-classifier.js');
    const classification = await classifyCapture(content);

    // Use the type provided by Claude if it differs from classifier
    const finalType = type || classification.type;

    const capture = await prisma.capture.create({
      data: {
        userId: ctx.userId,
        labId: ctx.labId,
        content,
        summary: classification.summary,
        category: typeToCategory(finalType),
        tags: classification.tags,
        priority: urgencyToPriority(classification.urgency),
        confidence: classification.confidence,
        actionDate: classification.dueDate ? new Date(classification.dueDate) : null,
        modelUsed: 'claude-tool-use',
        sourceType: 'text',
        status: 'active',
        reviewed: true,
      },
    });

    const label = finalType === 'task' ? '[할일]' : finalType === 'idea' ? '[아이디어]' : '[메모]';
    return `${label} 저장 완료: ${classification.summary}` +
      (classification.tags.length > 0 ? `\n태그: ${classification.tags.join(', ')}` : '') +
      (classification.dueDate ? `\n마감: ${classification.dueDate.split('T')[0]}` : '');
  } catch (err: any) {
    // Fallback: 분류기 실패 시 기본 저장
    await prisma.capture.create({
      data: {
        userId: ctx.userId,
        labId: ctx.labId,
        content,
        summary: content.length > 80 ? content.slice(0, 77) + '...' : content,
        category: type === 'task' ? 'TASK' : type === 'idea' ? 'IDEA' : 'MEMO',
        tags: [],
        priority: 'MEDIUM',
        confidence: 0.5,
        modelUsed: 'fallback',
        sourceType: 'text',
        status: 'active',
        reviewed: false,
      },
    });
    return `저장 완료 (기본 분류): ${content.slice(0, 60)}`;
  }
}

// ── get_daily_brief ──────────────────────────────────

async function executeGetDailyBrief(
  ctx: ExecutorContext,
): Promise<string> {
  ctx.sendProgress('오늘의 정보를 모으고 있습니다...');
  const { dailyBrief } = await import('../services/knowledge-graph.js');
  return await dailyBrief(ctx.userId);
}

// ── get_weekly_review ────────────────────────────────

async function executeGetWeeklyReview(
  ctx: ExecutorContext,
): Promise<string> {
  ctx.sendProgress('한 주의 활동을 정리하고 있습니다...');
  const { weeklyReview } = await import('../services/knowledge-graph.js');
  return await weeklyReview(ctx.userId);
}
