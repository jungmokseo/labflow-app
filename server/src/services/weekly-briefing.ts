/**
 * 주간 브리핑 생성
 *
 * 입력:
 *   - 지난 N일간 wiki_article_history (create/update 기록)
 *   - 지난 N일간 신규 meeting_thread / insight article
 *
 * 출력:
 *   - markdown 브리핑
 *   - `insight` 카테고리 article로 DB 저장 (제목: "주간 브리핑 @YYYY-MM-DD")
 */
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { logError } from './error-logger.js';
import { logApiCost } from './cost-logger.js';

const BRIEFING_DAYS = 7;

function generateId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 9);
  return `c${t}${r}`;
}

function trimContent(s: string | null, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '...' : s;
}

export interface WeeklyBriefingResult {
  briefingMarkdown: string;
  savedArticleTitle: string;
  stats: {
    historyCount: number;
    newMeetings: number;
    newInsights: number;
    createdArticles: number;
    updatedArticles: number;
  };
}

export async function generateWeeklyBriefing(
  labId: string,
  userId: string,
  days: number = BRIEFING_DAYS,
): Promise<WeeklyBriefingResult> {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY 미설정');

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const periodLabel = `${since.toISOString().slice(0, 10)} ~ ${new Date().toISOString().slice(0, 10)}`;

  // 1. history 조회 (create + update 모두)
  const history = await prisma.wikiArticleHistory.findMany({
    where: { labId, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  // 2. 신규 article (category별)
  const newMeetings = await prisma.wikiArticle.findMany({
    where: { labId, category: 'meeting_thread', createdAt: { gte: since } },
    select: { title: true, content: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  const newInsights = await prisma.wikiArticle.findMany({
    where: { labId, category: 'insight', createdAt: { gte: since } },
    select: { title: true, content: true },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });

  const createdCount = history.filter(h => h.changeType === 'create').length;
  const updatedCount = history.filter(h => h.changeType === 'update').length;

  // 3. 프롬프트 구성
  const historyText = history.slice(0, 40).map(h =>
    `- [${h.changeType}] "${h.title}" (${h.category}) v${h.version}\n  ${trimContent(h.contentAfter, 300)}`
  ).join('\n');

  const meetingsText = newMeetings.map(m =>
    `### ${m.title}\n${trimContent(m.content, 400)}`
  ).join('\n\n');

  const insightsText = newInsights.map(i =>
    `### ${i.title}\n${trimContent(i.content, 300)}`
  ).join('\n\n');

  const systemPrompt = `당신은 BLISS Lab 지식 위키의 주간 편집자입니다.
지난 ${days}일간의 위키 변경 이력과 신규 미팅/인사이트를 분석해서 연구실 교수가 월요일 아침에 읽을 브리핑을 작성하세요.

## 브리핑 구성 (정확히 이 순서로)
1. **핵심 요약** (3~5 bullet, 이번 주 가장 중요한 변화)
2. **프로젝트 진척** — 상태 변경된 프로젝트 언급, [[제목]] 크로스레퍼런스
3. **신규 미팅/결정사항** — 중요 결정 bullet
4. **외부 연구동향 반영** — paper_alert 기반 새 연구동향 article이 있으면
5. **다음 주 관찰 포인트** — 곧 마감/리뷰/투고 예정 사항

## 규칙
- 간결하게 (800~1500자 이내)
- 구체적 수치, 저널명, 날짜 유지
- 확인 못한 내용은 서술하지 말 것
- 이모지는 섹션 제목에만 사용
- 마크다운 헤더 레벨 2 사용 (##)`;

  const userMessage = `## 기간
${periodLabel}

## 통계
- wiki 변경: ${history.length}건 (create ${createdCount} / update ${updatedCount})
- 신규 미팅: ${newMeetings.length}건
- 신규 인사이트: ${newInsights.length}건

## 변경 이력 (최근 40건)
${historyText || '(없음)'}

## 신규 미팅 상세
${meetingsText || '(없음)'}

## 신규 인사이트
${insightsText || '(없음)'}`;

  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  let briefingMarkdown = '';
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }],
    });
    const usage = response.usage as any;
    const inputTokens = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    logApiCost(userId, 'claude-sonnet-4-6', inputTokens, usage.output_tokens ?? 0, 'weekly_briefing').catch(() => {});
    briefingMarkdown = response.content[0].type === 'text' ? response.content[0].text : '';
  } catch (err) {
    logError('background', '[weekly-briefing] Sonnet 호출 실패', { labId })(err);
    throw err;
  }

  // 4. 브리핑 aritcle로 저장
  const endDate = new Date().toISOString().slice(0, 10);
  const title = `📬 주간 브리핑 @${endDate}`;
  const fullContent = `**기간**: ${periodLabel}\n**생성일**: ${endDate}\n\n${briefingMarkdown}\n\n---\n\n_통계: wiki ${history.length}건 변경 / 신규 미팅 ${newMeetings.length} / 신규 인사이트 ${newInsights.length}_`;

  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO wiki_articles (id, lab_id, title, category, content, tags, sources, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 1, NOW(), NOW())
       ON CONFLICT (lab_id, title)
       DO UPDATE SET
         content    = EXCLUDED.content,
         updated_at = EXCLUDED.updated_at,
         version    = wiki_articles.version + 1`,
      generateId(),
      labId,
      title,
      'insight',
      fullContent,
      ['weekly-briefing', 'auto-generated', endDate],
      JSON.stringify([{ type: 'aggregation', id: `weekly-${endDate}`, date: endDate }]),
    );
  } catch (err) {
    logError('background', '[weekly-briefing] article 저장 실패', { labId })(err);
  }

  return {
    briefingMarkdown: fullContent,
    savedArticleTitle: title,
    stats: {
      historyCount: history.length,
      newMeetings: newMeetings.length,
      newInsights: newInsights.length,
      createdArticles: createdCount,
      updatedArticles: updatedCount,
    },
  };
}

/**
 * 주간 브리핑 자동 스케줄러
 *
 * 조건: 매주 월요일 오전 9시(KST, UTC+9) 이후 첫 체크에서 실행
 * 중복 방지: 오늘 날짜로 이미 생성된 브리핑 article이 있으면 skip
 * 대상: 전체 Lab (owner의 userId 사용)
 *
 * 서버 재시작 시에도 안전 (DB에 오늘자 브리핑 존재 여부로 판단).
 */
export function startWeeklyBriefingCron(): void {
  const CHECK_INTERVAL_MS = 60_000; // 1분마다 체크 (Date 비교만이라 가벼움)

  setInterval(async () => {
    try {
      const now = new Date();
      // KST 시각 계산 (서버가 UTC든 KST든 무관)
      const kstMs = now.getTime() + 9 * 60 * 60 * 1000;
      const kst = new Date(kstMs);
      const dow = kst.getUTCDay();   // 0=일, 1=월
      const hour = kst.getUTCHours();
      const minute = kst.getUTCMinutes();

      // 월요일 09:00~09:05 사이만 실행 시도
      if (dow !== 1 || hour !== 9 || minute > 5) return;

      const labs = await prisma.lab.findMany({
        select: { id: true, ownerId: true, name: true },
      });

      for (const lab of labs) {
        const today = kst.toISOString().slice(0, 10);
        const todayTitle = `📬 주간 브리핑 @${today}`;

        const existing = await prisma.wikiArticle.findFirst({
          where: { labId: lab.id, title: todayTitle },
          select: { id: true },
        });
        if (existing) continue; // 오늘자 브리핑 이미 생성됨

        try {
          const result = await generateWeeklyBriefing(lab.id, lab.ownerId, 7);
          console.log(`[weekly-briefing-cron] ✓ ${lab.name} — "${result.savedArticleTitle}" (${result.stats.historyCount}건 변경)`);
        } catch (err: any) {
          console.error(`[weekly-briefing-cron] ${lab.name} 실패:`, err?.message ?? err);
          logError('background', `[weekly-briefing-cron] lab ${lab.id} 실패`, { labId: lab.id })(err);
        }
      }
    } catch (err: any) {
      console.error('[weekly-briefing-cron] 체크 루프 에러:', err?.message ?? err);
    }
  }, CHECK_INTERVAL_MS);

  console.log('[weekly-briefing-cron] 시작됨 — 매주 월요일 09:00 KST 자동 실행');
}
