/**
 * 지식 그래프 중복 노드 조사.
 *   - BLISS, 연구실 등 동일 개체로 의심되는 여러 표기를 찾음
 *   - 각 그룹별 노드 수, 연결 edge 수, 출처 source 분포 표시
 */
import 'dotenv/config';
import { prisma } from '../src/config/prisma.js';

const LAB_ID = (process.env.LAB_ID ?? '').replace(/^"|"$/g, '');

async function main() {
  const lab = await prisma.lab.findUnique({ where: { id: LAB_ID }, select: { ownerId: true } });
  if (!lab) { console.error('lab 없음'); process.exit(1); }
  const userId = lab.ownerId;

  const allNodes = await prisma.knowledgeNode.findMany({
    where: { userId },
    select: {
      id: true, name: true, entityType: true, entityId: true,
      outEdges: { select: { id: true } },
      inEdges: { select: { id: true } },
    },
  });

  console.log(`\n총 노드: ${allNodes.length}개\n`);

  // 이름 정규화 (공백/특수문자/소문자) 후 그룹화
  function norm(s: string): string {
    return s.trim().toLowerCase().replace(/\s+/g, '').replace(/[·_\-–—()·.,]/g, '');
  }

  const groups = new Map<string, typeof allNodes>();
  for (const n of allNodes) {
    const key = `${n.entityType}:${norm(n.name)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(n);
  }

  const dupes = [...groups.entries()].filter(([_, arr]) => arr.length > 1).sort((a, b) => b[1].length - a[1].length);
  console.log(`정규화 동등 그룹(중복 가능성): ${dupes.length}\n`);

  for (const [key, arr] of dupes.slice(0, 25)) {
    const edgeCount = arr.reduce((s, n) => s + n.outEdges.length + n.inEdges.length, 0);
    console.log(`[${key}] ${arr.length}개 노드 / 총 ${edgeCount} edges`);
    for (const n of arr) {
      const eN = n.outEdges.length + n.inEdges.length;
      console.log(`   - "${n.name}" (${n.entityType}) edges=${eN} ${n.entityId ? '[linked]' : ''}`);
    }
    console.log();
  }

  // BLISS 키워드 포함 노드 별도 표시
  const blissNodes = allNodes.filter(n => /bliss/i.test(n.name));
  console.log(`\nBLISS 키워드 포함 노드: ${blissNodes.length}`);
  for (const n of blissNodes) {
    const eN = n.outEdges.length + n.inEdges.length;
    console.log(`   - "${n.name}" (${n.entityType}) edges=${eN}`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
