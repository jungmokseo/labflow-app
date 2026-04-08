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
import { authMiddleware } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { buildGraphFromText } from '../services/knowledge-graph.js';

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
  // 모든 논문 라우트에 인증 적용
  app.addHook('preHandler', authMiddleware);

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

  // ══════════════════════════════════════════════════
  //  핵심 논문 관리 (업로드 + 인덱싱 + 자연어 조회)
  // ══════════════════════════════════════════════════

  /**
   * POST /api/papers/upload — PDF 업로드 → 텍스트 추출 → Publication + 벡터 임베딩
   *
   * "핵심 논문 등록": PDF 올리면 자동으로
   * 1. Gemini로 제목/저자/저널/연도/초록 추출
   * 2. Publication DB에 저장
   * 3. 전문을 청크 분할 → 벡터 임베딩 → pgvector 저장
   */
  app.post('/api/papers/upload', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.userId!;
    const lab = await prisma.lab.findUnique({ where: { ownerId: userId } });
    if (!lab) return reply.code(404).send({ error: '연구실을 먼저 설정해주세요.' });

    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'PDF 파일이 필요합니다' });

    const chunks: Buffer[] = [];
    for await (const chunk of data.file as any) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    const buffer = Buffer.concat(chunks);
    if (buffer.length > 30 * 1024 * 1024) return reply.code(413).send({ error: '최대 30MB' });

    // 별칭 (multipart field)
    const nicknameField = (data.fields as any)?.nickname;
    const nickname = nicknameField?.value || null;

    try {
      // 1. Gemini로 논문 메타데이터 + 전문 추출
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

      const metaResult = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { data: buffer.toString('base64'), mimeType: 'application/pdf' } },
            { text: `이 논문의 메타데이터를 추출하세요. JSON으로만 응답:
{
  "title": "논문 제목 (원문 그대로)",
  "authors": "저자 목록 (쉼표 구분)",
  "journal": "저널명",
  "year": 2024,
  "doi": "10.xxxx/xxxxx 또는 null",
  "abstract": "초록 전문 (영문)"
}` },
          ],
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
      });

      const metaText = metaResult.response.text().trim();
      const metaMatch = metaText.match(/\{[\s\S]*\}/);
      const meta = metaMatch ? JSON.parse(metaMatch[0]) : {};

      // 2. 전문 텍스트 추출
      const fullResult = await model.generateContent({
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { data: buffer.toString('base64'), mimeType: 'application/pdf' } },
            { text: '이 논문의 전체 텍스트를 추출하세요. 제목부터 References까지 모든 텍스트를 그대로 출력:' },
          ],
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
      });
      const fullText = fullResult.response.text().trim();

      // 3. Publication DB 저장
      const pub = await prisma.publication.create({
        data: {
          labId: lab.id,
          title: meta.title || data.filename || 'Untitled',
          authors: meta.authors || null,
          journal: meta.journal || null,
          year: meta.year || null,
          doi: meta.doi || null,
          abstract: meta.abstract || null,
          nickname,
          indexed: false,
        },
      });

      // 4. 벡터 임베딩 (비동기 — 응답 먼저 보냄)
      const paperId = pub.id;
      (async () => {
        try {
          const textChunks = chunkText(fullText);
          for (let i = 0; i < textChunks.length; i++) {
            const contextualText = `Title: ${meta.title || ''}\nAuthors: ${meta.authors || ''}\nContent: ${textChunks[i]}`;
            const { embedding } = await generateEmbedding(contextualText);
            await storePaperEmbeddings(prisma, {
              paperId,
              title: meta.title,
              authors: meta.authors,
              abstract: meta.abstract,
              journal: meta.journal,
              year: meta.year,
              doi: meta.doi,
              chunkIndex: i,
              chunkText: textChunks[i],
            }, embedding);
          }
          await prisma.publication.update({ where: { id: paperId }, data: { indexed: true } });
          console.log(`[paper] Paper indexed: ${meta.title} (${textChunks.length} chunks)`);

          // 5. 지식 그래프에 논문 관계 구축
          const graphText = `논문 "${meta.title}" (${meta.journal || ''}, ${meta.year || ''})의 저자: ${meta.authors || ''}. 초록: ${meta.abstract || ''}`;
          await buildGraphFromText(userId, graphText, 'paper_alert');
          console.log(`[paper] Knowledge graph updated: ${meta.title}`);
        } catch (err) {
          console.error('Paper indexing failed:', err);
        }
      })();

      return reply.code(201).send({
        success: true,
        publication: pub,
        message: `논문이 등록되었습니다: "${meta.title || data.filename}". 벡터 인덱싱이 백그라운드에서 진행 중입니다.`,
        metadata: meta,
      });
    } catch (err: any) {
      return reply.code(500).send({ error: '논문 업로드 실패', details: err.message });
    }
  });

  /**
   * GET /api/papers/lookup — 자연어로 핵심 논문 조회
   *
   * 쿼리 예시:
   * - "2023 Adv Mat" → year=2023, journal에 "Adv" 포함
   * - "핵심 논문 1번" → nickname으로 검색
   * - "하이드로겔 논문" → title/abstract에 키워드 매칭
   * - "LM 논문" → nickname="LM 논문" 또는 title에 "liquid metal"
   */
  app.get('/api/papers/lookup', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.userId!;
    const lab = await prisma.lab.findUnique({ where: { ownerId: userId } });
    if (!lab) return reply.code(404).send({ error: '연구실 설정이 필요합니다.' });

    const { q } = z.object({ q: z.string().min(1) }).parse(req.query);

    // 전체 Publication 목록 로드
    const pubs = await prisma.publication.findMany({
      where: { labId: lab.id },
      orderBy: { year: 'desc' },
    });

    if (pubs.length === 0) return reply.send({ results: [], query: q });

    // Gemini로 자연어 쿼리 → 매칭
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const pubList = pubs.map((p, i) => `[${i}] "${p.title}" (${p.journal || '?'}, ${p.year || '?'})${p.nickname ? ` 별칭: ${p.nickname}` : ''} ${p.indexed ? '[indexed]' : '[pending]'}`).join('\n');

    const result = await model.generateContent(
      `사용자가 "${q}"라고 검색했습니다. 다음 논문 목록에서 매칭되는 논문의 인덱스를 JSON 배열로 반환하세요.
모호한 경우 가능한 후보를 모두 포함하세요.

논문 목록:
${pubList}

응답: [0, 3, 5] 형태로만. 매칭 없으면 [].`
    );

    const matchText = result.response.text().trim();
    const matchArr = matchText.match(/\[[\d,\s]*\]/);
    let indices: number[] = [];
    if (matchArr) {
      try { indices = JSON.parse(matchArr[0]); } catch { /* ignore */ }
    }

    const matched = indices
      .filter(i => i >= 0 && i < pubs.length)
      .map(i => pubs[i]);

    return reply.send({ results: matched, query: q, totalPublications: pubs.length });
  });

  /**
   * PATCH /api/papers/publications/:id — 별칭 설정
   */
  app.patch('/api/papers/publications/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ nickname: z.string().optional() }).parse(req.body);
    const updated = await prisma.publication.update({
      where: { id },
      data: { nickname: body.nickname },
    });
    return reply.send({ success: true, data: updated });
  });

  /**
   * GET /api/papers/publications — 등록된 핵심 논문 목록 (인덱싱 상태 포함)
   */
  app.get('/api/papers/publications', async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = req.userId!;
    const lab = await prisma.lab.findUnique({ where: { ownerId: userId } });
    if (!lab) return reply.send({ data: [] });

    const pubs = await prisma.publication.findMany({
      where: { labId: lab.id },
      orderBy: [{ year: 'desc' }, { createdAt: 'desc' }],
    });
    return reply.send({ data: pubs });
  });
}

