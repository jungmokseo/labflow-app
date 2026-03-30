/**
 * 논문 알림 Routes — 분야별 저널 추천 + 커스텀 RSS + 테마 관련도 평가 + AI 요약
 *
 * GET    /api/papers/alerts              → 알림 설정 + 저널 목록
 * POST   /api/papers/alerts              → 알림 설정 생성/수정
 * POST   /api/papers/alerts/run          → 수동 크롤링 실행
 * GET    /api/papers/alerts/results      → 결과 목록 (테마별 그룹)
 * PATCH  /api/papers/alerts/results/:id  → 읽음 표시
 * GET    /api/papers/journals/fields     → 분야별 추천 저널 패키지
 * GET    /api/papers/journals/search     → 키워드로 저널 검색 (OpenAlex)
 * POST   /api/papers/journals/custom     → 커스텀 RSS 피드 추가
 * POST   /api/papers/journals/validate   → RSS URL 유효성 검증
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { env } from '../config/env.js';

// ── Built-in 저널 RSS (분야별 분류) ────────────────
interface JournalInfo {
  name: string;
  rssUrl: string;
  publisher: string;
  fields: string[];  // 해당 저널이 관련된 분야
}

const BUILT_IN_JOURNALS: JournalInfo[] = [
  // === 종합 (모든 분야) ===
  { name: 'Nature', rssUrl: 'https://www.nature.com/nature.rss', publisher: 'Nature', fields: ['종합'] },
  { name: 'Science', rssUrl: 'https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=science', publisher: 'AAAS', fields: ['종합'] },
  { name: 'Nature Communications', rssUrl: 'https://www.nature.com/ncomms.rss', publisher: 'Nature', fields: ['종합'] },
  { name: 'PNAS', rssUrl: 'https://www.pnas.org/action/showFeed?type=etoc&feed=rss&jc=pnas', publisher: 'NAS', fields: ['종합'] },
  { name: 'Science Advances', rssUrl: 'https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=sciadv', publisher: 'AAAS', fields: ['종합'] },

  // === 재료/나노 ===
  { name: 'Nature Materials', rssUrl: 'https://www.nature.com/nmat.rss', publisher: 'Nature', fields: ['재료공학', '나노기술'] },
  { name: 'Nature Nanotechnology', rssUrl: 'https://www.nature.com/nnano.rss', publisher: 'Nature', fields: ['나노기술'] },
  { name: 'Advanced Materials', rssUrl: 'https://onlinelibrary.wiley.com/action/showFeed?jc=15214095&type=etoc&feed=rss', publisher: 'Wiley', fields: ['재료공학'] },
  { name: 'Advanced Functional Materials', rssUrl: 'https://onlinelibrary.wiley.com/action/showFeed?jc=16163028&type=etoc&feed=rss', publisher: 'Wiley', fields: ['재료공학'] },
  { name: 'ACS Nano', rssUrl: 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=ancac3', publisher: 'ACS', fields: ['나노기술', '재료공학'] },
  { name: 'Nano Letters', rssUrl: 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=nalefd', publisher: 'ACS', fields: ['나노기술'] },
  { name: 'Small', rssUrl: 'https://onlinelibrary.wiley.com/action/showFeed?jc=16136829&type=etoc&feed=rss', publisher: 'Wiley', fields: ['나노기술', '재료공학'] },

  // === 전기전자/센서 ===
  { name: 'Nature Electronics', rssUrl: 'https://www.nature.com/natelectron.rss', publisher: 'Nature', fields: ['전기전자', '센서'] },
  { name: 'Nature Sensors', rssUrl: 'https://www.nature.com/natsens.rss', publisher: 'Nature', fields: ['센서'] },
  { name: 'ACS Sensors', rssUrl: 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=ascefj', publisher: 'ACS', fields: ['센서'] },
  { name: 'Biosensors and Bioelectronics', rssUrl: 'https://rss.sciencedirect.com/publication/science/09565663', publisher: 'Elsevier', fields: ['센서', '바이오공학'] },
  { name: 'Sensors and Actuators B', rssUrl: 'https://rss.sciencedirect.com/publication/science/09254005', publisher: 'Elsevier', fields: ['센서'] },
  { name: 'IEEE Sensors Journal', rssUrl: 'https://ieeexplore.ieee.org/rss/TOC7361.XML', publisher: 'IEEE', fields: ['센서', '전기전자'] },

  // === 바이오/의공학 ===
  { name: 'Nature Biomedical Engineering', rssUrl: 'https://www.nature.com/natbiomedeng.rss', publisher: 'Nature', fields: ['바이오공학', '의공학'] },
  { name: 'Nature Biotechnology', rssUrl: 'https://www.nature.com/nbt.rss', publisher: 'Nature', fields: ['바이오공학'] },
  { name: 'Lab on a Chip', rssUrl: 'https://pubs.rsc.org/en/journals/journalissues/lc', publisher: 'RSC', fields: ['바이오공학', '미세유체'] },

  // === 화학 ===
  { name: 'Nature Chemical Engineering', rssUrl: 'https://www.nature.com/natchemeng.rss', publisher: 'Nature', fields: ['화학공학'] },
  { name: 'Chemical Reviews', rssUrl: 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=chreay', publisher: 'ACS', fields: ['화학'] },
  { name: 'Angewandte Chemie', rssUrl: 'https://onlinelibrary.wiley.com/action/showFeed?jc=15213773&type=etoc&feed=rss', publisher: 'Wiley', fields: ['화학'] },
  { name: 'JACS', rssUrl: 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=jacsat', publisher: 'ACS', fields: ['화학'] },

  // === 로봇/AI ===
  { name: 'Science Robotics', rssUrl: 'https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=scirobotics', publisher: 'AAAS', fields: ['로봇공학'] },
  { name: 'Nature Machine Intelligence', rssUrl: 'https://www.nature.com/natmachintell.rss', publisher: 'Nature', fields: ['AI/ML', '컴퓨터공학'] },

  // === 에너지/환경 ===
  { name: 'Nature Energy', rssUrl: 'https://www.nature.com/nenergy.rss', publisher: 'Nature', fields: ['에너지공학'] },
  { name: 'Joule', rssUrl: 'https://www.cell.com/joule/rss', publisher: 'Cell Press', fields: ['에너지공학'] },
  { name: 'Advanced Energy Materials', rssUrl: 'https://onlinelibrary.wiley.com/action/showFeed?jc=16146840&type=etoc&feed=rss', publisher: 'Wiley', fields: ['에너지공학', '재료공학'] },

  // === 통신/전자 ===
  { name: 'Nature Photonics', rssUrl: 'https://www.nature.com/nphoton.rss', publisher: 'Nature', fields: ['광학', '통신공학'] },
  { name: 'IEEE Communications Magazine', rssUrl: 'https://ieeexplore.ieee.org/rss/TOC35.XML', publisher: 'IEEE', fields: ['통신공학'] },
  { name: 'IEEE JSAC', rssUrl: 'https://ieeexplore.ieee.org/rss/TOC49.XML', publisher: 'IEEE', fields: ['통신공학'] },

  // === 토목/도시/환경 ===
  { name: 'Nature Sustainability', rssUrl: 'https://www.nature.com/natsustain.rss', publisher: 'Nature', fields: ['환경공학', '도시공학'] },
  { name: 'Environmental Science & Technology', rssUrl: 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=esthag', publisher: 'ACS', fields: ['환경공학'] },
  { name: 'Water Research', rssUrl: 'https://rss.sciencedirect.com/publication/science/00431354', publisher: 'Elsevier', fields: ['환경공학', '수자원'] },

  // === 기계/항공 ===
  { name: 'Nature Reviews Materials', rssUrl: 'https://www.nature.com/natrevmats.rss', publisher: 'Nature', fields: ['재료공학', '기계공학'] },

  // === 컴퓨터과학 ===
  { name: 'Nature Computational Science', rssUrl: 'https://www.nature.com/natcomputsci.rss', publisher: 'Nature', fields: ['컴퓨터공학'] },
];

// Build lookup maps
const JOURNAL_BY_NAME = new Map(BUILT_IN_JOURNALS.map(j => [j.name, j]));
const ALL_FIELDS = [...new Set(BUILT_IN_JOURNALS.flatMap(j => j.fields))].sort();

// ── Schemas ─────────────────────────────────────────
const alertSettingSchema = z.object({
  keywords: z.array(z.string()).min(1),
  journals: z.array(z.string()).optional(),
  customFeeds: z.array(z.object({
    name: z.string(),
    rssUrl: z.string().url(),
    publisher: z.string().optional(),
  })).optional(),
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
      const doi = itemXml.match(/doi[.:]?\s*(10\.\d{4,}\/[^\s<"]+)/i)?.[1]
        || link.match(/doi\.org\/(10\.\d{4,}\/[^\s<"]+)/i)?.[1]
        || undefined;

      if (title) items.push({ title, link, description, pubDate, authors, doi });
    }
    return items;
  } catch (err) {
    console.warn(`RSS fetch failed for ${url}:`, err);
    return [];
  }
}

// ── Theme scoring ───────────────────────────────────
interface ResearchTheme { name: string; keywords: string[]; }

function scoreByThemes(
  item: RssItem,
  themes: ResearchTheme[],
  flatKeywords: string[],
): { stars: number; matchedThemes: string[]; score: number } {
  const text = `${item.title} ${item.description}`.toLowerCase();
  const matchedThemes: string[] = [];
  for (const theme of themes) {
    if (theme.keywords.some(kw => text.includes(kw.toLowerCase()))) {
      matchedThemes.push(theme.name);
    }
  }
  let flatMatchCount = 0;
  for (const kw of flatKeywords) {
    if (text.includes(kw.toLowerCase())) flatMatchCount++;
  }
  let stars = 0;
  if (matchedThemes.length >= 2) stars = 3;
  else if (matchedThemes.length === 1) stars = 2;
  else if (flatMatchCount > 0) stars = 1;

  const totalKw = flatKeywords.length + themes.reduce((s, t) => s + t.keywords.length, 0);
  const totalMatch = matchedThemes.length + flatMatchCount;
  const score = totalKw > 0 ? Math.min(1, totalMatch / Math.max(totalKw * 0.3, 1)) : 0;
  return { stars, matchedThemes, score };
}

// ── CrossRef enrichment ─────────────────────────────
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
  } catch { return null; }
}

// ── AI Summary ──────────────────────────────────────
async function generatePaperSummary(title: string, abstract: string, matchedThemes: string[]): Promise<string> {
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const themeCtx = matchedThemes.length > 0 ? `관련 연구 테마: ${matchedThemes.join(', ')}\n` : '';
    const result = await model.generateContent(
      `다음 논문의 핵심 기여와 방법론을 한국어 2~3문장으로 요약하세요. 구체적 수치나 방법이 있으면 포함하세요.\n\n${themeCtx}제목: ${title}\n초록: ${abstract.slice(0, 1500)}\n\n요약:`
    );
    return result.response.text().trim();
  } catch { return ''; }
}

// ── Routes ──────────────────────────────────────────
export async function paperAlertRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);

  // ── GET /api/papers/journals/fields — 분야별 추천 저널 ──
  app.get('/api/papers/journals/fields', async (_request, reply) => {
    const fieldMap: Record<string, Array<{ name: string; publisher: string }>> = {};
    for (const field of ALL_FIELDS) {
      fieldMap[field] = BUILT_IN_JOURNALS
        .filter(j => j.fields.includes(field))
        .map(j => ({ name: j.name, publisher: j.publisher }));
    }
    return reply.send({
      fields: ALL_FIELDS,
      journalsByField: fieldMap,
      totalJournals: BUILT_IN_JOURNALS.length,
    });
  });

  // ── GET /api/papers/journals/search — OpenAlex 키워드 저널 검색 ──
  app.get('/api/papers/journals/search', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = z.object({ q: z.string().min(1) }).parse(request.query);

    try {
      // OpenAlex API: search journals (sources) by keyword
      const res = await fetch(
        `https://api.openalex.org/sources?search=${encodeURIComponent(query.q)}&filter=type:journal&per_page=20&mailto=contact@researchflow.app`,
        { signal: AbortSignal.timeout(10000) },
      );
      if (!res.ok) throw new Error(`OpenAlex API error: ${res.status}`);
      const data = await res.json();

      const journals = (data.results || []).map((src: any) => ({
        name: src.display_name,
        issn: src.issn?.[0] || null,
        publisher: src.host_organization_name || null,
        citedByCount: src.cited_by_count || 0,
        worksCount: src.works_count || 0,
        // RSS URL 자동 생성 시도
        rssUrl: guessRssUrl(src),
        openAlexId: src.id,
      }));

      return reply.send({ results: journals, query: query.q });
    } catch (err: any) {
      return reply.code(500).send({ error: '저널 검색 실패', details: err.message });
    }
  });

  // ── POST /api/papers/journals/validate — RSS URL 유효성 검증 ──
  app.post('/api/papers/journals/validate', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = z.object({ rssUrl: z.string().url() }).parse(request.body);
    try {
      const items = await parseRssFeed(body.rssUrl);
      return reply.send({
        valid: items.length > 0,
        itemCount: items.length,
        sampleTitle: items[0]?.title || null,
      });
    } catch {
      return reply.send({ valid: false, itemCount: 0, sampleTitle: null });
    }
  });

  // ── POST /api/papers/journals/custom — 커스텀 RSS 추가 ──
  app.post('/api/papers/journals/custom', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (!lab) return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });

    const body = z.object({
      name: z.string().min(1),
      rssUrl: z.string().url(),
      publisher: z.string().optional(),
    }).parse(request.body);

    // RSS 유효성 검증
    const items = await parseRssFeed(body.rssUrl);
    if (items.length === 0) {
      return reply.code(400).send({ error: 'RSS 피드에서 논문을 가져올 수 없습니다. URL을 확인해주세요.' });
    }

    // 기존 alert에 추가
    const alert = await prisma.paperAlert.findFirst({ where: { labId: lab.id } });
    if (!alert) {
      return reply.code(404).send({ error: '논문 알림 설정이 없습니다. 먼저 키워드를 설정해주세요.' });
    }

    const existing = (alert.customFeeds as any[] | null) || [];
    const alreadyExists = existing.some((f: any) => f.rssUrl === body.rssUrl);
    if (alreadyExists) {
      return reply.send({ success: true, message: '이미 등록된 피드입니다.' });
    }

    const updated = await prisma.paperAlert.update({
      where: { id: alert.id },
      data: {
        customFeeds: [...existing, { name: body.name, rssUrl: body.rssUrl, publisher: body.publisher || '' }] as any,
      },
    });

    return reply.send({ success: true, customFeeds: updated.customFeeds, sampleCount: items.length });
  });

  // ── GET /api/papers/alerts ────────────────────────
  app.get('/api/papers/alerts', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (!lab) return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });

    const alerts = await prisma.paperAlert.findMany({ where: { labId: lab.id } });

    // 분야별 그룹
    const fieldMap: Record<string, string[]> = {};
    for (const field of ALL_FIELDS) {
      fieldMap[field] = BUILT_IN_JOURNALS.filter(j => j.fields.includes(field)).map(j => j.name);
    }

    return {
      alerts,
      availableJournals: BUILT_IN_JOURNALS.map(j => j.name),
      journalCategories: fieldMap,
      researchThemes: (lab.researchThemes as ResearchTheme[] | null) || [],
    };
  });

  // ── POST /api/papers/alerts ────────────────────────
  app.post('/api/papers/alerts', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (!lab) return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });

    const body = alertSettingSchema.parse(request.body);
    const existing = await prisma.paperAlert.findFirst({ where: { labId: lab.id } });

    if (existing) {
      const updated = await prisma.paperAlert.update({
        where: { id: existing.id },
        data: {
          keywords: body.keywords,
          journals: body.journals || [],
          customFeeds: body.customFeeds ? (body.customFeeds as any) : existing.customFeeds,
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
        customFeeds: body.customFeeds ? (body.customFeeds as any) : undefined,
        schedule: body.schedule,
      },
    });
    return reply.code(201).send(alert);
  });

  // ── POST /api/papers/alerts/run ────────────────────
  app.post('/api/papers/alerts/run', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (!lab) return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });

    const alert = await prisma.paperAlert.findFirst({ where: { labId: lab.id, active: true } });
    if (!alert) return reply.code(404).send({ error: '논문 알림 설정이 없습니다.' });

    const themes = (lab.researchThemes as ResearchTheme[] | null) || [];
    const flatKeywords = alert.keywords as string[];

    // 크롤링 대상: built-in + custom feeds
    const feedsToCrawl: Array<{ name: string; rssUrl: string }> = [];

    // Built-in journals
    const journalNames = alert.journals.length > 0 ? alert.journals : [];
    for (const name of journalNames) {
      const j = JOURNAL_BY_NAME.get(name);
      if (j) feedsToCrawl.push({ name: j.name, rssUrl: j.rssUrl });
    }

    // Custom feeds
    const customFeeds = (alert.customFeeds as Array<{ name: string; rssUrl: string }> | null) || [];
    feedsToCrawl.push(...customFeeds);

    if (feedsToCrawl.length === 0) {
      return reply.code(400).send({ error: '모니터링할 저널이 없습니다. 설정에서 저널을 추가해주세요.' });
    }

    // 병렬 RSS 크롤링
    const feedResults = await Promise.all(
      feedsToCrawl.map(async feed => {
        const items = await parseRssFeed(feed.rssUrl);
        return items.map(item => ({ ...item, journal: feed.name }));
      })
    );
    const allItems = feedResults.flat();

    // 테마 기반 관련도 평가
    const scored = allItems
      .map(item => ({ ...item, ...scoreByThemes(item, themes, flatKeywords) }))
      .filter(item => item.stars > 0)
      .sort((a, b) => b.stars - a.stars || b.score - a.score)
      .slice(0, 30);

    // 저장 + CrossRef + AI 요약
    let savedCount = 0;
    for (const item of scored) {
      const exists = await prisma.paperAlertResult.findFirst({
        where: { alertId: alert.id, title: item.title },
      });
      if (exists) continue;

      let enrichedAbstract = item.description;
      let enrichedAuthors = item.authors;
      if (item.doi && item.stars >= 2) {
        const crossRef = await enrichWithCrossRef(item.doi);
        if (crossRef?.abstract) enrichedAbstract = crossRef.abstract;
        if (crossRef?.authors) enrichedAuthors = crossRef.authors.join(', ');
      }

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
      journals: feedsToCrawl.map(f => f.name),
      breakdown: {
        threeStars: scored.filter(s => s.stars === 3).length,
        twoStars: scored.filter(s => s.stars === 2).length,
        oneStar: scored.filter(s => s.stars === 1).length,
      },
    };
  });

  // ── GET /api/papers/alerts/results ─────────────────
  app.get('/api/papers/alerts/results', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (!lab) return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });

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

  // ── PATCH /api/papers/alerts/results/:id ───────────
  app.patch('/api/papers/alerts/results/:id', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    await prisma.paperAlertResult.update({
      where: { id: request.params.id },
      data: { read: true },
    });
    return { success: true };
  });
}

// ── 저널 RSS URL 추측 (OpenAlex 결과에서) ────────────
function guessRssUrl(source: any): string | null {
  const homepage = source.homepage_url || '';
  const issn = source.issn?.[0];

  // Nature 계열
  if (homepage.includes('nature.com')) {
    const match = homepage.match(/nature\.com\/([a-z]+)/);
    if (match) return `https://www.nature.com/${match[1]}.rss`;
  }
  // Science 계열
  if (homepage.includes('science.org')) {
    const match = homepage.match(/journal\/([a-z]+)/);
    if (match) return `https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=${match[1]}`;
  }
  // Wiley
  if (homepage.includes('wiley.com') && issn) {
    const issnClean = issn.replace('-', '');
    return `https://onlinelibrary.wiley.com/action/showFeed?jc=${issnClean}&type=etoc&feed=rss`;
  }
  // ACS
  if (homepage.includes('pubs.acs.org')) {
    const match = homepage.match(/journal\/([a-z]+)/);
    if (match) return `https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=${match[1]}`;
  }
  // Elsevier (ScienceDirect)
  if (issn) {
    return `https://rss.sciencedirect.com/publication/science/${issn.replace('-', '')}`;
  }
  return null;
}
