/**
 * 논문 알림 Routes — RSS 크롤링 + 테마별 키워드 필터링 + 관련도 평가 + AI 요약
 *
 * 유저가 선택한 저널에서, 연구 테마 키워드 기반으로 관련 논문을 추리고,
 * 3단계 관련도 (★★★/★★/★)로 평가하여 한국어 요약과 함께 제공.
 *
 * GET    /api/papers/alerts            → 논문 알림 설정 + 사용 가능 저널 목록
 * POST   /api/papers/alerts            → 논문 알림 설정 생성/수정
 * POST   /api/papers/alerts/run        → 수동 크롤링 실행
 * GET    /api/papers/alerts/results    → 알림 결과 목록 (테마별 그룹)
 * PATCH  /api/papers/alerts/results/:id → 읽음 표시
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { env } from '../config/env.js';

// ── 사용 가능한 전체 저널 RSS 피드 ─────────────────
const ALL_JOURNAL_FEEDS: Record<string, string> = {
  'Nature': 'https://www.nature.com/nature.rss',
  'Science': 'https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=science',
  'Nature Materials': 'https://www.nature.com/nmat.rss',
  'Nature Nanotechnology': 'https://www.nature.com/nnano.rss',
  'Nature Biomedical Engineering': 'https://www.nature.com/natbiomedeng.rss',
  'Nature Electronics': 'https://www.nature.com/natelectron.rss',
  'Nature Sensors': 'https://www.nature.com/natsens.rss',
  'Nature Chemical Engineering': 'https://www.nature.com/natchemeng.rss',
  'Science Advances': 'https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=sciadv',
  'Science Robotics': 'https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=scirobotics',
  'Advanced Materials': 'https://onlinelibrary.wiley.com/action/showFeed?jc=15214095&type=etoc&feed=rss',
  'Advanced Functional Materials': 'https://onlinelibrary.wiley.com/action/showFeed?jc=16163028&type=etoc&feed=rss',
  'ACS Nano': 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=ancac3',
  'ACS Sensors': 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=ascefj',
  'Nano Letters': 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=nalefd',
  'Small': 'https://onlinelibrary.wiley.com/action/showFeed?jc=16136829&type=etoc&feed=rss',
  'Biosensors and Bioelectronics': 'https://rss.sciencedirect.com/publication/science/09565663',
  'Lab on a Chip': 'https://pubs.rsc.org/en/journals/journalissues/lc',
  'Sensors and Actuators B': 'https://rss.sciencedirect.com/publication/science/09254005',
  'Chemical Reviews': 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=chreay',
  'Angewandte Chemie': 'https://onlinelibrary.wiley.com/action/showFeed?jc=15213773&type=etoc&feed=rss',
  'JACS': 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=jacsat',
  'Nature Communications': 'https://www.nature.com/ncomms.rss',
  'PNAS': 'https://www.pnas.org/action/showFeed?type=etoc&feed=rss&jc=pnas',
};

// ── Schemas ─────────────────────────────────────────
const alertSettingSchema = z.object({
  keywords: z.array(z.string()).min(1),
  journals: z.array(z.string()).optional(),
  schedule: z.enum(['daily', 'weekly']).default('weekly'),
});

// ── RSS Parser ──────────────────────────────────────
interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  authors?: string;
  doi?: string;
}

async function parseRssFeed(url: string): Promise<RssItem[]> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'ResearchFlow/1.0 (Paper Monitoring)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return [];

    const xml = await response.text();
    const items: RssItem[] = [];

    const itemMatches = xml.match(/<item[^>]*>[\s\S]*?<\/item>/gi) || [];
    for (const itemXml of itemMatches.slice(0, 50)) {
      const title = itemXml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim() || '';
      const link = itemXml.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]?.trim() || '';
      const description = itemXml.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim() || '';
      const pubDate = itemXml.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim() || '';
      const authors = itemXml.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim() || undefined;
      // DOI extraction
      const doi = itemXml.match(/doi[.:]?\s*(10\.\d{4,}\/[^\s<"]+)/i)?.[1]
        || link.match(/doi\.org\/(10\.\d{4,}\/[^\s<"]+)/i)?.[1]
        || undefined;

      if (title) {
        items.push({ title, link, description, pubDate, authors, doi });
      }
    }
    return items;
  } catch (err) {
    console.warn(`RSS fetch failed for ${url}:`, err);
    return [];
  }
}

// ── 테마 기반 관련도 평가 (★★★/★★/★) ──────────────
interface ResearchTheme {
  name: string;
  keywords: string[];
}

function scoreByThemes(
  item: RssItem,
  themes: ResearchTheme[],
  flatKeywords: string[],
): { stars: number; matchedThemes: string[]; score: number } {
  const text = `${item.title} ${item.description}`.toLowerCase();

  // 테마별 매칭
  const matchedThemes: string[] = [];
  for (const theme of themes) {
    const themeMatched = theme.keywords.some(kw => text.includes(kw.toLowerCase()));
    if (themeMatched) matchedThemes.push(theme.name);
  }

  // flat 키워드 매칭 (테마 외 추가 키워드)
  let flatMatchCount = 0;
  for (const kw of flatKeywords) {
    if (text.includes(kw.toLowerCase())) flatMatchCount++;
  }

  // ★★★: 2개 이상 테마 매칭
  // ★★: 1개 테마 매칭
  // ★: 테마 매칭 없지만 flat 키워드 매칭
  let stars = 0;
  if (matchedThemes.length >= 2) stars = 3;
  else if (matchedThemes.length === 1) stars = 2;
  else if (flatMatchCount > 0) stars = 1;

  const totalKw = flatKeywords.length + themes.reduce((s, t) => s + t.keywords.length, 0);
  const totalMatch = matchedThemes.length + flatMatchCount;
  const score = totalKw > 0 ? Math.min(1, totalMatch / Math.max(totalKw * 0.3, 1)) : 0;

  return { stars, matchedThemes, score };
}

// ── CrossRef DOI enrichment ─────────────────────────
async function enrichWithCrossRef(doi: string): Promise<{ abstract?: string; authors?: string[] } | null> {
  try {
    const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      headers: { 'User-Agent': 'ResearchFlow/1.0 (mailto:contact@researchflow.app)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;

    const data = await res.json();
    const work = data.message;
    return {
      abstract: work.abstract?.replace(/<[^>]+>/g, '').trim(),
      authors: work.author?.map((a: any) => `${a.given || ''} ${a.family || ''}`.trim()),
    };
  } catch {
    return null;
  }
}

// ── AI Summary (Gemini) ─────────────────────────────
async function generatePaperSummary(
  title: string,
  abstract: string,
  matchedThemes: string[],
): Promise<string> {
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const themeContext = matchedThemes.length > 0
      ? `관련 연구 테마: ${matchedThemes.join(', ')}\n`
      : '';

    const result = await model.generateContent(
      `다음 논문의 핵심 기여와 방법론을 한국어 2~3문장으로 요약하세요. 구체적 수치나 방법이 있으면 포함하세요.

${themeContext}제목: ${title}
초록: ${abstract.slice(0, 1500)}

요약:`
    );
    return result.response.text().trim();
  } catch {
    return '';
  }
}

// ── Routes ──────────────────────────────────────────
export async function paperAlertRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);

  // ── 알림 설정 + 사용 가능 저널 목록 ──────────────
  app.get('/api/papers/alerts', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (!lab) {
      return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });
    }
    const alerts = await prisma.paperAlert.findMany({
      where: { labId: lab.id },
    });

    // 저널 목록을 카테고리별로 분류
    const journalCategories = {
      'Nature 계열': ['Nature', 'Nature Materials', 'Nature Nanotechnology', 'Nature Biomedical Engineering', 'Nature Electronics', 'Nature Sensors', 'Nature Chemical Engineering', 'Nature Communications'],
      'Science 계열': ['Science', 'Science Advances', 'Science Robotics'],
      'Wiley': ['Advanced Materials', 'Advanced Functional Materials', 'Small', 'Angewandte Chemie'],
      'ACS': ['ACS Nano', 'ACS Sensors', 'Nano Letters', 'Chemical Reviews', 'JACS'],
      '기타': ['Biosensors and Bioelectronics', 'Lab on a Chip', 'Sensors and Actuators B', 'PNAS'],
    };

    return {
      alerts,
      availableJournals: Object.keys(ALL_JOURNAL_FEEDS),
      journalCategories,
      researchThemes: (lab.researchThemes as ResearchTheme[] | null) || [],
    };
  });

  // ── 알림 설정 생성/수정 ───────────────────────────
  app.post('/api/papers/alerts', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (!lab) {
      return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });
    }
    const body = alertSettingSchema.parse(request.body);

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

  // ── 수동 크롤링 실행 (테마 기반 관련도 평가) ──────
  app.post('/api/papers/alerts/run', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (!lab) {
      return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });
    }

    const alert = await prisma.paperAlert.findFirst({ where: { labId: lab.id, active: true } });
    if (!alert) {
      return reply.code(404).send({ error: '논문 알림 설정이 없습니다. 먼저 키워드를 설정해주세요.' });
    }

    // 테마 정보 로드
    const themes = (lab.researchThemes as ResearchTheme[] | null) || [];
    const flatKeywords = alert.keywords as string[];

    // 크롤링할 저널 결정 (유저가 선택한 저널만)
    const journalNames = alert.journals.length > 0
      ? alert.journals
      : Object.keys(ALL_JOURNAL_FEEDS);

    // 병렬 RSS 크롤링
    const feedPromises = journalNames
      .filter(name => ALL_JOURNAL_FEEDS[name])
      .map(async name => {
        const items = await parseRssFeed(ALL_JOURNAL_FEEDS[name]);
        return items.map(item => ({ ...item, journal: name }));
      });

    const feedResults = await Promise.all(feedPromises);
    const allItems = feedResults.flat();

    // 테마 기반 관련도 평가 + 필터링
    const scored = allItems
      .map(item => {
        const { stars, matchedThemes, score } = scoreByThemes(item, themes, flatKeywords);
        return { ...item, stars, matchedThemes, score };
      })
      .filter(item => item.stars > 0)
      .sort((a, b) => b.stars - a.stars || b.score - a.score)
      .slice(0, 30);

    // 결과 저장 + CrossRef 보강 + AI 요약
    let savedCount = 0;
    for (const item of scored) {
      // 중복 체크
      const exists = await prisma.paperAlertResult.findFirst({
        where: { alertId: alert.id, title: item.title },
      });
      if (exists) continue;

      // CrossRef DOI enrichment (★★ 이상만, API 부하 줄이기)
      let enrichedAbstract = item.description;
      let enrichedAuthors = item.authors;
      if (item.doi && item.stars >= 2) {
        const crossRef = await enrichWithCrossRef(item.doi);
        if (crossRef?.abstract) enrichedAbstract = crossRef.abstract;
        if (crossRef?.authors) enrichedAuthors = crossRef.authors.join(', ');
      }

      // AI 요약 (★★ 이상만 — 비용 절약)
      const summary = item.stars >= 2
        ? await generatePaperSummary(item.title, enrichedAbstract, item.matchedThemes)
        : '';

      await prisma.paperAlertResult.create({
        data: {
          alertId: alert.id,
          title: item.title,
          authors: enrichedAuthors,
          journal: item.journal,
          pubDate: item.pubDate ? new Date(item.pubDate) : null,
          url: item.link,
          doi: item.doi,
          abstract: enrichedAbstract.slice(0, 3000),
          aiSummary: summary,
          relevance: item.score,
          stars: item.stars,
          themes: item.matchedThemes,
        },
      });
      savedCount++;
    }

    await prisma.paperAlert.update({
      where: { id: alert.id },
      data: { lastRunAt: new Date() },
    });

    return {
      totalFetched: allItems.length,
      matched: scored.length,
      newSaved: savedCount,
      journals: journalNames,
      breakdown: {
        threeStars: scored.filter(s => s.stars === 3).length,
        twoStars: scored.filter(s => s.stars === 2).length,
        oneStar: scored.filter(s => s.stars === 1).length,
      },
    };
  });

  // ── 알림 결과 목록 (테마별 그룹) ─────────────────
  app.get('/api/papers/alerts/results', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (!lab) {
      return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });
    }

    const alert = await prisma.paperAlert.findFirst({ where: { labId: lab.id } });
    if (!alert) return { results: [], unreadCount: 0, grouped: {} };

    const query = z.object({
      unread: z.enum(['true', 'false']).optional(),
      stars: z.coerce.number().min(1).max(3).optional(),
      theme: z.string().optional(),
    }).parse(request.query || {});

    const where: any = { alertId: alert.id };
    if (query.unread === 'true') where.read = false;
    if (query.stars) where.stars = { gte: query.stars };
    if (query.theme) where.themes = { has: query.theme };

    const results = await prisma.paperAlertResult.findMany({
      where,
      orderBy: [{ stars: 'desc' }, { relevance: 'desc' }, { createdAt: 'desc' }],
      take: 50,
    });

    const unreadCount = await prisma.paperAlertResult.count({
      where: { alertId: alert.id, read: false },
    });

    // 테마별 그룹핑
    const grouped: Record<string, typeof results> = {};
    for (const r of results) {
      const resultThemes = (r.themes as string[]) || [];
      if (resultThemes.length === 0) {
        if (!grouped['기타']) grouped['기타'] = [];
        grouped['기타'].push(r);
      } else {
        for (const t of resultThemes) {
          if (!grouped[t]) grouped[t] = [];
          grouped[t].push(r);
        }
      }
    }

    return { results, unreadCount, grouped };
  });

  // ── 읽음 표시 ────────────────────────────────────
  app.patch('/api/papers/alerts/results/:id', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    await prisma.paperAlertResult.update({
      where: { id: request.params.id },
      data: { read: true },
    });
    return { success: true };
  });
}
