-- Manual migration: create wiki_articles and wiki_raw_queue tables
-- Run with: npx prisma db execute --file prisma/migrations/manual_create_wiki_tables.sql

CREATE TABLE IF NOT EXISTS wiki_articles (
  id          TEXT PRIMARY KEY,
  lab_id      TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  category    TEXT NOT NULL,
  content     TEXT NOT NULL,
  tags        TEXT[] NOT NULL DEFAULT '{}',
  sources     JSONB NOT NULL DEFAULT '[]',
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lab_id, title)
);

CREATE INDEX IF NOT EXISTS wiki_articles_lab_category ON wiki_articles(lab_id, category);
CREATE INDEX IF NOT EXISTS wiki_articles_lab_updated  ON wiki_articles(lab_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS wiki_raw_queue (
  id            TEXT PRIMARY KEY,
  lab_id        TEXT NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
  source_type   TEXT NOT NULL,
  source_id     TEXT NOT NULL,
  content       TEXT NOT NULL,
  processed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS wiki_raw_queue_lab_processed ON wiki_raw_queue(lab_id, processed_at);
