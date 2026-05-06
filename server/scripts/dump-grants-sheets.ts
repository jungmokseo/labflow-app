// GDrive '과제 정보' 파일의 모든 시트 구조 dump — 어떤 데이터가 있는지 확인용
import { readAllSheets } from '../src/services/gdrive-sync.js';
import { env } from '../src/config/env.js';

async function main() {
if (!env.GDRIVE_FILE_PROJECT_INFO) {
  console.error('GDRIVE_FILE_PROJECT_INFO 미설정');
  process.exit(1);
}

const sheets = await readAllSheets(env.GDRIVE_FILE_PROJECT_INFO);
console.log(`\n총 ${sheets.length}개 시트\n`);

for (const s of sheets) {
  console.log(`════════════════════════════════════════════`);
  console.log(`📄 [${s.sheetName}] (${s.rows.length} rows)`);
  console.log(`════════════════════════════════════════════`);

  if (s.sheetName === '과제 정보') {
    // 1단계 시트 — 헤더 + 첫 3 row만
    if (s.rows.length > 0) {
      console.log('\n  Headers:');
      s.rows[0].forEach((h, i) => console.log(`    [${i}] ${h}`));
      console.log('\n  Sample rows:');
      for (const row of s.rows.slice(1, 4)) {
        console.log('    ' + row.slice(0, 6).map(v => v.slice(0, 30)).join(' | '));
      }
    }
  } else {
    // 2단계 시트 — key-value 모두
    for (const row of s.rows.slice(0, 30)) {
      const k = (row[0] || '').trim();
      const v = (row[1] || '').trim();
      if (k || v) console.log(`  ${k.padEnd(20)} | ${v.slice(0, 80)}`);
    }
  }
  console.log('');
}
}
main().catch(e => { console.error(e); process.exit(1); });
