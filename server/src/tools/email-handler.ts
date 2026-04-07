/**
 * Email Handler — 이메일 브리핑/조회/답장/설정 변경
 */

import { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { trackAICost, COST_PER_CALL } from '../middleware/rate-limiter.js';
import { getOrCreateShadow, saveShadowMessage, compressForShadow } from './shadow-session.js';

/**
 * 이메일 후속 질문 — 기존 메모 데이터 기반
 */
export async function handleEmailQuery(
  message: string,
  userId: string,
): Promise<string> {
  const recentBriefing = await prisma.memo.findFirst({
    where: { userId, source: 'email-briefing' },
    orderBy: { createdAt: 'desc' },
  });
  const context = recentBriefing?.content?.slice(0, 3000) || '최근 이메일 브리핑 데이터 없음';

  const emailData = `## 최근 이메일 브리핑 데이터

${context}

[형식 지시] 위 이메일 데이터를 참고하여 사용자의 질문에 답변하세요. 이모지 금지. 불릿(-) 기반.`;
  return emailData;
}

/**
 * 이메일 브리핑 — Gmail에서 실시간 가져오기
 */
export async function handleEmailBriefing(
  app: FastifyInstance,
  request: FastifyRequest,
  message: string,
  userId: string,
  sendProgress: (step: string) => void,
  stream: boolean,
  reply: any,
): Promise<{ result: string | null; narrativeSuccess: boolean }> {
  const keepaliveId = stream
    ? setInterval(() => {
        try { reply.raw.write(`data: ${JSON.stringify({ type: 'progress', step: '이메일을 처리하고 있습니다...' })}\n\n`); } catch {}
      }, 12000)
    : null;

  let shadowResult: string | null = null;
  let narrativeSuccess = false;

  try {
    sendProgress('Gmail에서 이메일을 가져오고 있습니다...');
    const briefingRes = await app.inject({
      method: 'GET',
      url: '/api/email/narrative-briefing?maxResults=30&includeBody=true',
      headers: {
        authorization: request.headers.authorization || '',
        'content-type': 'application/json',
        'x-dev-user-id': request.headers['x-dev-user-id'] as string || '',
      },
    });
    if (briefingRes.statusCode === 200) {
      const briefingData = JSON.parse(briefingRes.body) as any;
      if (briefingData.success && briefingData.markdown) {
        sendProgress('이메일을 분류하고 브리핑을 작성하고 있습니다...');
        shadowResult = briefingData.markdown;
        narrativeSuccess = true;
        const shadowChannelId = await getOrCreateShadow(userId, 'email');
        const shadowContent = await compressForShadow(briefingData.markdown, 'email');
        saveShadowMessage(shadowChannelId, message, shadowContent).catch((err: any) => console.error('[background] saveShadowMessage:', err.message || err));
      }
    } else if (briefingRes.statusCode === 401) {
      console.error(`[brain] narrative-briefing: Gmail token expired (401)`);
      shadowResult = '**Gmail 토큰이 만료되었습니다.**\n\n설정 → Gmail 재연동 버튼을 눌러 다시 인증해주세요.\n(Google OAuth 토큰은 주기적으로 만료될 수 있습니다)';
      narrativeSuccess = true;
    } else {
      console.error(`[brain] narrative-briefing failed: status=${briefingRes.statusCode}, body=${briefingRes.body.slice(0, 500)}`);
    }
  } catch (err: any) {
    console.error('[brain] Email briefing internal call failed:', err.message || err);
  } finally {
    if (keepaliveId) clearInterval(keepaliveId);
  }

  return { result: shadowResult, narrativeSuccess };
}

/**
 * 이메일 전문 읽기
 */
export async function handleEmailRead(
  app: FastifyInstance,
  request: FastifyRequest,
  message: string,
  userId: string,
  entities: Record<string, string>,
  sendProgress: (step: string) => void,
): Promise<string> {
  try {
    // 검색어: entities에서 먼저, 없으면 사용자 메시지에서 직접 추출
    let searchTerms = entities.subject || entities.sender || entities.content || '';
    if (!searchTerms) {
      // 메시지에서 키워드 추출: "GitHub 이메일 자세히" → "GitHub"
      const cleaned = message
        .replace(/이메일|메일|email|자세히|보여줘|보여|원문|전문|전체|내용|읽어|확인|최근|가장/gi, '')
        .trim();
      if (cleaned.length > 0) {
        searchTerms = cleaned;
      }
    }
    const queryParam = searchTerms ? `&q=${encodeURIComponent(searchTerms)}` : '';

    // 먼저 5건을 가져와서 복수 결과 처리
    const emailRes = await app.inject({
      method: 'GET',
      url: `/api/email/messages/recent?limit=5${queryParam}`,
      headers: {
        authorization: request.headers.authorization || '',
        'content-type': 'application/json',
        'x-dev-user-id': request.headers['x-dev-user-id'] as string || '',
      },
    });

    const emailData = JSON.parse(emailRes.body);
    if (!emailData.emails || emailData.emails.length === 0) {
      return searchTerms
        ? `"${searchTerms}" 관련 이메일을 찾을 수 없습니다.`
        : '최근 이메일이 없습니다.';
    }

    sendProgress('이메일 내용을 가져오고 있습니다...');
    const emails = emailData.emails;

    if (emails.length === 1) {
      // 1건: 바로 전문 표시
      const e = emails[0];
      const result = formatEmailFull(e);
      const shadowChannelId = await getOrCreateShadow(userId, 'email');
      saveShadowMessage(shadowChannelId, message, result.slice(0, 2000)).catch(() => {});
      return result;
    }

    // 복수 결과: 목록 + 가장 최신 1건 전문
    // (최신순 정렬 — API가 최신순이면 [0]이 가장 최신)
    const listSection = emails.map((e: any, i: number) =>
      `${i + 1}. **${e.subject}** — ${(e.from || '').split('<')[0].trim()} (${e.date})`
    ).join('\n');

    const newest = emails[0];
    const fullSection = formatEmailFull(newest);

    const result = `"${searchTerms || '최근'}" 관련 이메일 **${emails.length}건** 발견:\n\n${listSection}\n\n---\n\n**가장 최신 이메일 전문:**\n\n${fullSection}\n\n---\n다른 이메일을 보려면 번호나 제목을 알려주세요.`;

    const shadowChannelId = await getOrCreateShadow(userId, 'email');
    saveShadowMessage(shadowChannelId, message, result.slice(0, 2000)).catch(() => {});
    return result;
  } catch (err: any) {
    console.error('[brain] email_read error:', err.message);
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
${e.body?.slice(0, 3000) || '(본문 없음)'}`;
}

/**
 * 이메일 답장 초안 작성
 */
export async function handleEmailReplyDraft(
  app: FastifyInstance,
  request: FastifyRequest,
  message: string,
  userId: string,
  entities: Record<string, string>,
  sendProgress: (step: string) => void,
): Promise<string> {
  try {
    const searchTerms = entities.subject || entities.sender || entities.content || '';
    const queryParam = searchTerms ? `&q=${encodeURIComponent(searchTerms)}` : '';

    const emailRes = await app.inject({
      method: 'GET',
      url: `/api/email/messages/recent?limit=1${queryParam}`,
      headers: {
        authorization: request.headers.authorization || '',
        'content-type': 'application/json',
        'x-dev-user-id': request.headers['x-dev-user-id'] as string || '',
      },
    });

    const emailData = JSON.parse(emailRes.body);
    if (!emailData.emails || emailData.emails.length === 0) {
      return '답장할 이메일을 찾을 수 없습니다.';
    }

    const email = emailData.emails[0];

    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const draftModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    sendProgress('답장 초안을 작성하고 있습니다...');
    const draftPrompt = `다음 이메일에 대한 답장 초안을 작성해주세요.
사용자가 추가로 지시한 내용이 있으면 반영하세요.

원본 이메일:
- 발신자: ${email.from}
- 제목: ${email.subject}
- 본문: ${(email.body as string)?.slice(0, 2000) || email.snippet}

사용자 지시: ${message}

답장 초안을 한국어로 작성하세요. 이모지를 사용하지 마세요. 정중하고 전문적인 어조로 작성하세요.
제목(Subject)과 본문(Body)을 구분하여 다음 JSON 형식으로만 응답하세요:
{"subject": "Re: 원본 제목", "body": "답장 본문"}`;

    const draftResult = await draftModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: draftPrompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2000 },
    });

    const draftText = draftResult.response.text().trim();
    const jsonMatch = draftText.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const draft = JSON.parse(jsonMatch[0]);
      const senderEmail = (email.from as string).match(/<([^>]+)>/)?.[1] || email.from;

      const draftRes = await app.inject({
        method: 'POST',
        url: '/api/email/draft',
        headers: {
          authorization: request.headers.authorization || '',
          'content-type': 'application/json',
          'x-dev-user-id': request.headers['x-dev-user-id'] as string || '',
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

      const shadowChannelId = await getOrCreateShadow(userId, 'email');
      saveShadowMessage(shadowChannelId, message, `답장 초안 작성: ${email.subject}`).catch(() => {});

      if (draftData.success) {
        return `**답장 초안이 Gmail 임시보관함에 저장되었습니다.**

**원본:** ${email.subject} (${email.from})
**제목:** ${draft.subject}

**초안 내용:**
${draft.body}

---
Gmail에서 확인하고 수정한 후 전송하세요.`;
      } else {
        return `답장 초안 생성은 완료했으나 Gmail 저장에 실패했습니다: ${draftData.error || '알 수 없는 오류'}

**초안 내용:**
${draft.body}`;
      }
    } else {
      return '답장 초안 생성에 실패했습니다. 다시 시도해주세요.';
    }
  } catch (err: any) {
    console.error('[brain] email_reply_draft error:', err.message);
    return `답장 초안 생성 실패: ${err.message}`;
  }
}

/**
 * 이메일 분류 설정 변경
 */
export async function handleEmailPreference(
  message: string,
  userId: string,
): Promise<string> {
  try {
    const user = await prisma.user.findFirst({ where: { id: userId } });
    const profile = user ? await prisma.emailProfile.findUnique({ where: { userId: user.id } }) : null;

    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const currentRules = profile ? JSON.stringify({
      keywords: profile.keywords,
      excludePatterns: profile.excludePatterns,
      importanceRules: profile.importanceRules,
    }) : '{}';

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: `사용자가 이메일 브리핑 설정을 변경하고 싶어합니다.

사용자 요청: "${message}"

현재 설정:
${currentRules}

다음 JSON으로 응답하세요:
{
  "action": "add_keyword" | "remove_keyword" | "add_exclude" | "remove_exclude" | "add_importance_rule" | "remove_importance_rule",
  "field": "keywords" | "excludePatterns" | "importanceRules",
  "value": (추가/제거할 값 — keyword는 문자열, excludePattern은 {field, pattern}, importanceRule은 {condition, action, description}),
  "explanation": "사용자에게 보여줄 설명 (한국어)"
}` }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 512, responseMimeType: 'application/json' },
    });

    const parsed = JSON.parse(result.response.text().trim());

    if (user && profile && parsed.field && parsed.value) {
      const current = (profile as any)[parsed.field] || [];
      const currentArr = Array.isArray(current) ? current : JSON.parse(current as string);
      let updated;

      if (parsed.action?.startsWith('add')) {
        updated = [...currentArr, parsed.value];
      } else if (parsed.action?.startsWith('remove')) {
        updated = currentArr.filter((item: any) =>
          typeof item === 'string' ? item !== parsed.value : JSON.stringify(item) !== JSON.stringify(parsed.value)
        );
      } else {
        updated = [...currentArr, parsed.value];
      }

      await prisma.emailProfile.update({
        where: { userId: user.id },
        data: { [parsed.field]: updated },
      });

      return parsed.explanation || `이메일 설정이 업데이트되었습니다: ${parsed.action}`;
    } else {
      return parsed.explanation || '이메일 설정 변경 요청을 처리했습니다.';
    }
  } catch (err: any) {
    console.error('[brain] email_preference error:', err.message);
    return '이메일 설정 변경 중 오류가 발생했습니다. 설정 페이지에서 직접 변경해주세요.';
  }
}

/**
 * handleToolMessage의 email case — 기존 메모 기반 이메일 데이터
 */
export async function handleEmailToolMessage(
  message: string,
  userId: string,
): Promise<{ response: string; intent: string }> {
  const recentBriefing = await prisma.memo.findFirst({
    where: { userId, source: 'email-briefing' },
    orderBy: { createdAt: 'desc' },
  });
  const context = recentBriefing?.content?.slice(0, 3000) || '최근 이메일 브리핑 데이터 없음';

  const emailData = `## 최근 이메일 브리핑 데이터

${context}

[형식 지시] 위 이메일 데이터를 참고하여 사용자의 질문에 답변하세요. 이모지 금지. 불릿(-) 기반.`;
  return { response: emailData, intent: 'email_tool' };
}
