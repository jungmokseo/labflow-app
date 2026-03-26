/**
 * Papers API Routes
 *
 * 논문 업로드, 임베딩 생성, 벡터 검색 API
 * Research Discussion Bot의 RAG 파이프라인을 지원하는 라우트
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../config/prisma.js';
import {
  generateEmbedding,
  chunkText,
  storePaperEmbeddings,
  searchPapers,
  deletePaperEmbeddings,
  listStoredPapers,
  type PaperChunk,
} from '../services/embedding-service.js';

// ── 스키마 ───────────────────────────────────────────

const IngestPaperSchema = z.object({
  paperId: z.string().min(1),
  title: z.string().min(1),
  authors: z.string().optional(),
  abstract: z.string().optional(),
  journal: z.string().optional(),
  year: z.number().optional(),
  doi: z.string().optional(),
  fullText: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
});

const SearchPapersSchema = z.object({
  query: z.string().min(1),
  limit: z.number().min(1).max(20).default(5),
  threshold: z.number().min(0).max(1).default(0.5),
});

// ── 라우트 ──────────────────────────────────────────

export async function paperRoutes(app: FastifyInstance) {

  /**
   * POST /api/papers/ingest — 논문 텍스트 수집 + 임베딩 생성 + 벡터 저장
   *
   * 플로우:
   * 1. fullText를 청크로 분할
   * 2. 각 청크에 대해 OpenAI 임베딩 생성
   * 3. Supabase pgvector에 저장
   */
  app.post('/api/papers/ingest', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = IngestPaperSchema.parse(req.body);

    try {
      // 1. 기존 임베딩 삭제 (재수집용)
      await deletePaperEmbeddings(prisma, body.paperId);

      // 2. 텍스트 청킹
      const chunks = chunkText(body.fullText);
      app.log.info(`[Papers] ${body.title}: ${chunks.length} chunks created`);

      // 3. 각 청크 임베딩 + 저장
      const results: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        // 청크 텍스트에 제목/초록 컨텍스트 추가 (embedding 품질 향상)
        const contextualText = [
          `Title: ${body.title}`,
          body.authors ? `Authors: ${body.authors}` : '',
          `Content: ${chunks[i]}`,
        ].filter(Boolean).join('\n');

        const { embedding } = await generateEmbedding(contextualText);

        const chunk: PaperChunk = {
          paperId: body.paperId,
          title: body.title,
          authors: body.authors,
          abstract: body.abstract,
          journal: body.journal,
          year: body.year,
          doi: body.doi,
          chunkIndex: i,
          chunkText: chunks[i],
          metadata: body.metadata,
        };

        const id = await storePaperEmbeddings(prisma, chunk, embedding);
        results.push(id);
      }

      return reply.send({
        success: true,
        paperId: body.paperId,
        title: body.title,
        chunksStored: results.length,
        chunkIds: results,
      });
    } catch (err) {
      app.log.error(`[Papers] Ingest failed: ${(err as Error).message}`);
      return reply.code(500).send({
        error: 'Paper ingestion failed',
        details: (err as Error).message,
      });
    }
  });

  /**
   * POST /api/papers/search — 벡터 유사도 검색
   *
   * 플로우:
   * 1. 검색 쿼리 임베딩 생성
   * 2. pgvector 코사인 유사도 검색
   * 3. 중복 제거 후 결과 반환
   */
  app.post('/api/papers/search', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = SearchPapersSchema.parse(req.body);

    try {
      // 1. 쿼리 임베딩 생성
      const { embedding } = await generateEmbedding(body.query);

      // 2. pgvector 검색
      const results = await searchPapers(prisma, embedding, body.limit, body.threshold);

      // 3. 논문 단위로 그룹핑 (복수 청크가 같은 논문에서 나올 수 있으므로)
      const paperMap = new Map<string, {
        paperId: string;
        title: string;
        authors: string | null;
        abstract: string | null;
        relevantChunks: Array<{ chunkText: string; similarity: number }>;
        maxSimilarity: number;
      }>();

      for (const r of results) {
        const existing = paperMap.get(r.paperId);
        if (existing) {
          existing.relevantChunks.push({
            chunkText: r.chunkText,
            similarity: r.similarity,
          });
          existing.maxSimilarity = Math.max(existing.maxSimilarity, r.similarity);
        } else {
          paperMap.set(r.paperId, {
            paperId: r.paperId,
            title: r.title,
            authors: r.authors,
            abstract: r.abstract,
            relevantChunks: [{ chunkText: r.chunkText, similarity: r.similarity }],
            maxSimilarity: r.similarity,
          });
        }
      }

      const papers = Array.from(paperMap.values())
        .sort((a, b) => b.maxSimilarity - a.maxSimilarity);

      return reply.send({
        query: body.query,
        totalResults: papers.length,
        papers,
      });
    } catch (err) {
      app.log.error(`[Papers] Search failed: ${(err as Error).message}`);
      return reply.code(500).send({
        error: 'Paper search failed',
        details: (err as Error).message,
      });
    }
  });

  /**
   * GET /api/papers — 저장된 논문 목록
   */
  app.get('/api/papers', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const papers = await listStoredPapers(prisma);
      return reply.send({ papers, total: papers.length });
    } catch (err) {
      return reply.code(500).send({
        error: 'Failed to list papers',
        details: (err as Error).message,
      });
    }
  });

  /**
   * DELETE /api/papers/:paperId — 논문 삭제 (임베딩 포함)
   */
  app.delete('/api/papers/:paperId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { paperId } = req.params as { paperId: string };

    try {
      await deletePaperEmbeddings(prisma, paperId);
      return reply.send({ success: true, paperId });
    } catch (err) {
      return reply.code(500).send({
        error: 'Failed to delete paper',
        details: (err as Error).message,
      });
    }
  });
}

