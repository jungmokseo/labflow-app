-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('BASIC', 'PRO', 'MAX');

-- CreateEnum
CREATE TYPE "CaptureCategory" AS ENUM ('IDEA', 'TASK', 'MEMO');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "clerk_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "lab_name" TEXT,
    "plan" "Plan" NOT NULL DEFAULT 'BASIC',
    "credits" INTEGER NOT NULL DEFAULT 100,
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "captures" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "lab_id" TEXT,
    "content" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "category" "CaptureCategory" NOT NULL DEFAULT 'MEMO',
    "tags" TEXT[],
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "confidence" DOUBLE PRECISION,
    "action_date" TIMESTAMP(3),
    "model_used" TEXT,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "completed_at" TIMESTAMP(3),
    "source_type" TEXT NOT NULL DEFAULT 'text',
    "raw_input" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "captures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meetings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "transcription" TEXT,
    "summary" TEXT,
    "agenda" TEXT[],
    "discussions" TEXT,
    "action_items" TEXT[],
    "next_steps" TEXT[],
    "duration" INTEGER,
    "model_used" TEXT,
    "metadata" JSONB DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gmail_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gmail_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "classify_by_group" BOOLEAN NOT NULL DEFAULT false,
    "groups" JSONB NOT NULL DEFAULT '[]',
    "last_briefing_at" TIMESTAMP(3),
    "excludePatterns" JSONB NOT NULL DEFAULT '[]',
    "keywords" JSONB NOT NULL DEFAULT '[]',
    "importance_rules" JSONB NOT NULL DEFAULT '[]',
    "sender_timezones" JSONB NOT NULL DEFAULT '[]',
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_nodes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "name" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_edges" (
    "id" TEXT NOT NULL,
    "from_node_id" TEXT NOT NULL,
    "to_node_id" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "source" TEXT NOT NULL,
    "evidence" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "feature_type" TEXT NOT NULL,
    "rules" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "snapshot_data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "labs" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "institution" TEXT,
    "department" TEXT,
    "pi_name" TEXT,
    "pi_email" TEXT,
    "research_fields" TEXT[],
    "homepage_url" TEXT,
    "acknowledgment" TEXT,
    "response_style" TEXT,
    "onboarding_done" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "labs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_members" (
    "id" TEXT NOT NULL,
    "lab_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "role" TEXT NOT NULL DEFAULT '학생',
    "phone" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "metadata" JSONB DEFAULT '{}',
    "access_count" INTEGER NOT NULL DEFAULT 0,
    "last_verified" TIMESTAMP(3),
    "last_accessed" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lab_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "lab_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "number" TEXT,
    "funder" TEXT,
    "period" TEXT,
    "pi" TEXT,
    "pm" TEXT,
    "acknowledgment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "metadata" JSONB DEFAULT '{}',
    "access_count" INTEGER NOT NULL DEFAULT 0,
    "last_verified" TIMESTAMP(3),
    "last_accessed" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publications" (
    "id" TEXT NOT NULL,
    "lab_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "authors" TEXT,
    "journal" TEXT,
    "year" INTEGER,
    "doi" TEXT,
    "project_id" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "access_count" INTEGER NOT NULL DEFAULT 0,
    "last_verified" TIMESTAMP(3),
    "last_accessed" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_dicts" (
    "id" TEXT NOT NULL,
    "lab_id" TEXT NOT NULL,
    "wrong_form" TEXT NOT NULL,
    "correct_form" TEXT NOT NULL,
    "category" TEXT,
    "auto_added" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "domain_dicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memos" (
    "id" TEXT NOT NULL,
    "lab_id" TEXT,
    "user_id" TEXT NOT NULL,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "tags" TEXT[],
    "source" TEXT NOT NULL DEFAULT 'manual',
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "access_count" INTEGER NOT NULL DEFAULT 0,
    "last_verified" TIMESTAMP(3),
    "last_accessed" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paper_alerts" (
    "id" TEXT NOT NULL,
    "lab_id" TEXT NOT NULL,
    "keywords" TEXT[],
    "journals" TEXT[],
    "schedule" TEXT NOT NULL DEFAULT 'weekly',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "paper_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "paper_alert_results" (
    "id" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "authors" TEXT,
    "journal" TEXT,
    "pub_date" TIMESTAMP(3),
    "url" TEXT,
    "abstract" TEXT,
    "ai_summary" TEXT,
    "relevance" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "paper_alert_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channels" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_summaries" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "summary_text" TEXT NOT NULL,
    "message_range" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_clerk_id_key" ON "users"("clerk_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "captures_user_id_category_idx" ON "captures"("user_id", "category");

-- CreateIndex
CREATE INDEX "captures_user_id_created_at_idx" ON "captures"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "captures_user_id_completed_idx" ON "captures"("user_id", "completed");

-- CreateIndex
CREATE INDEX "captures_lab_id_category_idx" ON "captures"("lab_id", "category");

-- CreateIndex
CREATE INDEX "captures_lab_id_status_idx" ON "captures"("lab_id", "status");

-- CreateIndex
CREATE INDEX "meetings_user_id_created_at_idx" ON "meetings"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "gmail_tokens_user_id_key" ON "gmail_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_profiles_user_id_key" ON "email_profiles"("user_id");

-- CreateIndex
CREATE INDEX "knowledge_nodes_user_id_idx" ON "knowledge_nodes"("user_id");

-- CreateIndex
CREATE INDEX "knowledge_nodes_user_id_entity_type_idx" ON "knowledge_nodes"("user_id", "entity_type");

-- CreateIndex
CREATE INDEX "knowledge_nodes_entity_id_idx" ON "knowledge_nodes"("entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_nodes_user_id_entity_type_name_key" ON "knowledge_nodes"("user_id", "entity_type", "name");

-- CreateIndex
CREATE INDEX "knowledge_edges_from_node_id_idx" ON "knowledge_edges"("from_node_id");

-- CreateIndex
CREATE INDEX "knowledge_edges_to_node_id_idx" ON "knowledge_edges"("to_node_id");

-- CreateIndex
CREATE INDEX "knowledge_edges_source_idx" ON "knowledge_edges"("source");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_edges_from_node_id_to_node_id_relation_key" ON "knowledge_edges"("from_node_id", "to_node_id", "relation");

-- CreateIndex
CREATE INDEX "user_preferences_user_id_idx" ON "user_preferences"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_user_id_feature_type_key" ON "user_preferences"("user_id", "feature_type");

-- CreateIndex
CREATE UNIQUE INDEX "labs_owner_id_key" ON "labs"("owner_id");

-- CreateIndex
CREATE INDEX "lab_members_lab_id_active_idx" ON "lab_members"("lab_id", "active");

-- CreateIndex
CREATE INDEX "projects_lab_id_idx" ON "projects"("lab_id");

-- CreateIndex
CREATE INDEX "publications_lab_id_year_idx" ON "publications"("lab_id", "year");

-- CreateIndex
CREATE UNIQUE INDEX "domain_dicts_lab_id_wrong_form_key" ON "domain_dicts"("lab_id", "wrong_form");

-- CreateIndex
CREATE INDEX "memos_user_id_created_at_idx" ON "memos"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "memos_lab_id_created_at_idx" ON "memos"("lab_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "paper_alerts_lab_id_active_idx" ON "paper_alerts"("lab_id", "active");

-- CreateIndex
CREATE INDEX "paper_alert_results_alert_id_read_idx" ON "paper_alert_results"("alert_id", "read");

-- CreateIndex
CREATE INDEX "channels_user_id_idx" ON "channels"("user_id");

-- CreateIndex
CREATE INDEX "messages_channel_id_created_at_idx" ON "messages"("channel_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "channel_summaries_channel_id_created_at_idx" ON "channel_summaries"("channel_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "captures" ADD CONSTRAINT "captures_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "captures" ADD CONSTRAINT "captures_lab_id_fkey" FOREIGN KEY ("lab_id") REFERENCES "labs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gmail_tokens" ADD CONSTRAINT "gmail_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_profiles" ADD CONSTRAINT "email_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_edges" ADD CONSTRAINT "knowledge_edges_from_node_id_fkey" FOREIGN KEY ("from_node_id") REFERENCES "knowledge_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_edges" ADD CONSTRAINT "knowledge_edges_to_node_id_fkey" FOREIGN KEY ("to_node_id") REFERENCES "knowledge_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "labs" ADD CONSTRAINT "labs_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_members" ADD CONSTRAINT "lab_members_lab_id_fkey" FOREIGN KEY ("lab_id") REFERENCES "labs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_lab_id_fkey" FOREIGN KEY ("lab_id") REFERENCES "labs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publications" ADD CONSTRAINT "publications_lab_id_fkey" FOREIGN KEY ("lab_id") REFERENCES "labs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "domain_dicts" ADD CONSTRAINT "domain_dicts_lab_id_fkey" FOREIGN KEY ("lab_id") REFERENCES "labs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memos" ADD CONSTRAINT "memos_lab_id_fkey" FOREIGN KEY ("lab_id") REFERENCES "labs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memos" ADD CONSTRAINT "memos_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_alerts" ADD CONSTRAINT "paper_alerts_lab_id_fkey" FOREIGN KEY ("lab_id") REFERENCES "labs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "paper_alert_results" ADD CONSTRAINT "paper_alert_results_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "paper_alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_summaries" ADD CONSTRAINT "channel_summaries_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

