/**
 * RAG Engine — Production-grade Retrieval-Augmented Generation
 *
 * 1. Embedding Manager: embed + store + change detection (content hash)
 * 2. Query Expander: synonym map + LLM expansion
 * 3. Hybrid Search: vector similarity + keyword FTS via pgvector
 * 4. Reranker: confidence decay + access frequency + recency boost
 * 5. Grounded Prompt Builder: numbered citations + hallucination guard
 */

import { createHash } from 'crypto';
import { generateEmbedding, generateEmbeddings } from './embedding-service.js';
import { env } from '../config/env.js';

// ── Types ──────────────────────────────────────────

export interface EmbeddableRecord {
  sourceType: 'memo' | 'member' | 'project' | 'publication';
  sourceId: string;
  labId?: string | null;
  userId?: string | null;
  title: string;
  content: string;
  tags?: string[];
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface SearchResult {
  id: string;
  sourceType: string;
  sourceId: string;
  title: string | null;
  chunkText: string;
  metadata: Record<string, unknown>;
  vectorScore: number;
  keywordScore: number;
  combinedScore: number;
}

export interface RankedResult extends SearchResult {
  finalScore: number;
  citation: number;
}

interface ExpandedQuery {
  original: string;
  expanded: string;
  keywords: string[];
}

// ── 1. Embedding Manager ──────────────────────────

function computeContentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function buildEmbeddableText(record: EmbeddableRecord): string {
  const parts = [];
  if (record.source) parts.push(`[${record.source}]`);
  if (record.title) parts.push(record.title);
  if (record.content) parts.push(record.content);
  if (record.tags?.length) parts.push(`태그: ${record.tags.join(', ')}`);
  return parts.join('\n');
}

/**
 * 문서 유형별 스마트 청킹
 * - 규정/매뉴얼: 조항 단위 (제X조, X항, X.X.)
 * - 논문: 섹션 단위 (Abstract, Introduction, Methods, Results, Discussion, References)
 * - 엑셀/데이터: 행 그룹 단위
 * - 회의록: 안건 단위
 * - 일반: 단락 기반 500자
 */
function chunkRecord(record: EmbeddableRecord): Array<{ index: number; text: string }> {
  const fullText = buildEmbeddableText(record);

  if (fullText.length <= 500) {
    return [{ index: 0, text: fullText }];
  }

  // Context prefix for all chunks
  const prefix = [
    record.source ? `[${record.source}]` : '',
    record.title || '',
    record.tags?.length ? `태그: ${record.tags.join(', ')}` : '',
  ].filter(Boolean).join(' | ');
  const prefixStr = prefix ? `${prefix}\n` : '';

  // Detect document type and choose strategy
  const content = record.content;
  const isRegulation = /제\d+조|제\d+항|\d+\.\d+\.\d+|조항|규정|시행세칙|매뉴얼/i.test(content);
  const isPaper = /abstract|introduction|method|result|discussion|conclusion|references|초록|서론|방법|결과|논의|결론|참고문헌/i.test(content);
  const isMeeting = /안건|논의 내용|액션 아이템|다음 미팅|다음 할 일/i.test(content);
  const isExcel = record.tags?.includes('excel') || (record.source === 'file-upload' && record.tags?.includes('excel'));

  let sections: string[];

  if (isRegulation) {
    // Split by article/section markers
    sections = content.split(/(?=제\d+조|제\d+항|\n\d+\.\d+[\.\s]|\n[①②③④⑤⑥⑦⑧⑨⑩])/);
  } else if (isPaper) {
    // Split by section headers
    sections = content.split(/(?=\n(?:Abstract|Introduction|Method|Result|Discussion|Conclusion|Reference|초록|서론|방법|결과|논의|결론|참고문헌)[s]?\b)/i);
  } else if (isMeeting) {
    // Split by agenda items
    sections = content.split(/(?=\n(?:##?\s|안건|논의|액션|다음))/);
  } else {
    // Default: paragraph-based
    sections = content.split(/\n\n+|\n(?=[■•\-\d]+\.?\s)/);
  }

  // Build chunks with max size, merging small sections
  const maxChunkSize = 800 - prefixStr.length;
  const chunks: Array<{ index: number; text: string }> = [];
  let currentChunk = '';
  let idx = 0;

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // If a single section is too large, sub-split by paragraphs
    if (trimmed.length > maxChunkSize) {
      if (currentChunk.trim()) {
        chunks.push({ index: idx++, text: `${prefixStr}${currentChunk.trim()}` });
        currentChunk = '';
      }
      // Sub-split large section
      const subParts = trimmed.split(/\n\n+/);
      let subChunk = '';
      for (const sub of subParts) {
        if (subChunk.length + sub.length > maxChunkSize && subChunk.length > 0) {
          chunks.push({ index: idx++, text: `${prefixStr}${subChunk.trim()}` });
          subChunk = '';
        }
        subChunk += sub + '\n';
      }
      if (subChunk.trim()) {
        chunks.push({ index: idx++, text: `${prefixStr}${subChunk.trim()}` });
      }
      continue;
    }

    if (currentChunk.length + trimmed.length > maxChunkSize && currentChunk.length > 0) {
      chunks.push({ index: idx++, text: `${prefixStr}${currentChunk.trim()}` });
      currentChunk = '';
    }
    currentChunk += trimmed + '\n\n';
  }

  if (currentChunk.trim()) {
    chunks.push({ index: idx, text: `${prefixStr}${currentChunk.trim()}` });
  }

  return chunks.length > 0 ? chunks : [{ index: 0, text: fullText.slice(0, 1500) }];
}

export async function embedAndStore(
  prisma: any,
  record: EmbeddableRecord,
): Promise<{ stored: boolean; skipped: boolean }> {
  const fullText = buildEmbeddableText(record);
  const hash = computeContentHash(fullText);

  // Check if already embedded with same content
  const existing = await prisma.$queryRawUnsafe(`
    SELECT id FROM memo_embeddings
    WHERE source_id = $1 AND source_type = $2 AND content_hash = $3
    LIMIT 1
  `, record.sourceId, record.sourceType, hash);

  if ((existing as any[]).length > 0) {
    return { stored: false, skipped: true };
  }

  // Delete old embeddings (all chunks) if content changed
  await prisma.$queryRawUnsafe(`
    DELETE FROM memo_embeddings WHERE source_id = $1 AND source_type = $2
  `, record.sourceId, record.sourceType);

  // 청킹: 긴 텍스트는 분할하여 각각 임베딩
  const chunks = chunkRecord(record);

  for (const chunk of chunks) {
    const { embedding } = await generateEmbedding(chunk.text);
    const vectorStr = `[${embedding.join(',')}]`;

    await prisma.$queryRawUnsafe(`
      INSERT INTO memo_embeddings (source_type, source_id, lab_id, user_id, title, chunk_index, chunk_text, content_hash, embedding, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10::jsonb)
    `,
      record.sourceType,
      record.sourceId,
      record.labId || null,
      record.userId || null,
      record.title || null,
      chunk.index,
      chunk.text,
      hash,
      vectorStr,
      JSON.stringify(record.metadata || {}),
    );
  }

  return { stored: true, skipped: false };
}

export async function embedBatch(
  prisma: any,
  records: EmbeddableRecord[],
  batchSize: number = 50,
): Promise<{ success: number; skipped: number; failed: number }> {
  let success = 0, skipped = 0, failed = 0;

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    const texts = batch.map(r => buildEmbeddableText(r));
    const hashes = texts.map(t => computeContentHash(t));

    // Check which need embedding
    const needsEmbedding: number[] = [];
    for (let j = 0; j < batch.length; j++) {
      const existing = await prisma.$queryRawUnsafe(`
        SELECT id FROM memo_embeddings
        WHERE source_id = $1 AND source_type = $2 AND content_hash = $3
        LIMIT 1
      `, batch[j].sourceId, batch[j].sourceType, hashes[j]);
      if ((existing as any[]).length === 0) {
        needsEmbedding.push(j);
      } else {
        skipped++;
      }
    }

    if (needsEmbedding.length === 0) continue;

    try {
      const textsToEmbed = needsEmbedding.map(j => texts[j]);
      const embeddings = await generateEmbeddings(textsToEmbed);

      for (let k = 0; k < needsEmbedding.length; k++) {
        const j = needsEmbedding[k];
        const record = batch[j];
        const vectorStr = `[${embeddings[k].embedding.join(',')}]`;

        try {
          await prisma.$queryRawUnsafe(`
            DELETE FROM memo_embeddings WHERE source_id = $1 AND source_type = $2
          `, record.sourceId, record.sourceType);

          await prisma.$queryRawUnsafe(`
            INSERT INTO memo_embeddings (source_type, source_id, lab_id, user_id, title, chunk_index, chunk_text, content_hash, embedding, metadata)
            VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8::vector, $9::jsonb)
          `,
            record.sourceType,
            record.sourceId,
            record.labId || null,
            record.userId || null,
            record.title || null,
            texts[j],
            hashes[j],
            vectorStr,
            JSON.stringify(record.metadata || {}),
          );
          success++;
        } catch (err) {
          console.warn(`Embed failed for ${record.sourceType}/${record.sourceId}:`, err);
          failed++;
        }
      }
    } catch (err) {
      console.warn(`Batch embedding failed:`, err);
      failed += needsEmbedding.length;
    }

    // Rate limit pause between batches
    if (i + batchSize < records.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return { success, skipped, failed };
}

// ── 2. Query Expander ────────────────────────────

const SYNONYM_MAP: Record<string, string[]> = {
  '계정': ['로그인', '비밀번호', 'ID', '아이디', 'account', '패스워드'],
  '과제': ['프로젝트', '연구비', '사업', 'R&D', '연구과제', '수행'],
  '학회': ['컨퍼런스', '심포지엄', '학술대회', 'conference'],
  '장비': ['기기', '실험장비', '분석장비', 'equipment', 'instrument'],
  '정산': ['예산', '집행', '보고서', '잔액', '결산'],
  '참여율': ['출석', '출석률', '참석', 'attendance'],
  '논문': ['paper', '저널', '투고', '게재', '출판', 'publication'],
  '학생': ['대학원생', '석사', '박사', '연구원', '구성원', 'member'],
  '미팅': ['회의', '면담', '상담', 'meeting', '미팅노트'],
  '일정': ['스케줄', '캘린더', 'calendar', 'schedule'],
  '규정': ['규칙', '매뉴얼', '가이드', '안내', 'regulation'],
  '사사': ['acknowledgement', 'funding', '지원사업'],
  '이메일': ['메일', 'email', 'gmail'],
  '연락처': ['전화', '번호', '이메일', 'contact'],
  '휴가': ['연차', '출장', '부재', 'vacation'],
};

export function expandQuery(query: string): ExpandedQuery {
  // Extract meaningful keywords
  const cleaned = query.replace(/[?？！!을를이가에서의로는은해줘줘요알려정보보여뭐있어내]/g, ' ');
  const words = cleaned.split(/\s+/).filter(w => w.length > 1);

  // Find synonyms
  const expanded = new Set(words);
  for (const word of words) {
    // Direct match
    if (SYNONYM_MAP[word]) {
      SYNONYM_MAP[word].forEach(s => expanded.add(s));
    }
    // Partial match (e.g., "계정정보" contains "계정")
    for (const [key, synonyms] of Object.entries(SYNONYM_MAP)) {
      if (word.includes(key) || key.includes(word)) {
        synonyms.forEach(s => expanded.add(s));
        expanded.add(key);
      }
    }
  }

  return {
    original: query,
    expanded: Array.from(expanded).join(' '),
    keywords: words,
  };
}

// ── 3. Hybrid Search ─────────────────────────────

export async function hybridSearch(
  prisma: any,
  query: string,
  userId: string,
  labId: string | null,
  options?: { limit?: number; threshold?: number },
): Promise<SearchResult[]> {
  const limit = options?.limit || 10;
  const threshold = options?.threshold || 0.25;

  const expanded = expandQuery(query);

  // Generate query embedding from expanded text
  let queryEmbedding: number[];
  try {
    const result = await generateEmbedding(expanded.expanded);
    queryEmbedding = result.embedding;
  } catch (err) {
    console.warn('Query embedding failed, falling back to keyword-only:', err);
    return keywordFallback(prisma, expanded.keywords, userId, labId, limit);
  }

  const vectorStr = `[${queryEmbedding.join(',')}]`;

  try {
    const results = await prisma.$queryRawUnsafe(`
      SELECT * FROM search_lab_memory(
        $1::vector, $2, $3, $4, $5, 0.7, 0.3, $6
      )
    `,
      vectorStr,
      expanded.keywords.join(' '),
      userId,
      labId,
      limit,
      threshold,
    );

    return (results as any[]).map(r => ({
      id: r.id,
      sourceType: r.source_type,
      sourceId: r.source_id,
      title: r.title,
      chunkText: r.chunk_text,
      metadata: r.metadata || {},
      vectorScore: Number(r.vector_score) || 0,
      keywordScore: Number(r.keyword_score) || 0,
      combinedScore: Number(r.combined_score) || 0,
    }));
  } catch (err) {
    console.warn('Hybrid search failed, falling back to keyword:', err);
    return keywordFallback(prisma, expanded.keywords, userId, labId, limit);
  }
}

async function keywordFallback(
  prisma: any,
  keywords: string[],
  userId: string,
  labId: string | null,
  limit: number,
): Promise<SearchResult[]> {
  if (keywords.length === 0) return [];

  const results = await prisma.$queryRawUnsafe(`
    SELECT
      id, source_type, source_id, title, chunk_text, metadata,
      0.0::FLOAT AS vector_score,
      ts_rank(to_tsvector('simple', chunk_text), plainto_tsquery('simple', $1))::FLOAT AS keyword_score,
      ts_rank(to_tsvector('simple', chunk_text), plainto_tsquery('simple', $1))::FLOAT AS combined_score
    FROM memo_embeddings
    WHERE (user_id = $2 OR lab_id = $3)
      AND to_tsvector('simple', chunk_text) @@ plainto_tsquery('simple', $1)
    ORDER BY keyword_score DESC
    LIMIT $4
  `, keywords.join(' '), userId, labId, limit);

  return (results as any[]).map(r => ({
    id: r.id,
    sourceType: r.source_type,
    sourceId: r.source_id,
    title: r.title,
    chunkText: r.chunk_text,
    metadata: r.metadata || {},
    vectorScore: 0,
    keywordScore: Number(r.keyword_score) || 0,
    combinedScore: Number(r.combined_score) || 0,
  }));
}

// ── 4. Reranker (Gemini Cross-Encoder + Rule-based fallback) ──

/**
 * Cross-encoder 리랭킹: Gemini Flash가 쿼리-결과 관련성을 0-10으로 평가
 * 규칙 기반보다 훨씬 정확 (의미적 관련성 판단)
 * 비용: Gemini Flash는 무료 티어 내에서 동작
 */
export async function rerank(
  results: SearchResult[],
  query?: string,
  options?: { topK?: number },
): Promise<RankedResult[]> {
  const topK = options?.topK || 8;

  if (results.length === 0) return [];

  // Cross-encoder: Gemini Flash로 관련성 평가
  if (query && results.length > 1) {
    try {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

      const candidates = results.slice(0, 15).map((r, i) =>
        `[${i}] ${r.title || ''}: ${r.chunkText.substring(0, 200)}`
      ).join('\n');

      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text:
          `사용자 질문: "${query}"\n\n아래 검색 결과의 관련성을 0-10으로 평가하세요. JSON 배열로만 응답:\n\n${candidates}\n\n응답: [{"i":0,"s":8},{"i":1,"s":3},...] (i=인덱스, s=점수)`
        }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 512 },
      });

      const text = result.response.text().trim();
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        const scores = JSON.parse(match[0]) as Array<{i: number; s: number}>;
        const scoreMap = new Map(scores.map(s => [s.i, s.s]));

        const ranked = results.slice(0, 15).map((r, i) => ({
          ...r,
          finalScore: (scoreMap.get(i) || 5) / 10,
          citation: 0,
        }));

        ranked.sort((a, b) => b.finalScore - a.finalScore);
        return ranked.slice(0, topK).map((r, i) => ({ ...r, citation: i + 1 }));
      }
    } catch (err) {
      console.warn('Cross-encoder rerank failed, using rule-based:', err);
    }
  }

  // Fallback: 규칙 기반 리랭킹
  return rerankByRules(results, topK);
}

function rerankByRules(results: SearchResult[], topK: number): RankedResult[] {
  const sourceBoost: Record<string, number> = {
    'faq': 1.15, 'account': 1.10, 'regulation': 1.05,
    'lab-project': 1.0, 'member': 1.0, 'project': 1.0, 'publication': 0.95,
  };

  const ranked = results.map((r, i) => {
    let score = r.combinedScore;
    const accessCount = (r.metadata as any)?.accessCount || 0;
    if (accessCount > 0) score *= (1 + 0.1 * Math.log10(accessCount + 1));
    const source = (r.metadata as any)?.source || r.sourceType;
    score *= sourceBoost[source] || 1.0;
    return { ...r, finalScore: score, citation: i + 1 };
  });

  ranked.sort((a, b) => b.finalScore - a.finalScore);
  return ranked.slice(0, topK).map((r, i) => ({ ...r, citation: i + 1 }));
}

// ── 5. Grounded Prompt Builder ───────────────────

export function buildGroundedPrompt(
  query: string,
  rankedResults: RankedResult[],
  layerContext?: string,
): { systemAddendum: string; userContent: string } {
  if (rankedResults.length === 0) {
    return {
      systemAddendum: '',
      userContent: query,
    };
  }

  const citations = rankedResults.map(r => {
    const sourceLabel = {
      'memo': '메모', 'member': '구성원', 'project': '과제', 'publication': '논문',
    }[r.sourceType] || r.sourceType;
    const metaSource = (r.metadata as any)?.source;
    const label = metaSource ? `${sourceLabel}/${metaSource}` : sourceLabel;
    return `[${r.citation}] (${label}) ${r.title || ''}\n${r.chunkText.substring(0, 500)}`;
  }).join('\n\n');

  const systemAddendum = `
## 검색 결과 기반 응답 규칙
- 아래 [1], [2]... 번호가 붙은 검색 결과만 사용하여 답변하세요.
- 검색 결과에 없는 내용은 "해당 정보가 등록되어 있지 않습니다"라고 답하세요.
- 여러 검색 결과가 관련되면 종합하여 자연스럽게 정리하세요.
- 검색 결과의 원본을 그대로 인용하되, 사용자가 이해하기 쉽게 재구성하세요.`;

  let userContent = query;
  if (layerContext) {
    userContent = `[연구실 컨텍스트]\n${layerContext}\n\n${userContent}`;
  }
  userContent += `\n\n[검색 결과 — 이 데이터만으로 답변하세요]\n${citations}`;

  return { systemAddendum, userContent };
}

// ── 6. Response Validator ────────────────────────

export function validateResponse(
  response: string,
  hasResults: boolean,
): { isGrounded: boolean; warning?: string } {
  // If we had search results but response says "없습니다", something went wrong
  if (hasResults && (response.includes('등록된 정보가 없습니다') || response.includes('현재 등록된 내용이 없습니다'))) {
    return {
      isGrounded: false,
      warning: '검색 결과가 있었으나 AI가 활용하지 않았습니다. 다시 질문해 주세요.',
    };
  }
  return { isGrounded: true };
}

// ── 7. Convenience: Check if RAG is available ────

export async function isRagReady(prisma: any): Promise<boolean> {
  try {
    const result = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS cnt FROM memo_embeddings LIMIT 1
    `);
    return (result as any[])[0]?.cnt > 0;
  } catch {
    return false;
  }
}

// ── 8. Similar Document Detection ──────────────────

export interface SimilarDocument {
  sourceId: string;
  sourceType: string;
  title: string | null;
  similarity: number;
  chunkText: string;
}

/**
 * 업로드된 문서와 유사한 기존 문서를 검색
 * 문서의 첫 1500자를 임베딩하여 기존 데이터와 비교
 */
export async function findSimilarDocuments(
  prisma: any,
  text: string,
  userId: string,
  labId: string | null,
  options?: { threshold?: number; limit?: number },
): Promise<SimilarDocument[]> {
  const threshold = options?.threshold ?? 0.82;
  const limit = options?.limit ?? 5;

  try {
    // Embed first 1500 chars (representative sample)
    const sampleText = text.slice(0, 1500);
    const { embedding } = await generateEmbedding(sampleText);
    const vectorStr = `[${embedding.join(',')}]`;

    const results = await prisma.$queryRawUnsafe(`
      SELECT DISTINCT ON (source_id)
        source_id, source_type, title, chunk_text,
        1 - (embedding <=> $1::vector) as similarity
      FROM memo_embeddings
      WHERE (user_id = $2 OR lab_id = $3)
        AND 1 - (embedding <=> $1::vector) > $4
      ORDER BY source_id, similarity DESC
      LIMIT $5
    `, vectorStr, userId, labId, threshold, limit);

    return (results as any[]).map(r => ({
      sourceId: r.source_id,
      sourceType: r.source_type,
      title: r.title,
      similarity: Number(Number(r.similarity).toFixed(3)),
      chunkText: r.chunk_text?.slice(0, 200) || '',
    }));
  } catch (err) {
    console.warn('[findSimilarDocuments] failed:', err);
    return [];
  }
}
