/**
 * Repair Knowledge Graph — 고립 노드 연결 + entityId 매칭 + 재구축
 *
 * Usage: npx tsx server/src/scripts/repair-knowledge-graph.ts
 *
 * 1단계: 기존 노드의 entityId를 LabMember/Project와 매칭
 * 2단계: 고립된 equipment/topic 노드를 프로젝트 메타데이터로 연결
 * 3단계: 멤버↔프로젝트 관계 생성 (participates_in)
 * 4단계: 기존 대화/미팅/이메일에서 그래프 재구축
 */

import { basePrismaClient as prisma } from '../config/prisma.js';
import { upsertNode, upsertEdge, buildGraphFromText } from '../services/knowledge-graph.js';

const DELAY_MS = 500;

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== Knowledge Graph 수리 시작 ===\n');

  const [nodeCount, edgeCount] = await Promise.all([
    prisma.knowledgeNode.count(),
    prisma.knowledgeEdge.count(),
  ]);
  console.log(`[현재 상태] 노드: ${nodeCount}개, 엣지: ${edgeCount}개\n`);

  // userId 확인 (단일 사용자 기준)
  const owner = await prisma.lab.findFirst({ select: { ownerId: true, id: true } });
  if (!owner) {
    console.log('Lab이 없습니다. 종료.');
    process.exit(0);
  }
  const userId = owner.ownerId;
  const labId = owner.id;

  // ── 1단계: entityId 매칭 ────────────────────────────────
  console.log('[1/4] entityId 매칭...');
  const [members, projects] = await Promise.all([
    prisma.labMember.findMany({ where: { labId, active: true }, select: { id: true, name: true } }),
    prisma.project.findMany({ where: { labId }, select: { id: true, name: true, funder: true, metadata: true } }),
  ]);

  const nodesWithoutEntityId = await prisma.knowledgeNode.findMany({
    where: { userId, entityId: null, entityType: { in: ['person', 'project'] } },
  });

  let matched = 0;
  for (const node of nodesWithoutEntityId) {
    let entityId: string | undefined;

    if (node.entityType === 'person') {
      const member = members.find(m => m.name === node.name || node.name.includes(m.name) || m.name.includes(node.name));
      if (member) entityId = member.id;
    } else if (node.entityType === 'project') {
      const project = projects.find(p => p.name === node.name || node.name.includes(p.name) || p.name.includes(node.name));
      if (project) entityId = project.id;
    }

    if (entityId) {
      await prisma.knowledgeNode.update({ where: { id: node.id }, data: { entityId } });
      matched++;
    }
  }
  console.log(`  ✅ ${matched}/${nodesWithoutEntityId.length} 노드 entityId 매칭 완료\n`);

  // ── 2단계: 멤버↔프로젝트 관계 생성 ──────────────────────
  console.log('[2/4] 멤버↔프로젝트 관계 구축...');
  let relCreated = 0;

  // 프로젝트 메타데이터에서 참여자 정보 추출
  for (const project of projects) {
    const projectNode = await prisma.knowledgeNode.findUnique({
      where: { userId_entityType_name: { userId, entityType: 'project', name: project.name } },
    });
    if (!projectNode) continue;

    // PI/PM이 있으면 supervises 관계
    if (project.funder) {
      const funderNode = await upsertNode(userId, 'institution', project.funder);
      await upsertEdge(projectNode.id, funderNode.id, 'related_to', 'seed', `과제 지원 기관: ${project.funder}`, userId);
      relCreated++;
    }
  }
  console.log(`  ✅ ${relCreated}개 멤버↔프로젝트 관계 생성\n`);

  // ── 3단계: 고립 equipment/topic 노드를 프로젝트와 연결 ──────
  console.log('[3/4] 고립 노드 연결...');
  const allNodes = await prisma.knowledgeNode.findMany({ where: { userId }, select: { id: true, name: true, entityType: true } });
  const fromIds = new Set((await prisma.knowledgeEdge.findMany({ where: { userId }, select: { fromNodeId: true } })).map(e => e.fromNodeId));
  const toIds = new Set((await prisma.knowledgeEdge.findMany({ where: { userId }, select: { toNodeId: true } })).map(e => e.toNodeId));
  const isolatedNodes = allNodes.filter(n => !fromIds.has(n.id) && !toIds.has(n.id));

  console.log(`  고립 노드 ${isolatedNodes.length}개 발견`);

  // 전략 1: 연구실 대표 노드(서정목)에 equipment/topic 직접 연결
  const labOwnerNode = await prisma.knowledgeNode.findUnique({
    where: { userId_entityType_name: { userId, entityType: 'person', name: '서정목' } },
  });

  let directLinked = 0;
  if (labOwnerNode) {
    for (const node of isolatedNodes) {
      if (node.entityType === 'equipment') {
        await upsertEdge(labOwnerNode.id, node.id, 'uses_term', 'seed', `연구실 보유 장비: ${node.name}`, userId);
        directLinked++;
      } else if (node.entityType === 'topic') {
        await upsertEdge(labOwnerNode.id, node.id, 'related_to', 'seed', `연구 주제: ${node.name}`, userId);
        directLinked++;
      } else if (node.entityType === 'project') {
        await upsertEdge(labOwnerNode.id, node.id, 'participates_in', 'seed', `과제 PI: ${node.name}`, userId);
        directLinked++;
      }
    }
    console.log(`  ✅ 직접 연결: ${directLinked}개 (연구실 대표 ↔ 장비/주제/과제)`);
  }

  // 전략 2: AI 기반 세밀한 연결 (프로젝트↔장비, 프로젝트↔토픽)
  const stillIsolated = isolatedNodes.filter(n => {
    // 직접 연결되지 않은 노드만
    return !labOwnerNode || (n.entityType !== 'equipment' && n.entityType !== 'topic' && n.entityType !== 'project');
  });
  if (stillIsolated.length > 0) {
    const isolatedText = stillIsolated.map(n => `${n.entityType}: ${n.name}`).join('\n');
    const projectNames = projects.map(p => p.name).join('\n');
    const memberNames = members.map(m => m.name).join('\n');

    const connectText = `다음은 연구실의 엔티티입니다:\n${isolatedText}\n\n다음은 연구 과제 목록입니다:\n${projectNames}\n\n다음은 연구실 구성원입니다:\n${memberNames}\n\n이 엔티티가 어떤 과제나 구성원과 관련되는지 추출하세요.`;

    try {
      await buildGraphFromText(userId, connectText, 'seed');
      console.log(`  ✅ AI 기반 추가 연결 완료 (${stillIsolated.length}개 대상)`);
    } catch (err) {
      console.error('  ❌ AI 연결 실패:', err);
    }
    await sleep(DELAY_MS);
  }

  // ── 4단계: 기존 대화에서 재구축 ─────────────────────────
  console.log('\n[4/4] 기존 대화에서 그래프 재구축...');
  const channels = await prisma.channel.findMany({
    where: { userId, shadow: false, archived: false },
    select: { id: true },
  });

  let chatProcessed = 0;
  for (const ch of channels) {
    const messages = await prisma.message.findMany({
      where: { channelId: ch.id },
      select: { role: true, content: true },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });

    if (messages.length < 2) continue;

    const chatText = messages
      .map(m => `${m.role === 'user' ? '사용자' : 'AI'}: ${m.content}`)
      .join('\n')
      .substring(0, 3000);

    try {
      await buildGraphFromText(userId, chatText, 'chat');
      chatProcessed++;
      process.stdout.write(`\r  처리: ${chatProcessed}/${channels.length} 채널`);
    } catch {}
    await sleep(DELAY_MS);
  }
  console.log(`\n  ✅ 채팅 ${chatProcessed}건 처리\n`);

  // ── 결과 요약 ─────────────────────────────────────────
  const [finalNodes, finalEdges] = await Promise.all([
    prisma.knowledgeNode.count(),
    prisma.knowledgeEdge.count(),
  ]);

  const finalIsolated = await countIsolated(userId);

  console.log('=== 수리 완료 ===');
  console.log(`  노드: ${nodeCount} → ${finalNodes} (+${finalNodes - nodeCount})`);
  console.log(`  엣지: ${edgeCount} → ${finalEdges} (+${finalEdges - edgeCount})`);
  console.log(`  고립 노드: ${isolatedNodes.length} → ${finalIsolated}`);
  console.log(`  entityId 매칭: ${matched}건`);

  process.exit(0);
}

async function countIsolated(userId: string): Promise<number> {
  const allNodes = await prisma.knowledgeNode.findMany({ where: { userId }, select: { id: true } });
  const fromIds = new Set((await prisma.knowledgeEdge.findMany({ where: { userId }, select: { fromNodeId: true } })).map(e => e.fromNodeId));
  const toIds = new Set((await prisma.knowledgeEdge.findMany({ where: { userId }, select: { toNodeId: true } })).map(e => e.toNodeId));
  return allNodes.filter(n => !fromIds.has(n.id) && !toIds.has(n.id)).length;
}

main().catch(err => {
  console.error('[fatal] 수리 실패:', err);
  process.exit(1);
});
