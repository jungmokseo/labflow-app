-- ============================================
-- Voice Chatbot Supabase Schema
-- LabFlow MVP — 보이스챗봇 통합
-- ============================================

-- pgvector 확장 활성화
CREATE EXTENSION IF NOT EXISTS vector;

-- ── 1. 논문 벡터 테이블 (Research Bot RAG) ──────────

CREATE TABLE IF NOT EXISTS paper_embeddings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  paper_id      TEXT NOT NULL,
  title         TEXT NOT NULL,
  authors       TEXT,
  abstract      TEXT,
  journal       TEXT,
  year          INTEGER,
  doi           TEXT,
  chunk_index   INTEGER NOT NULL DEFAULT 0,
  chunk_text    TEXT NOT NULL,
  embedding     vector(1536) NOT NULL,  -- text-embedding-3-small
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- 벡터 검색 인덱스 (IVFFlat for speed)
CREATE INDEX IF NOT EXISTS idx_paper_embeddings_vector
  ON paper_embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 텍스트 검색 인덱스
CREATE INDEX IF NOT EXISTS idx_paper_embeddings_title
  ON paper_embeddings USING gin (to_tsvector('english', title));

CREATE INDEX IF NOT EXISTS idx_paper_embeddings_paper_id
  ON paper_embeddings (paper_id);


-- ── 2. 대화 세션 테이블 (Opik 스타일 모니터링) ─────

CREATE TABLE IF NOT EXISTS voice_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        TEXT UNIQUE NOT NULL,
  persona_id        TEXT NOT NULL,
  user_id           TEXT,
  started_at        TIMESTAMPTZ NOT NULL,
  ended_at          TIMESTAMPTZ,
  total_turns       INTEGER DEFAULT 0,
  avg_latency_ms    INTEGER DEFAULT 0,
  total_tool_calls  INTEGER DEFAULT 0,
  error_count       INTEGER DEFAULT 0,
  language          TEXT DEFAULT 'unknown',
  metadata          JSONB DEFAULT '{}',
  created_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voice_sessions_user
  ON voice_sessions (user_id);

CREATE INDEX IF NOT EXISTS idx_voice_sessions_persona
  ON voice_sessions (persona_id);

CREATE INDEX IF NOT EXISTS idx_voice_sessions_started
  ON voice_sessions (started_at DESC);


-- ── 3. 대화 턴 테이블 (상세 로그) ──────────────────

CREATE TABLE IF NOT EXISTS voice_turns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      TEXT NOT NULL REFERENCES voice_sessions(session_id),
  turn_index      INTEGER NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         TEXT NOT NULL,
  audio_length_ms INTEGER,
  latency_ms      INTEGER,
  tool_calls      JSONB DEFAULT '[]',
  error           TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voice_turns_session
  ON voice_turns (session_id, turn_index);


-- ── 4. 영어 교정 기록 테이블 (English Tutor) ───────

CREATE TABLE IF NOT EXISTS english_corrections (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   TEXT NOT NULL,
  user_id      TEXT,
  original     TEXT NOT NULL,
  corrected    TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('pronunciation', 'grammar', 'vocabulary')),
  explanation  TEXT,
  practiced    BOOLEAN DEFAULT false,
  mastered     BOOLEAN DEFAULT false,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_corrections_user
  ON english_corrections (user_id);

CREATE INDEX IF NOT EXISTS idx_corrections_type
  ON english_corrections (type);

CREATE INDEX IF NOT EXISTS idx_corrections_session
  ON english_corrections (session_id);


-- ── 5. 논문 검색 함수 (pgvector similarity) ────────

CREATE OR REPLACE FUNCTION search_papers(
  query_embedding vector(1536),
  match_count INTEGER DEFAULT 5,
  match_threshold FLOAT DEFAULT 0.3
)
RETURNS TABLE (
  id UUID,
  paper_id TEXT,
  title TEXT,
  authors TEXT,
  abstract TEXT,
  chunk_text TEXT,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    pe.id,
    pe.paper_id,
    pe.title,
    pe.authors,
    pe.abstract,
    pe.chunk_text,
    1 - (pe.embedding <=> query_embedding) AS similarity
  FROM paper_embeddings pe
  WHERE 1 - (pe.embedding <=> query_embedding) > match_threshold
  ORDER BY pe.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;


-- ── 6. 대화 통계 뷰 ────────────────────────────────

CREATE OR REPLACE VIEW voice_session_stats AS
SELECT
  persona_id,
  COUNT(*) AS total_sessions,
  AVG(total_turns) AS avg_turns,
  AVG(avg_latency_ms) AS avg_latency,
  SUM(total_tool_calls) AS total_tools_used,
  SUM(error_count) AS total_errors,
  COUNT(CASE WHEN language = 'ko' THEN 1 END) AS korean_sessions,
  COUNT(CASE WHEN language = 'en' THEN 1 END) AS english_sessions
FROM voice_sessions
WHERE ended_at IS NOT NULL
GROUP BY persona_id;
