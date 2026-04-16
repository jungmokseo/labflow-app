/**
 * 기존 wiki_articles 전체에 embedding 일괄 생성.
 * 재실행 안전: chunk ON CONFLICT UPSERT로 덮어씀.
 *
 * 비용: OpenAI text-embedding-3-small $0.02/MTok
 *   평균 article 1500자 = ~500 tokens × 136 article = ~68k tokens = ~$0.0014
 *   → 매우 저렴
 */
import 'dotenv/config';
import { prisma } from '../src/config/prisma.js';
import { generateEmbedding, chunkText, storeWikiEmbedding, deleteWikiEmbeddings } from '../src/services/embedding-service.js';

const LAB_ID = (process.env.LAB_ID ?? '').replace(/^"|"$/g, '');

async function main() {
  const articles = await prisma.wikiArticle.findMany({
    where: { labId: LAB_ID },
    select: { id: true, title: true, category: true, content: true },
    orderBy: { updatedAt: 'desc' },
  });

  console.log(`\n총 ${articles.length}개 article에 embedding 생성\n`);

  const startedAt = Date.now();
  let ok = 0, failed = 0, chunks = 0;

  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    try {
      const textChunks = chunkText(`# ${a.title}\n\n${a.content}`, 1500);
      await deleteWikiEmbeddings(prisma, a.id);
      for (let j = 0; j < textChunks.length; j++) {
        const { embedding } = await generateEmbedding(textChunks[j]);
        await storeWikiEmbedding(prisma, {
          articleId: a.id,
          labId: LAB_ID,
          title: a.title,
          category: a.category,
          chunkIndex: j,
          chunkText: textChunks[j],
        }, embedding);
        chunks++;
      }
      ok++;
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`  ✓ [${i + 1}/${articles.length}] ${elapsed}s "${a.title.slice(0, 60)}" (${textChunks.length} chunk)`);
    } catch (err: any) {
      failed++;
      console.error(`  ✗ ${a.title} — ${err.message?.slice(0, 80)}`);
    }
  }

  console.log(`\n완료: 성공 ${ok} / 실패 ${failed}, 총 ${chunks} chunk`);

  // 검증
  const count = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT COUNT(*)::bigint as count FROM wiki_embeddings WHERE lab_id = $1`,
    LAB_ID,
  );
  console.log(`DB wiki_embeddings 총 개수: ${count[0].count.toString()}`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
