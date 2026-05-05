// raw SQL로 manuscripts + manuscript_mail_events 테이블 생성
// (prisma db push --accept-data-loss는 paper_embeddings/wiki_embeddings/worksheet_reminders 손실 위험)
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const sql = `
CREATE TABLE IF NOT EXISTS manuscripts (
  id TEXT PRIMARY KEY,
  notion_url TEXT NOT NULL,
  title TEXT NOT NULL,
  stage TEXT NOT NULL,
  whose_turn TEXT,
  first_authors TEXT,
  pi_role TEXT,
  current_journal TEXT,
  impact_factor DOUBLE PRECISION,
  attempts INTEGER DEFAULT 1,
  reject_history TEXT,
  manuscript_num TEXT,
  submitted_at TIMESTAMP,
  revision_due_at TIMESTAMP,
  published_at TIMESTAMP,
  doi TEXT,
  manuscript_page_url TEXT,
  last_activity_at TIMESTAMP NOT NULL,
  last_activity_type TEXT,
  memo TEXT,
  notion_last_edited_at TIMESTAMP NOT NULL,
  synced_at TIMESTAMP DEFAULT NOW(),
  archived BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS manuscripts_stage_last_activity_idx ON manuscripts(stage, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS manuscripts_whose_turn_last_activity_idx ON manuscripts(whose_turn, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS manuscripts_archived_published_idx ON manuscripts(archived, published_at DESC);
CREATE INDEX IF NOT EXISTS manuscripts_manuscript_num_idx ON manuscripts(manuscript_num);

CREATE TABLE IF NOT EXISTS manuscript_mail_events (
  id TEXT PRIMARY KEY,
  gmail_message_id TEXT UNIQUE NOT NULL,
  thread_id TEXT,
  manuscript_id TEXT,
  manuscript_num TEXT,
  event_type TEXT NOT NULL,
  journal TEXT,
  subject TEXT,
  from_addr TEXT,
  received_at TIMESTAMP NOT NULL,
  revision_due_at TIMESTAMP,
  raw_snippet TEXT,
  applied BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS manuscript_mail_events_ms_received_idx ON manuscript_mail_events(manuscript_id, received_at DESC);
CREATE INDEX IF NOT EXISTS manuscript_mail_events_applied_received_idx ON manuscript_mail_events(applied, received_at DESC);
`;

const stmts = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
for (const stmt of stmts) {
  await prisma.$executeRawUnsafe(stmt);
  console.log(`OK: ${stmt.slice(0, 60)}...`);
}
await prisma.$disconnect();
console.log('manuscripts + manuscript_mail_events 테이블 생성 완료');
