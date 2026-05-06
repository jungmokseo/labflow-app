import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const projects = await p.project.findMany({
  select: { id: true, name: true, shortName: true, businessName: true, metadata: true, syncedAt: true },
  orderBy: { syncedAt: 'desc' },
});
console.log(`총 ${projects.length}개 Project`);
console.log('───────────');
let withDetailFields = 0, withSheetExtras = 0, withShortName = 0;
for (const pr of projects) {
  const md = pr.metadata || {};
  if (Object.keys(md.detailFields || {}).length) withDetailFields++;
  if (Object.keys(md.sheetExtras || {}).length) withSheetExtras++;
  if (pr.shortName) withShortName++;
}
console.log(`shortName 있는 row: ${withShortName}/${projects.length}`);
console.log(`detailFields 있는 row: ${withDetailFields}/${projects.length}`);
console.log(`sheetExtras 있는 row: ${withSheetExtras}/${projects.length}`);
console.log('───────────');
console.log('전체 row 요약 (sync 최근순):');
for (const pr of projects) {
  const md = pr.metadata || {};
  const dfKeys = Object.keys(md.detailFields || {});
  const seKeys = Object.keys(md.sheetExtras || {});
  console.log(`\n• name="${pr.name?.slice(0,50)}" shortName="${pr.shortName || ''}" busName="${pr.businessName || ''}"`);
  console.log(`  synced=${pr.syncedAt} detailFields=${dfKeys.length} sheetExtras=${seKeys.length}`);
  if (dfKeys.length > 0) console.log(`    DF keys: ${dfKeys.join(' | ')}`);
}
await p.$disconnect();
