-- ErrorLog 테이블 생성 (paper_embeddings를 건드리지 않기 위해 raw SQL로 직접 실행)
-- 실행: psql 또는 Supabase SQL Editor에서 실행하거나
--      npx prisma db execute --file prisma/migrations/manual_create_error_logs.sql --schema prisma/schema.prisma

CREATE TABLE IF NOT EXISTS "error_logs" (
  "id" TEXT NOT NULL,
  "user_id" TEXT,
  "category" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'error',
  "message" TEXT NOT NULL,
  "context" JSONB DEFAULT '{}',
  "stack" TEXT,
  "resolved" BOOLEAN NOT NULL DEFAULT false,
  "resolved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "error_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "error_logs_resolved_created_at_idx"
  ON "error_logs"("resolved", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "error_logs_category_created_at_idx"
  ON "error_logs"("category", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "error_logs_user_id_created_at_idx"
  ON "error_logs"("user_id", "created_at" DESC);
