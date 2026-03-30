/**
 * 논문 알림 Routes — RSS 크롤링 + 키워드 필터링 + AI 요약
 *
 * GET    /api/papers/alerts            → 논문 알림 설정 조회
 * POST   /api/papers/alerts            → 논문 알림 설정 생성/수정
 * POST   /api/papers/alerts/run        → 수동 크롤링 실행
 * GET    /api/papers/alerts/results    → 알림 결과 목록
 * PATCH  /api/papers/alerts/results/:id → 읽음 표시
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { env } from '../config/env.js';

// ── 주요 학술 저널 RSS 피드 목록 ────────────────────
const JOURNAL_RSS_FEEDS: Record<string, string> = {
  'Nature': 'https://www.nature.com/nature.rss',
  'Science': 'https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=science',
  'Nature Materials': 'https://www.nature.com/nmat.rss',
  'Nature Electronics': 'https://www.nature.com/natelectron.rss',
  'Nature Biomedical Engineering': 'https://www.nature.com/natbiomedeng.rss',
  'Advanced Materials': 'https://onlinelibrary.wiley.com/action/showFeed?jc=15214095&type=etoc&feed=rss',
  'ACS Nano': 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=ancac3',
  'Advanced Functional Materials': 'https://onlinelibrary.wiley.com/action/showFeed?jc=16163028&type=etoc&feed=rss',
  'Nano Letters': 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=nalefd',
  'Small': 'https://onlinelibrary.wiley.com/action/showFeed?jc=16136829&type=etoc&feed=rss',
  'Biosensors and Bioelectronics': 'https://rss.sciencedirect.com/publication/science/09565663',
  'Lab on a Chip': 'https://pubs.rsc.org/en/journals/journalissues/lc#702702',
  'Sensors and Actuators B': 'https://rss.sciencedirect.com/publication/science/09254005',
  'Chemical Reviews': 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=chreay',
};

// ── Schemas ─────────────────────────────────────────
const alertSettingSchema = z.object({
  keywords: z.array(z.string()).min(1),
  journals: z.array(z.string()).optional(), // 저널 이름 목록, 비면 전체
  schedule: z.enum(['daily', 'weekly']).default('weekly'),
});

// ── Simple RSS Parser (no external dependency) ───────
interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  authors?: string;
}

async function parseRssFeed(url: string): Promise<RssItem[]> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'LabFlow/1.0 (Research Paper Alert)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return [];

    const xml = await response.text();
    const items: RssItem[] = [];

    // Simple XML parsing for RSS items
    const itemMatches = xml.match(/<item[^>]*>[\s\S]*?<\/item>/gi) || [];
    for (const itemXml of itemMatches.slice(0, 50)) {
      const title = itemXml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim() || '';
      const link = itemXml.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]?.trim() || '';
      const description = itemXml.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim() || '';
      const pubDate = itemXml.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim() || '';
      const authors = itemXml.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim() || undefined;

      if (title) {
        items.push({ title, link, description, pubDate, authors });
      }
    }
    return items;
  } catch (err) {
    console.warn(`RSS fetch failed for ${url}:`, err);
    return [];
  }
}

// ── Keyword matching ─────────────────────────────────
function matchesKeywords(item: RssItem, keywords: string[]): { matches: boolean; score: number } {
  const text = `${item.title} ${item.description}`.toLowerCase();
  let matchCount = 0;

  for (const kw of keywords) {
    const kwLower = kw.toLowerCase();
    if (text.includes(kwLower)) matchCount++;
  }

  return {
    matches: matchCount > 0,
    score: keywords.length > 0 ? matchCount / keywords.length : 0,
  };
}

// ── AI Summary generation ────────────────────────────
async function generatePaperSummary(title: string, abstract: string): Promise<string> {
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const result = await model.generateContent(
      `다음 논문의 핵심 내용을 한국어 2~3문장으로 요약하세요:\n\n제목: ${title}\n초록: ${abstract.slice(0, 1000)}`
    );
    return result.response.text();
  } catch {
    return '';
  }
}

// ── Routes ───────────────────────────────────────────
export async function paperAlertRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);

  // ── 알림 설정 조회 ────────────────────────────────
  app.get('/api/papers/alerts', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (!lab) {
      return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });
    }
    const alerts = await prisma.paperAlert.findMany({
      where: { labId: lab.id },
    });
    return {
      alerts,
      availableJournals: Object.keys(JOURNAL_RSS_FEEDS),
    };
  });

  // ── 알림 설정 생성/수정 ────────────────────────────
  app.post('/api/papers/alerts', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (!lab) {
      return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });
    }
    const body = alertSettingSchema.parse(request.body);

    // 기존 알림이 있으면 업데이트, 없으면 생성
    const existing = await prisma.paperAlert.findFirst({ where: { labId: lab.id } });
    if (existing) {
      const updated = await prisma.paperAlert.update({
        where: { id: existing.id },
        data: {
          keywords: body.keywords,
          journals: body.journals || [],
          schedule: body.schedule,
        },
      });
      return updated;
    }

    const alert = await prisma.paperAlert.create({
      data: {
        labId: lab.id,
        keywords: body.keywords,
        journals: body.journals || [],
        schedule: body.schedule,
      },
    });
    return reply.code(201).send(alert);
  });

  // ── 수동 크롤링 실행 ──────────────────────────────
  app.post('/api/papers/alerts/run', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (!lab) {
      return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });
    }

    const alert = await prisma.paperAlert.findFirst({ where: { labId: lab.id, active: true } });
    if (!alert) {
      return reply.code(404).send({ error: '논문 알림 설정이 없습니다. 먼저 키워드를 설정해주세요.' });
    }

    // 크롤링할 저널 결정
    const journalNames = alert.journals.length > 0 ? alert.journals : Object.keys(JOURNAL_RSS_FEEDS);
    const rssUrls = journalNames
      .map(name => JOURNAL_RSS_FEEDS[name])
      .filter(Boolean);

    // RSS 크롤링
    const allItems: (RssItem & { journal: string })[] = [];
    for (const [name, url] of Object.entries(JOURNAL_RSS_FEEDS)) {
      if (!journalNames.includes(name)) continue;
      const items = await parseRssFeed(url);
      allItems.push(...items.map(item => ({ ...item, journal: name })));
    }

    // 키워드 필터링
    const matched = allItems
      .map(item => ({
        ...item,
        ...matchesKeywords(item, alert.keywords),
      }))
      .filter(item => item.matches)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30); // 최대 30개

    // 결과 저장 + AI 요약
    let savedCount = 0;
    for (const item of matched) {
      // 중복 체크 (같은 제목)
      const exists = await prisma.paperAlertResult.findFirst({
        where: { alertId: alert.id, title: item.title },
      });
      if (exists) continue;

      const summary = await generatePaperSummary(item.title, item.description);

      await prisma.paperAlertResult.create({
        data: {
          alertId: alert.id,
          title: item.title,
          authors: item.authors,
          journal: item.journal,
          pubDate: item.pubDate ? new Date(item.pubDate) : null,
          url: item.link,
          abstract: item.description.slice(0, 2000),
          aiSummary: summary,
          relevance: item.score,
        },
      });
      savedCount++;
    }

    // 마지막 실행 시간 업데이트
    await prisma.paperAlert.update({
      where: { id: alert.id },
      data: { lastRunAt: new Date() },
    });

    return {
      totalFetched: allItems.length,
      matched: matched.length,
      newSaved: savedCount,
      journals: journalNames,
    };
  });

  // ── 알림 결과 목록 ────────────────────────────────
  app.get('/api/papers/alerts/results', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (!lab) {
      return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });
    }

    const alert = await prisma.paperAlert.findFirst({ where: { labId: lab.id } });
    if (!alert) return { results: [], unreadCount: 0 };

    const { unread } = (request.query as any) || {};
    const results = await prisma.paperAlertResult.findMany({
      where: {
        alertId: alert.id,
        ...(unread === 'true' ? { read: false } : {}),
      },
      orderBy: [{ relevance: 'desc' }, { createdAt: 'desc' }],
      take: 50,
    });

    const unreadCount = await prisma.paperAlertResult.count({
      where: { alertId: alert.id, read: false },
    });

    return { results, unreadCount };
  });

  // ── 읽음 표시 ─────────────────────────────────────
  app.patch('/api/papers/alerts/results/:id', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    await prisma.paperAlertResult.update({
      where: { id: request.params.id },
      data: { read: true },
    });
    return { success: true };
  });
}
