-- =============================================================================
-- LabFlow — Row-Level Security (RLS) Policies
-- =============================================================================
--
-- PURPOSE: Defense-in-depth data isolation for multi-tenant LabFlow.
--
-- ARCHITECTURE:
--   1. PRIMARY isolation is enforced via Prisma middleware ($allOperations),
--      which automatically injects WHERE user_id = ? / lab_id = ? into every
--      query. This covers 99% of runtime access.
--
--   2. RLS is a SAFETY NET — it catches any path that bypasses Prisma:
--      - Raw SQL queries (prisma.$queryRaw)
--      - Direct psql / migration scripts that forget filters
--      - Future ORM changes or refactors that accidentally drop the middleware
--
-- SESSION VARIABLES:
--   Before each request, the application MUST set two session variables:
--     SET LOCAL app.current_user_id = '<user_cuid>';
--     SET LOCAL app.current_lab_id  = '<lab_cuid>';
--
--   This is typically done in a Prisma $connect hook, transaction wrapper,
--   or Supabase RLS context.
--
-- SUPABASE AUTH MIGRATION:
--   If migrating to Supabase Auth, replace:
--     current_setting('app.current_user_id', true)  →  auth.uid()::text
--     current_setting('app.current_lab_id', true)    →  (select lab_id from ...)
--
-- SERVICE ROLE:
--   A "service_role" Postgres role is granted full bypass for admin tasks,
--   migrations, and background jobs (e.g., paper alert cron).
--
-- USAGE:
--   Run this file against your database after schema migrations:
--     psql $DATABASE_URL -f server/prisma/rls-policies.sql
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- Helper: create the service_role if it doesn't exist
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END
$$;


-- =============================================================================
-- 1. users — own row only (id = current_user_id)
-- =============================================================================
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE POLICY "users_select" ON users FOR SELECT
  USING (id = current_setting('app.current_user_id', true));

CREATE POLICY "users_insert" ON users FOR INSERT
  WITH CHECK (id = current_setting('app.current_user_id', true));

CREATE POLICY "users_update" ON users FOR UPDATE
  USING (id = current_setting('app.current_user_id', true))
  WITH CHECK (id = current_setting('app.current_user_id', true));

CREATE POLICY "users_delete" ON users FOR DELETE
  USING (id = current_setting('app.current_user_id', true));

CREATE POLICY "users_service_bypass" ON users FOR ALL TO service_role USING (true);


-- =============================================================================
-- 2. captures — user_id = current_user_id
-- =============================================================================
ALTER TABLE captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE captures FORCE ROW LEVEL SECURITY;

CREATE POLICY "captures_select" ON captures FOR SELECT
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "captures_insert" ON captures FOR INSERT
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "captures_update" ON captures FOR UPDATE
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "captures_delete" ON captures FOR DELETE
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "captures_service_bypass" ON captures FOR ALL TO service_role USING (true);


-- =============================================================================
-- 3. meetings — user_id = current_user_id
-- =============================================================================
ALTER TABLE meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE meetings FORCE ROW LEVEL SECURITY;

CREATE POLICY "meetings_select" ON meetings FOR SELECT
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "meetings_insert" ON meetings FOR INSERT
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "meetings_update" ON meetings FOR UPDATE
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "meetings_delete" ON meetings FOR DELETE
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "meetings_service_bypass" ON meetings FOR ALL TO service_role USING (true);


-- =============================================================================
-- 4. gmail_tokens — user_id = current_user_id
-- =============================================================================
ALTER TABLE gmail_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_tokens FORCE ROW LEVEL SECURITY;

CREATE POLICY "gmail_tokens_select" ON gmail_tokens FOR SELECT
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "gmail_tokens_insert" ON gmail_tokens FOR INSERT
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "gmail_tokens_update" ON gmail_tokens FOR UPDATE
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "gmail_tokens_delete" ON gmail_tokens FOR DELETE
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "gmail_tokens_service_bypass" ON gmail_tokens FOR ALL TO service_role USING (true);


-- =============================================================================
-- 5. email_profiles — user_id = current_user_id
-- =============================================================================
ALTER TABLE email_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_profiles FORCE ROW LEVEL SECURITY;

CREATE POLICY "email_profiles_select" ON email_profiles FOR SELECT
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "email_profiles_insert" ON email_profiles FOR INSERT
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "email_profiles_update" ON email_profiles FOR UPDATE
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "email_profiles_delete" ON email_profiles FOR DELETE
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "email_profiles_service_bypass" ON email_profiles FOR ALL TO service_role USING (true);


-- =============================================================================
-- 6. knowledge_nodes — user_id = current_user_id
-- =============================================================================
ALTER TABLE knowledge_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_nodes FORCE ROW LEVEL SECURITY;

CREATE POLICY "knowledge_nodes_select" ON knowledge_nodes FOR SELECT
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "knowledge_nodes_insert" ON knowledge_nodes FOR INSERT
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "knowledge_nodes_update" ON knowledge_nodes FOR UPDATE
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "knowledge_nodes_delete" ON knowledge_nodes FOR DELETE
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "knowledge_nodes_service_bypass" ON knowledge_nodes FOR ALL TO service_role USING (true);


-- =============================================================================
-- 7. knowledge_edges — user_id = current_user_id
-- =============================================================================
ALTER TABLE knowledge_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_edges FORCE ROW LEVEL SECURITY;

CREATE POLICY "knowledge_edges_select" ON knowledge_edges FOR SELECT
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "knowledge_edges_insert" ON knowledge_edges FOR INSERT
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "knowledge_edges_update" ON knowledge_edges FOR UPDATE
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "knowledge_edges_delete" ON knowledge_edges FOR DELETE
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "knowledge_edges_service_bypass" ON knowledge_edges FOR ALL TO service_role USING (true);


-- =============================================================================
-- 8. user_preferences — user_id = current_user_id
-- =============================================================================
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences FORCE ROW LEVEL SECURITY;

CREATE POLICY "user_preferences_select" ON user_preferences FOR SELECT
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "user_preferences_insert" ON user_preferences FOR INSERT
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "user_preferences_update" ON user_preferences FOR UPDATE
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "user_preferences_delete" ON user_preferences FOR DELETE
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "user_preferences_service_bypass" ON user_preferences FOR ALL TO service_role USING (true);


-- =============================================================================
-- 9. memos — user_id = current_user_id
-- =============================================================================
ALTER TABLE memos ENABLE ROW LEVEL SECURITY;
ALTER TABLE memos FORCE ROW LEVEL SECURITY;

CREATE POLICY "memos_select" ON memos FOR SELECT
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "memos_insert" ON memos FOR INSERT
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "memos_update" ON memos FOR UPDATE
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "memos_delete" ON memos FOR DELETE
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "memos_service_bypass" ON memos FOR ALL TO service_role USING (true);


-- =============================================================================
-- 10. channels — user_id = current_user_id
-- =============================================================================
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE channels FORCE ROW LEVEL SECURITY;

CREATE POLICY "channels_select" ON channels FOR SELECT
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "channels_insert" ON channels FOR INSERT
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "channels_update" ON channels FOR UPDATE
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "channels_delete" ON channels FOR DELETE
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "channels_service_bypass" ON channels FOR ALL TO service_role USING (true);


-- =============================================================================
-- 11. messages — user_id = current_user_id
-- =============================================================================
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;

CREATE POLICY "messages_select" ON messages FOR SELECT
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "messages_insert" ON messages FOR INSERT
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "messages_update" ON messages FOR UPDATE
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "messages_delete" ON messages FOR DELETE
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "messages_service_bypass" ON messages FOR ALL TO service_role USING (true);


-- =============================================================================
-- 12. channel_summaries — user_id = current_user_id
-- =============================================================================
ALTER TABLE channel_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_summaries FORCE ROW LEVEL SECURITY;

CREATE POLICY "channel_summaries_select" ON channel_summaries FOR SELECT
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "channel_summaries_insert" ON channel_summaries FOR INSERT
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "channel_summaries_update" ON channel_summaries FOR UPDATE
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "channel_summaries_delete" ON channel_summaries FOR DELETE
  USING (user_id = current_setting('app.current_user_id', true));

CREATE POLICY "channel_summaries_service_bypass" ON channel_summaries FOR ALL TO service_role USING (true);


-- =============================================================================
-- 13. memo_embeddings — user_id = current_user_id (nullable; allow shared rows)
-- =============================================================================
ALTER TABLE memo_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE memo_embeddings FORCE ROW LEVEL SECURITY;

CREATE POLICY "memo_embeddings_select" ON memo_embeddings FOR SELECT
  USING (
    user_id = current_setting('app.current_user_id', true)
    OR user_id IS NULL  -- shared/system embeddings
  );

CREATE POLICY "memo_embeddings_insert" ON memo_embeddings FOR INSERT
  WITH CHECK (
    user_id = current_setting('app.current_user_id', true)
    OR user_id IS NULL
  );

CREATE POLICY "memo_embeddings_update" ON memo_embeddings FOR UPDATE
  USING (
    user_id = current_setting('app.current_user_id', true)
    OR user_id IS NULL
  )
  WITH CHECK (
    user_id = current_setting('app.current_user_id', true)
    OR user_id IS NULL
  );

CREATE POLICY "memo_embeddings_delete" ON memo_embeddings FOR DELETE
  USING (
    user_id = current_setting('app.current_user_id', true)
    OR user_id IS NULL
  );

CREATE POLICY "memo_embeddings_service_bypass" ON memo_embeddings FOR ALL TO service_role USING (true);


-- =============================================================================
-- 14. labs — owner_id = current_user_id
-- =============================================================================
ALTER TABLE labs ENABLE ROW LEVEL SECURITY;
ALTER TABLE labs FORCE ROW LEVEL SECURITY;

CREATE POLICY "labs_select" ON labs FOR SELECT
  USING (owner_id = current_setting('app.current_user_id', true));

CREATE POLICY "labs_insert" ON labs FOR INSERT
  WITH CHECK (owner_id = current_setting('app.current_user_id', true));

CREATE POLICY "labs_update" ON labs FOR UPDATE
  USING (owner_id = current_setting('app.current_user_id', true))
  WITH CHECK (owner_id = current_setting('app.current_user_id', true));

CREATE POLICY "labs_delete" ON labs FOR DELETE
  USING (owner_id = current_setting('app.current_user_id', true));

CREATE POLICY "labs_service_bypass" ON labs FOR ALL TO service_role USING (true);


-- =============================================================================
-- 15. lab_members — lab_id = current_lab_id
-- =============================================================================
ALTER TABLE lab_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab_members FORCE ROW LEVEL SECURITY;

CREATE POLICY "lab_members_select" ON lab_members FOR SELECT
  USING (lab_id = current_setting('app.current_lab_id', true));

CREATE POLICY "lab_members_insert" ON lab_members FOR INSERT
  WITH CHECK (lab_id = current_setting('app.current_lab_id', true));

CREATE POLICY "lab_members_update" ON lab_members FOR UPDATE
  USING (lab_id = current_setting('app.current_lab_id', true))
  WITH CHECK (lab_id = current_setting('app.current_lab_id', true));

CREATE POLICY "lab_members_delete" ON lab_members FOR DELETE
  USING (lab_id = current_setting('app.current_lab_id', true));

CREATE POLICY "lab_members_service_bypass" ON lab_members FOR ALL TO service_role USING (true);


-- =============================================================================
-- 16. projects — lab_id = current_lab_id
-- =============================================================================
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

CREATE POLICY "projects_select" ON projects FOR SELECT
  USING (lab_id = current_setting('app.current_lab_id', true));

CREATE POLICY "projects_insert" ON projects FOR INSERT
  WITH CHECK (lab_id = current_setting('app.current_lab_id', true));

CREATE POLICY "projects_update" ON projects FOR UPDATE
  USING (lab_id = current_setting('app.current_lab_id', true))
  WITH CHECK (lab_id = current_setting('app.current_lab_id', true));

CREATE POLICY "projects_delete" ON projects FOR DELETE
  USING (lab_id = current_setting('app.current_lab_id', true));

CREATE POLICY "projects_service_bypass" ON projects FOR ALL TO service_role USING (true);


-- =============================================================================
-- 17. publications — lab_id = current_lab_id
-- =============================================================================
ALTER TABLE publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE publications FORCE ROW LEVEL SECURITY;

CREATE POLICY "publications_select" ON publications FOR SELECT
  USING (lab_id = current_setting('app.current_lab_id', true));

CREATE POLICY "publications_insert" ON publications FOR INSERT
  WITH CHECK (lab_id = current_setting('app.current_lab_id', true));

CREATE POLICY "publications_update" ON publications FOR UPDATE
  USING (lab_id = current_setting('app.current_lab_id', true))
  WITH CHECK (lab_id = current_setting('app.current_lab_id', true));

CREATE POLICY "publications_delete" ON publications FOR DELETE
  USING (lab_id = current_setting('app.current_lab_id', true));

CREATE POLICY "publications_service_bypass" ON publications FOR ALL TO service_role USING (true);


-- =============================================================================
-- 18. domain_dicts — lab_id = current_lab_id
-- =============================================================================
ALTER TABLE domain_dicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_dicts FORCE ROW LEVEL SECURITY;

CREATE POLICY "domain_dicts_select" ON domain_dicts FOR SELECT
  USING (lab_id = current_setting('app.current_lab_id', true));

CREATE POLICY "domain_dicts_insert" ON domain_dicts FOR INSERT
  WITH CHECK (lab_id = current_setting('app.current_lab_id', true));

CREATE POLICY "domain_dicts_update" ON domain_dicts FOR UPDATE
  USING (lab_id = current_setting('app.current_lab_id', true))
  WITH CHECK (lab_id = current_setting('app.current_lab_id', true));

CREATE POLICY "domain_dicts_delete" ON domain_dicts FOR DELETE
  USING (lab_id = current_setting('app.current_lab_id', true));

CREATE POLICY "domain_dicts_service_bypass" ON domain_dicts FOR ALL TO service_role USING (true);


-- =============================================================================
-- 19. paper_alerts — lab_id = current_lab_id
-- =============================================================================
ALTER TABLE paper_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_alerts FORCE ROW LEVEL SECURITY;

CREATE POLICY "paper_alerts_select" ON paper_alerts FOR SELECT
  USING (lab_id = current_setting('app.current_lab_id', true));

CREATE POLICY "paper_alerts_insert" ON paper_alerts FOR INSERT
  WITH CHECK (lab_id = current_setting('app.current_lab_id', true));

CREATE POLICY "paper_alerts_update" ON paper_alerts FOR UPDATE
  USING (lab_id = current_setting('app.current_lab_id', true))
  WITH CHECK (lab_id = current_setting('app.current_lab_id', true));

CREATE POLICY "paper_alerts_delete" ON paper_alerts FOR DELETE
  USING (lab_id = current_setting('app.current_lab_id', true));

CREATE POLICY "paper_alerts_service_bypass" ON paper_alerts FOR ALL TO service_role USING (true);


-- =============================================================================
-- 20. paper_alert_results — via subquery: alert_id → paper_alerts.lab_id
-- =============================================================================
ALTER TABLE paper_alert_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_alert_results FORCE ROW LEVEL SECURITY;

CREATE POLICY "paper_alert_results_select" ON paper_alert_results FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM paper_alerts
      WHERE paper_alerts.id = paper_alert_results.alert_id
        AND paper_alerts.lab_id = current_setting('app.current_lab_id', true)
    )
  );

CREATE POLICY "paper_alert_results_insert" ON paper_alert_results FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM paper_alerts
      WHERE paper_alerts.id = paper_alert_results.alert_id
        AND paper_alerts.lab_id = current_setting('app.current_lab_id', true)
    )
  );

CREATE POLICY "paper_alert_results_update" ON paper_alert_results FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM paper_alerts
      WHERE paper_alerts.id = paper_alert_results.alert_id
        AND paper_alerts.lab_id = current_setting('app.current_lab_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM paper_alerts
      WHERE paper_alerts.id = paper_alert_results.alert_id
        AND paper_alerts.lab_id = current_setting('app.current_lab_id', true)
    )
  );

CREATE POLICY "paper_alert_results_delete" ON paper_alert_results FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM paper_alerts
      WHERE paper_alerts.id = paper_alert_results.alert_id
        AND paper_alerts.lab_id = current_setting('app.current_lab_id', true)
    )
  );

CREATE POLICY "paper_alert_results_service_bypass" ON paper_alert_results FOR ALL TO service_role USING (true);


-- =============================================================================
-- Done. All 20 tables have RLS enabled with per-user / per-lab isolation.
-- =============================================================================
