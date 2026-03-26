/**
 * 지식 그래프 API 라우트 — Passive Knowledge Graph
 *
 * GET    /api/graph                    — 전체 지식 그래프 (노드 + 엣지)
 * GET    /api/graph/node/:nodeId       — 특정 노드의 연결 관계
 * GET    /api/graph/connections/:type  — 특정 엔티티 유형별 연결 현황
 * GET    /api/graph/insights           — AI 인사이트
 * POST   /api/graph/seed               — 기존 데이터에서 초기 그래프 생성
 * POST   /api/graph/extract            — 텍스트에서 수동 관계 추출
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import {
  getFullGraph,
  getNodeConnections,
  getConnectionsByType,
  generateGraphInsights,
  seedGraphFromExistingData,
  buildGraphFromText,
} from '../services/knowledge-graph.js';

// ── Zod 스키마 ──────────────────────────────────────
const graphQuerySchema = z.object({
  entityType: z.string().optional(),
  limit: z.coerce.number().min(1).max(500).default(200),
  offset: z.coerce.number().min(0).default(0),
});

const extractBodySchema = z.object({
  text: z.string().min(10).max(10000),
  source: z.enum(['chat', 'meeting', 'email', 'paper_alert', 'onboarding', 'manual']).default('manual'),
});

// ── 라우트 등록 ──────────────────────────────────────
export async function knowledgeGraphRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // ── GET /api/graph — 전체 지식 그래프 ────────────
  app.get('/api/graph', async (request, reply) => {
    const query = graphQuerySchema.parse(request.query);
    const userId = request.userId!;

    const graph = await getFullGraph(userId, {
      entityType: query.entityType,
      limit: query.limit,
      offset: query.offset,
    });

    return reply.send({ success: true, data: graph });
  });

  // ── GET /api/graph/node/:nodeId — 노드 연결 ────
  app.get('/api/graph/node/:nodeId', async (request, reply) => {
    const { nodeId } = request.params as { nodeId: string };
    const userId = request.userId!;

    const connections = await getNodeConnections(userId, nodeId);
    if (!connections) {
      return reply.code(404).send({ error: '노드를 찾을 수 없습니다' });
    }

    return reply.send({ success: true, data: connections });
  });

  // ── GET /api/graph/connections/:type — 유형별 연결 ──
  app.get('/api/graph/connections/:type', async (request, reply) => {
    const { type } = request.params as { type: string };
    const userId = request.userId!;

    const validTypes = ['person', 'project', 'paper', 'term', 'equipment', 'journal', 'institution', 'topic'];
    if (!validTypes.includes(type)) {
      return reply.code(400).send({
        error: `유효하지 않은 엔티티 유형입니다. 가능한 값: ${validTypes.join(', ')}`,
      });
    }

    const connections = await getConnectionsByType(userId, type);
    return reply.send({ success: true, data: connections });
  });

  // ── GET /api/graph/insights — AI 인사이트 ────────
  app.get('/api/graph/insights', async (request, reply) => {
    const userId = request.userId!;

    const insights = await generateGraphInsights(userId);
    return reply.send({ success: true, data: insights });
  });

  // ── POST /api/graph/seed — 초기 그래프 생성 ──────
  app.post('/api/graph/seed', async (request, reply) => {
    const userId = request.userId!;

    const result = await seedGraphFromExistingData(userId);
    return reply.send({
      success: true,
      data: result,
      message: `초기 그래프 생성 완료: ${result.nodesCreated}개 노드, ${result.edgesCreated}개 엣지`,
    });
  });

  // ── POST /api/graph/extract — 수동 관계 추출 ──────
  app.post('/api/graph/extract', async (request, reply) => {
    const body = extractBodySchema.parse(request.body);
    const userId = request.userId!;

    // 비동기가 아닌 동기로 실행 (수동 호출이므로 결과 확인 필요)
    await buildGraphFromText(userId, body.text, body.source as any);

    return reply.send({
      success: true,
      message: '관계 추출 완료. /api/graph에서 결과를 확인하세요.',
    });
  });
}
