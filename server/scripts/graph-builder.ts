import { PrismaClient } from '@prisma/client';

export async function buildKnowledgeGraph(prisma: PrismaClient, userId: string) {
  console.log('🔗 Knowledge Graph 생성 시작...');

  // 1. 기존 데이터 조회
  const members = await prisma.labMember.findMany();
  const projects = await prisma.project.findMany();

  // 2. Person 노드 생성
  const personNodes: Map<string, string> = new Map(); // name → nodeId
  for (const member of members) {
    const node = await prisma.knowledgeNode.upsert({
      where: { userId_entityType_name: { userId, entityType: 'person', name: member.name } },
      create: { userId, entityType: 'person', entityId: member.id, name: member.name, metadata: { role: member.role, email: member.email } },
      update: { entityId: member.id },
    });
    personNodes.set(member.name, node.id);
  }
  console.log(`  ✅ Person nodes: ${personNodes.size}`);

  // 3. Project 노드 생성
  const projectNodes: Map<string, string> = new Map();
  for (const project of projects) {
    const node = await prisma.knowledgeNode.upsert({
      where: { userId_entityType_name: { userId, entityType: 'project', name: project.name } },
      create: { userId, entityType: 'project', entityId: project.id, name: project.name, metadata: { status: project.status, funder: project.funder } },
      update: { entityId: project.id },
    });
    projectNodes.set(project.name, node.id);
  }
  console.log(`  ✅ Project nodes: ${projectNodes.size}`);

  // 4. Institution 노드 (발주처/전문기관)
  const institutions = new Set<string>();
  for (const project of projects) {
    if (project.funder) institutions.add(project.funder);
    const meta = project.metadata as any;
    if (meta?.agency) institutions.add(meta.agency);
  }
  const institutionNodes: Map<string, string> = new Map();
  for (const inst of institutions) {
    const node = await prisma.knowledgeNode.upsert({
      where: { userId_entityType_name: { userId, entityType: 'institution', name: inst } },
      create: { userId, entityType: 'institution', name: inst },
      update: {},
    });
    institutionNodes.set(inst, node.id);
  }
  console.log(`  ✅ Institution nodes: ${institutionNodes.size}`);

  // 5. Equipment 노드
  const equipments = ['SEM', 'XRD', 'AFM', 'TEM', 'UV-Vis', 'FTIR', 'NMR', 'HPLC', 'Mass Spectrometry', '클린룸', 'Spin Coater', 'Electrospinning'];
  for (const eq of equipments) {
    await prisma.knowledgeNode.upsert({
      where: { userId_entityType_name: { userId, entityType: 'equipment', name: eq } },
      create: { userId, entityType: 'equipment', name: eq },
      update: {},
    });
  }
  console.log(`  ✅ Equipment nodes: ${equipments.length}`);

  // 6. Topic 노드
  const topics = ['flexible electronics', 'biosensors', 'hydrogel', 'packaging', 'wearable devices'];
  const topicNodes: Map<string, string> = new Map();
  for (const topic of topics) {
    const node = await prisma.knowledgeNode.upsert({
      where: { userId_entityType_name: { userId, entityType: 'topic', name: topic } },
      create: { userId, entityType: 'topic', name: topic },
      update: {},
    });
    topicNodes.set(topic, node.id);
  }
  console.log(`  ✅ Topic nodes: ${topics.length}`);

  // 7. PI(서정목) 노드
  const piNode = await prisma.knowledgeNode.upsert({
    where: { userId_entityType_name: { userId, entityType: 'person', name: '서정목' } },
    create: { userId, entityType: 'person', name: '서정목', metadata: { role: 'PI', email: 'jungmok.seo@gmail.com' } },
    update: {},
  });

  // ── Edges ──────────────────────────────────────────

  let edgeCount = 0;

  // 8. 수행과제관리.담당자 → person participates_in project
  for (const project of projects) {
    const meta = project.metadata as any;
    const managers: string[] = meta?.managers ?? [];
    const projectNodeId = projectNodes.get(project.name);
    if (!projectNodeId) continue;

    for (const manager of managers) {
      const personNodeId = personNodes.get(manager);
      if (!personNodeId) continue;

      await prisma.knowledgeEdge.upsert({
        where: { fromNodeId_toNodeId_relation: { fromNodeId: personNodeId, toNodeId: projectNodeId, relation: 'participates_in' } },
        create: { fromNodeId: personNodeId, toNodeId: projectNodeId, relation: 'participates_in', source: 'seed', weight: 1.0 },
        update: {},
      });
      edgeCount++;
    }

    // 9. Project → related_to institution (발주처)
    if (project.funder) {
      const instNodeId = institutionNodes.get(project.funder);
      if (instNodeId) {
        await prisma.knowledgeEdge.upsert({
          where: { fromNodeId_toNodeId_relation: { fromNodeId: projectNodeId, toNodeId: instNodeId, relation: 'related_to' } },
          create: { fromNodeId: projectNodeId, toNodeId: instNodeId, relation: 'related_to', source: 'seed', weight: 1.0 },
          update: {},
        });
        edgeCount++;
      }
    }

    // 10. Project → related_to institution (전문기관)
    if (meta?.agency) {
      const agencyNodeId = institutionNodes.get(meta.agency);
      if (agencyNodeId) {
        await prisma.knowledgeEdge.upsert({
          where: { fromNodeId_toNodeId_relation: { fromNodeId: projectNodeId, toNodeId: agencyNodeId, relation: 'related_to' } },
          create: { fromNodeId: projectNodeId, toNodeId: agencyNodeId, relation: 'related_to', source: 'seed', weight: 1.0 },
          update: {},
        });
        edgeCount++;
      }
    }
  }

  // 11. PI → supervises 각 person
  for (const [, personNodeId] of personNodes) {
    if (personNodeId === piNode.id) continue;
    await prisma.knowledgeEdge.upsert({
      where: { fromNodeId_toNodeId_relation: { fromNodeId: piNode.id, toNodeId: personNodeId, relation: 'supervises' } },
      create: { fromNodeId: piNode.id, toNodeId: personNodeId, relation: 'supervises', source: 'seed', weight: 1.0 },
      update: {},
    });
    edgeCount++;
  }

  console.log(`  ✅ KnowledgeEdge ${edgeCount}개 생성`);

  // Count totals
  const totalNodes = await prisma.knowledgeNode.count({ where: { userId } });
  const totalEdges = await prisma.knowledgeEdge.count();
  console.log(`🔗 Knowledge Graph 완료: ${totalNodes} nodes, ${totalEdges} edges`);

  return { totalNodes, totalEdges };
}
