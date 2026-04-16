/**
 * Heavy User 시뮬레이션 — Notion 샘플 페이지 fetch.
 *
 * 목적: Research Flow 알고리즘의 실제 데이터 품질 검증용.
 * deployed app의 env.NOTION_API_KEY로 접근 → app이 보는 것과 동일한 시야.
 *
 * 출력: scripts/heavy-user-sample.json — 아티클 분석용 raw 데이터
 */
import { Client } from '@notionhq/client';
import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const PROJECT_DB = '37e9d1e2155a4f1a8a17a12f271f8c7d';
const MEETING_DB = 'c2eeadfd525c4971a6cc849bdb8563fb';
const PAPER_TREND_PAGE = '312f9f17-6cf4-81b9-a4ca-f3c23c20b7c0';

// ── rich text → string ──────────────────────────────
function rtStr(rt: any[]): string {
  if (!Array.isArray(rt)) return '';
  return rt.map((t: any) => t.plain_text ?? '').join('');
}

// ── 블록 재귀 → 마크다운 (depth 무제한, visited 방지) ──
async function blocksToMd(blockId: string, depth = 0, visited = new Set<string>()): Promise<string> {
  if (visited.has(blockId) || visited.size > 500) return '';
  visited.add(blockId);

  const lines: string[] = [];
  const indent = '  '.repeat(depth);

  let cursor: string | undefined = undefined;
  do {
    const res: any = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });

    for (const b of res.results as any[]) {
      let line = '';
      switch (b.type) {
        case 'paragraph':         line = rtStr(b.paragraph?.rich_text ?? []); break;
        case 'heading_1':         line = '# ' + rtStr(b.heading_1?.rich_text ?? []); break;
        case 'heading_2':         line = '## ' + rtStr(b.heading_2?.rich_text ?? []); break;
        case 'heading_3':         line = '### ' + rtStr(b.heading_3?.rich_text ?? []); break;
        case 'bulleted_list_item':line = '- ' + rtStr(b.bulleted_list_item?.rich_text ?? []); break;
        case 'numbered_list_item':line = '1. ' + rtStr(b.numbered_list_item?.rich_text ?? []); break;
        case 'to_do':             line = (b.to_do?.checked ? '[x] ' : '[ ] ') + rtStr(b.to_do?.rich_text ?? []); break;
        case 'quote':             line = '> ' + rtStr(b.quote?.rich_text ?? []); break;
        case 'callout':           line = rtStr(b.callout?.rich_text ?? []); break;
        case 'toggle':            line = rtStr(b.toggle?.rich_text ?? []); break;
        case 'code':              line = '```\n' + rtStr(b.code?.rich_text ?? []) + '\n```'; break;
        case 'table_row':         line = '| ' + (b.table_row?.cells ?? []).map((c: any[]) => rtStr(c)).join(' | ') + ' |'; break;
        case 'child_page':        line = `[하위] ${b.child_page?.title ?? ''}`; break;
        case 'child_database':    line = `[DB] ${b.child_database?.title ?? ''}`; break;
      }
      if (line) lines.push(indent + line);

      if (b.has_children) {
        const sub = await blocksToMd(b.id, depth + 1, visited);
        if (sub) lines.push(sub);
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return lines.filter(Boolean).join('\n');
}

function getTitle(page: any): string {
  const props = page.properties ?? {};
  for (const key of Object.keys(props)) {
    const p = props[key];
    if (p.type === 'title' && Array.isArray(p.title)) {
      return rtStr(p.title) || '(제목 없음)';
    }
  }
  return '(제목 없음)';
}

function propsFlatten(props: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, p] of Object.entries(props)) {
    if (p.type === 'title') continue;
    let val: any = null;
    switch (p.type) {
      case 'rich_text':   val = rtStr(p.rich_text ?? []); break;
      case 'select':      val = p.select?.name ?? null; break;
      case 'multi_select':val = (p.multi_select ?? []).map((s: any) => s.name); break;
      case 'date':        val = p.date?.start ?? null; break;
      case 'checkbox':    val = p.checkbox; break;
      case 'number':      val = p.number; break;
      case 'status':      val = p.status?.name ?? null; break;
      case 'people':      val = (p.people ?? []).map((u: any) => u.name ?? ''); break;
    }
    if (val !== null && val !== '' && (!Array.isArray(val) || val.length > 0)) {
      out[key] = val;
    }
  }
  return out;
}

async function fetchDbPages(dbId: string, limit: number, sortProp?: string) {
  const q: any = { database_id: dbId, page_size: limit };
  if (sortProp) q.sorts = [{ property: sortProp, direction: 'descending' }];
  const res: any = await notion.databases.query(q);
  const pages = [];
  for (const page of res.results as any[]) {
    const title = getTitle(page);
    const props = propsFlatten(page.properties ?? {});
    let body = '';
    try { body = await blocksToMd(page.id); } catch { /* skip */ }
    pages.push({
      id: page.id,
      title,
      lastEditedTime: page.last_edited_time,
      props,
      body: body.slice(0, 20000),
      bodyLength: body.length,
    });
    console.log(`  ✓ ${title} (${body.length}자)`);
  }
  return pages;
}

async function fetchSinglePage(pageId: string) {
  const page: any = await notion.pages.retrieve({ page_id: pageId });
  const title = getTitle(page);
  const props = propsFlatten(page.properties ?? {});
  let body = '';
  try { body = await blocksToMd(pageId); } catch { /* skip */ }
  console.log(`  ✓ ${title} (${body.length}자)`);
  return {
    id: pageId,
    title,
    lastEditedTime: page.last_edited_time,
    props,
    body: body.slice(0, 20000),
    bodyLength: body.length,
  };
}

async function main() {
  console.log('\n[1/3] 프로젝트 DB 샘플 fetch (최근 8개)...');
  const projects = await fetchDbPages(PROJECT_DB, 8, '마지막 업데이트');

  console.log('\n[2/3] 미팅 노트 DB 샘플 fetch (최근 5개)...');
  let meetings: any[] = [];
  try {
    meetings = await fetchDbPages(MEETING_DB, 5);
  } catch (err: any) {
    console.warn(`  ⚠️ 미팅 DB 접근 실패: ${err.code} — integration 권한 누락`);
  }

  console.log('\n[3/3] 논문 동향 페이지 fetch...');
  let paperTrend: any = null;
  try {
    paperTrend = await fetchSinglePage(PAPER_TREND_PAGE);
  } catch (err: any) {
    console.warn(`  ⚠️ 논문동향 페이지 접근 실패: ${err.code}`);
  }

  const output = {
    fetchedAt: new Date().toISOString(),
    projects,
    meetings,
    paperTrend,
  };

  const outPath = path.join(process.cwd(), 'scripts', 'heavy-user-sample.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n✓ 저장: ${outPath}`);
  console.log(`  - 프로젝트 ${projects.length}개`);
  console.log(`  - 미팅노트 ${meetings.length}개`);
  console.log(`  - 논문동향 ${paperTrend?.bodyLength ?? 0}자`);
}

main().catch(err => { console.error(err); process.exit(1); });
