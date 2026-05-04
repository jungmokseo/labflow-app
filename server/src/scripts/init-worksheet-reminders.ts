/**
 * worksheet_reminders 테이블 즉시 생성 (raw SQL).
 * Usage: npx tsx src/scripts/init-worksheet-reminders.ts
 */
import { checkPendingReminders } from '../services/worksheet-reminder.js';

checkPendingReminders()
  .then(r => console.log('Table ensured. Initial check:', JSON.stringify(r)))
  .catch(e => { console.error('FAILED:', e.message); process.exit(1); })
  .finally(() => process.exit(0));
