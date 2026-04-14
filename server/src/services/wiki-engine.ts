/**
 * Wiki Engine — Karpathy 스타일 LLM 지식 위키 시스템
 *
 * 연구실 데이터(미팅, 대화, 논문 알림, 캡처)를 주기적으로 수집(ingest)하여
 * 마크다운 아티클 형태의 지식 위키를 자동 생성·업데이트합니다.
 *
 * 흐름:
 *   enqueueNewData() → WikiRawQueue 추가 (중복 방지)
 *   ingestAndCompile() → Claude Sonnet으로 위키 업데이트
 *   deepSynthesis() → Claude Opus로 전체 딥 리뷰
 */

import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { logError } from './error-logger.js';

// ── Anthropic 클라이언트 ──────────────────────────────────
function getAnthropicClient(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY가 설정되지 않았습니다');
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

// ── JSON 파싱 헬퍼 ────────────────────────────────────────
function extractJsonArray(text: string): any[] {
  // 코드 블록 안 JSON 추출
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = codeBlockMatch ? codeBlockMatch[1] : text;

  // 배열 구간 추출
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) return [];

  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    console.warn('[wiki-engine] JSON 파싱 실패, 빈 배열 반환');
    return [];
  }
}

// ── CUID 생성 (prisma cuid()와 동일한 패턴) ──────────────
function generateId(): string {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 9);
  return `c${timestamp}${randomPart}`;
}

// ── enqueueNewData ────────────────────────────────────────

/**
 * 지난 25시간 내 새로 생성된 데이터를 WikiRawQueue에 추가.
 * sourceId 체크로 중복 방지.
 *
 * @returns 새로 enqueue된 항목 수
 */
export async function enqueueNewData(labId: string, userId: string): Promise<number> {
  const since = new Date(Date.now() - 25 * 60 * 60 * 1000);
  let enqueued = 0;

  // ── Meeting ──────────────────────────────────────────────
  try {
    const meetings = await prisma.meeting.findMany({
      where: { userId, createdAt: { gte: since } },
      select: {
        id: true,
        title: true,
        summary: true,
        actionItems: true,
        createdAt: true,
      },
    });

    for (const m of meetings) {
      const existing = await prisma.wikiRawQueue.findFirst({
        where: { labId, sourceId: m.id },
      });
      if (existing) continue;

      const parts: string[] = [`[미팅] ${m.title}`, `날짜: ${m.createdAt.toISOString().split('T')[0]}`];
      if (m.summary) parts.push(`요약: ${m.summary.slice(0, 1000)}`);
      if (m.actionItems.length > 0) parts.push(`액션아이템:\n${m.actionItems.map(a => `- ${a}`).join('\n')}`);

      await prisma.wikiRawQueue.create({
        data: {
          id: generateId(),
          labId,
          sourceType: 'meeting',
          sourceId: m.id,
          content: parts.join('\n'),
        },
      });
      enqueued++;
    }
  } catch (err) {
    logError('background', '[wiki-engine] Meeting enqueue 실패', { labId })(err);
  }

  // ── Brain Message (role=assistant, 채널별 user+assistant 쌍) ──
  try {
    const channels = await prisma.channel.findMany({
      where: { userId, shadow: false, archived: false },
      select: { id: true, name: true },
    });

    for (const ch of channels) {
      // 채널별 최근 메시지 쌍 (user + 바로 뒤 assistant)
      const messages = await prisma.message.findMany({
        where: { channelId: ch.id, createdAt: { gte: since } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, role: true, content: true, createdAt: true },
      });

      if (messages.length === 0) continue;

      // user+assistant 쌍으로 묶기
      const pairs: Array<{ user: string; assistant: string; date: string }> = [];
      for (let i = 0; i < messages.length - 1; i++) {
        if (messages[i].role === 'user' && messages[i + 1].role === 'assistant') {
          pairs.push({
            user: messages[i].content.slice(0, 300),
            assistant: messages[i + 1].content.slice(0, 500),
            date: messages[i].createdAt.toISOString().split('T')[0],
          });
          i++; // 다음 메시지 건너뜀
        }
      }
      if (pairs.length === 0) continue;

      // 채널+날짜 기준 sourceId
      const today = new Date().toISOString().split('T')[0];
      const sourceId = `brain_${ch.id}_${today}`;

      const existing = await prisma.wikiRawQueue.findFirst({
        where: { labId, sourceId },
      });
      if (existing) continue;

      const content = `[대화 요약] 채널: ${ch.name || ch.id}\n날짜: ${today}\n\n` +
        pairs.map((p, i) => `Q${i + 1}: ${p.user}\nA${i + 1}: ${p.assistant}`).join('\n\n');

      await prisma.wikiRawQueue.create({
        data: {
          id: generateId(),
          labId,
          sourceType: 'brain_message',
          sourceId,
          content: content.slice(0, 3000),
        },
      });
      enqueued++;
    }
  } catch (err) {
    logError('background', '[wiki-engine] Brain Message enqueue 실패', { labId })(err);
  }

  // ── PaperAlertResult (stars >= 2) ────────────────────────
  try {
    const alerts = await prisma.paperAlert.findMany({
      where: { labId },
      select: { id: true },
    });
    const alertIds = alerts.map(a => a.id);

    if (alertIds.length > 0) {
      const papers = await prisma.paperAlertResult.findMany({
        where: {
          alertId: { in: alertIds },
          stars: { gte: 2 },
          createdAt: { gte: since },
        },
        select: {
          id: true,
          title: true,
          aiSummary: true,
          aiReason: true,
          journal: true,
          pubDate: true,
          createdAt: true,
        },
      });

      for (const p of papers) {
        const existing = await prisma.wikiRawQueue.findFirst({
          where: { labId, sourceId: p.id },
        });
        if (existing) continue;

        const parts: string[] = [
          `[논문 알림] ${p.title}`,
          `저널: ${p.journal || '미상'}`,
          `날짜: ${(p.pubDate || p.createdAt).toISOString().split('T')[0]}`,
        ];
        if (p.aiSummary) parts.push(`AI 요약: ${p.aiSummary.slice(0, 500)}`);
        if (p.aiReason) parts.push(`관련도 이유: ${p.aiReason.slice(0, 300)}`);

        await prisma.wikiRawQueue.create({
          data: {
            id: generateId(),
            labId,
            sourceType: 'paper_alert',
            sourceId: p.id,
            content: parts.join('\n'),
          },
        });
        enqueued++;
      }
    }
  } catch (err) {
    logError('background', '[wiki-engine] PaperAlertResult enqueue 실패', { labId })(err);
  }

  // ── Capture (IDEA or TASK만) ─────────────────────────────
  try {
    const captures = await prisma.capture.findMany({
      where: {
        labId,
        category: { in: ['IDEA', 'TASK'] },
        createdAt: { gte: since },
      },
      select: {
        id: true,
        content: true,
        category: true,
        tags: true,
        createdAt: true,
      },
    });

    for (const c of captures) {
      const existing = await prisma.wikiRawQueue.findFirst({
        where: { labId, sourceId: c.id },
      });
      if (existing) continue;

      const content = [
        `[캡처] ${c.category === 'IDEA' ? '아이디어' : '태스크'}`,
        `날짜: ${c.createdAt.toISOString().split('T')[0]}`,
        `내용: ${c.content.slice(0, 500)}`,
        c.tags.length > 0 ? `태그: ${c.tags.join(', ')}` : '',
      ].filter(Boolean).join('\n');

      await prisma.wikiRawQueue.create({
        data: {
          id: generateId(),
          labId,
          sourceType: 'capture',
          sourceId: c.id,
          content,
        },
      });
      enqueued++;
    }
  } catch (err) {
    logError('background', '[wiki-engine] Capture enqueue 실패', { labId })(err);
  }

  // ── Slack (future) ────────────────────────────────────────
  // TODO: Slack 연동 시 여기에 추가
  // const slackMessages = await prisma.slackMessage.findMany(...)
  // sourceType: 'slack', sourceId: slackMessage.id
  // ─────────────────────────────────────────────────────────

  console.log(`[wiki-engine] enqueueNewData 완료: ${enqueued}개 항목 추가 (labId: ${labId})`);
  return enqueued;
}

// ── ingestAndCompile ──────────────────────────────────────

/**
 * 미처리 큐 항목을 Claude Sonnet으로 처리하여 위키 업데이트.
 *
 * @returns { processed: number, updated: string[] }
 */
export async function ingestAndCompile(labId: string): Promise<{ processed: number; updated: string[] }> {
  // 1. 미처리 큐 항목 가져오기 (limit 50)
  const queue = await prisma.wikiRawQueue.findMany({
    where: { labId, processedAt: null },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  if (queue.length === 0) {
    console.log('[wiki-engine] ingestAndCompile: 처리할 큐 항목 없음');
    return { processed: 0, updated: [] };
  }

  // 2. 기존 위키 아티클 인덱스 (title + category + tags만)
  const existingArticles = await prisma.wikiArticle.findMany({
    where: { labId },
    select: { title: true, category: true, tags: true },
  });

  const anthropic = getAnthropicClient();

  // 3. Claude Sonnet 호출
  const queueText = queue.map((q, i) =>
    `[${i + 1}] (${q.sourceType})\n${q.content}`
  ).join('\n\n---\n\n');

  const existingText = existingArticles.length > 0
    ? existingArticles.map(a =>
        `- ${a.title} (${a.category}) [태그: ${a.tags.join(', ')}]`
      ).join('\n')
    : '(아직 아티클 없음)';

  const prompt = `당신은 BLISS Lab(연세대 바이오센서/유연전자소자 연구실) 지식 위키의 관리자입니다.

[새로 들어온 데이터]
${queueText}

[기존 위키 아티클 목록]
${existingText}

지시사항:
1. 새 데이터를 분석해서 관련 있는 기존 아티클을 업데이트하거나, 없으면 새 아티클 생성
2. 각 아티클은 [[다른아티클제목]] 형식으로 크로스레퍼런스 포함
3. 카테고리: person(연구자), project(과제), research_trend(연구동향), meeting_thread(미팅주제), experiment(실험), collaboration(협업), general
4. 마크다운 형식, 간결하고 정보 밀도 높게
5. 날짜 정보는 반드시 포함
6. 이모지 사용 금지

JSON 출력 형식 (배열만 출력, 다른 텍스트 없이):
[
  {
    "title": "아티클 제목",
    "category": "카테고리",
    "content": "마크다운 내용",
    "tags": ["태그1", "태그2"],
    "sources": [{"type": "meeting", "id": "...", "date": "..."}]
  }
]`;

  let articles: any[] = [];
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    articles = extractJsonArray(text);
  } catch (err) {
    logError('background', '[wiki-engine] Sonnet ingest 호출 실패', { labId })(err);
    return { processed: 0, updated: [] };
  }

  // 4. 파싱된 아티클 upsert
  const updatedTitles: string[] = [];
  const now = new Date();

  for (const article of articles) {
    if (!article.title || !article.category || !article.content) continue;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO wiki_articles (id, lab_id, title, category, content, tags, sources, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 1, $8, $8)
         ON CONFLICT (lab_id, title)
         DO UPDATE SET
           category   = EXCLUDED.category,
           content    = EXCLUDED.content,
           tags       = EXCLUDED.tags,
           sources    = EXCLUDED.sources,
           version    = wiki_articles.version + 1,
           updated_at = EXCLUDED.updated_at`,
        generateId(),
        labId,
        article.title,
        article.category,
        article.content,
        article.tags || [],
        JSON.stringify(article.sources || []),
        now,
      );
      updatedTitles.push(article.title);
    } catch (err) {
      logError('background', `[wiki-engine] 아티클 upsert 실패: ${article.title}`, { labId })(err);
    }
  }

  // 5. 처리된 큐 항목 processedAt 업데이트
  await prisma.wikiRawQueue.updateMany({
    where: { id: { in: queue.map(q => q.id) } },
    data: { processedAt: now },
  });

  console.log(`[wiki-engine] ingestAndCompile 완료: ${queue.length}개 처리, ${updatedTitles.length}개 아티클 업데이트`);
  return { processed: queue.length, updated: updatedTitles };
}

// ── deepSynthesis ─────────────────────────────────────────

/**
 * Claude Opus로 전체 위키 딥 리뷰.
 * 아티클 간 연결고리 발견, 패턴 분석, 모순 수정, 인사이트 아티클 생성.
 */
export async function deepSynthesis(labId: string): Promise<void> {
  // 1. 전체 위키 아티클 가져오기 (최대 30개, content 포함)
  const articles = await prisma.wikiArticle.findMany({
    where: { labId },
    orderBy: { updatedAt: 'desc' },
    take: 30,
  });

  if (articles.length === 0) {
    console.log('[wiki-engine] deepSynthesis: 아티클 없음, 건너뜀');
    return;
  }

  const anthropic = getAnthropicClient();

  // 2. Claude Opus 호출
  const articlesText = articles.map(a =>
    `### ${a.title} (${a.category}) [v${a.version}]\n${a.content}`
  ).join('\n\n---\n\n');

  const prompt = `당신은 BLISS Lab 연구실의 지식 위키 전문 편집자입니다.

[전체 위키 아티클]
${articlesText}

다음을 수행하세요:
1. 아티클 간 놓친 연결고리 발견 및 [[크로스레퍼런스]] 추가
2. 여러 데이터에서 패턴 발견 (예: 특정 연구 방향의 발전 흐름)
3. 모순되거나 오래된 정보 수정
4. 중요한 인사이트를 새 "synthesis" 아티클로 생성 (category: general, title: "인사이트: ...")
5. 각 아티클의 version +1 (실제 버전은 DB에서 +1됨)

이모지 사용 금지.
업데이트할 아티클만 JSON 배열로 반환 (변경 없는 것은 제외, 다른 텍스트 없이):
[{"title": "...", "category": "...", "content": "...", "tags": [...], "sources": [...]}]`;

  let updatedArticles: any[] = [];
  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    updatedArticles = extractJsonArray(text);
  } catch (err) {
    logError('background', '[wiki-engine] Opus deepSynthesis 호출 실패', { labId })(err);
    return;
  }

  // 3. 업데이트된 아티클 upsert
  const now = new Date();
  let updateCount = 0;

  for (const article of updatedArticles) {
    if (!article.title || !article.category || !article.content) continue;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO wiki_articles (id, lab_id, title, category, content, tags, sources, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 1, $8, $8)
         ON CONFLICT (lab_id, title)
         DO UPDATE SET
           category   = EXCLUDED.category,
           content    = EXCLUDED.content,
           tags       = EXCLUDED.tags,
           sources    = EXCLUDED.sources,
           version    = wiki_articles.version + 1,
           updated_at = EXCLUDED.updated_at`,
        generateId(),
        labId,
        article.title,
        article.category,
        article.content,
        article.tags || [],
        JSON.stringify(article.sources || []),
        now,
      );
      updateCount++;
    } catch (err) {
      logError('background', `[wiki-engine] deepSynthesis upsert 실패: ${article.title}`, { labId })(err);
    }
  }

  console.log(`[wiki-engine] deepSynthesis 완료: ${updateCount}개 아티클 업데이트`);
}

// ── searchWiki ────────────────────────────────────────────

/**
 * 위키 검색 — 제목/태그/카테고리/내용에서 키워드 매칭.
 * 관련도 순 정렬: 제목 매칭 > 태그 매칭 > 내용 매칭
 */
export async function searchWiki(labId: string, query: string, limit = 5): Promise<any[]> {
  const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 1);
  if (keywords.length === 0) return [];

  // 모든 아티클 가져오기 (대용량 위키가 아닌 연구실 특성상 전체 로드 후 메모리 필터링)
  const articles = await prisma.wikiArticle.findMany({
    where: { labId },
    select: {
      id: true,
      title: true,
      category: true,
      content: true,
      tags: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: 'desc' },
  });

  // 관련도 점수 계산
  const scored = articles.map(a => {
    const titleLow = a.title.toLowerCase();
    const tagsLow = a.tags.map(t => t.toLowerCase());
    const contentLow = a.content.toLowerCase();
    let score = 0;

    for (const kw of keywords) {
      if (titleLow.includes(kw)) score += 10;
      if (tagsLow.some(t => t.includes(kw))) score += 5;
      if (contentLow.includes(kw)) score += 1;
    }

    return {
      ...a,
      content: a.content.slice(0, 500), // truncate
      score,
    };
  });

  return scored
    .filter(a => a.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score: _s, ...rest }) => rest);
}

// ── getWikiStatus ─────────────────────────────────────────

/**
 * 현재 위키 상태 조회.
 */
export async function getWikiStatus(labId: string): Promise<object> {
  const [articles, pendingCount, lastProcessed] = await Promise.all([
    prisma.wikiArticle.findMany({
      where: { labId },
      select: { category: true, updatedAt: true },
    }),
    prisma.wikiRawQueue.count({
      where: { labId, processedAt: null },
    }),
    prisma.wikiRawQueue.findFirst({
      where: { labId, processedAt: { not: null } },
      orderBy: { processedAt: 'desc' },
      select: { processedAt: true },
    }),
  ]);

  // 카테고리별 분포
  const categoryDist: Record<string, number> = {};
  for (const a of articles) {
    categoryDist[a.category] = (categoryDist[a.category] || 0) + 1;
  }

  return {
    totalArticles: articles.length,
    categoryDistribution: categoryDist,
    pendingQueueItems: pendingCount,
    lastIngestAt: lastProcessed?.processedAt ?? null,
  };
}
