import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const projects = await p.project.findMany({
  orderBy: { syncedAt: 'desc' },
  take: 30,
  select: { name: true, number: true, funder: true, period: true, pi: true, status: true, syncedAt: true },
});
console.log(`총 ${projects.length}개 과제`);
for (const pr of projects.slice(0, 10)) {
  console.log(`- [${pr.status}] ${pr.name}${pr.number ? ' ('+pr.number+')' : ''} · ${pr.funder || '-'} · ${pr.period || '-'} · PI: ${pr.pi || '-'}`);
}
await p.$disconnect();
