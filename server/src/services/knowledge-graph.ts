/**
 * Knowledge Graph Service — 자동 지식 그래프 (Passive Knowledge Graph)
 *
 * 옵시디언 스타일의 엔티티-관계 그래프를 자동으로 구축:
 * - 대화, 미팅, 이메일에서 엔티티 쌍과 관계를 AI로 추출
 * - 같은 관계가 반복 언급되면 weight++ (강화 학습 효과)
 * - 비동기 처리로 사용자 응답 지연 없음
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

// ── 타입 정의 ──────────────────────────────────────────
export interface ExtractedRelation {
  fromEntity: { name: string; type: string; metadata?: Record<string, any> };
  toEntity: { name: string; type: string; metadata?: Record<string, any> };
  relation: string;
  evidence: string;
}

export type EntityType = 'person' | 'project' | 'paper' | 'term' | 'equipment' | 'journal' | 'institution' | 'topic';
export type RelationType = 'participates_in' | 'authored' | 'uses_term' | 'published_in' | 'supervises' | 'collaborates_with' | 'cited_by' | 'related_to' | 'discussed_in' | 'mentioned_in';
export type SourceType = 'chat' | 'meeting' | 'email' | 'paper_alert' | 'onboarding' | 'manual' | 'seed';

// ── Gemini 관계 추출 프롬프트 ──────────────────────────
const RELATION_EXTRACTION_PROMPT = `당신은 학술 연구 환경에서 엔티티(개체)와 관계를 추출하는 전문가입니다.

주어진 텍스트에서 다음 유형의 엔티티를 식별하세요:
- person: 사람 이름 (연구자, 학생, 교수)
- project: 프로젝트/과제명
- paper: 논문 제목
- term: 전문 용어/기술 키워드
- equipment: 장비/도구
- journal: 학술지/컨퍼런스
- institution: 기관/대학/회사
- topic: 연구 주제/분야

그리고 엔티티 사이의 관계를 추출하세요:
- participates_in: 사람→프로젝트 참여
- authored: 사람→논문 저술
- uses_term: 프로젝트/논문→전문용어 사용
- published_in: 논문→학술지 게재
- supervises: 사람→사람 지도
- collaborates_with: 사람↔사람 협업
- discussed_in: 주제→미팅/대화에서 논의
- mentioned_in: 엔티티→이메일에서 언급
- related_to: 일반적 연관

반드시 아래 JSON 형식으로만 응답하세요. 관계가 없으면 빈 배열 반환:
{
  "relations": [
    {
      "from": { "name": "엔티티명", "type": "person" },
      "to": { "name": "엔티티명", "type": "project" },
      "relation": "participates_in",
      "evidence": "원문에서 관계를 보여주는 짧은 발췌"
    }
  ]
}

규칙:
- 엔티티명은 정규화 (예: "김태영 학생" → "김태영", "Nature Comm." → "Nature Communications")
- 확실한 관계만 추출 (추측 금지)
- 최대 10개 관계까지`;

// ── 핵심: AI 관계 추출 (비동기) ──────────────────────────
export async function extractRelationsFromText(
  text: string,
  source: SourceType,
): Promise<ExtractedRelation[]> {
  try {
    const result = await geminiModel.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            { text: RELATION_EXTRACTION_PROMPT },
            { text: `\n\n다음 텍스트에서 엔티티와 관계를 추출하세요:\n\n${text.substring(0, 3000)}` },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2048,
      },
    });

    const response = result.response.text().trim();
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.relations)) return [];

    return parsed.relations
      .filter((r: any) => r.from?.name && r.to?.name && r.relation)
      .map((r: any) => ({
        fromEntity: { name: String(r.from.name).trim(), type: String(r.from.type || 'topic').trim() },
        toEntity: { name: String(r.to.name).trim(), type: String(r.to.type || 'topic').trim() },
        relation: String(r.relation).trim(),
        evidence: String(r.evidence || '').substring(0, 500),
      }));
  } catch (error) {
    console.warn('⚠️ 관계 추출 실패 (비치명적):', error);
    return [];
  }
}

// ── 노드 upsert (get or create) ────────────────────────
export async function upsertNode(
  userId: string,
  entityType: string,
  name: string,
  metadata?: Record<string, any>,
  entityId?: string,
) {
  const existing = await prisma.knowledgeNode.findUnique({
    where: { userId_entityType_name: { userId, entityType, name } },
  });

  if (existing) {
    // 메타데이터 병합
    if (metadata || entityId) {
      const mergedMeta = { ...(existing.metadata as any || {}), ...(metadata || {}) };
      return prisma.knowledgeNode.update({
        where: { id: existing.id },
        data: {
          metadata: mergedMeta,
          ...(entityId && !existing.entityId ? { entityId } : {}),
        },
      });
    }
    return existing;
  }

  return prisma.knowledgeNode.create({
    data: { userId, entityType, name, metadata: metadata || {}, entityId },
  });
}

// ── 엣지 upsert (weight 증가) ──────────────────────────
export async function upsertEdge(
  fromNodeId: string,
  toNodeId: string,
  relation: string,
  source: string,
  evidence?: string,
) {
  const existing = await prisma.knowledgeEdge.findUnique({
    where: { fromNodeId_toNodeId_relation: { fromNodeId, toNodeId, relation } },
  });

  if (existing) {
    // weight++ 강화 학습 효과
    return prisma.knowledgeEdge.update({
      where: { id: existing.id },
      data: {
        weight: existing.weight + 1,
        evidence: evidence || existing.evidence,
        source, // 최신 소스로 업데이트
      },
    });
  }

  return prisma.knowledgeEdge.create({
    data: { fromNodeId, toNodeId, relation, source, evidence, weight: 1 },
  });
}

// ── 메인: 텍스트에서 그래프 자동 구축 (비동기, fire-and-forget) ──
export async function buildGraphFromText(
  userId: string,
  text: string,
  source: SourceType,
): Promise<void> {
  try {
    const relations = await extractRelationsFromText(text, source);
    if (relations.length === 0) return;

    for (const rel of relations) {
      try {
        const fromNode = await upsertNode(userId, rel.fromEntity.type, rel.fromEntity.name, rel.fromEntity.metadata);
        const toNode = await upsertNode(userId, rel.toEntity.type, rel.toEntity.name, rel.toEntity.metadata);
        await upsertEdge(fromNode.id, toNode.id, rel.relation, source, rel.evidence);
      } catch (err) {
        // 개별 관계 저장 실패는 무시 (unique constraint 등)
        console.warn('⚠️ 관계 저장 스킵:', err);
      }
    }

    console.log(`📊 지식 그래프: ${relations.length}개 관계 추출됨 (source: ${source})`);
  } catch (error) {
    console.warn('⚠️ 그래프 구축 실패 (비치명적):', error);
  }
}

// ── 그래프 조회: 전체 ──────────────────────────────────
export async function getFullGraph(
  userId: string,
  opts?: { entityType?: string; limit?: number; offset?: number },
) {
  const where: any = { userId };
  if (opts?.entityType) where.entityType = opts.entityType;

  const [nodes, totalNodes] = await Promise.all([
    prisma.knowledgeNode.findMany({
      where,
      take: opts?.limit || 200,
      skip: opts?.offset || 0,
      orderBy: { updatedAt: 'desc' },
      include: {
        outEdges: { include: { toNode: true } },
        inEdges: { include: { fromNode: true } },
      },
    }),
    prisma.knowledgeNode.count({ where }),
  ]);

  // 노드 ID 집합
  const nodeIds = new Set(nodes.map(n => n.id));

  // 표시 범위 내 엣지만 수집
  const edges: any[] = [];
  const edgeIds = new Set<string>();

  for (const node of nodes) {
    for (const e of [...node.outEdges, ...node.inEdges]) {
      if (!edgeIds.has(e.id)) {
        edgeIds.add(e.id);
        edges.push(e);
      }
    }
  }

  return {
    nodes: nodes.map(n => ({
      id: n.id,
      name: n.name,
      entityType: n.entityType,
      entityId: n.entityId,
      metadata: n.metadata,
      edgeCount: n.outEdges.length + n.inEdges.length,
      updatedAt: n.updatedAt.toISOString(),
    })),
    edges: edges.map(e => ({
      id: e.id,
      from: e.fromNodeId,
      to: e.toNodeId,
      relation: e.relation,
      weight: e.weight,
      source: e.source,
      evidence: e.evidence,
    })),
    meta: { totalNodes, returnedNodes: nodes.length, totalEdges: edges.length },
  };
}

// ── 그래프 조회: 특정 노드의 연결 ──────────────────────
export async function getNodeConnections(userId: string, nodeId: string) {
  const node = await prisma.knowledgeNode.findFirst({
    where: { id: nodeId, userId },
    include: {
      outEdges: { include: { toNode: true }, orderBy: { weight: 'desc' } },
      inEdges: { include: { fromNode: true }, orderBy: { weight: 'desc' } },
    },
  });

  if (!node) return null;

  return {
    node: {
      id: node.id,
      name: node.name,
      entityType: node.entityType,
      entityId: node.entityId,
      metadata: node.metadata,
    },
    outgoing: node.outEdges.map(e => ({
      relation: e.relation,
      weight: e.weight,
      target: { id: e.toNode.id, name: e.toNode.name, type: e.toNode.entityType },
      evidence: e.evidence,
      source: e.source,
    })),
    incoming: node.inEdges.map(e => ({
      relation: e.relation,
      weight: e.weight,
      source: { id: e.fromNode.id, name: e.fromNode.name, type: e.fromNode.entityType },
      evidence: e.evidence,
      edgeSource: e.source,
    })),
  };
}

// ── 그래프 조회: 엔티티 유형별 연결 현황 ──────────────
export async function getConnectionsByType(userId: string, entityType: string) {
  const nodes = await prisma.knowledgeNode.findMany({
    where: { userId, entityType },
    include: {
      outEdges: { include: { toNode: true } },
      inEdges: { include: { fromNode: true } },
    },
    orderBy: { updatedAt: 'desc' },
    take: 100,
  });

  return nodes.map(n => ({
    id: n.id,
    name: n.name,
    metadata: n.metadata,
    connections: [
      ...n.outEdges.map(e => ({
        direction: 'out' as const,
        relation: e.relation,
        weight: e.weight,
        entity: { id: e.toNode.id, name: e.toNode.name, type: e.toNode.entityType },
      })),
      ...n.inEdges.map(e => ({
        direction: 'in' as const,
        relation: e.relation,
        weight: e.weight,
        entity: { id: e.fromNode.id, name: e.fromNode.name, type: e.fromNode.entityType },
      })),
    ],
    totalConnections: n.outEdges.length + n.inEdges.length,
  }));
}

// ── AI 인사이트 생성 ──────────────────────────────────
export async function generateGraphInsights(userId: string) {
  // 그래프 통계 수집
  const [nodeCount, edgeCount, typeCounts, topConnected, isolatedNodes] = await Promise.all([
    prisma.knowledgeNode.count({ where: { userId } }),
    prisma.knowledgeEdge.count({
      where: { fromNode: { userId } },
    }),
    prisma.knowledgeNode.groupBy({
      by: ['entityType'],
      where: { userId },
      _count: true,
    }),
    // 가장 많이 연결된 노드 (outEdges 기준)
    prisma.$queryRaw`
      SELECT kn.id, kn.name, kn.entity_type as "entityType",
        (SELECT COUNT(*) FROM knowledge_edges WHERE from_node_id = kn.id) +
        (SELECT COUNT(*) FROM knowledge_edges WHERE to_node_id = kn.id) as "totalEdges"
      FROM knowledge_nodes kn
      WHERE kn.user_id = ${userId}
      ORDER BY "totalEdges" DESC
      LIMIT 5
    ` as Promise<Array<{ id: string; name: string; entityType: string; totalEdges: bigint }>>,
    // 고립 노드 (연결 없는)
    prisma.$queryRaw`
      SELECT kn.id, kn.name, kn.entity_type as "entityType"
      FROM knowledge_nodes kn
      WHERE kn.user_id = ${userId}
        AND NOT EXISTS (SELECT 1 FROM knowledge_edges WHERE from_node_id = kn.id)
        AND NOT EXISTS (SELECT 1 FROM knowledge_edges WHERE to_node_id = kn.id)
      LIMIT 10
    ` as Promise<Array<{ id: string; name: string; entityType: string }>>,
  ]);

  if (nodeCount < 3) {
    return {
      summary: '지식 그래프가 아직 초기 단계입니다. 대화, 미팅, 이메일이 쌓이면 자동으로 관계가 추출됩니다.',
      stats: { nodes: nodeCount, edges: edgeCount },
      insights: [],
    };
  }

  // Gemini로 인사이트 생성
  const graphSummary = `
노드 수: ${nodeCount}, 엣지 수: ${edgeCount}
엔티티 유형별: ${typeCounts.map(t => `${t.entityType}: ${t._count}개`).join(', ')}
가장 연결 많은 엔티티: ${topConnected.map(n => `${n.name}(${n.entityType}, ${Number(n.totalEdges)}개 연결)`).join(', ')}
고립 엔티티: ${isolatedNodes.map(n => `${n.name}(${n.entityType})`).join(', ')}
`.trim();

  try {
    const result = await geminiModel.generateContent({
      contents: [{
        role: 'user',
        parts: [{
          text: `당신은 연구실 지식 그래프 분석가입니다. 다음 그래프 통계를 분석하여 연구 관리에 도움이 되는 인사이트 3-5개를 한국어로 생성하세요.

${graphSummary}

인사이트 유형:
- 협업 기회: 같은 주제에 관심 있지만 직접 연결이 없는 사람들
- 핵심 허브: 가장 많이 연결된 엔티티의 중요성
- 고립 엔티티: 연결이 없는 엔티티에 대한 제안
- 연구 클러스터: 밀접하게 연결된 주제 그룹

JSON 배열로만 응답:
[{ "type": "collaboration|hub|isolated|cluster", "title": "인사이트 제목", "description": "상세 설명", "entities": ["관련 엔티티명"] }]`,
        }],
      }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1500 },
    });

    const text = result.response.text().trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const insights = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

    return {
      summary: `지식 그래프에 ${nodeCount}개 엔티티와 ${edgeCount}개 관계가 있습니다.`,
      stats: {
        nodes: nodeCount,
        edges: edgeCount,
        typeBreakdown: Object.fromEntries(typeCounts.map(t => [t.entityType, t._count])),
      },
      topEntities: topConnected.map(n => ({
        name: n.name,
        type: n.entityType,
        connections: Number(n.totalEdges),
      })),
      isolatedEntities: isolatedNodes.map(n => ({ name: n.name, type: n.entityType })),
      insights,
    };
  } catch {
    return {
      summary: `지식 그래프에 ${nodeCount}개 엔티티와 ${edgeCount}개 관계가 있습니다.`,
      stats: { nodes: nodeCount, edges: edgeCount },
      insights: [],
    };
  }
}

// ── 초기 시드: 기존 데이터에서 그래프 생성 ────────────
export async function seedGraphFromExistingData(userId: string): Promise<{ nodesCreated: number; edgesCreated: number }> {
  let nodesCreated = 0;
  let edgesCreated = 0;

  // 1. 기존 미팅에서 주제 노드 생성
  const meetings = await prisma.meeting.findMany({
    where: { user: { clerkId: userId } },
    select: { id: true, title: true, agenda: true, actionItems: true },
    take: 50,
  });

  for (const m of meetings) {
    try {
      const meetingNode = await upsertNode(userId, 'topic', m.title, { sourceType: 'meeting' }, m.id);
      nodesCreated++;

      // 안건 → 토픽
      for (const agenda of m.agenda) {
        if (agenda.length > 2) {
          const topicNode = await upsertNode(userId, 'topic', agenda);
          nodesCreated++;
          await upsertEdge(meetingNode.id, topicNode.id, 'discussed_in', 'seed');
          edgesCreated++;
        }
      }
    } catch { /* skip duplicates */ }
  }

  // 2. 기존 캡처에서 태그 기반 노드
  const captures = await prisma.capture.findMany({
    where: { user: { clerkId: userId } },
    select: { id: true, tags: true, summary: true, category: true },
    take: 100,
  });

  const tagCounts = new Map<string, number>();
  for (const c of captures) {
    for (const tag of c.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }

  // 2회 이상 언급된 태그만 노드로
  for (const [tag, count] of tagCounts) {
    if (count >= 2 && tag.length > 1) {
      try {
        await upsertNode(userId, 'topic', tag, { frequency: count });
        nodesCreated++;
      } catch { /* skip */ }
    }
  }

  return { nodesCreated, edgesCreated };
}
