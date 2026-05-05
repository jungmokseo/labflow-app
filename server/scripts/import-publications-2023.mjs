// publications.json → Notion DB (2023+ 만 시드)
import fs from 'fs';

const NOTION_KEY = process.env.NOTION_API_KEY;
if (!NOTION_KEY) { console.error('NOTION_API_KEY 미설정'); process.exit(1); }
const DB_ID = '06e9070b-661d-4d7d-829f-3aed16dda560';

const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf-8'));
const pubs = data.publications.filter(p => p.year >= 2023);
console.log(`총 ${data.publications.length}편 중 2023+ ${pubs.length}편 import 시작`);

function parseAuthors(authorsHtml) {
  const firstAuthorPattern = /<strong>([^<]+)<\/strong><sup>†<\/sup>/g;
  const firstAuthors = [];
  let m;
  while ((m = firstAuthorPattern.exec(authorsHtml)) !== null) {
    if (m[1] !== 'Jungmok Seo') firstAuthors.push(m[1].trim());
  }
  // 1저자 † 표시 없으면 첫 strong을 1저자로 (혹은 빈 값)
  if (firstAuthors.length === 0) {
    const firstStrongMatch = authorsHtml.match(/<strong>([^<]+)<\/strong>/);
    if (firstStrongMatch && firstStrongMatch[1] !== 'Jungmok Seo') {
      firstAuthors.push(firstStrongMatch[1].trim());
    }
  }
  const piIsCorresponding = /<strong>Jungmok Seo<\/strong><sup>\*<\/sup>/.test(authorsHtml);
  return { firstAuthors, piIsCorresponding };
}

function extractJournal(j) { return j.split(',')[0].trim(); }

async function createPage(pub) {
  const { firstAuthors, piIsCorresponding } = parseAuthors(pub.authors);
  const journal = extractJournal(pub.journal);
  const pubDate = `${pub.year}-12-31`;

  const properties = {
    "제목": { title: [{ text: { content: pub.title } }] },
    "단계": { select: { name: '게재 완료' } },
    "현재/타겟 저널": { rich_text: [{ text: { content: journal } }] },
    "PI 역할": { select: { name: piIsCorresponding ? '교신' : '공저' } },
    "게재일": { date: { start: pubDate } },
    "마지막 활동": { date: { start: pubDate } },
    "마지막 활동 종류": { rich_text: [{ text: { content: '게재됨' } }] },
    "메모": { rich_text: [{ text: { content: `Pub #${pub.number} · ${pub.journal}` } }] },
  };
  if (firstAuthors.length > 0) properties["1저자 학생"] = { rich_text: [{ text: { content: firstAuthors.join(', ') } }] };
  if (pub.impactFactor) properties["Impact Factor"] = { number: pub.impactFactor };
  if (pub.link) properties["DOI"] = { url: pub.link };

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ parent: { database_id: DB_ID }, properties }),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error(`#${pub.number} 실패: ${res.status} ${t.slice(0, 200)}`);
    return false;
  }
  return true;
}

let ok = 0, fail = 0;
const concurrency = 3;
for (let i = 0; i < pubs.length; i += concurrency) {
  const batch = pubs.slice(i, i + concurrency);
  const r = await Promise.all(batch.map(createPage));
  for (const b of r) b ? ok++ : fail++;
}
console.log(`완료: 성공 ${ok}, 실패 ${fail}`);
