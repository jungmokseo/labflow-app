// publications.json → Notion DB import
// 게재 완료 91편 시드. PI 교신/공저, 1저자 BLISS 학생, 저널, IF, 게재일 추출.
import fs from 'fs';

const NOTION_KEY = process.env.NOTION_API_KEY;
if (!NOTION_KEY) { console.error('NOTION_API_KEY 미설정'); process.exit(1); }
const DATA_SOURCE_ID = 'b9cba7ee-f2f1-4d48-bc56-d438c946f561';

const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf-8'));
const pubs = data.publications;
console.log(`총 ${pubs.length}편 import 시작`);

function parseAuthors(authorsHtml) {
  // <strong>이름</strong><sup>†</sup> → 1저자 BLISS 학생 (공동 1저자도 추출)
  // 학생/멤버 = <strong>으로 mark된 사람
  // 1저자 = 다음에 †가 붙은 사람
  // PI 교신 = "Jungmok Seo" 다음에 *

  // 1저자 BLISS 학생 추출 — strong 안의 이름 + 직후 sup †
  const firstAuthorPattern = /<strong>([^<]+)<\/strong><sup>†<\/sup>/g;
  const firstAuthors = [];
  let m;
  while ((m = firstAuthorPattern.exec(authorsHtml)) !== null) {
    if (m[1] !== 'Jungmok Seo') firstAuthors.push(m[1].trim());
  }

  // 1저자가 BLISS 학생이 아닌 경우(외부 협업) — 일반 텍스트로 †
  // 그 경우 첫 BLISS 학생을 표기 안 함
  const hasFirstBliss = firstAuthors.length > 0;

  // 교신 = Jungmok Seo<sup>*</sup>
  const piIsCorresponding = /Jungmok Seo<\/strong><sup>\*<\/sup>|<strong>Jungmok Seo<\/strong><sup>\*<\/sup>/.test(authorsHtml);

  return { firstAuthors, piIsCorresponding, hasFirstBliss };
}

function extractJournal(j) {
  // "Bioactive Materials, 61, 210 - 228 (2026)" → "Bioactive Materials"
  return j.split(',')[0].trim();
}

function extractDate(j, year) {
  // year만 있으므로 12월 31일로 (게재일 미상 — 카운트는 정확)
  // 향후 사용자 직접 수정 가능
  return `${year}-12-31`;
}

async function createPage(pub) {
  const { firstAuthors, piIsCorresponding } = parseAuthors(pub.authors);
  const journal = extractJournal(pub.journal);
  const pubDate = extractDate(pub.journal, pub.year);

  const properties = {
    "제목": { title: [{ text: { content: pub.title } }] },
    "단계": { select: { name: '게재 완료' } },
    "1저자 학생": { rich_text: [{ text: { content: firstAuthors.join(', ') } }] },
    "현재/타겟 저널": { rich_text: [{ text: { content: journal } }] },
    "Impact Factor": { number: pub.impactFactor || null },
    "PI 역할": { select: { name: piIsCorresponding ? '교신' : '공저' } },
    "게재일": { date: { start: pubDate } },
    "DOI": { url: pub.link || null },
    "마지막 활동": { date: { start: pubDate } },
    "마지막 활동 종류": { rich_text: [{ text: { content: '게재됨' } }] },
    "메모": { rich_text: [{ text: { content: `Pub #${pub.number} · ${pub.journal}` } }] },
  };

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      parent: { database_id: '06e9070b-661d-4d7d-829f-3aed16dda560' },
      properties,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`#${pub.number} 실패: ${res.status} ${errText.slice(0, 300)}`);
    return false;
  }
  return true;
}

let ok = 0, fail = 0;
const concurrency = 3;
for (let i = 0; i < pubs.length; i += concurrency) {
  const batch = pubs.slice(i, i + concurrency);
  const results = await Promise.all(batch.map(createPage));
  for (const r of results) r ? ok++ : fail++;
  if ((i + concurrency) % 15 === 0 || i + concurrency >= pubs.length) {
    console.log(`진행: ${ok + fail}/${pubs.length} (성공 ${ok} / 실패 ${fail})`);
  }
}
console.log(`완료: 성공 ${ok}, 실패 ${fail}`);
