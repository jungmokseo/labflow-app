/**
 * Embedding Service
 *
 * OpenAI text-embedding-3-small 모델을 사용해
 * 논문 텍스트를 벡터 임베딩으로 변환하고
 * Supabase pgvector에서 유사도 검색을 수행하는 서비스
 */

import { env } from '../config/env.js';
import { trackAICost, COST_PER_CALL } from '../middleware/rate-limiter.js';

// 마지막 userId를 추적하여 임베딩 비용 귀속 (호출부에서 설정)
let _currentUserId: string | null = null;
export function setEmbeddingUserId(userId: string | null): void {
  _currentUserId = userId;
}

// ── 타입 정의 ─────────────────────────────────────────

export interface PaperChunk {
  paperId: string;
  labId?: string;
  title: string;
  authors?: string;
  abstract?: string;
  journal?: string;
  year?: number;
  doi?: string;
  chunkIndex: number;
  chunkText: string;
  metadata?: Record<string, unknown>;
}

export interface PaperSearchResult {
  id: string;
  paperId: string;
  title: string;
  authors: string | null;
  abstract: string | null;
  chunkText: string;
  similarity: number;
}

export interface EmbeddingResult {
  embedding: number[];
  tokensUsed: number;
}

// ── 임베딩 생성 ──────────────────────────────────────

/**
 * OpenAI text-embedding-3-small로 텍스트 임베딩 생성
 * 출력 차원: 1536 (pgvector 테이블과 동일)
 */
export async function generateEmbedding(text: string): Promise<EmbeddingResult> {
  if (!env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text.slice(0, 8000), // 토큰 제한 방지
      dimensions: 1536,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI Embedding API error: ${response.status} ${err}`);
  }

  const data = await response.json() as {
    data: Array<{ embedding: number[] }>;
    usage: { total_tokens: number };
  };

  // OpenAI 임베딩 비용 추적
  if (_currentUserId) {
    trackAICost(_currentUserId, 'openai-embedding', COST_PER_CALL['openai-embedding'], 'embedding');
  }

  return {
    embedding: data.data[0].embedding,
    tokensUsed: data.usage.total_tokens,
  };
}

/**
 * 복수 텍스트 배치 임베딩 생성
 */
export async function generateEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
  if (!env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: texts.map(t => t.slice(0, 8000)),
      dimensions: 1536,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI Embedding API error: ${response.status} ${err}`);
  }

  const data = await response.json() as {
    data: Array<{ embedding: number[]; index: number }>;
    usage: { total_tokens: number };
  };

  // OpenAI 임베딩 비용 추적 (배치: 텍스트 수만큼)
  if (_currentUserId) {
    trackAICost(_currentUserId, 'openai-embedding', COST_PER_CALL['openai-embedding'] * texts.length, 'embedding');
  }

  return data.data
    .sort((a, b) => a.index - b.index)
    .map(d => ({
      embedding: d.embedding,
      tokensUsed: Math.round(data.usage.total_tokens / texts.length),
    }));
}

// ── 텍스트 청킹 ────────────────────────────────────────

/**
 * 논문 텍스트를 임베딩 가능한 청크로 분할
 * 전략: 단락 기반 분할 + 오버랩 없음
 */
export function chunkText(text: string, maxChunkSize: number = 1500): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let currentChunk = '';

  for (const para of paragraphs) {
    if (currentChunk.length + para.length > maxChunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = '';
    }
    currentChunk += para + '\n\n';
  }

  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  // 빈 청크 방지 + 너무 긴 단일 단락 처리
  return chunks.flatMap(chunk => {
    if (chunk.length <= maxChunkSize) return [chunk];
    // 문장 단위로 추가 분할
    const sentences = chunk.split(/(?<=[.!?])\s+/);
    const subChunks: string[] = [];
    let sub = '';
    for (const s of sentences) {
      if (sub.length + s.length > maxChunkSize && sub.length > 0) {
        subChunks.push(sub.trim());
        sub = '';
      }
      sub += s + ' ';
    }
    if (sub.trim()) subChunks.push(sub.trim());
    return subChunks;
  });
}

// ── Supabase 벡터 저장/검색 ─────────────────────────────

let tableEnsured = false;

/** paper_embeddings 테이블이 없으면 자동 생성 */
async function ensurePaperEmbeddingsTable(prisma: any) {
  if (tableEnsured) return;
  try {
    await prisma.$queryRawUnsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
    await prisma.$queryRawUnsafe(`
      CREATE TABLE IF NOT EXISTS paper_embeddings (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        paper_id      TEXT NOT NULL,
        lab_id        TEXT,
        title         TEXT NOT NULL,
        authors       TEXT,
        abstract      TEXT,
        journal       TEXT,
        year          INTEGER,
        doi           TEXT,
        chunk_index   INTEGER NOT NULL DEFAULT 0,
        chunk_text    TEXT NOT NULL,
        embedding     vector(1536) NOT NULL,
        metadata      JSONB DEFAULT '{}',
        created_at    TIMESTAMPTZ DEFAULT now(),
        updated_at    TIMESTAMPTZ DEFAULT now()
      )
    `);
    await prisma.$queryRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_paper_embeddings_paper_id ON paper_embeddings(paper_id)`);
    await prisma.$queryRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_paper_embeddings_lab_id ON paper_embeddings(lab_id)`);
    try {
      await prisma.$queryRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_paper_embeddings_embedding ON paper_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`);
    } catch { /* ivfflat은 데이터 부족 시 실패할 수 있음 */ }
    tableEnsured = true;
    console.log('[embedding] paper_embeddings table ensured');
  } catch (e) {
    console.error('[embedding] Failed to ensure table:', e);
  }
}

/**
 * Supabase에 논문 청크 임베딩 저장
 * Prisma client 대신 raw SQL 사용 (pgvector 타입 지원)
 */
export async function storePaperEmbeddings(
  prisma: any,
  paper: PaperChunk,
  embedding: number[]
): Promise<string> {
  await ensurePaperEmbeddingsTable(prisma);
  const vectorStr = `[${embedding.join(',')}]`;

  const result = await prisma.$queryRawUnsafe(`
    INSERT INTO paper_embeddings (paper_id, lab_id, title, authors, abstract, journal, year, doi, chunk_index, chunk_text, embedding, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector, $12::jsonb)
    RETURNING id::text
  `,
    paper.paperId,
    paper.labId || null,
    paper.title,
    paper.authors || null,
    paper.abstract || null,
    paper.journal || null,
    paper.year || null,
    paper.doi || null,
    paper.chunkIndex,
    paper.chunkText,
    vectorStr,
    JSON.stringify(paper.metadata || {})
  );

  return result[0].id;
}

/**
 * pgvector 코사인 유사도로 논문 검색
 * Supabase의 search_papers RPC 함수 활용
 */
export async function searchPapers(
  prisma: any,
  queryEmbedding: number[],
  limit: number = 5,
  threshold: number = 0.5,
  labId?: string,
): Promise<PaperSearchResult[]> {
  const vectorStr = `[${queryEmbedding.join(',')}]`;

  const labFilter = labId ? `AND lab_id = $4` : '';
  const params: any[] = [vectorStr, threshold, limit];
  if (labId) params.push(labId);

  const results = await prisma.$queryRawUnsafe(`
    SELECT
      id::text,
      paper_id as "paperId",
      title,
      authors,
      abstract,
      chunk_text as "chunkText",
      1 - (embedding <=> $1::vector) as similarity
    FROM paper_embeddings
    WHERE 1 - (embedding <=> $1::vector) > $2 ${labFilter}
    ORDER BY embedding <=> $1::vector
    LIMIT $3
  `,
    ...params
  );

  return results as PaperSearchResult[];
}

/**
 * 특정 paper_id의 모든 청크 삭제 (재임베딩용)
 */
export async function deletePaperEmbeddings(
  prisma: any,
  paperId: string
): Promise<number> {
  const result = await prisma.$queryRawUnsafe(`
    DELETE FROM paper_embeddings WHERE paper_id = $1
  `, paperId);
  return (result as any)?.count || 0;
}

/**
 * 저장된 논문 목록 조회 (중복 제거)
 */
export async function listStoredPapers(
  prisma: any,
  labId?: string,
): Promise<Array<{ paperId: string; title: string; authors: string | null; chunkCount: number }>> {
  const labFilter = labId ? `WHERE lab_id = $1` : '';
  const params = labId ? [labId] : [];
  const results = await prisma.$queryRawUnsafe(`
    SELECT
      paper_id as "paperId",
      MAX(title) as title,
      MAX(authors) as authors,
      COUNT(*)::int as "chunkCount"
    FROM paper_embeddings
    ${labFilter}
    GROUP BY paper_id
    ORDER BY MAX(created_at) DESC
  `, ...params);

  return results as Array<{ paperId: string; title: string; authors: string | null; chunkCount: number }>;
}

