/**
 * 모든 wiki_articles 내용을 knowledge graph에 반영.
 *
 * 로직:
 *   1. lab의 owner userId 찾음
 *   2. 위키 아티클 전체 순회
 *   3. 각 아티클의 title + content를 buildGraphFromText로 추출
 *      → knowledge_nodes + knowledge_edges에 upsert
 *   4. 진행상황 로깅
 *
 * 비용: Gemini 2.5 Flash, ~$0.0002/article × 136 = ~$0.03
 */
import 'dotenv/config';
import { prisma } from '../src/config/prisma.js';
import { buildGraphFromText } from '../src/services/knowledge-graph.js';

const LAB_ID = (process.env.LAB_ID ?? '').replace(/^"|"$/g, '');

async function main() {
  // 1. lab owner userId
  const lab = await prisma.lab.findUnique({
    where: { id: LAB_ID },
    select: { ownerId: true, name: true },
  });
  if (!lab) { console.error('lab 없음'); process.exit(1); }
  const userId = lab.ownerId;
  console.log(`\nLab: ${lab.name} / Owner: ${userId}\n`);

  // 2. 전체 wiki article
  const articles = await prisma.wikiArticle.findMany({
    where: { labId: LAB_ID },
    select: { id: true, title: true, content: true, category: true },
    orderBy: { updatedAt: 'desc' },
  });
  console.log(`총 ${articles.length}개 article 처리\n`);

  // 3. 기존 graph 통계 (before)
  const beforeNodes = await prisma.knowledgeNode.count({ where: { userId } });
  const beforeEdges = await prisma.knowledgeEdge.count({ where: { userId } });
  console.log(`이전 graph: ${beforeNodes} nodes, ${beforeEdges} edges\n`);

  // 4. 각 article 순차 처리 (Gemini rate limit 고려)
  let ok = 0, failed = 0;
  const failedTitles: string[] = [];
  const startedAt = Date.now();

  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const text = `# ${a.title} [${a.category}]\n\n${a.content}`;
    try {
      await buildGraphFromText(userId, text, 'wiki');
      ok++;
    } catch (err: any) {
      failed++;
      failedTitles.push(a.title);
    }
    const pct = Math.round(((i + 1) / articles.length) * 100);
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(`  [${i + 1}/${articles.length}] ${pct}% (${elapsed}s) ${ok === i + 1 - failed ? '✓' : '✗'} ${a.title.slice(0, 60)}`);
  }

  // 5. 이후 통계
  const afterNodes = await prisma.knowledgeNode.count({ where: { userId } });
  const afterEdges = await prisma.knowledgeEdge.count({ where: { userId } });

  console.log(`\n✓ 완료: 성공 ${ok} / 실패 ${failed}`);
  console.log(`노드: ${beforeNodes} → ${afterNodes} (+${afterNodes - beforeNodes})`);
  console.log(`엣지: ${beforeEdges} → ${afterEdges} (+${afterEdges - beforeEdges})`);

  if (failedTitles.length > 0) {
    console.log('\n실패한 article:');
    failedTitles.slice(0, 10).forEach(t => console.log(`  - ${t}`));
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
