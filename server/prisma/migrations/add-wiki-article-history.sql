-- Wiki Article History 테이블 생성
CREATE TABLE IF NOT EXISTS wiki_article_history (
  id              TEXT PRIMARY KEY,
  article_id      TEXT NOT NULL,
  lab_id          TEXT NOT NULL,
  title           TEXT NOT NULL,
  category        TEXT NOT NULL,
  version         INT NOT NULL,
  change_type     TEXT NOT NULL,          -- 'create' | 'update' | 'delete'
  content_before  TEXT,
  content_after   TEXT,
  diff_summary    TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wiki_history_lab_created
  ON wiki_article_history(lab_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wiki_history_article
  ON wiki_article_history(article_id);
