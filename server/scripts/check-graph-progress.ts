import 'dotenv/config';
import { prisma } from '../src/config/prisma.js';

const LAB_ID = (process.env.LAB_ID ?? '').replace(/^"|"$/g, '');

async function main() {
  const lab = await prisma.lab.findUnique({ where: { id: LAB_ID }, select: { ownerId: true } });
  if (!lab) { process.exit(1); }
  const userId = lab.ownerId;

  const nodes = await prisma.knowledgeNode.count({ where: { userId } });
  const edges = await prisma.knowledgeEdge.count({ where: { userId } });

  // 최근 5분 내 생성된 노드/엣지
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const recentNodes = await prisma.knowledgeNode.count({
    where: { userId, createdAt: { gte: fiveMinAgo } },
  });
  const recentEdges = await prisma.knowledgeEdge.count({
    where: { userId, createdAt: { gte: fiveMinAgo } },
  });

  const lastNode = await prisma.knowledgeNode.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: { name: true, createdAt: true, entityType: true },
  });

  console.log(`노드: ${nodes} (최근 5분: ${recentNodes})`);
  console.log(`엣지: ${edges} (최근 5분: ${recentEdges})`);
  if (lastNode) {
    const agoSec = Math.round((Date.now() - new Date(lastNode.createdAt).getTime()) / 1000);
    console.log(`마지막 노드 생성: ${agoSec}s 전 — "${lastNode.name}" (${lastNode.entityType})`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
