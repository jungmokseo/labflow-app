/**
 * 논문 알림 Routes — 분야별 탑 저널 추천 + 자동 검색/추가 + 테마 관련도 평가
 *
 * GET    /api/papers/alerts              → 알림 설정
 * POST   /api/papers/alerts              → 알림 설정 생성/수정
 * POST   /api/papers/alerts/run          → 수동 크롤링
 * GET    /api/papers/alerts/results      → 결과 목록
 * PATCH  /api/papers/alerts/results/:id  → 읽음 표시
 * GET    /api/papers/journals/fields     → 분야별 추천 저널
 * POST   /api/papers/journals/search     → 저널명/키워드 검색 (OpenAlex)
 * POST   /api/papers/journals/add        → 저널 추가 (이름 또는 RSS)
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { logError } from '../services/error-logger.js';
import { logApiCost } from '../services/cost-logger.js';

const MAX_JOURNALS = 15;

// ── 분야별 탑 저널 (7개씩) ─────────────────────────
interface JournalInfo {
  name: string;
  rssUrl: string;
  publisher: string;
  fields: string[];
}

const BUILT_IN_JOURNALS: JournalInfo[] = [
  // === 종합 (Multidisciplinary) ===
  { name: 'Nature', rssUrl: 'https://www.nature.com/nature.rss', publisher: 'Nature', fields: ['종합'] },
  { name: 'Science', rssUrl: 'https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=science', publisher: 'AAAS', fields: ['종합'] },
  { name: 'Cell', rssUrl: 'https://www.cell.com/cell/rss', publisher: 'Cell Press', fields: ['종합'] },
  { name: 'Nature Communications', rssUrl: 'https://www.nature.com/ncomms.rss', publisher: 'Nature', fields: ['종합'] },
  { name: 'Science Advances', rssUrl: 'https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=sciadv', publisher: 'AAAS', fields: ['종합'] },
  { name: 'PNAS', rssUrl: 'https://www.pnas.org/action/showFeed?type=etoc&feed=rss&jc=pnas', publisher: 'NAS', fields: ['종합'] },
  { name: 'Nature Reviews Chemistry', rssUrl: 'https://www.nature.com/natrevchem.rss', publisher: 'Nature', fields: ['종합', '화학'] },

  // === 재료공학 ===
  { name: 'Nature Materials', rssUrl: 'https://www.nature.com/nmat.rss', publisher: 'Nature', fields: ['재료공학'] },
  { name: 'Advanced Materials', rssUrl: 'https://onlinelibrary.wiley.com/action/showFeed?jc=15214095&type=etoc&feed=rss', publisher: 'Wiley', fields: ['재료공학'] },
  { name: 'Advanced Functional Materials', rssUrl: 'https://onlinelibrary.wiley.com/action/showFeed?jc=16163028&type=etoc&feed=rss', publisher: 'Wiley', fields: ['재료공학'] },
  { name: 'Matter', rssUrl: 'https://www.cell.com/matter/rss', publisher: 'Cell Press', fields: ['재료공학'] },
  { name: 'ACS Applied Materials & Interfaces', rssUrl: 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=aamick', publisher: 'ACS', fields: ['재료공학'] },
  { name: 'Chemistry of Materials', rssUrl: 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=cmatex', publisher: 'ACS', fields: ['재료공학'] },
  { name: 'Nature Reviews Materials', rssUrl: 'https://www.nature.com/natrevmats.rss', publisher: 'Nature', fields: ['재료공학'] },

  // === 나노기술 ===
  { name: 'Nature Nanotechnology', rssUrl: 'https://www.nature.com/nnano.rss', publisher: 'Nature', fields: ['나노기술'] },
  { name: 'ACS Nano', rssUrl: 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=ancac3', publisher: 'ACS', fields: ['나노기술'] },
  { name: 'Nano Letters', rssUrl: 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=nalefd', publisher: 'ACS', fields: ['나노기술'] },
  { name: 'Small', rssUrl: 'https://onlinelibrary.wiley.com/action/showFeed?jc=16136829&type=etoc&feed=rss', publisher: 'Wiley', fields: ['나노기술'] },
  { name: 'Nano Energy', rssUrl: 'https://rss.sciencedirect.com/publication/science/22112855', publisher: 'Elsevier', fields: ['나노기술', '에너지공학'] },
  { name: 'Small Methods', rssUrl: 'https://onlinelibrary.wiley.com/action/showFeed?jc=23669608&type=etoc&feed=rss', publisher: 'Wiley', fields: ['나노기술'] },
  { name: 'Nanoscale', rssUrl: 'https://pubs.rsc.org/en/content/getauthorfeed/journal/nr', publisher: 'RSC', fields: ['나노기술'] },

  // === 전기전자 ===
  { name: 'Nature Electronics', rssUrl: 'https://www.nature.com/natelectron.rss', publisher: 'Nature', fields: ['전기전자'] },
  { name: 'IEEE Electron Device Letters', rssUrl: 'https://ieeexplore.ieee.org/rss/TOC16.XML', publisher: 'IEEE', fields: ['전기전자'] },
  { name: 'IEEE Trans. Electron Devices', rssUrl: 'https://ieeexplore.ieee.org/rss/TOC16.XML', publisher: 'IEEE', fields: ['전기전자'] },
  { name: 'IEEE JSSC', rssUrl: 'https://ieeexplore.ieee.org/rss/TOC4.XML', publisher: 'IEEE', fields: ['전기전자'] },
  { name: 'IEEE Trans. Power Electronics', rssUrl: 'https://ieeexplore.ieee.org/rss/TOC63.XML', publisher: 'IEEE', fields: ['전기전자'] },
  { name: 'IEEE Trans. Industrial Electronics', rssUrl: 'https://ieeexplore.ieee.org/rss/TOC41.XML', publisher: 'IEEE', fields: ['전기전자'] },
  { name: 'Advanced Electronic Materials', rssUrl: 'https://onlinelibrary.wiley.com/action/showFeed?jc=2199160x&type=etoc&feed=rss', publisher: 'Wiley', fields: ['전기전자'] },

  // === 센서 ===
  { name: 'Nature Sensors', rssUrl: 'https://www.nature.com/natsens.rss', publisher: 'Nature', fields: ['센서'] },
  { name: 'ACS Sensors', rssUrl: 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=ascefj', publisher: 'ACS', fields: ['센서'] },
  { name: 'Biosensors and Bioelectronics', rssUrl: 'https://rss.sciencedirect.com/publication/science/09565663', publisher: 'Elsevier', fields: ['센서', '바이오공학'] },
  { name: 'Sensors and Actuators B', rssUrl: 'https://rss.sciencedirect.com/publication/science/09254005', publisher: 'Elsevier', fields: ['센서'] },
  { name: 'Sensors and Actuators A', rssUrl: 'https://rss.sciencedirect.com/publication/science/09244247', publisher: 'Elsevier', fields: ['센서'] },
  { name: 'IEEE Sensors Journal', rssUrl: 'https://ieeexplore.ieee.org/rss/TOC7361.XML', publisher: 'IEEE', fields: ['센서'] },
  { name: 'Analytica Chimica Acta', rssUrl: 'https://rss.sciencedirect.com/publication/science/00032670', publisher: 'Elsevier', fields: ['센서', '화학'] },

  // === 바이오공학 ===
  { name: 'Nature Biomedical Engineering', rssUrl: 'https://www.nature.com/natbiomedeng.rss', publisher: 'Nature', fields: ['바이오공학'] },
  { name: 'Nature Biotechnology', rssUrl: 'https://www.nature.com/nbt.rss', publisher: 'Nature', fields: ['바이오공학'] },
  { name: 'Biomaterials', rssUrl: 'https://rss.sciencedirect.com/publication/science/01429612', publisher: 'Elsevier', fields: ['바이오공학', '재료공학'] },
  { name: 'Bioactive Materials', rssUrl: 'https://rss.sciencedirect.com/publication/science/2452199X', publisher: 'Elsevier', fields: ['바이오공학'] },
  { name: 'Lab on a Chip', rssUrl: 'https://pubs.rsc.org/en/content/getauthorfeed/journal/lc', publisher: 'RSC', fields: ['바이오공학'] },
  { name: 'ACS Biomater. Sci. Eng.', rssUrl: 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=abseba', publisher: 'ACS', fields: ['바이오공학'] },
  { name: 'Biofabrication', rssUrl: '', publisher: 'IOP', fields: ['바이오공학'] },

  // === 화학 ===
  { name: 'Nature Chemistry', rssUrl: 'https://www.nature.com/nchem.rss', publisher: 'Nature', fields: ['화학'] },
  { name: 'JACS', rssUrl: 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=jacsat', publisher: 'ACS', fields: ['화학'] },
  { name: 'Angewandte Chemie', rssUrl: 'https://onlinelibrary.wiley.com/action/showFeed?jc=15213773&type=etoc&feed=rss', publisher: 'Wiley', fields: ['화학'] },
  { name: 'Chemical Reviews', rssUrl: 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=chreay', publisher: 'ACS', fields: ['화학'] },
  { name: 'Chem. Soc. Rev.', rssUrl: 'https://pubs.rsc.org/en/content/getauthorfeed/journal/cs', publisher: 'RSC', fields: ['화학'] },
  { name: 'ACS Central Science', rssUrl: 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=acscii', publisher: 'ACS', fields: ['화학'] },
  { name: 'Nature Chemical Engineering', rssUrl: 'https://www.nature.com/natchemeng.rss', publisher: 'Nature', fields: ['화학', '화학공학'] },

  // === 로봇공학/AI ===
  { name: 'Science Robotics', rssUrl: 'https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=scirobotics', publisher: 'AAAS', fields: ['로봇공학'] },
  { name: 'Nature Machine Intelligence', rssUrl: 'https://www.nature.com/natmachintell.rss', publisher: 'Nature', fields: ['AI/ML'] },
  { name: 'IEEE Trans. Robotics', rssUrl: 'https://ieeexplore.ieee.org/rss/TOC8860.XML', publisher: 'IEEE', fields: ['로봇공학'] },
  { name: 'Soft Robotics', rssUrl: '', publisher: 'Mary Ann Liebert', fields: ['로봇공학'] },
  { name: 'IEEE Robotics & Automation Letters', rssUrl: 'https://ieeexplore.ieee.org/rss/TOC8860.XML', publisher: 'IEEE', fields: ['로봇공학'] },
  { name: 'IEEE TPAMI', rssUrl: 'https://ieeexplore.ieee.org/rss/TOC34.XML', publisher: 'IEEE', fields: ['AI/ML'] },
  { name: 'Int. J. Robotics Research', rssUrl: '', publisher: 'SAGE', fields: ['로봇공학'] },

  // === 에너지공학 ===
  { name: 'Nature Energy', rssUrl: 'https://www.nature.com/nenergy.rss', publisher: 'Nature', fields: ['에너지공학'] },
  { name: 'Joule', rssUrl: 'https://www.cell.com/joule/rss', publisher: 'Cell Press', fields: ['에너지공학'] },
  { name: 'Advanced Energy Materials', rssUrl: 'https://onlinelibrary.wiley.com/action/showFeed?jc=16146840&type=etoc&feed=rss', publisher: 'Wiley', fields: ['에너지공학'] },
  { name: 'Energy Environ. Sci.', rssUrl: 'https://pubs.rsc.org/en/content/getauthorfeed/journal/ee', publisher: 'RSC', fields: ['에너지공학'] },
  { name: 'ACS Energy Letters', rssUrl: 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=aelccp', publisher: 'ACS', fields: ['에너지공학'] },
  { name: 'Energy Storage Materials', rssUrl: 'https://rss.sciencedirect.com/publication/science/24058297', publisher: 'Elsevier', fields: ['에너지공학'] },
  { name: 'Cell Reports Physical Science', rssUrl: 'https://www.cell.com/cell-reports-physical-science/rss', publisher: 'Cell Press', fields: ['에너지공학'] },

  // === 통신공학 ===
  { name: 'Nature Photonics', rssUrl: 'https://www.nature.com/nphoton.rss', publisher: 'Nature', fields: ['통신공학', '광학'] },
  { name: 'IEEE Communications Magazine', rssUrl: 'https://ieeexplore.ieee.org/rss/TOC35.XML', publisher: 'IEEE', fields: ['통신공학'] },
  { name: 'IEEE JSAC', rssUrl: 'https://ieeexplore.ieee.org/rss/TOC49.XML', publisher: 'IEEE', fields: ['통신공학'] },
  { name: 'IEEE Trans. Communications', rssUrl: 'https://ieeexplore.ieee.org/rss/TOC26.XML', publisher: 'IEEE', fields: ['통신공학'] },
  { name: 'IEEE Trans. Wireless Communications', rssUrl: 'https://ieeexplore.ieee.org/rss/TOC7693.XML', publisher: 'IEEE', fields: ['통신공학'] },
  { name: 'IEEE Comm. Surveys & Tutorials', rssUrl: 'https://ieeexplore.ieee.org/rss/TOC9739.XML', publisher: 'IEEE', fields: ['통신공학'] },
  { name: 'Light: Science & Applications', rssUrl: 'https://www.nature.com/lsa.rss', publisher: 'Nature', fields: ['통신공학', '광학'] },

  // === 환경/도시공학 ===
  { name: 'Nature Sustainability', rssUrl: 'https://www.nature.com/natsustain.rss', publisher: 'Nature', fields: ['환경공학'] },
  { name: 'Nature Climate Change', rssUrl: 'https://www.nature.com/nclimate.rss', publisher: 'Nature', fields: ['환경공학'] },
  { name: 'Nature Water', rssUrl: 'https://www.nature.com/natwater.rss', publisher: 'Nature', fields: ['환경공학'] },
  { name: 'Environmental Science & Technology', rssUrl: 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=esthag', publisher: 'ACS', fields: ['환경공학'] },
  { name: 'ES&T Letters', rssUrl: 'https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=estlcu', publisher: 'ACS', fields: ['환경공학'] },
  { name: 'Water Research', rssUrl: 'https://rss.sciencedirect.com/publication/science/00431354', publisher: 'Elsevier', fields: ['환경공학'] },
  { name: 'One Earth', rssUrl: 'https://www.cell.com/one-earth/rss', publisher: 'Cell Press', fields: ['환경공학'] },

  // === 컴퓨터공학 ===
  { name: 'Nature Computational Science', rssUrl: 'https://www.nature.com/natcomputsci.rss', publisher: 'Nature', fields: ['컴퓨터공학'] },
  { name: 'Nature Human Behaviour', rssUrl: 'https://www.nature.com/nathumbehav.rss', publisher: 'Nature', fields: ['컴퓨터공학'] },
  { name: 'IEEE TNNLS', rssUrl: 'https://ieeexplore.ieee.org/rss/TOC5962385.XML', publisher: 'IEEE', fields: ['컴퓨터공학', 'AI/ML'] },
  { name: 'IEEE Trans. Software Engineering', rssUrl: 'https://ieeexplore.ieee.org/rss/TOC32.XML', publisher: 'IEEE', fields: ['컴퓨터공학'] },
  { name: 'IEEE TIFS', rssUrl: 'https://ieeexplore.ieee.org/rss/TOC10206.XML', publisher: 'IEEE', fields: ['컴퓨터공학'] },
  { name: 'npj Computational Materials', rssUrl: 'https://www.nature.com/npjcompumats.rss', publisher: 'Nature', fields: ['컴퓨터공학', '재료공학'] },
  { name: 'ACM Computing Surveys', rssUrl: '', publisher: 'ACM', fields: ['컴퓨터공학'] },

  // === 기계/항공 ===
  { name: 'Nature Mechanical Engineering', rssUrl: 'https://www.nature.com/natmecheng.rss', publisher: 'Nature', fields: ['기계공학'] },
  { name: 'Additive Manufacturing', rssUrl: 'https://rss.sciencedirect.com/publication/science/22148604', publisher: 'Elsevier', fields: ['기계공학'] },
  { name: 'Int. J. Machine Tools & Manufacture', rssUrl: 'https://rss.sciencedirect.com/publication/science/08906955', publisher: 'Elsevier', fields: ['기계공학'] },
  { name: 'Composites Part B', rssUrl: 'https://rss.sciencedirect.com/publication/science/13598368', publisher: 'Elsevier', fields: ['기계공학', '재료공학'] },
  { name: 'Int. J. Mechanical Sciences', rssUrl: 'https://rss.sciencedirect.com/publication/science/00207403', publisher: 'Elsevier', fields: ['기계공학'] },
  { name: 'Extreme Mechanics Letters', rssUrl: 'https://rss.sciencedirect.com/publication/science/23524316', publisher: 'Elsevier', fields: ['기계공학'] },
  { name: 'AIAA Journal', rssUrl: '', publisher: 'AIAA', fields: ['기계공학', '항공'] },

  // === 의공학 ===
  { name: 'Nature Medicine', rssUrl: 'https://www.nature.com/nm.rss', publisher: 'Nature', fields: ['의공학'] },
  { name: 'Science Translational Medicine', rssUrl: 'https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=stm', publisher: 'AAAS', fields: ['의공학'] },
  { name: 'Advanced Healthcare Materials', rssUrl: 'https://onlinelibrary.wiley.com/action/showFeed?jc=21922659&type=etoc&feed=rss', publisher: 'Wiley', fields: ['의공학'] },
  { name: 'Acta Biomaterialia', rssUrl: 'https://rss.sciencedirect.com/publication/science/17427061', publisher: 'Elsevier', fields: ['의공학', '재료공학'] },
  { name: 'Theranostics', rssUrl: '', publisher: 'Ivyspring', fields: ['의공학'] },
  { name: 'Ann. Biomedical Engineering', rssUrl: '', publisher: 'Springer', fields: ['의공학'] },
  { name: 'IEEE Trans. Biomedical Engineering', rssUrl: 'https://ieeexplore.ieee.org/rss/TOC10.XML', publisher: 'IEEE', fields: ['의공학'] },

  // === 물리 ===
  { name: 'Nature Physics', rssUrl: 'https://www.nature.com/nphys.rss', publisher: 'Nature', fields: ['물리'] },
  { name: 'Physical Review Letters', rssUrl: '', publisher: 'APS', fields: ['물리'] },
  { name: 'Physical Review X', rssUrl: '', publisher: 'APS', fields: ['물리'] },
  { name: 'Reviews of Modern Physics', rssUrl: '', publisher: 'APS', fields: ['물리'] },
  { name: 'Advanced Photonics', rssUrl: '', publisher: 'SPIE', fields: ['물리', '광학'] },
  { name: 'Optica', rssUrl: '', publisher: 'Optica', fields: ['물리', '광학'] },
  { name: 'Light: Science & Applications', rssUrl: 'https://www.nature.com/lsa.rss', publisher: 'Nature', fields: ['물리', '광학'] },
];

// Build lookup
const JOURNAL_BY_NAME = new Map(BUILT_IN_JOURNALS.map(j => [j.name, j]));
const ALL_FIELDS = [...new Set(BUILT_IN_JOURNALS.flatMap(j => j.fields))].sort();

// ── Schemas ─────────────────────────────────────────
// keywords: 빈 배열 허용 — Lab researchThemes 키워드가 서버에서 자동 채워짐
const alertSettingSchema = z.object({
  keywords: z.array(z.string()).optional().default([]),
  journals: z.array(z.string()).optional(),
  customFeeds: z.array(z.object({
    name: z.string(),
    rssUrl: z.string().url(),
    publisher: z.string().optional(),
  })).optional(),
  schedule: z.enum(['weekly', 'manual']).default('weekly'),
});

// ── Cron 스케줄러 (서버 시작 시 실행) ────────────────
let cronInterval: ReturnType<typeof setInterval> | null = null;

export function startPaperAlertCron() {
  if (cronInterval) return;
  // 1일 1회 체크 (주간 스케줄이므로 하루 한번이면 충분)
  cronInterval = setInterval(async () => {
    try {
      await checkAndRunScheduledAlerts();
    } catch (err) {
      console.error('Paper alert cron error:', err);
    }
  }, 24 * 60 * 60 * 1000); // 24시간
  // 기존 daily → weekly 마이그레이션
  prisma.paperAlert.updateMany({ where: { schedule: 'daily' }, data: { schedule: 'weekly' } }).catch(logError('paper', 'daily→weekly 마이그레이션 실패', {}, 'warn'));
  // 서버 시작 시 즉시 1회 체크 (밀린 스케줄 처리)
  checkAndRunScheduledAlerts().catch(logError('paper', '시작 시 알림 체크 실패'));
  console.log('[paper-alert] Paper alert cron started (daily check)');
}

export function stopPaperAlertCron() {
  if (cronInterval) { clearInterval(cronInterval); cronInterval = null; }
}

async function checkAndRunScheduledAlerts() {
  const now = new Date();
  const alerts = await prisma.paperAlert.findMany({
    where: { active: true, schedule: { not: 'manual' } },
    include: { lab: true },
  });

  for (const alert of alerts) {
    const lastRun = alert.lastRunAt || new Date(0);
    const hoursSinceLastRun = (now.getTime() - lastRun.getTime()) / (1000 * 60 * 60);

    let shouldRun = false;
    if (alert.schedule === 'weekly' && hoursSinceLastRun >= 167) shouldRun = true; // ~7일

    if (shouldRun) {
      console.log(`[paper-alert] Running scheduled paper alert: ${alert.id} (${alert.schedule})`);
      try {
        await runPaperCrawl(alert, alert.lab);
      } catch (err) {
        console.error(`Paper alert ${alert.id} failed:`, err);
      }
    }
  }
}

// ── RSS Parser ──────────────────────────────────────
interface RssItem {
  title: string; link: string; description: string;
  pubDate: string; authors?: string; doi?: string;
}

async function parseRssFeed(url: string): Promise<RssItem[]> {
  if (!url) return [];
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'ResearchFlow/1.0 (Paper Monitoring)' },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) return [];
    const xml = await response.text();
    const items: RssItem[] = [];
    const itemMatches = xml.match(/<item[^>]*>[\s\S]*?<\/item>/gi) || [];
    for (const itemXml of itemMatches) {
      const title = itemXml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim() || '';
      const link = itemXml.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]?.trim() || '';
      const description = itemXml.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim() || '';
      const pubDate = itemXml.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1]?.trim() || '';
      const authors = itemXml.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim() || undefined;
      const doi = itemXml.match(/doi[.:]?\s*(10\.\d{4,}\/[^\s<"]+)/i)?.[1] || link.match(/doi\.org\/(10\.\d{4,}\/[^\s<"]+)/i)?.[1] || undefined;
      if (title) items.push({ title, link, description, pubDate, authors, doi });
    }
    return items;
  } catch { return []; }
}

// ── 기본 연구 테마 (Lab researchThemes 없을 때 fallback) ──
const DEFAULT_RESEARCH_THEMES: ResearchTheme[] = [
  { name: 'Liquid Metal', keywords: ['liquid metal', 'gallium', 'EGaIn', 'galinstan', 'LM particle', 'LM nanoparticle', 'liquid-metal', 'spray printing', 'Marangoni', 'self-fusion', 'stretchable electrode', 'deformable conductor', 'liquid metal composite', 'liquid metal alloy', 'room temperature liquid metal', 'liquid metal droplet', 'gallium-based'] },
  { name: '하이드로겔', keywords: ['hydrogel', 'PVA hydrogel', 'PAA hydrogel', 'double network hydrogel', 'self-healing hydrogel', 'hemostasis', 'hemostatic', 'wound healing', 'wound dressing', 'tough hydrogel', 'conductive hydrogel', 'injectable hydrogel', 'hydrogel sensor', 'hydrogel patch', 'adhesive hydrogel', 'ionic hydrogel', 'stretchable hydrogel', 'bioelectronic hydrogel', 'wearable hydrogel'] },
  { name: 'Antifouling Coating', keywords: ['antifouling', 'anti-fouling', 'biofouling', 'biofilm', 'lubricant-infused', 'lubricated surface', 'slippery surface', 'SLIPS', 'liquid-infused', 'omniphobic', 'implant coating', 'antibacterial coating', 'antimicrobial surface', 'fouling resistant', 'non-fouling', 'zwitterionic coating'] },
  { name: '이종소재 접착제', keywords: ['tissue adhesive', 'bioadhesive', 'bio-adhesive', 'dopamine adhesive', 'mussel-inspired adhesive', 'catechol adhesive', 'chain entanglement', 'heterogeneous bonding', 'dissimilar material bonding', 'universal adhesive', 'underwater adhesive', 'wet adhesion', 'tough adhesion', 'surgical adhesive', 'wound closure adhesive', 'sealant adhesive'] },
  { name: 'Neuromorphic Device', keywords: ['neuromorphic', 'memristor', 'memristive', 'synaptic device', 'synaptic transistor', 'in-memory computing', 'resistive switching', 'artificial synapse', 'spiking neural', 'brain-inspired computing', 'reservoir computing', 'neural interface', 'brain-computer interface', 'neural recording', 'neural electrode'] },
];

/**
 * 수집 범위 안내 메시지 (논문용) — T_last가 오래되었거나 첫 실행일 때 사용자에게 범위 설명
 */
function describePaperFetchRange(tLast: Date, isFirstRun: boolean): string | null {
  const diffMs = Date.now() - tLast.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (isFirstRun) {
    return '첫 논문 모니터링입니다. 최근 2주간의 논문을 수집합니다.';
  }
  if (diffDays >= 14) {
    return `마지막 모니터링 이후 ${diffDays}일이 경과하여, ${diffDays}일간의 논문을 수집합니다. 양이 많아 처리 시간이 다소 걸릴 수 있습니다.`;
  }
  if (diffDays >= 3) {
    return `마지막 모니터링 이후 ${diffDays}일이 경과하여, ${diffDays}일간의 논문을 수집합니다.`;
  }
  return null;
}

// ── Theme scoring ───────────────────────────────────
interface ResearchTheme { name: string; keywords: string[]; }

/**
 * 텍스트 정규화 — 키워드 매칭 false negative 축소.
 * - 하이픈/언더스코어를 공백으로 (anti-fouling ↔ anti fouling ↔ antifouling)
 * - 연속 공백을 1개로
 * - 소문자 변환
 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 더 관대한 키워드 매칭 — 5가지 변형 시도:
 * 1. 정확 substring (기존 동작 유지)
 * 2. 정규화 substring (하이픈/공백 무시)
 * 3. 공백 제거 매칭 (biosensor ↔ bio sensor)
 * 4. 단어 경계 + 어형 변형 (hydrogel → hydrogels, hydrogel-based)
 * 5. 다단어 키워드는 모든 단어가 가까이 등장하면 매칭 (50자 이내)
 */
function matchKeyword(text: string, keyword: string): boolean {
  const lowerText = text.toLowerCase();
  const lowerKw = keyword.toLowerCase();
  if (lowerText.includes(lowerKw)) return true;

  const normText = normalizeText(text);
  const normKw = normalizeText(keyword);
  if (normText.includes(normKw)) return true;

  // 공백 제거 매칭 (biosensor ↔ bio sensor)
  const compactKw = normKw.replace(/\s/g, '');
  if (compactKw.length >= 5 && normText.replace(/\s/g, '').includes(compactKw)) return true;

  // 단어 경계 + 어형 변형 (단일 단어 키워드만)
  if (!normKw.includes(' ') && normKw.length >= 4) {
    try {
      const escaped = normKw.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      const boundaryRe = new RegExp(`\\b${escaped}\\w{0,4}\\b`, 'i');
      if (boundaryRe.test(normText)) return true;
    } catch {}
  }

  // 다단어 키워드: 모든 단어가 50자 이내에 등장
  if (normKw.includes(' ')) {
    const words = normKw.split(' ').filter(w => w.length >= 3);
    if (words.length >= 2) {
      const positions = words.map(w => normText.indexOf(w));
      if (positions.every(p => p >= 0)) {
        const span = Math.max(...positions) - Math.min(...positions);
        if (span <= 50) return true;
      }
    }
  }
  return false;
}

function scoreByThemes(item: RssItem, themes: ResearchTheme[], flatKeywords: string[]) {
  const text = `${item.title} ${item.description}`;
  const matchedThemes: string[] = [];
  let themeMatchCount = 0; // 각 테마 안에서 몇 개 키워드가 매칭됐는지
  for (const theme of themes) {
    let count = 0;
    for (const kw of theme.keywords) { if (matchKeyword(text, kw)) count++; }
    if (count > 0) {
      matchedThemes.push(theme.name);
      themeMatchCount += count;
    }
  }
  let flatMatchCount = 0;
  for (const kw of flatKeywords) { if (matchKeyword(text, kw)) flatMatchCount++; }

  // 별점 기준 완화 — 더 너그럽게 핵심으로 분류:
  // ★3: 테마 ≥ 2 매칭, 또는 (테마 1 + 키워드 2+), 또는 (테마 1 + 같은테마 안에서 3+ 매칭)
  // ★2: 테마 1 매칭, 또는 키워드 3+ 매칭
  // ★1: 키워드 1+ 매칭 (의미 있을 가능성)
  let stars = 0;
  if (matchedThemes.length >= 2) stars = 3;
  else if (matchedThemes.length === 1 && (flatMatchCount >= 2 || themeMatchCount >= 3)) stars = 3;
  else if (matchedThemes.length === 1) stars = 2;
  else if (flatMatchCount >= 3) stars = 2;
  else if (flatMatchCount >= 1) stars = 1;

  const totalKw = flatKeywords.length + themes.reduce((s, t) => s + t.keywords.length, 0);
  const score = totalKw > 0 ? Math.min(1, (matchedThemes.length + flatMatchCount + themeMatchCount * 0.3) / Math.max(totalKw * 0.2, 1)) : 0;
  return { stars, matchedThemes, score };
}

// ── AI Relevance Scoring (연구실 맥락 기반) ──────────
async function aiRelevanceScore(
  papers: Array<{ title: string; description: string; journal: string; matchedThemes: string[]; stars: number }>,
  themes: ResearchTheme[],
  labContext: string,
): Promise<Map<string, { stars: number; reason: string }>> {
  const results = new Map<string, { stars: number; reason: string }>();
  if (papers.length === 0) return results;

  // 배치로 처리 (최대 20편씩)
  const batches: typeof papers[] = [];
  for (let i = 0; i < papers.length; i += 20) {
    batches.push(papers.slice(i, i + 20));
  }

  for (const batch of batches) {
    const paperList = batch.map((p, i) =>
      `[${i + 1}] "${p.title}" (${p.journal})\n    키워드 스코어: ★${p.stars} (매칭 테마: ${p.matchedThemes.join(', ') || '없음'})\n    초록: ${p.description.slice(0, 400)}`
    ).join('\n\n');

    const prompt = `당신은 바이오센서/유연전자소자 분야 연구 논문 큐레이터입니다.

아래는 연구실의 핵심 연구 테마입니다:
${themes.map(t => `- ${t.name}: ${t.keywords.join(', ')}`).join('\n')}

${labContext ? `연구실 추가 맥락:\n${labContext}\n` : ''}

아래 논문들은 키워드 매칭으로 사전 필터링되었으며, 각 논문에 **키워드 스코어**(참고값)가 표시되어 있습니다.
이 스코어를 참고하되, 논문의 실제 내용(방법론, 소재, 응용 분야)을 기반으로 관련도를 재평가하세요.

**중요 지침 — 너무 엄격하게 보지 말고, 가능성에 대해 관대하게 평가하세요:**
- 키워드 스코어가 ★2~3인 논문은 명확한 이유가 없는 한 ★1로 강등하지 마세요.
- "키워드 스코어 ★0"으로 표시된 논문도 있을 수 있습니다. 의미적으로 관련이 있다면 ★1~2로 승격해주세요.
- 초록이 짧거나 description이 거의 없어도, 제목만으로 관련 가능성이 보이면 ★1을 기본으로 부여하세요.
- 직접 키워드가 일치하지 않더라도 다음 분야는 모두 관련 있다고 봅니다:
  · 유연/스트레처블 전자소자, 웨어러블 센서, 바이오인터페이스
  · 폴리머/하이드로겔/고분자 소재 (특히 의료용/바이오용)
  · 표면 처리/접착/항균 코팅 (특히 임플란트/의료기기 응용)
  · 나노소재(나노입자, 나노섬유 등)의 생체 응용
  · 뉴럴 인터페이스, BCI, 신경 전극, 신경 자극
  · 액체금속, 전도성 잉크, 인쇄 전자
- 같은 폴리머라도 응용이 medical/bioelectronic이면 ★2 이상 적극 부여하세요.
- ★2 논문에는 "이 논문의 어떤 부분이 연구실과 관련 있어서 확인을 추천하는지" 구체적으로 설명하세요.

${paperList}

각 논문에 대해 다음 JSON 배열로만 응답하세요:
[{"id": 1, "stars": 1~3, "reason": "관련 이유 또는 확인 추천 코멘트 (2문장 이내)"}]

stars 기준 (관대하게):
- 3: 연구실 핵심 테마와 직접 관련. 방법론·소재·응용이 연구실에서 즉시 활용 가능.
- 2: 인접 분야이며 참고/검토할 가치 있음. 의미적으로 연구실 테마와 겹침.
- 1: 같은 분야이나 직접 연관은 낮음. 동향 파악·인사이트 목적.`;

    try {
      if (env.ANTHROPIC_API_KEY) {
        const Anthropic = (await import('@anthropic-ai/sdk')).default;
        const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2048,
          temperature: 0.1,
          messages: [{ role: 'user', content: prompt }],
        });
        logApiCost('system', 'claude-sonnet-4-20250514', response.usage.input_tokens, response.usage.output_tokens, 'paper_relevance_score').catch(() => {});
        const text = response.content.find(b => b.type === 'text');
        if (text && text.type === 'text') {
          const match = text.text.match(/\[[\s\S]*\]/);
          if (match) {
            const scored = JSON.parse(match[0]) as Array<{ id: number; stars: number; reason: string }>;
            for (const s of scored) {
              const paper = batch[s.id - 1];
              if (paper) results.set(paper.title, { stars: Math.min(3, Math.max(1, s.stars)), reason: s.reason });
            }
          }
        }
      }
    } catch (err) {
      console.warn('[paper-alert] AI relevance scoring failed, using keyword scores:', err);
      // Fallback: 키워드 스코어 그대로 사용
      for (const p of batch) {
        results.set(p.title, { stars: p.stars, reason: '' });
      }
    }
  }

  return results;
}

// ── CrossRef ────────────────────────────────────────
async function enrichWithCrossRef(doi: string) {
  try {
    const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      headers: { 'User-Agent': 'ResearchFlow/1.0 (mailto:contact@researchflow.app)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const work = (await res.json()).message;
    return {
      abstract: work.abstract?.replace(/<[^>]+>/g, '').trim(),
      authors: work.author?.map((a: any) => `${a.given || ''} ${a.family || ''}`.trim()),
    };
  } catch { return null; }
}

// ── AI Summary (Opus 4.6 — 논문 요약은 깊은 이해 필요) ──
async function generatePaperSummary(title: string, abstract: string, matchedThemes: string[]) {
  const ctx = matchedThemes.length > 0 ? `관련 연구 테마: ${matchedThemes.join(', ')}\n` : '';
  const prompt = `다음 논문의 핵심 기여(novelty)와 방법론을 한국어 2~3문장으로 요약하세요.
- 이 논문이 기존 연구 대비 무엇이 새로운지 명확히 짚어주세요.
- 구체적 수치, 소재, 방법이 있으면 반드시 포함하세요.
- 해당 분야 연구자가 읽었을 때 "이 논문을 읽어야 하는 이유"가 드러나야 합니다.
- 응답에 이모지를 절대 사용하지 마라.

${ctx}제목: ${title}
초록: ${abstract.slice(0, 2000)}

요약:`;

  // Opus 4.6 우선, fallback → Sonnet → Gemini
  if (env.ANTHROPIC_API_KEY) {
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const response = await anthropic.messages.create({
        model: 'claude-opus-4-20250514',
        max_tokens: 1024,
        temperature: 0.2,
        messages: [{ role: 'user', content: prompt }],
      });
      logApiCost('system', 'claude-opus-4-20250514', response.usage.input_tokens, response.usage.output_tokens, 'paper_summary').catch(() => {});
      const text = response.content.find(b => b.type === 'text');
      if (text && text.type === 'text') return text.text.trim();
    } catch (err) {
      console.warn('Opus paper summary failed, trying Sonnet:', err);
      // Sonnet fallback
      try {
        const Anthropic = (await import('@anthropic-ai/sdk')).default;
        const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          temperature: 0.2,
          messages: [{ role: 'user', content: prompt }],
        });
        logApiCost('system', 'claude-sonnet-4-20250514', response.usage.input_tokens, response.usage.output_tokens, 'paper_summary_fallback').catch(() => {});
        const text = response.content.find(b => b.type === 'text');
        if (text && text.type === 'text') return text.text.trim();
      } catch { /* fall through to Gemini */ }
    }
  }

  // Gemini fallback (Anthropic 키 없을 때)
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch { return ''; }
}

// ── 주간 논문 동향 분석 (Sonnet) ──────────────────────
async function generateWeeklyInsight(
  papers: Array<{ title: string; journal: string; stars: number; matchedThemes: string[]; description: string }>,
  journals: string[],
  themes: ResearchTheme[],
  totalFetched: number,
): Promise<string> {
  const themeNames = themes.map(t => t.name);

  // ★ 등급별 분리
  const coreStar2Plus = papers.filter(p => p.stars >= 2);
  const referenceStar1 = papers.filter(p => p.stars === 1);

  // 테마별 통계 — ★2 이상(핵심)만 카운트 (테마별 분포는 핵심 논문 기준)
  const themeCount: Record<string, number> = {};
  for (const p of coreStar2Plus) {
    for (const t of p.matchedThemes) {
      themeCount[t] = (themeCount[t] || 0) + 1;
    }
  }
  const themeStats = Object.entries(themeCount).sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t}(${c}편)`).join(', ') || '(없음)';

  // 핵심 논문 목록 (★★★, ★★)
  const topPapers = coreStar2Plus.slice(0, 10);
  const paperList = topPapers.map(p =>
    `- [★${'★'.repeat(p.stars - 1)}] ${p.title} (${p.journal}) — 테마: ${p.matchedThemes.join(', ')}`
  ).join('\n') || '(없음)';

  const prompt = `당신은 바이오센서/유연전자소자 연구 분야의 전문 분석가입니다.

### 이번 주 수집 통계 (사실 — 정확히 이 숫자만 사용)
- 저널 수: ${journals.length}개
- RSS 총 수집량: ${totalFetched.toLocaleString()}편 (raw)
- 키워드 매칭 후 관련 논문: ${papers.length}편
  - 핵심 ★2 이상: ${coreStar2Plus.length}편 (단일 또는 복수 테마 직접 매칭)
  - 참고 ★1: ${referenceStar1.length}편 (일반 키워드만 매칭, 관련도 낮음)
- 핵심 테마별 분포 (★2+ 기준): ${themeStats}
- 연구실 5대 테마 목록: ${themeNames.join(', ')}

### 핵심 논문 목록 (★2 이상)
${paperList}

위 내용을 바탕으로 이번 주 연구 동향 시사점을 3~5문장의 전문 분석으로 작성하세요.

요구사항:
1. 어떤 테마가 활발한지, 구체적 논문명과 저널을 인용하며 설명
2. 복수 테마에 걸치는 논문이 있다면 왜 중요한지 분석
3. 연구 트렌드나 새로운 방향성이 보이면 짚어주세요
4. "~편이 수집되었습니다" 같은 단순 나열 대신 "왜 이것이 중요한지" 분석 관점
5. 이모지 사용 금지. 전문적이고 간결한 한국어로 작성.
6. 마크다운 볼드(**키워드**)를 적극 활용하여 핵심 포인트를 강조.
7. **숫자 사용 규칙 (절대 준수)**:
   - 편수/개수를 언급할 때는 반드시 위 "이번 주 수집 통계" 섹션의 정확한 숫자만 사용하세요.
   - 예시 허용: "하이드로겔 ${themeCount['하이드로겔'] || 0}편", "핵심 ${coreStar2Plus.length}편", "총 ${papers.length}편 관련"
   - 예시 금지: "하이드로겔 19편", "20편" 등 통계 섹션에 없는 숫자는 절대 만들어내지 마세요.
   - 편수 언급이 꼭 필요하지 않으면 아예 생략하고 정성적 분석에 집중하세요.

시사점:`;

  // Sonnet 사용 (비용 효율적 + 고품질 분석)
  if (env.ANTHROPIC_API_KEY) {
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }],
      });
      logApiCost('system', 'claude-sonnet-4-20250514', response.usage.input_tokens, response.usage.output_tokens, 'weekly_insight').catch(() => {});
      const text = response.content.find(b => b.type === 'text');
      if (text && text.type === 'text') return text.text.trim();
    } catch (err) {
      console.warn('Sonnet weekly insight failed:', err);
    }
  }

  // Gemini fallback
  try {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const result = await model.generateContent(prompt);
    const usage = result.response.usageMetadata;
    if (usage) logApiCost('system', 'gemini-2.5-flash', usage.promptTokenCount ?? 0, usage.candidatesTokenCount ?? 0, 'weekly_insight_fallback').catch(() => {});
    return result.response.text().trim();
  } catch { return ''; }
}

// ── RSS URL 추측 ────────────────────────────────────
function guessRssUrl(source: any): string | null {
  const homepage = source.homepage_url || '';
  const issn = source.issn?.[0];
  if (homepage.includes('nature.com')) {
    const m = homepage.match(/nature\.com\/([a-z]+)/); if (m) return `https://www.nature.com/${m[1]}.rss`;
  }
  if (homepage.includes('science.org')) {
    const m = homepage.match(/journal\/([a-z]+)/); if (m) return `https://www.science.org/action/showFeed?type=etoc&feed=rss&jc=${m[1]}`;
  }
  if (homepage.includes('wiley.com') && issn) return `https://onlinelibrary.wiley.com/action/showFeed?jc=${issn.replace('-', '')}&type=etoc&feed=rss`;
  if (homepage.includes('pubs.acs.org')) {
    const m = homepage.match(/journal\/([a-z]+)/); if (m) return `https://pubs.acs.org/action/showFeed?type=etoc&feed=rss&jc=${m[1]}`;
  }
  if (homepage.includes('cell.com')) {
    const m = homepage.match(/cell\.com\/([^/]+)/); if (m) return `https://www.cell.com/${m[1]}/rss`;
  }
  if (issn) return `https://rss.sciencedirect.com/publication/science/${issn.replace('-', '')}`;
  return null;
}

// ── 크롤링 실행 함수 (라우트 + cron 공용) ────────────
export async function runPaperCrawl(
  alert: { id: string; keywords: string[]; journals: string[]; customFeeds: any; lastRunAt: Date | null },
  lab: { id: string; researchThemes: any },
) {
  // Lab researchThemes 사용, 없거나 키워드가 부족하면 기본 5대 테마로 fallback
  let themes = (lab.researchThemes as ResearchTheme[] | null) || [];
  const totalThemeKeywords = themes.reduce((s, t) => s + (t.keywords?.length || 0), 0);
  if (themes.length === 0 || totalThemeKeywords < 10) {
    themes = DEFAULT_RESEARCH_THEMES;
  }
  const flatKeywords = alert.keywords as string[];

  // T_last: lastRunAt 이후 논문만 수집 (첫 실행이면 최근 2주)
  const isFirstRunPaper = !alert.lastRunAt;
  const tLast = alert.lastRunAt || new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const paperFetchNotice = describePaperFetchRange(tLast, isFirstRunPaper);

  // 크롤링 대상
  const feeds: Array<{ name: string; rssUrl: string }> = [];
  for (const name of alert.journals) {
    const j = JOURNAL_BY_NAME.get(name);
    if (j?.rssUrl) feeds.push({ name: j.name, rssUrl: j.rssUrl });
  }
  feeds.push(...((alert.customFeeds as Array<{ name: string; rssUrl: string }> | null) || []).filter(f => f.rssUrl));

  if (feeds.length === 0) return { totalFetched: 0, matched: 0, newSaved: 0, journals: [], breakdown: { threeStars: 0, twoStars: 0, oneStar: 0 } };

  // 병렬 RSS
  const allItems = (await Promise.all(
    feeds.map(async f => (await parseRssFeed(f.rssUrl)).map(item => ({ ...item, journal: f.name })))
  )).flat();

  // T_last 날짜 필터: pubDate가 lastRunAt 이후인 것만
  const afterTLast = allItems.filter(item => {
    if (!item.pubDate) return true; // pubDate 없으면 포함 (ACS 등 일부 저널)
    try {
      const pubMs = new Date(item.pubDate).getTime();
      return pubMs >= tLast.getTime();
    } catch { return true; }
  });

  // 1차 필터: 키워드 매칭 (빠른 pre-filter)
  const allScored = afterTLast.map(item => ({ ...item, ...scoreByThemes(item, themes, flatKeywords) }));
  const keywordMatched = allScored
    .filter(item => item.stars > 0)
    .sort((a, b) => b.stars - a.stars || b.score - a.score);

  // ★0 (키워드 미매칭) 중에서도 의미적으로 관련 가능한 후보를 일부 AI 평가에 포함:
  // RSS description이 짧아 substring 매칭 실패 가능성 → 제목/저널 기반으로 일부 샘플링.
  // 키워드 매칭이 너무 적을 때(< 30편)에만 추가 후보 수집 (AI 비용 통제).
  let extraCandidates: typeof allScored = [];
  if (keywordMatched.length < 30) {
    const matchedTitles = new Set(keywordMatched.map(i => i.title));
    extraCandidates = allScored
      .filter(item => item.stars === 0 && !matchedTitles.has(item.title))
      // 가벼운 휴리스틱: title/desc 길이가 어느 정도 있고 (스팸/공지가 아님), 영문 위주 (논문일 가능성)
      .filter(item => item.title.length >= 20 && /^[a-zA-Z\s\d\-:.,()]+$/.test(item.title.slice(0, 50)))
      .slice(0, Math.max(0, 30 - keywordMatched.length))
      .map(item => ({ ...item, stars: 1 as 0 | 1 | 2 | 3 })); // 임시로 ★1로 마킹 → AI가 재평가
  }

  const aiInputCandidates = [...keywordMatched, ...extraCandidates];

  // 2차 필터: AI 관련도 평가 (연구실 맥락 기반)
  let labContext = '';
  try {
    const labData = await prisma.lab.findUnique({
      where: { id: lab.id },
      include: { projects: { where: { status: 'active' }, take: 10 }, publications: { take: 10, orderBy: { year: 'desc' } } },
    });
    if (labData) {
      const parts: string[] = [];
      if (labData.researchFields?.length > 0) parts.push(`연구 분야: ${labData.researchFields.join(', ')}`);
      if (labData.projects.length > 0) parts.push(`진행 과제: ${labData.projects.map(p => `${p.name}(${p.funder || ''})`).join(', ')}`);
      if (labData.publications.length > 0) parts.push(`최근 논문: ${labData.publications.map(p => p.title).join(', ')}`);
      labContext = parts.join('\n');
    }
  } catch (err) { console.warn('[paper-alert] Lab context fetch failed:', err); }

  const aiScores = await aiRelevanceScore(aiInputCandidates, themes, labContext);

  // AI 스코어 적용 (AI 결과 있으면 교체, 없으면 키워드 스코어 유지)
  // 단 extraCandidates(★0 출신)는 AI 결과 없으면 결과에서 제외 (의미 매칭 실패).
  const matchedTitleSet = new Set(keywordMatched.map(i => i.title));
  const scored = aiInputCandidates
    .map(item => {
      const aiResult = aiScores.get(item.title);
      return aiResult ? { ...item, stars: aiResult.stars, aiReason: aiResult.reason } : { ...item, aiReason: '' };
    })
    .filter(item => {
      // 키워드 매칭은 무조건 통과, 추가 후보(★0 출신)는 AI가 ★2+ 줬을 때만 통과
      if (matchedTitleSet.has(item.title)) return true;
      return item.stars >= 2;
    })
    .sort((a, b) => b.stars - a.stars || b.score - a.score)
    .slice(0, 100); // 50 → 100편으로 확대

  // 매칭 키워드 추출 함수 — scoreByThemes와 동일한 매칭 규칙 사용
  function extractMatchedKeywords(item: { title: string; description: string }, themesArr: ResearchTheme[], flatKw: string[]): string[] {
    const text = `${item.title} ${item.description}`;
    const matched: string[] = [];
    for (const t of themesArr) {
      for (const kw of t.keywords) { if (matchKeyword(text, kw) && !matched.includes(kw)) matched.push(kw); }
    }
    for (const kw of flatKw) { if (matchKeyword(text, kw) && !matched.includes(kw)) matched.push(kw); }
    return matched;
  }

  // 저장 (제목 기반 중복 제거 + CrossRef + AI 요약)
  let savedCount = 0;
  for (const item of scored) {
    if (await prisma.paperAlertResult.findFirst({ where: { alertId: alert.id, title: item.title } })) continue;

    let enrichedAbstract = item.description, enrichedAuthors = item.authors;
    if (item.doi && item.stars >= 2) {
      const cr = await enrichWithCrossRef(item.doi);
      if (cr?.abstract) enrichedAbstract = cr.abstract;
      if (cr?.authors) enrichedAuthors = cr.authors.join(', ');
    }
    // ★2+ 상세 요약, ★1 간단 요약
    const summary = item.stars >= 2
      ? await generatePaperSummary(item.title, enrichedAbstract, item.matchedThemes)
      : enrichedAbstract.length > 50
        ? enrichedAbstract.slice(0, 200).replace(/\s+\S*$/, '') + '…'
        : '';

    const mKeywords = extractMatchedKeywords(item, themes, flatKeywords);

    try {
      await prisma.paperAlertResult.create({
        data: {
          alertId: alert.id, title: item.title, authors: enrichedAuthors,
          journal: item.journal, pubDate: item.pubDate ? new Date(item.pubDate) : null,
          url: item.link, doi: item.doi, abstract: enrichedAbstract.slice(0, 3000),
          aiSummary: summary, aiReason: (item as any).aiReason || null,
          relevance: item.score, stars: item.stars, themes: item.matchedThemes,
          matchedKeywords: mKeywords,
        },
      });
    } catch {
      // 새 컬럼(aiReason, matchedKeywords)이 없으면 기존 필드만으로 저장
      await prisma.paperAlertResult.create({
        data: {
          alertId: alert.id, title: item.title, authors: enrichedAuthors,
          journal: item.journal, pubDate: item.pubDate ? new Date(item.pubDate) : null,
          url: item.link, doi: item.doi, abstract: enrichedAbstract.slice(0, 3000),
          aiSummary: summary, relevance: item.score, stars: item.stars, themes: item.matchedThemes,
        },
      });
    }
    savedCount++;
  }

  // 주간 분석 생성 (Sonnet으로 전문 분석) — DB에 저장
  let weeklyInsight = '';
  if (scored.length > 0) {
    try {
      weeklyInsight = await generateWeeklyInsight(scored, feeds.map(f => f.name), themes, allItems.length);
    } catch (err) {
      console.warn('Weekly insight generation failed:', err);
    }
  }

  // T_last 업데이트 + 통계/시사점 저장 (새 컬럼 없으면 graceful fallback)
  try {
    await prisma.paperAlert.update({
      where: { id: alert.id },
      data: {
        lastRunAt: new Date(),
        lastTotalFetched: allItems.length,
        lastWeeklyInsight: weeklyInsight || null,
      },
    });
  } catch {
    // 새 컬럼이 아직 DB에 없으면 lastRunAt만 업데이트
    await prisma.paperAlert.update({
      where: { id: alert.id },
      data: { lastRunAt: new Date() },
    });
  }

  return {
    totalFetched: allItems.length,
    afterTLastFilter: afterTLast.length,
    matched: scored.length,
    newSaved: savedCount,
    tLast: tLast.toISOString(),
    journals: feeds.map(f => f.name),
    weeklyInsight,
    breakdown: {
      threeStars: scored.filter(s => s.stars === 3).length,
      twoStars: scored.filter(s => s.stars === 2).length,
      oneStar: scored.filter(s => s.stars === 1).length,
    },
    ...(paperFetchNotice ? { fetchRangeNotice: paperFetchNotice } : {}),
  };
}

// ── Routes ──────────────────────────────────────────
export async function paperAlertRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authMiddleware);

  // ── 분야별 추천 저널 ─────────────────────────────
  app.get('/api/papers/journals/fields', async (_req, reply) => {
    const fieldMap: Record<string, Array<{ name: string; publisher: string; hasRss: boolean }>> = {};
    for (const field of ALL_FIELDS) {
      fieldMap[field] = BUILT_IN_JOURNALS
        .filter(j => j.fields.includes(field))
        .map(j => ({ name: j.name, publisher: j.publisher, hasRss: !!j.rssUrl }));
    }
    return reply.send({ fields: ALL_FIELDS, journalsByField: fieldMap, totalJournals: BUILT_IN_JOURNALS.length });
  });

  // ── 저널명/키워드 검색 (OpenAlex) ─────────────────
  app.post('/api/papers/journals/search', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = z.object({ query: z.string().min(1) }).parse(request.body);

    // 1. built-in 목록에서 먼저 검색
    const queryLower = body.query.toLowerCase();
    const builtInMatches = BUILT_IN_JOURNALS
      .filter(j => j.name.toLowerCase().includes(queryLower))
      .map(j => ({ name: j.name, publisher: j.publisher, rssUrl: j.rssUrl || null, source: 'built-in' as const, citedByCount: 0 }));

    // 2. OpenAlex에서 검색
    let openAlexResults: any[] = [];
    try {
      const res = await fetch(
        `https://api.openalex.org/sources?search=${encodeURIComponent(body.query)}&filter=type:journal&per_page=15&mailto=contact@researchflow.app`,
        { signal: AbortSignal.timeout(10000) },
      );
      if (res.ok) {
        const data = await res.json();
        openAlexResults = (data.results || [])
          .filter((s: any) => !JOURNAL_BY_NAME.has(s.display_name))
          .map((s: any) => ({
            name: s.display_name,
            publisher: s.host_organization_name || null,
            rssUrl: guessRssUrl(s),
            source: 'openalex' as const,
            citedByCount: s.cited_by_count || 0,
          }));
      }
    } catch { /* OpenAlex 실패 시 built-in만 반환 */ }

    return reply.send({ results: [...builtInMatches, ...openAlexResults].slice(0, 20) });
  });

  // ── 저널 추가 (이름 또는 RSS) ─────────────────────
  app.post('/api/papers/journals/add', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (!lab) return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });

    const body = z.object({
      name: z.string().min(1),
      rssUrl: z.string().url().optional(),
    }).parse(request.body);

    const alert = await prisma.paperAlert.findFirst({ where: { labId: lab.id } });
    if (!alert) return reply.code(404).send({ error: '논문 알림 설정이 없습니다.' });

    // 최대 개수 체크
    const currentCount = alert.journals.length + ((alert.customFeeds as any[] | null) || []).length;
    if (currentCount >= MAX_JOURNALS) {
      return reply.code(400).send({ error: `최대 ${MAX_JOURNALS}개 저널까지 추가할 수 있습니다. 기존 저널을 삭제 후 추가해주세요.` });
    }

    // built-in 저널인지 확인
    const builtIn = JOURNAL_BY_NAME.get(body.name);
    if (builtIn) {
      if (alert.journals.includes(body.name)) {
        return reply.send({ success: true, message: '이미 등록된 저널입니다.' });
      }
      await prisma.paperAlert.update({
        where: { id: alert.id },
        data: { journals: [...alert.journals, body.name] },
      });
      return reply.send({ success: true, type: 'built-in', name: body.name });
    }

    // 커스텀 저널 추가
    let rssUrl = body.rssUrl;
    if (!rssUrl) {
      // OpenAlex에서 RSS URL 자동 검색
      try {
        const res = await fetch(
          `https://api.openalex.org/sources?search=${encodeURIComponent(body.name)}&filter=type:journal&per_page=1&mailto=contact@researchflow.app`,
          { signal: AbortSignal.timeout(8000) },
        );
        if (res.ok) {
          const data = await res.json();
          if (data.results?.[0]) rssUrl = guessRssUrl(data.results[0]) || undefined;
        }
      } catch { /* ignore */ }
    }

    if (!rssUrl) {
      return reply.code(400).send({
        error: `"${body.name}"의 RSS URL을 자동으로 찾지 못했습니다. RSS URL을 직접 입력해주세요.`,
      });
    }

    // RSS 유효성 검증
    const items = await parseRssFeed(rssUrl);
    if (items.length === 0) {
      return reply.code(400).send({ error: 'RSS 피드에서 논문을 가져올 수 없습니다. URL을 확인해주세요.' });
    }

    const existing = (alert.customFeeds as any[] | null) || [];
    if (existing.some((f: any) => f.name === body.name || f.rssUrl === rssUrl)) {
      return reply.send({ success: true, message: '이미 등록된 피드입니다.' });
    }

    await prisma.paperAlert.update({
      where: { id: alert.id },
      data: {
        customFeeds: [...existing, { name: body.name, rssUrl, publisher: '' }] as any,
      },
    });

    return reply.send({ success: true, type: 'custom', name: body.name, rssUrl, sampleCount: items.length });
  });

  // ── 알림 설정 조회 (설정 없으면 Lab 테마 기반 자동 생성) ─
  app.get('/api/papers/alerts', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (!lab) return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });
    let alerts = await prisma.paperAlert.findMany({ where: { labId: lab.id } });

    // 설정이 없거나 저널이 비어있으면 Lab researchThemes 기반 자동 복원
    if (alerts.length === 0 || (alerts[0] && alerts[0].journals.length === 0)) {
      const themes = (lab.researchThemes as ResearchTheme[] | null) || [];
      const autoKeywords = themes.flatMap(t => t.keywords || []);
      // 연구 분야에 맞는 기본 저널 추천 (재료/센서/바이오/나노/화학 중심)
      const defaultJournals = [
        'Nature', 'Science', 'Nature Materials', 'Nature Nanotechnology',
        'Nature Biomedical Engineering', 'Nature Electronics', 'Science Advances',
        'Science Robotics', 'Advanced Materials', 'Advanced Functional Materials',
        'Nature Sensors', 'Nature Chemical Engineering', 'ACS Nano', 'ACS Sensors',
      ].filter(j => JOURNAL_BY_NAME.has(j));

      if (alerts.length === 0) {
        const created = await prisma.paperAlert.create({
          data: {
            labId: lab.id,
            keywords: autoKeywords.length > 0 ? autoKeywords : (lab.researchFields || []),
            journals: defaultJournals,
            schedule: 'weekly',
          },
        });
        alerts = [created];
        console.log(`[paper-alert] Auto-created alert for lab ${lab.id} with ${defaultJournals.length} journals, ${autoKeywords.length} keywords`);
      } else if (alerts[0].journals.length === 0) {
        const updated = await prisma.paperAlert.update({
          where: { id: alerts[0].id },
          data: {
            journals: defaultJournals,
            keywords: autoKeywords.length > 0 ? autoKeywords : alerts[0].keywords,
          },
        });
        alerts = [updated];
        console.log(`[paper-alert] Auto-restored journals for alert ${alerts[0].id}`);
      }
    }

    const fieldMap: Record<string, string[]> = {};
    for (const field of ALL_FIELDS) {
      fieldMap[field] = BUILT_IN_JOURNALS.filter(j => j.fields.includes(field)).map(j => j.name);
    }
    // 다음 실행 예정 시간 계산
    const primaryAlert = alerts[0];
    let nextRunEstimate: string | null = null;
    if (primaryAlert?.lastRunAt && primaryAlert.schedule !== 'manual') {
      const lastRun = new Date(primaryAlert.lastRunAt);
      const interval = 7 * 24 * 60 * 60 * 1000; // weekly
      nextRunEstimate = new Date(lastRun.getTime() + interval).toISOString();
    }

    return {
      alerts,
      availableJournals: BUILT_IN_JOURNALS.filter(j => !!j.rssUrl).map(j => j.name),
      journalCategories: fieldMap,
      maxJournals: MAX_JOURNALS,
      researchThemes: (lab.researchThemes as ResearchTheme[] | null) || [],
      scheduleOptions: ['weekly', 'manual'],
      nextRunEstimate,
    };
  });

  // ── 알림 설정 생성/수정 ───────────────────────────
  app.post('/api/papers/alerts', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (!lab) return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });
    const body = alertSettingSchema.parse(request.body);

    // 키워드 비어있으면 Lab 연구 테마 키워드로 자동 채움
    let keywords = body.keywords;
    if (keywords.length === 0 && lab.researchThemes) {
      const themes = lab.researchThemes as Array<{ name: string; keywords: string[] }>;
      keywords = themes.flatMap(t => t.keywords || []);
      if (keywords.length === 0) keywords = lab.researchFields || [];
    }

    const totalJournals = (body.journals?.length || 0) + (body.customFeeds?.length || 0);
    if (totalJournals > MAX_JOURNALS) {
      return reply.code(400).send({ error: `최대 ${MAX_JOURNALS}개 저널까지 설정할 수 있습니다.` });
    }

    const existing = await prisma.paperAlert.findFirst({ where: { labId: lab.id } });
    if (existing) {
      return prisma.paperAlert.update({
        where: { id: existing.id },
        data: {
          keywords,
          journals: body.journals || [],
          customFeeds: body.customFeeds ? (body.customFeeds as any) : existing.customFeeds,
          schedule: body.schedule,
        },
      });
    }
    return reply.code(201).send(await prisma.paperAlert.create({
      data: {
        labId: lab.id, keywords,
        journals: body.journals || [],
        customFeeds: body.customFeeds ? (body.customFeeds as any) : undefined,
        schedule: body.schedule,
      },
    }));
  });

  // ── 수동 크롤링 (즉시 응답 + 백그라운드 실행) ──────
  app.post('/api/papers/alerts/run', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (!lab) return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });
    const alert = await prisma.paperAlert.findFirst({ where: { labId: lab.id, active: true } });
    if (!alert) return reply.code(404).send({ error: '논문 알림 설정이 없습니다.' });

    // 7일 이내 재실행 차단 (단, 설정 변경 시 예외)
    if (alert.lastRunAt) {
      const daysSinceLastRun = (Date.now() - alert.lastRunAt.getTime()) / (1000 * 60 * 60 * 24);
      const configChanged = alert.updatedAt.getTime() > alert.lastRunAt.getTime();

      if (daysSinceLastRun < 7 && !configChanged) {
        const nextRunDate = new Date(alert.lastRunAt.getTime() + 7 * 24 * 60 * 60 * 1000);
        const daysLeft = Math.ceil(7 - daysSinceLastRun);
        return reply.code(429).send({
          error: `논문 모니터링은 주 1회 실행됩니다. ${daysLeft}일 후(${nextRunDate.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' })})에 다시 실행할 수 있습니다.`,
          nextAvailableAt: nextRunDate.toISOString(),
        });
      }
    }

    // 즉시 응답 — 수집은 백그라운드에서 진행
    reply.send({ success: true, status: 'started', message: '수집을 시작했습니다. 완료되면 결과가 업데이트됩니다.' });

    // 백그라운드 실행
    runPaperCrawl(alert, lab).catch(err => {
      console.error('[paper-alert] Background crawl failed:', err.message || err);
    });
  });

  // ── 결과 목록 ────────────────────────────────────
  app.get('/api/papers/alerts/results', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (!lab) return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });
    const alert = await prisma.paperAlert.findFirst({ where: { labId: lab.id } });
    if (!alert) return { results: [], unreadCount: 0, grouped: {} };

    const q = z.object({
      unread: z.enum(['true', 'false']).optional(),
      stars: z.coerce.number().min(1).max(3).optional(),
      theme: z.string().optional(),
    }).parse(request.query || {});

    const where: any = { alertId: alert.id };
    if (q.unread === 'true') where.read = false;
    if (q.stars) where.stars = { gte: q.stars };
    if (q.theme) where.themes = { has: q.theme };

    const results = await prisma.paperAlertResult.findMany({
      where, orderBy: [{ stars: 'desc' }, { relevance: 'desc' }, { createdAt: 'desc' }], take: 50,
    });
    const unreadCount = await prisma.paperAlertResult.count({ where: { alertId: alert.id, read: false } });

    const grouped: Record<string, typeof results> = {};
    for (const r of results) {
      for (const t of ((r.themes as string[]) || ['기타'])) {
        if (!grouped[t]) grouped[t] = [];
        grouped[t].push(r);
      }
    }
    return {
      results, unreadCount, grouped, journals: alert.journals,
      totalFetched: (alert as any).lastTotalFetched ?? null,
      weeklyInsight: (alert as any).lastWeeklyInsight ?? null,
    };
  });

  // ── 읽음 표시 ────────────────────────────────────
  app.patch('/api/papers/alerts/results/:id', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    await prisma.paperAlertResult.update({ where: { id: request.params.id }, data: { read: true } });
    return { success: true };
  });

  // ── 결과 초기화 (설정 유지, 결과만 삭제) ──────────
  app.delete('/api/papers/alerts/results', async (request: FastifyRequest, reply: FastifyReply) => {
    const lab = await prisma.lab.findUnique({ where: { ownerId: request.userId! } });
    if (!lab) return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });
    const alert = await prisma.paperAlert.findFirst({ where: { labId: lab.id } });
    if (!alert) return reply.code(404).send({ error: '논문 알림 설정이 없습니다.' });

    const deleted = await prisma.paperAlertResult.deleteMany({ where: { alertId: alert.id } });
    await prisma.paperAlert.update({ where: { id: alert.id }, data: { lastRunAt: null } });

    return { success: true, deleted: deleted.count, message: '결과 초기화 완료. 다시 수집하면 최근 2주분을 새로 가져옵니다.' };
  });
}
