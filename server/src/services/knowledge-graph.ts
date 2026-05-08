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
import { generateEmbedding } from './embedding-service.js';
import { createHash } from 'crypto';
import { logApiCost } from './cost-logger.js';

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
export type SourceType = 'chat' | 'meeting' | 'email' | 'paper_alert' | 'onboarding' | 'manual' | 'seed' | 'wiki';

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

    // Gemini가 evidence에 따옴표/특수문자를 넣어 JSON이 깨지는 경우 복구 시도
    let parsed: any;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      // JSON 복구: 제어 문자 제거 + 잘못된 따옴표 이스케이프
      const sanitized = jsonMatch[0]
        .replace(/[\x00-\x1f]/g, ' ')
        .replace(/(?<=:\s*"[^"]*)"(?=[^"]*"[,\s}])/g, '\\"');
      try {
        parsed = JSON.parse(sanitized);
      } catch {
        // 최후 수단: relations 배열만 추출
        const relMatch = jsonMatch[0].match(/"relations"\s*:\s*\[([\s\S]*)\]/);
        if (!relMatch) return [];
        try {
          parsed = { relations: JSON.parse(`[${relMatch[1].replace(/[\x00-\x1f]/g, ' ')}]`) };
        } catch {
          console.warn('[warn] JSON 복구 실패, 건너뜀');
          return [];
        }
      }
    }
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
    console.warn('[warn] 관계 추출 실패 (비치명적):', error);
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

  const node = await prisma.knowledgeNode.create({
    data: { userId, entityType, name, metadata: metadata || {}, entityId },
  });

  // Auto-embed new knowledge node (fire-and-forget)
  const nodeText = [name, (metadata as any)?.description || ''].filter(Boolean).join('\n');
  generateEmbedding(nodeText)
    .then(result => {
      const vectorStr = `[${result.embedding.join(',')}]`;
      const hash = createHash('sha256').update(nodeText).digest('hex').slice(0, 16);
      return prisma.$executeRawUnsafe(
        `INSERT INTO memo_embeddings (source_type, source_id, user_id, title, chunk_index, chunk_text, content_hash, embedding, metadata)
         VALUES ('knowledge_node', $1, $2, $3, 0, $4, $5, $6::vector, '{}')
         ON CONFLICT (source_id, source_type, chunk_index) DO UPDATE SET embedding = $6::vector, chunk_text = $4, content_hash = $5, updated_at = NOW()`,
        node.id, userId, name, nodeText.slice(0, 2000), hash, vectorStr
      );
    })
    .catch(err => console.warn('[embed] knowledge node embedding failed:', err));

  return node;
}

// ── 엣지 upsert (weight 증가) ──────────────────────────
export async function upsertEdge(
  fromNodeId: string,
  toNodeId: string,
  relation: string,
  source: string,
  evidence?: string,
  userId?: string,
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

  return (prisma.knowledgeEdge.create as any)({
    data: { fromNodeId, toNodeId, relation, source, evidence, weight: 1, ...(userId ? { userId } : {}) },
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
    logApiCost(userId, 'gemini-2.5-flash', 0, 0, 'knowledge_graph_extract').catch(() => {});
    if (relations.length === 0) return;

    // entityId 자동 매칭을 위해 Lab 데이터 캐시 (1회 조회)
    const lab = await prisma.lab.findFirst({ where: { ownerId: userId }, select: { id: true } });
    let memberMap: Map<string, string> | null = null;
    let projectMap: Map<string, string> | null = null;

    if (lab) {
      const [members, projects] = await Promise.all([
        prisma.labMember.findMany({ where: { labId: lab.id, active: true }, select: { id: true, name: true, nameEn: true } }),
        prisma.project.findMany({ where: { labId: lab.id }, select: { id: true, name: true } }),
      ]);
      memberMap = new Map<string, string>();
      for (const m of members) {
        memberMap.set(m.name, m.id);
        if (m.nameEn) memberMap.set(m.nameEn, m.id);
      }
      projectMap = new Map(projects.map(p => [p.name, p.id]));
    }

    for (const rel of relations) {
      try {
        const fromEntityId = resolveEntityId(rel.fromEntity.type, rel.fromEntity.name, memberMap, projectMap);
        const toEntityId = resolveEntityId(rel.toEntity.type, rel.toEntity.name, memberMap, projectMap);
        const fromNode = await upsertNode(userId, rel.fromEntity.type, rel.fromEntity.name, rel.fromEntity.metadata, fromEntityId);
        const toNode = await upsertNode(userId, rel.toEntity.type, rel.toEntity.name, rel.toEntity.metadata, toEntityId);
        await upsertEdge(fromNode.id, toNode.id, rel.relation, source, rel.evidence, userId);
      } catch (err) {
        console.warn('[warn] 관계 저장 스킵:', err);
      }
    }

    console.log(`[knowledge-graph] ${relations.length}개 관계 추출됨 (source: ${source})`);
  } catch (error) {
    console.error('[knowledge-graph] 그래프 구축 실패:', error);
  }
}

/** 엔티티 이름으로 실제 DB 레코드 ID 매칭 (부분 매칭 포함) */
function resolveEntityId(
  type: string,
  name: string,
  memberMap: Map<string, string> | null,
  projectMap: Map<string, string> | null,
): string | undefined {
  if (type === 'person' && memberMap) {
    // 정확 매칭
    if (memberMap.has(name)) return memberMap.get(name);
    // 부분 매칭 (예: "김태영" ⊂ "김태영 학생")
    for (const [mName, mId] of memberMap) {
      if (name.includes(mName) || mName.includes(name)) return mId;
    }
  }
  if (type === 'project' && projectMap) {
    if (projectMap.has(name)) return projectMap.get(name);
    for (const [pName, pId] of projectMap) {
      if (name.includes(pName) || pName.includes(name)) return pId;
    }
  }
  return undefined;
}

// ── 그래프 조회: 전체 ──────────────────────────────────
export async function getFullGraph(
  userId: string,
  opts?: { entityType?: string; limit?: number; offset?: number },
) {
  const where: any = { userId };
  if (opts?.entityType) where.entityType = opts.entityType;

  // PI(본인) 노드 제외 — 모든 연결이 PI 중심이라 그래프가 무의미해짐
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const piName = user?.name?.trim().toLowerCase();

  const [allNodes, totalNodes] = await Promise.all([
    prisma.knowledgeNode.findMany({
      where,
      take: (opts?.limit || 200) + 10, // PI 제외 후 부족분 대비 여유
      skip: opts?.offset || 0,
      orderBy: { updatedAt: 'desc' },
      include: {
        outEdges: { include: { toNode: true } },
        inEdges: { include: { fromNode: true } },
      },
    }),
    prisma.knowledgeNode.count({ where }),
  ]);

  // PI 노드 필터링: person 타입이면서 이름이 PI와 일치하는 노드 제외
  const piNodeIds = new Set<string>();
  const nodes = allNodes.filter(n => {
    if (n.entityType === 'person' && piName) {
      const nodeName = n.name.trim().toLowerCase();
      if (nodeName === piName || piName.includes(nodeName) || nodeName.includes(piName)) {
        piNodeIds.add(n.id);
        return false;
      }
    }
    return true;
  }).slice(0, opts?.limit || 200);

  // 표시 범위 내 엣지만 수집 (PI 노드 연결 제외)
  const edges: any[] = [];
  const edgeIds = new Set<string>();

  for (const node of nodes) {
    for (const e of [...node.outEdges, ...node.inEdges]) {
      if (!edgeIds.has(e.id) && !piNodeIds.has(e.fromNodeId) && !piNodeIds.has(e.toNodeId)) {
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
      edgeCount:
        n.outEdges.filter(e => !piNodeIds.has(e.toNodeId)).length +
        n.inEdges.filter(e => !piNodeIds.has(e.fromNodeId)).length,
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
    meta: { totalNodes: totalNodes - piNodeIds.size, returnedNodes: nodes.length, totalEdges: edges.length },
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

// ── LightRAG: Graph + Vector 검색 ──────────────────────

export type GraphContext = {
  entities: Array<{ id: string; name: string; type: string; description?: string }>;
  relationships: Array<{ from: string; to: string; relation: string; weight: number }>;
  vectorMatches: Array<{ source: string; text: string; similarity: number }>;
  contextText: string;
};

export async function extractQueryEntities(query: string): Promise<{
  lowLevel: string[];
  highLevel: string[];
}> {
  try {
    const result = await geminiModel.generateContent({
      contents: [{
        role: 'user',
        parts: [{
          text: `다음 질문에서 엔티티를 추출하세요.
- lowLevel: 구체적 이름 (사람명, 논문 제목, 과제명 등)
- highLevel: 추상적 주제나 연구 테마
반드시 JSON으로만 응답: {"lowLevel":[],"highLevel":[]}

질문: "${query}"`,
        }],
      }],
      generationConfig: { temperature: 0, maxOutputTokens: 256 },
    });
    const text = result.response.text().trim();
    const json = text.match(/\{[\s\S]*\}/);
    if (!json) return { lowLevel: [], highLevel: [] };
    const parsed = JSON.parse(json[0]);
    return {
      lowLevel: Array.isArray(parsed.lowLevel) ? parsed.lowLevel.map(String) : [],
      highLevel: Array.isArray(parsed.highLevel) ? parsed.highLevel.map(String) : [],
    };
  } catch {
    return { lowLevel: [], highLevel: [] };
  }
}

export async function getGraphContextForQuery(
  query: string,
  userId: string,
  labId: string | null,
  options?: { maxNodes?: number; maxHops?: number; timeoutMs?: number }
): Promise<GraphContext> {
  const maxNodes = options?.maxNodes ?? 20;
  const timeoutMs = options?.timeoutMs ?? 800;

  const entities: GraphContext['entities'] = [];
  const relationships: GraphContext['relationships'] = [];
  const vectorMatches: GraphContext['vectorMatches'] = [];
  const seenNodeIds = new Set<string>();

  try {
    await Promise.race([
      _graphSearch(query, userId, labId, maxNodes, seenNodeIds, entities, relationships, vectorMatches),
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ]);

    return { entities, relationships, vectorMatches, contextText: formatGraphContext(entities, relationships, vectorMatches) };
  } catch (err) {
    console.warn('[LightRAG] graph context failed:', err);
    return { entities, relationships, vectorMatches, contextText: formatGraphContext(entities, relationships, vectorMatches) };
  }
}

async function _graphSearch(
  query: string,
  userId: string,
  labId: string | null,
  maxNodes: number,
  seenNodeIds: Set<string>,
  entities: GraphContext['entities'],
  relationships: GraphContext['relationships'],
  vectorMatches: GraphContext['vectorMatches'],
) {
  // Step 1: Extract entities from query (Gemini Flash)
  const { lowLevel, highLevel } = await extractQueryEntities(query);

  // Step 2: Low-level exact + fuzzy node matching
  const lowLevelNodes = await Promise.all(
    lowLevel.map(name =>
      prisma.knowledgeNode.findMany({
        where: { userId, name: { contains: name, mode: 'insensitive' } },
        take: 5,
      })
    )
  );

  for (const nodes of lowLevelNodes) {
    for (const n of nodes) {
      if (!seenNodeIds.has(n.id) && seenNodeIds.size < maxNodes) {
        seenNodeIds.add(n.id);
        entities.push({ id: n.id, name: n.name, type: n.entityType, description: (n.metadata as any)?.description });
      }
    }
  }

  // Step 3: High-level — vector search on MemoEmbedding
  try {
    const queryEmb = await generateEmbedding(query);
    const vectorStr = `[${queryEmb.embedding.join(',')}]`;

    const vectorResults = await prisma.$queryRawUnsafe(`
      SELECT id::text, source_type as "sourceType", source_id as "sourceId",
             title, chunk_text as "chunkText",
             1 - (embedding <=> $1::vector) as similarity
      FROM memo_embeddings
      WHERE (lab_id = $2 OR user_id = $3)
        AND 1 - (embedding <=> $1::vector) > 0.5
      ORDER BY embedding <=> $1::vector
      LIMIT 10
    `, vectorStr, labId, userId) as Array<any>;

    for (const r of vectorResults) {
      vectorMatches.push({
        source: `[${r.sourceType}] ${r.title || ''}`.trim(),
        text: (r.chunkText || '').slice(0, 200),
        similarity: Number(r.similarity?.toFixed(3) ?? 0),
      });
    }
  } catch (err) {
    console.warn('[LightRAG] vector search failed:', err);
  }

  // Step 4: 1-2 hop graph traversal from matched nodes
  if (seenNodeIds.size > 0) {
    const nodeIds = Array.from(seenNodeIds);
    const edges = await prisma.knowledgeEdge.findMany({
      where: {
        OR: [
          { fromNodeId: { in: nodeIds } },
          { toNodeId: { in: nodeIds } },
        ],
      },
      include: { fromNode: true, toNode: true },
      orderBy: { weight: 'desc' },
      take: 30,
    });

    for (const e of edges) {
      relationships.push({
        from: e.fromNode.name,
        to: e.toNode.name,
        relation: e.relation,
        weight: e.weight,
      });

      // Add discovered nodes (2nd hop)
      for (const n of [e.fromNode, e.toNode]) {
        if (!seenNodeIds.has(n.id) && seenNodeIds.size < maxNodes) {
          seenNodeIds.add(n.id);
          entities.push({ id: n.id, name: n.name, type: n.entityType });
        }
      }
    }
  }
}

function formatGraphContext(
  entities: GraphContext['entities'],
  relationships: GraphContext['relationships'],
  vectorMatches: GraphContext['vectorMatches'],
): string {
  if (entities.length === 0 && vectorMatches.length === 0) return '';

  const parts: string[] = [];

  if (entities.length > 0) {
    parts.push('## 관련 지식 그래프');
    for (const e of entities.slice(0, 10)) {
      parts.push(`- ${e.name}(${e.type})${e.description ? ': ' + e.description : ''}`);
    }
  }

  if (relationships.length > 0) {
    parts.push('\n## 그래프 관계 (weight 높은 순)');
    const sorted = [...relationships].sort((a, b) => b.weight - a.weight);
    for (const r of sorted.slice(0, 10)) {
      parts.push(`- ${r.from} --${r.relation}--> ${r.to} [${r.weight.toFixed(2)}]`);
    }
  }

  if (vectorMatches.length > 0) {
    parts.push('\n## 유사 문서');
    for (const v of vectorMatches.slice(0, 5)) {
      parts.push(`${v.source} ${v.text}... (유사도 ${v.similarity})`);
    }
  }

  return parts.join('\n');
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
    const insightUsage = result.response.usageMetadata;
    if (insightUsage) logApiCost(userId, 'gemini-2.5-flash', insightUsage.promptTokenCount ?? 0, insightUsage.candidatesTokenCount ?? 0, 'graph_insights').catch(() => {});

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

// ══════════════════════════════════════════════════════
//  THINKING COMMANDS — 옵시디언 스타일 인사이트 서피싱
// ══════════════════════════════════════════════════════

/** Sanitize LLM output before storing in DB */
function sanitizeLlmOutput(text: string, maxLength = 5000): string {
  return text
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')  // strip script tags
    .replace(/<[^>]+>/g, '')  // strip all HTML tags
    .slice(0, maxLength)
    .trim();
}

/**
 * /today — 오늘 할 일 우선순위 브리핑
 * 캘린더 + 이메일 긴급 + 논문 알림 + 미완료 액션아이템 + 최근 메모를 통합
 */
export async function dailyBrief(userId: string): Promise<string> {
  const lab = await prisma.lab.findUnique({ where: { ownerId: userId } });
  const labId = lab?.id;

  // 병렬로 모든 데이터 수집
  const [
    todayMeetings,
    recentCaptures,
    pendingEvents,
    recentMemos,
    recentAlerts,
    recentBriefing,
    unreadAlerts,
  ] = await Promise.all([
    // 오늘 미팅
    prisma.meeting.findMany({
      where: { userId, createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
    // 미완료 캡처 (태스크)
    prisma.capture.findMany({
      where: { userId, status: 'active', category: 'TASK' },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
      take: 10,
    }),
    // 대기 중 캘린더 일정
    prisma.memo.findMany({
      where: { userId, source: 'pending-event', tags: { has: 'pending' } },
      take: 5,
    }),
    // 최근 메모 (오늘)
    prisma.memo.findMany({
      where: { userId, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
    // 최신 논문 알림 (읽지 않은 것)
    labId ? prisma.paperAlertResult.findMany({
      where: { alert: { labId }, read: false },
      orderBy: [{ stars: 'desc' }, { createdAt: 'desc' }],
      take: 5,
    }) : [],
    // 최근 이메일 브리핑
    prisma.memo.findFirst({
      where: { userId, source: 'email-briefing' },
      orderBy: { createdAt: 'desc' },
    }),
    // 안 읽은 논문 알림 수
    labId ? prisma.paperAlertResult.count({
      where: { alert: { labId }, read: false },
    }) : 0,
  ]);

  // 이메일 브리핑에서 긴급/대응필요 추출
  let urgentEmails = 0;
  let actionEmails = 0;
  if (recentBriefing?.content) {
    try {
      const data = JSON.parse(recentBriefing.content);
      const items = Array.isArray(data) ? data : data.briefings || [];
      urgentEmails = items.filter((e: any) => e.category === 'urgent').length;
      actionEmails = items.filter((e: any) => e.category === 'action-needed').length;
    } catch { /* ignore */ }
  }

  // Gemini로 우선순위 브리핑 생성
  const briefingData = `
오늘 날짜: ${new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}

[이메일] 긴급: ${urgentEmails}건, 대응필요: ${actionEmails}건
${recentBriefing ? `마지막 브리핑: ${recentBriefing.createdAt.toLocaleString('ko-KR')}` : '브리핑 없음'}

[미완료 태스크 ${recentCaptures.length}건]
${recentCaptures.map((c, i) => `${i + 1}. [${c.priority}] ${c.summary || c.content.slice(0, 50)}`).join('\n') || '없음'}

[대기 중 일정 ${pendingEvents.length}건]
${pendingEvents.map(m => { try { const e = JSON.parse(m.content); return `- ${e.title} (${e.date})`; } catch { return ''; } }).filter(Boolean).join('\n') || '없음'}

[오늘 미팅 ${todayMeetings.length}건]
${todayMeetings.map(m => `- ${m.title}`).join('\n') || '없음'}

[안 읽은 논문 알림 ${unreadAlerts}건]
${recentAlerts.map(a => `- ${'★'.repeat(a.stars || 1)} ${a.title} (${a.journal})`).join('\n') || '없음'}

[최근 메모 ${recentMemos.length}건]
${recentMemos.map(m => `- ${m.title || m.content.slice(0, 40)}`).join('\n') || '없음'}
`.trim();

  try {
    const result = await geminiModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: `다음 정보를 바탕으로 오늘의 우선순위 브리핑을 작성하세요.

규칙:
1. 가장 긴급한 것부터 순서대로 정리
2. 이메일 긴급 건이 있으면 최우선
3. 마감이 가까운 태스크 강조
4. 논문 알림 중 별 3개짜리는 꼭 언급
5. 마지막에 "오늘의 포커스" 한 줄 제안
6. 한국어로 작성, 이모지 사용

${briefingData}` }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1500 },
    });
    const dailyUsage = result.response.usageMetadata;
    if (dailyUsage) logApiCost(userId, 'gemini-2.5-flash', dailyUsage.promptTokenCount ?? 0, dailyUsage.candidatesTokenCount ?? 0, 'daily_brief').catch(() => {});
    return sanitizeLlmOutput(result.response.text());
  } catch {
    // fallback: raw data 반환
    return `**오늘의 브리핑**\n\n` +
      (urgentEmails > 0 ? `[긴급] 이메일 ${urgentEmails}건\n` : '') +
      (actionEmails > 0 ? `[대응] 이메일 ${actionEmails}건\n` : '') +
      (recentCaptures.length > 0 ? `\n[할일] 미완료 태스크 ${recentCaptures.length}건\n${recentCaptures.map(c => `  - ${c.summary || c.content.slice(0, 50)}`).join('\n')}\n` : '') +
      (unreadAlerts > 0 ? `\n[논문] 안 읽은 논문 ${unreadAlerts}건\n` : '') +
      (pendingEvents.length > 0 ? `\n[일정] 대기 중 일정 ${pendingEvents.length}건\n` : '');
  }
}

/**
 * /emerge — 숨겨진 연결 발견 (weak tie surfacing)
 * Knowledge Graph에서 약한 연결 + 최근 활동에서 반복 패턴을 찾아 인사이트 생성
 */
export async function emergeInsights(userId: string): Promise<string> {
  const lab = await prisma.lab.findUnique({ where: { ownerId: userId } });
  const labId = lab?.id;

  // 1. Weak ties: weight가 낮지만 존재하는 연결 (의외의 연결)
  const weakTies = await prisma.$queryRaw<Array<{
    fromName: string; fromType: string; toName: string; toType: string;
    relation: string; weight: number; evidence: string;
  }>>`
    SELECT fn.name as "fromName", fn.entity_type as "fromType",
           tn.name as "toName", tn.entity_type as "toType",
           ke.relation, ke.weight, ke.evidence
    FROM knowledge_edges ke
    JOIN knowledge_nodes fn ON ke.from_node_id = fn.id
    JOIN knowledge_nodes tn ON ke.to_node_id = tn.id
    WHERE fn.user_id = ${userId}
      AND ke.weight <= 2
      AND ke.weight >= 1
    ORDER BY ke.updated_at DESC
    LIMIT 15
  `;

  // 2. 고립 노드 중 최근 것 (아직 연결 안 된 새로운 개념)
  const isolatedRecent = await prisma.$queryRaw<Array<{
    name: string; entityType: string; createdAt: Date;
  }>>`
    SELECT kn.name, kn.entity_type as "entityType", kn.created_at as "createdAt"
    FROM knowledge_nodes kn
    WHERE kn.user_id = ${userId}
      AND NOT EXISTS (SELECT 1 FROM knowledge_edges WHERE from_node_id = kn.id)
      AND NOT EXISTS (SELECT 1 FROM knowledge_edges WHERE to_node_id = kn.id)
    ORDER BY kn.created_at DESC
    LIMIT 10
  `;

  // 3. 최근 2주간 반복 언급된 키워드 (대화 + 메모에서)
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const recentMessages = await prisma.message.findMany({
    where: {
      channel: { userId },
      role: 'user',
      createdAt: { gte: twoWeeksAgo },
    },
    select: { content: true },
    take: 100,
  });
  const recentMemos = labId ? await prisma.memo.findMany({
    where: { labId, createdAt: { gte: twoWeeksAgo } },
    select: { content: true, title: true, tags: true },
    take: 50,
  }) : [];

  // 4. 서로 다른 과제에서 공유되는 키워드 (교차점)
  const projects = labId ? await prisma.project.findMany({
    where: { labId },
    select: { name: true, metadata: true },
  }) : [];

  // Gemini로 연결 분석
  const analysisData = `
[Weak Ties — 약한 연결 (의외의 관계)]
${weakTies.length > 0
    ? weakTies.map(t => `${t.fromName}(${t.fromType}) --${t.relation}--> ${t.toName}(${t.toType}) [weight:${t.weight}] "${t.evidence || ''}"`).join('\n')
    : '약한 연결 없음'}

[고립 노드 — 아직 연결되지 않은 개념]
${isolatedRecent.map(n => `${n.name} (${n.entityType})`).join(', ') || '없음'}

[최근 2주 대화 키워드]
${recentMessages.map(m => m.content.slice(0, 100)).join(' | ').slice(0, 2000) || '대화 없음'}

[최근 메모 태그]
${recentMemos.flatMap(m => m.tags).join(', ') || '태그 없음'}

[진행 중 과제]
${projects.map(p => p.name).join(', ') || '과제 없음'}
`.trim();

  try {
    const result = await geminiModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: `당신은 연구 인사이트 발견 전문가입니다. 아래 데이터에서 숨겨진 연결과 새로운 가능성을 찾아주세요.

분석 요청:
1. **의외의 연결**: Weak tie 중에서 실제로 유용할 수 있는 연결을 찾으세요. 예: "A 과제의 센서 기술이 B 과제의 패키징 문제를 해결할 수 있음"
2. **떠오르는 패턴**: 최근 대화/메모에서 반복적으로 등장하지만 아직 구체화되지 않은 아이디어
3. **고립된 가치**: 아직 다른 개념과 연결되지 않았지만 잠재력이 있는 개념
4. **교차 가능성**: 서로 다른 과제/분야 사이의 시너지 기회

규칙:
- 각 인사이트는 구체적이어야 함 (추상적인 조언 금지)
- "~할 수 있습니다" 대신 "~해보는 건 어떨까요?" 형태로 제안
- 3-5개 인사이트, 한국어, 이모지 사용
- 가장 흥미로운 것부터 정렬

${analysisData}` }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 2000 },
    });
    const emergeUsage = result.response.usageMetadata;
    if (emergeUsage) logApiCost(userId, 'gemini-2.5-flash', emergeUsage.promptTokenCount ?? 0, emergeUsage.candidatesTokenCount ?? 0, 'emerge_insights').catch(() => {});
    return `🔮 **Emerge — 숨겨진 연결 발견**\n\n${sanitizeLlmOutput(result.response.text())}`;
  } catch {
    if (weakTies.length === 0 && isolatedRecent.length === 0) {
      return '🔮 아직 충분한 데이터가 없습니다. 대화, 미팅, 논문이 쌓이면 숨겨진 연결을 찾아드립니다.';
    }
    return `🔮 **약한 연결 ${weakTies.length}개 발견**\n\n` +
      weakTies.slice(0, 5).map(t => `• ${t.fromName} ↔ ${t.toName} (${t.relation})`).join('\n');
  }
}

/**
 * /weekly — 이번 주 활동 리뷰 + 다음 주 제안
 */
export async function weeklyReview(userId: string): Promise<string> {
  const lab = await prisma.lab.findUnique({ where: { ownerId: userId } });
  const labId = lab?.id;

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    weekMeetings,
    weekCaptures,
    weekMemos,
    weekMessages,
    weekAlerts,
    completedCaptures,
    graphGrowth,
  ] = await Promise.all([
    prisma.meeting.findMany({
      where: { userId, createdAt: { gte: weekAgo } },
      select: { title: true, summary: true, actionItems: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.capture.findMany({
      where: { userId, createdAt: { gte: weekAgo }, status: 'active' },
      select: { summary: true, category: true, priority: true, content: true },
    }),
    labId ? prisma.memo.findMany({
      where: { labId, createdAt: { gte: weekAgo } },
      select: { title: true, source: true, tags: true, content: true },
    }) : [],
    prisma.message.count({
      where: { channel: { userId }, createdAt: { gte: weekAgo } },
    }),
    labId ? prisma.paperAlertResult.findMany({
      where: { alert: { labId }, createdAt: { gte: weekAgo } },
      orderBy: { stars: 'desc' },
      take: 5,
    }) : [],
    prisma.capture.count({
      where: { userId, completedAt: { gte: weekAgo } },
    }),
    // Knowledge Graph 성장
    Promise.all([
      prisma.knowledgeNode.count({ where: { userId, createdAt: { gte: weekAgo } } }),
      prisma.knowledgeEdge.count({ where: { fromNode: { userId }, createdAt: { gte: weekAgo } } }),
    ]),
  ]);

  const [newNodes, newEdges] = graphGrowth;

  const weekData = `
기간: ${weekAgo.toLocaleDateString('ko-KR')} ~ ${new Date().toLocaleDateString('ko-KR')}

[미팅 ${weekMeetings.length}건]
${weekMeetings.map(m => `- ${m.title} (${m.createdAt.toLocaleDateString('ko-KR')})\n  액션아이템: ${m.actionItems.join(', ') || '없음'}`).join('\n') || '없음'}

[캡처 활동] 새로 생성: ${weekCaptures.length}건, 완료: ${completedCaptures}건
${weekCaptures.slice(0, 5).map(c => `- [${c.category}/${c.priority}] ${c.summary || c.content.slice(0, 50)}`).join('\n') || '없음'}

[메모 ${weekMemos.length}건]
${weekMemos.slice(0, 5).map(m => `- [${m.source}] ${m.title || m.content.slice(0, 40)}`).join('\n') || '없음'}

[AI 대화] ${weekMessages}회 대화

[논문 알림 하이라이트]
${weekAlerts.map(a => `- ${'★'.repeat(a.stars || 1)} ${a.title}`).join('\n') || '없음'}

[Knowledge Graph 성장] +${newNodes} 노드, +${newEdges} 관계
`.trim();

  const weeklyPrompt = `다음 데이터를 바탕으로 주간 리뷰를 작성하세요.

## 출력 포맷 (정확히 따르세요)

**주간 리뷰** — ${weekAgo.toLocaleDateString('ko-KR')} ~ ${new Date().toLocaleDateString('ko-KR')}

### 이번 주 요약
- 핵심 활동 3-5줄, 각 항목 별도 줄

### 미완료 사항
- 아직 처리 안 된 액션아이템이나 태스크
- 항목별 별도 줄, 마감일 있으면 **볼드**

### 이번 주 하이라이트
- 가장 의미 있었던 활동 1-2건

### 다음 주 제안
- 데이터 기반으로 다음 주에 집중할 것 2-3개 제안
- 구체적 액션 포함

### Knowledge Graph 성장
- 새 노드/관계 수치와 의미

## 규칙
- 한국어로 작성
- 마크다운 서식(볼드 **, 불릿 -, 수평선 ---) 적극 활용
- 각 항목은 반드시 별도의 줄에 작성. 한 줄에 여러 항목을 절대 나열하지 마라.
- 키워드, 고유명사, 날짜/마감일은 반드시 **볼드**로 강조
- 이모지를 사용하지 마라. 마크다운 서식으로만 구조를 표현하라.

${weekData}`;

  // Sonnet으로 주간 리뷰 생성 (품질 우선)
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    if (env.ANTHROPIC_API_KEY) {
      const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        temperature: 0.3,
        messages: [{ role: 'user', content: weeklyPrompt }],
      });
      logApiCost(userId, 'claude-sonnet-4-20250514', response.usage.input_tokens, response.usage.output_tokens, 'weekly_review').catch(() => {});
      const text = response.content.find(b => b.type === 'text');
      if (text && text.type === 'text') {
        return text.text;
      }
    }
  } catch (err) {
    console.warn('Weekly review Sonnet failed, fallback to Gemini:', err);
  }

  // Gemini fallback
  try {
    const result = await geminiModel.generateContent({
      contents: [{ role: 'user', parts: [{ text: weeklyPrompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1500 },
    });
    const weeklyUsage = result.response.usageMetadata;
    if (weeklyUsage) logApiCost(userId, 'gemini-2.5-flash', weeklyUsage.promptTokenCount ?? 0, weeklyUsage.candidatesTokenCount ?? 0, 'weekly_review_fallback').catch(() => {});
    return sanitizeLlmOutput(result.response.text());
  } catch {
    return `**주간 리뷰 (${weekAgo.toLocaleDateString('ko-KR')} ~ 오늘)**\n\n` +
      `미팅: ${weekMeetings.length}건 | 캡처: ${weekCaptures.length}건 (완료: ${completedCaptures}건) | 대화: ${weekMessages}회\n` +
      `Knowledge Graph: +${newNodes} 노드, +${newEdges} 관계`;
  }
}

// ── 초기 시드: 기존 데이터에서 그래프 생성 ────────────
export async function seedGraphFromExistingData(userId: string): Promise<{ nodesCreated: number; edgesCreated: number }> {
  let nodesCreated = 0;
  let edgesCreated = 0;

  // 1. 기존 미팅에서 주제 노드 생성
  const meetings = await prisma.meeting.findMany({
    where: { userId },
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
          await upsertEdge(meetingNode.id, topicNode.id, 'discussed_in', 'seed', undefined, userId);
          edgesCreated++;
        }
      }
    } catch { /* skip duplicates */ }
  }

  // 2. 기존 캡처에서 태그 기반 노드
  const captures = await prisma.capture.findMany({
    where: { userId },
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

// ── 교차 연결 파이프라인: 회의/이메일/논문 간 자동 링크 ──────
/**
 * 새로 생성된 소스(회의/이메일/논문)의 텍스트를 기존 지식그래프 노드와 비교하여
 * 관련 노드를 자동으로 연결합니다.
 *
 * 동작 방식:
 * 1. 새 텍스트에서 키워드/엔티티 추출
 * 2. 기존 지식그래프 노드 중 이름이 매칭되는 것 탐색
 * 3. 매칭된 노드와 새 소스 간 엣지 생성 (related_to, mentioned_in)
 */
export async function crossLinkSources(
  userId: string,
  sourceText: string,
  sourceType: SourceType,
  sourceTitle: string,
): Promise<{ linksCreated: number }> {
  let linksCreated = 0;
  try {
    // 기존 지식그래프 노드 조회
    const existingNodes = await prisma.knowledgeNode.findMany({
      where: { userId },
      select: { id: true, name: true, entityType: true },
      take: 500,
    });
    if (existingNodes.length === 0) return { linksCreated: 0 };

    const textLower = sourceText.toLowerCase();

    // 소스 자체를 노드로 등록
    const sourceEntityType = sourceType === 'meeting' ? 'topic' : sourceType === 'email' ? 'topic' : 'paper';
    const sourceNode = await upsertNode(userId, sourceEntityType, sourceTitle, {
      source: sourceType,
      createdAt: new Date().toISOString(),
    });

    // 기존 노드 이름이 새 텍스트에 언급되었는지 확인
    for (const node of existingNodes) {
      if (node.id === sourceNode.id) continue;
      const nodeName = node.name.toLowerCase();
      // 2글자 이상의 노드명만 매칭 (너무 짧으면 오탐)
      if (nodeName.length < 2) continue;

      if (textLower.includes(nodeName)) {
        const relation = sourceType === 'meeting' ? 'discussed_in' :
                         sourceType === 'email' ? 'mentioned_in' : 'related_to';
        try {
          await upsertEdge(
            node.id,
            sourceNode.id,
            relation,
            sourceType,
            `"${node.name}" mentioned in ${sourceType}: ${sourceTitle}`,
            userId,
          );
          linksCreated++;
        } catch { /* skip duplicate */ }
      }
    }

    if (linksCreated > 0) {
      console.log(`[cross-link] Created ${linksCreated} cross-links from ${sourceType}: ${sourceTitle}`);
    }
  } catch (err) {
    console.warn('[cross-link] Failed:', err);
  }
  return { linksCreated };
}
