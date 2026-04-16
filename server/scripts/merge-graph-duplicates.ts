/**
 * 지식 그래프 중복 노드 병합.
 *
 * 전략:
 *   - name 정규화 (공백/특수문자/케이스 무시) 기준으로 그룹핑 (entityType 달라도 동일 취급)
 *   - 각 그룹의 canonical node = edge 가장 많은 노드 (동수면 먼저 만들어진 것)
 *   - 다른 노드들의 in/out edges를 canonical node로 재연결
 *   - 중복 edge(같은 from-to-relation) 중복 제거
 *   - 중복 노드 삭제
 *
 * 특수 케이스:
 *   - "BLISS Lab" 의 topic/paper 변형도 institution과 같다고 간주 (사용자 요청)
 */
import 'dotenv/config';
import { prisma } from '../src/config/prisma.js';

const LAB_ID = (process.env.LAB_ID ?? '').replace(/^"|"$/g, '');

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '').replace(/[·_\-–—()·.,/]/g, '');
}

async function main() {
  const lab = await prisma.lab.findUnique({ where: { id: LAB_ID }, select: { ownerId: true } });
  if (!lab) { console.error('lab 없음'); process.exit(1); }
  const userId = lab.ownerId;

  const allNodes = await prisma.knowledgeNode.findMany({
    where: { userId },
    select: {
      id: true, name: true, entityType: true, entityId: true, createdAt: true,
      outEdges: { select: { id: true } },
      inEdges: { select: { id: true } },
    },
  });

  // 그룹핑 — 정규화된 이름 기준
  const groups = new Map<string, typeof allNodes>();
  for (const n of allNodes) {
    const key = norm(n.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(n);
  }

  const dupes = [...groups.entries()].filter(([_, arr]) => arr.length > 1);
  console.log(`\n총 노드: ${allNodes.length}`);
  console.log(`중복 그룹: ${dupes.length}\n`);

  let mergedNodes = 0, mergedEdges = 0, dedupedEdges = 0;

  for (const [key, arr] of dupes) {
    // canonical = edge 가장 많음
    arr.sort((a, b) => {
      const ea = a.outEdges.length + a.inEdges.length;
      const eb = b.outEdges.length + b.inEdges.length;
      if (eb !== ea) return eb - ea;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
    const canonical = arr[0];
    const duplicates = arr.slice(1);

    console.log(`[${key}] canonical: "${canonical.name}" (${canonical.entityType}, edges=${canonical.outEdges.length + canonical.inEdges.length})`);

    for (const dup of duplicates) {
      const dupEdges = dup.outEdges.length + dup.inEdges.length;
      console.log(`   merge: "${dup.name}" (${dup.entityType}, edges=${dupEdges}) → canonical`);

      // dup의 모든 edge를 개별 처리 (unique constraint 충돌 시 삭제로 대응)
      const outEdges = await prisma.knowledgeEdge.findMany({
        where: { fromNodeId: dup.id },
        select: { id: true, toNodeId: true, relation: true },
      });
      for (const e of outEdges) {
        // canonical 기준 동일 edge 이미 존재하면 dup edge 삭제
        const existing = await prisma.knowledgeEdge.findFirst({
          where: { fromNodeId: canonical.id, toNodeId: e.toNodeId, relation: e.relation },
        });
        if (existing) {
          await prisma.knowledgeEdge.delete({ where: { id: e.id } });
          dedupedEdges++;
        } else {
          await prisma.knowledgeEdge.update({ where: { id: e.id }, data: { fromNodeId: canonical.id } });
          mergedEdges++;
        }
      }

      const inEdges = await prisma.knowledgeEdge.findMany({
        where: { toNodeId: dup.id },
        select: { id: true, fromNodeId: true, relation: true },
      });
      for (const e of inEdges) {
        const existing = await prisma.knowledgeEdge.findFirst({
          where: { fromNodeId: e.fromNodeId, toNodeId: canonical.id, relation: e.relation },
        });
        if (existing) {
          await prisma.knowledgeEdge.delete({ where: { id: e.id } });
          dedupedEdges++;
        } else {
          await prisma.knowledgeEdge.update({ where: { id: e.id }, data: { toNodeId: canonical.id } });
          mergedEdges++;
        }
      }

      // 중복 노드 삭제
      await prisma.knowledgeNode.delete({ where: { id: dup.id } });
      mergedNodes++;
    }

    // canonical 노드에 self-loop (fromNodeId = toNodeId) 제거 — merge 과정에서 생길 수 있음
    const selfLoops = await prisma.knowledgeEdge.findMany({
      where: { fromNodeId: canonical.id, toNodeId: canonical.id },
      select: { id: true },
    });
    if (selfLoops.length > 0) {
      await prisma.knowledgeEdge.deleteMany({
        where: { id: { in: selfLoops.map(e => e.id) } },
      });
      dedupedEdges += selfLoops.length;
    }
  }

  // 글로벌 dedup — 같은 (fromNodeId, toNodeId, relation) edge 중복 제거
  console.log('\n글로벌 edge dedup...');
  const allEdges = await prisma.knowledgeEdge.findMany({
    where: { userId },
    select: { id: true, fromNodeId: true, toNodeId: true, relation: true, createdAt: true },
  });
  const edgeKey = (e: any) => `${e.fromNodeId}|${e.toNodeId}|${e.relation}`;
  const edgeSeen = new Map<string, string>();
  const edgeToDelete: string[] = [];
  for (const e of allEdges.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())) {
    const k = edgeKey(e);
    if (edgeSeen.has(k)) edgeToDelete.push(e.id);
    else edgeSeen.set(k, e.id);
  }
  if (edgeToDelete.length > 0) {
    await prisma.knowledgeEdge.deleteMany({ where: { id: { in: edgeToDelete } } });
    dedupedEdges += edgeToDelete.length;
  }

  const finalNodes = await prisma.knowledgeNode.count({ where: { userId } });
  const finalEdges = await prisma.knowledgeEdge.count({ where: { userId } });

  console.log(`\n✓ 완료`);
  console.log(`  병합된 노드: ${mergedNodes}개`);
  console.log(`  재연결된 edge: ${mergedEdges}`);
  console.log(`  중복 제거 edge: ${dedupedEdges}`);
  console.log(`  최종 노드 수: ${finalNodes}`);
  console.log(`  최종 edge 수: ${finalEdges}`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
