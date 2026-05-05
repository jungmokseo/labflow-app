// 진행 중 manuscript 제목에서 (학생) suffix 제거 — 한 줄 카드 컴팩트화
import fs from 'fs';

const NOTION_KEY = process.env.NOTION_API_KEY;
const DB_ID = '06e9070b-661d-4d7d-829f-3aed16dda560';

async function notion(path, opts = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method: opts.method || 'GET',
    headers: {
      'Authorization': `Bearer ${NOTION_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().then(t => t.slice(0, 200))}`);
  return res.json();
}

async function queryAll() {
  const all = [];
  let cursor;
  do {
    const r = await notion(`/databases/${DB_ID}/query`, { method: 'POST', body: { page_size: 100, start_cursor: cursor } });
    all.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return all;
}

const rows = await queryAll();
console.log(`총 ${rows.length}개 row`);

let cleaned = 0, skipped = 0;
for (const row of rows) {
  const title = row.properties['제목']?.title?.[0]?.plain_text || '';
  const stage = row.properties['단계']?.select?.name;
  if (stage === '게재 완료') { skipped++; continue; }  // publications 제목은 보존

  // (학생) 또는 — 학생 패턴 — 단순히 끝의 (이름) 제거
  let cleanTitle = title.replace(/\s*\(([^)]*[가-힣]+[^)]*)\)\s*$/, '').trim();
  // "유림: NCF Cu-Cu" 같은 패턴은 그대로
  if (cleanTitle === title || cleanTitle.length < 3) { skipped++; continue; }

  await notion(`/pages/${row.id}`, {
    method: 'PATCH',
    body: { properties: { '제목': { title: [{ text: { content: cleanTitle } }] } } },
  });
  console.log(`  ${title.slice(0, 60)} → ${cleanTitle.slice(0, 60)}`);
  cleaned++;
}
console.log(`완료: ${cleaned}개 정리, ${skipped}개 skip`);
