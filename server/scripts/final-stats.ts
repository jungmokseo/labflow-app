import 'dotenv/config';
import { prisma } from '../src/config/prisma.js';

const LAB_ID = (process.env.LAB_ID ?? '').replace(/^"|"$/g, '');

async function main() {
  const all = await prisma.wikiArticle.findMany({
    where: { labId: LAB_ID },
    select: { title: true, category: true, tags: true, content: true },
    orderBy: { updatedAt: 'desc' },
  });

  console.log(`\nTotal: ${all.length} articles\n`);

  const byCat: Record<string, number> = {};
  let simCount = 0;
  for (const a of all) {
    byCat[a.category] = (byCat[a.category] ?? 0) + 1;
    if (a.tags.includes('sim-by-claude-code')) simCount++;
  }
  console.log('By category:');
  for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c.padEnd(20)} ${n}`);
  }

  console.log(`\nSimulation-tagged: ${simCount}`);
  console.log(`Non-simulation: ${all.length - simCount}`);

  const avgLen = Math.round(all.reduce((s, a) => s + a.content.length, 0) / all.length);
  console.log(`Avg content length: ${avgLen} chars`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
