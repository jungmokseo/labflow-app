/**
 * 워크시트 sync 수동 실행 (개발/디버깅용).
 * Usage: npx tsx src/scripts/run-worksheet-sync.ts
 */
import { syncWorksheetProjects } from '../services/worksheet-sync.js';

syncWorksheetProjects()
  .then(r => console.log('SYNC RESULT:', JSON.stringify(r, null, 2)))
  .catch(e => { console.error('SYNC FAILED:', e); process.exit(1); })
  .finally(() => process.exit(0));
