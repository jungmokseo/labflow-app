-- memo_embeddings: Lab Memory 벡터 스토어
-- 모든 데이터 타입(memo, member, project, publication)의 임베딩을 저장

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS memo_embeddings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  lab_id        TEXT,
  user_id       TEXT,
  title         TEXT,
  chunk_index   INTEGER NOT NULL DEFAULT 0,
  chunk_text    TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  embedding     vector(1536) NOT NULL,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- Vector similarity index (IVFFlat, cosine distance)
CREATE INDEX IF NOT EXISTS idx_memo_emb_vector
  ON memo_embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 10);

-- Tenant isolation
CREATE INDEX IF NOT EXISTS idx_memo_emb_lab
  ON memo_embeddings (lab_id, source_type);

CREATE INDEX IF NOT EXISTS idx_memo_emb_user
  ON memo_embeddings (user_id);

-- Dedup
CREATE UNIQUE INDEX IF NOT EXISTS idx_memo_emb_source
  ON memo_embeddings (source_id, source_type, chunk_index);

-- Full-text search (Korean + English via simple config)
CREATE INDEX IF NOT EXISTS idx_memo_emb_fts
  ON memo_embeddings USING gin (to_tsvector('simple', chunk_text));

-- Hybrid search function
CREATE OR REPLACE FUNCTION search_lab_memory(
  query_embedding vector(1536),
  query_text TEXT,
  p_user_id TEXT,
  p_lab_id TEXT DEFAULT NULL,
  match_count INTEGER DEFAULT 10,
  vector_weight FLOAT DEFAULT 0.7,
  keyword_weight FLOAT DEFAULT 0.3,
  match_threshold FLOAT DEFAULT 0.25
)
RETURNS TABLE (
  id UUID,
  source_type TEXT,
  source_id TEXT,
  title TEXT,
  chunk_text TEXT,
  metadata JSONB,
  vector_score FLOAT,
  keyword_score FLOAT,
  combined_score FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    me.id,
    me.source_type,
    me.source_id,
    me.title,
    me.chunk_text,
    me.metadata,
    (1 - (me.embedding <=> query_embedding))::FLOAT AS vector_score,
    ts_rank(to_tsvector('simple', me.chunk_text), plainto_tsquery('simple', query_text))::FLOAT AS keyword_score,
    ((1 - (me.embedding <=> query_embedding)) * vector_weight +
     ts_rank(to_tsvector('simple', me.chunk_text), plainto_tsquery('simple', query_text)) * keyword_weight
    )::FLOAT AS combined_score
  FROM memo_embeddings me
  WHERE (me.user_id = p_user_id OR (p_lab_id IS NOT NULL AND me.lab_id = p_lab_id))
    AND (1 - (me.embedding <=> query_embedding)) > match_threshold
  ORDER BY combined_score DESC
  LIMIT match_count;
END;
$$;
