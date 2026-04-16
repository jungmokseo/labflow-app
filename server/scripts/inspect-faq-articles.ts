import 'dotenv/config';
import { prisma } from '../src/config/prisma.js';

const LAB_ID = (process.env.LAB_ID ?? '').replace(/^"|"$/g, '');

async function main() {
  const all = await prisma.wikiArticle.findMany({
    where: { labId: LAB_ID },
    select: { id: true, title: true, category: true, sources: true, tags: true },
    orderBy: { updatedAt: 'desc' },
  });

  const faqLike = all.filter(a => {
    const srcs = Array.isArray(a.sources) ? (a.sources as any[]) : [];
    const hasFaqSource = srcs.some(s => s?.type === 'notion_faq' || s?.type === 'faq');
    const faqTitle = a.title.includes('FAQ') || a.title.startsWith('FAQ');
    const faqTag = a.tags.some(t => t.toLowerCase().includes('faq'));
    const faqCat = a.category === 'faq';
    return hasFaqSource || faqTitle || faqTag || faqCat;
  });

  console.log(`\nTotal articles: ${all.length}`);
  console.log(`FAQ-like matches: ${faqLike.length}\n`);
  faqLike.forEach(a => {
    const srcStr = JSON.stringify(a.sources).slice(0, 120);
    console.log(`  - [${a.category}] ${a.title}`);
    console.log(`    tags: ${a.tags.join(', ')}`);
    console.log(`    sources: ${srcStr}`);
  });

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
