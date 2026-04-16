/**
 * Heavy User 시뮬레이션 v2 — 전체 풀 INSERT.
 *
 * 입력: articles-{projects,meetings,autopcb,people,extra}.json
 * 작업: wiki_articles 테이블에 upsert (title conflict 시 덮어씀)
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { prisma } from '../src/config/prisma.js';

const LAB_ID = (process.env.LAB_ID ?? '').replace(/^"|"$/g, '');
if (!LAB_ID) { console.error('LAB_ID 없음'); process.exit(1); }

const SIM_TAG = 'sim-by-claude-code';

type Article = {
  title: string;
  category: string;
  content: string;
  tags: string[];
  sources: Array<{ type: string; id: string; date?: string }>;
};

function generateId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 9);
  return `c${t}${r}`;
}

function loadArticles(fileName: string): Article[] {
  const p = path.join(process.cwd(), 'scripts', fileName);
  if (!fs.existsSync(p)) {
    console.warn(`  (skip) ${fileName} 없음`);
    return [];
  }
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const arts = raw.articles ?? [];
  console.log(`  ${fileName}: ${arts.length}개`);
  return arts;
}

async function main() {
  console.log(`\n[full-insert] LAB_ID=${LAB_ID}\n`);

  const files = [
    'articles-projects.json',
    'articles-meetings.json',
    'articles-autopcb.json',
    'articles-people.json',
    'articles-extra.json',
    'articles-insights.json',
  ];

  const all: Article[] = [];
  for (const f of files) all.push(...loadArticles(f));

  // 중복 title 체크 — 같은 제목이면 뒤에 나온 것으로 덮음
  const byTitle = new Map<string, Article>();
  let dupCount = 0;
  for (const a of all) {
    const t = (a.title ?? '').trim();
    if (!t) continue;
    if (byTitle.has(t)) dupCount++;
    byTitle.set(t, a);
  }
  const deduped = [...byTitle.values()];
  console.log(`\n총 ${all.length}개 로드, 중복 ${dupCount}개 머지 → 최종 ${deduped.length}개\n`);

  const now = new Date();
  let created = 0, updated = 0, failed = 0;
  const byCat: Record<string, number> = {};

  for (const a of deduped) {
    if (!a.title || !a.category || !a.content) { failed++; continue; }
    try {
      const existing = await prisma.wikiArticle.findFirst({
        where: { labId: LAB_ID, title: a.title },
        select: { id: true, version: true },
      });
      const tagsWithSim = [...new Set([...(a.tags ?? []), SIM_TAG])];
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
        LAB_ID,
        a.title,
        a.category,
        a.content,
        tagsWithSim,
        JSON.stringify(a.sources ?? []),
        now,
      );
      if (existing) updated++;
      else created++;
      byCat[a.category] = (byCat[a.category] ?? 0) + 1;
    } catch (err: any) {
      failed++;
      console.error(`  ✗ ${a.title} — ${err.message?.slice(0, 100)}`);
    }
  }

  console.log(`\n결과: 신규 ${created} / 업데이트 ${updated} / 실패 ${failed}`);
  console.log(`카테고리별:`, byCat);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
