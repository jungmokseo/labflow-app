import { Client } from '@notionhq/client';
import 'dotenv/config';

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const DBS: Record<string, string> = {
  'BLISS Lab 프로젝트': '37e9d1e2155a4f1a8a17a12f271f8c7d',
  '빠른 메모 저장소': 'ea8083d433c64920a031a8257322494b',
  'Jarvis 과제 정보': 'b4e01f852e14447ca165cf1894602623',
  '아이디어 박스': '9da9d2f425744252 9ad3f1a4a90398de'.replace(' ', ''),
  '인박스 테스크': '7ff177bcb309491584b96c0003242780',
};

async function main() {
  for (const [name, id] of Object.entries(DBS)) {
    try {
      const db = await notion.databases.retrieve({ database_id: id });
      const props = Object.entries((db as any).properties).map(([k, v]: any) => `  ${k} (${v.type})`);

      const pages = await notion.databases.query({ database_id: id, page_size: 3 });
      const total = pages.results.length;
      // Check if there are more
      const hasMore = pages.has_more;

      console.log(`\n=== ${name} (${total}${hasMore ? '+' : ''} rows) ===`);
      console.log(props.join('\n'));

      // Show sample titles
      for (const page of pages.results) {
        const p = page as any;
        const titleEntry = Object.entries(p.properties).find(([, v]: any) => (v as any).type === 'title');
        if (titleEntry) {
          const title = (titleEntry[1] as any).title?.map((t: any) => t.plain_text).join('') || '';
          console.log(`  → ${title}`);
        }
      }
    } catch (e: any) {
      console.log(`\n=== ${name}: ERROR - ${e.message?.slice(0, 100)} ===`);
    }
  }
}

main();
