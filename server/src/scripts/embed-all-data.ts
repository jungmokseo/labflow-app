/**
 * One-time script: Embed all existing Lab Memory data into memo_embeddings
 *
 * Usage: npx tsx server/src/scripts/embed-all-data.ts
 *
 * Steps:
 * 1. Run SQL migration (create table + indexes + search function)
 * 2. Load all Memos, LabMembers, Projects, Publications
 * 3. Batch embed via OpenAI text-embedding-3-small
 * 4. Store in memo_embeddings with content hash for dedup
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { basePrismaClient as prisma } from '../config/prisma.js';
import { embedBatch, type EmbeddableRecord } from '../services/rag-engine.js';

async function main() {
  console.log('[setup] Step 1: Checking table exists...');
  // Table creation DDL (no functions — those must be run in Supabase SQL editor)
  const ddlStatements = [
    `CREATE EXTENSION IF NOT EXISTS vector`,
    `CREATE TABLE IF NOT EXISTS memo_embeddings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source_type TEXT NOT NULL, source_id TEXT NOT NULL, lab_id TEXT, user_id TEXT,
      title TEXT, chunk_index INTEGER NOT NULL DEFAULT 0, chunk_text TEXT NOT NULL,
      content_hash TEXT NOT NULL, embedding vector(1536) NOT NULL,
      metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_memo_emb_lab ON memo_embeddings (lab_id, source_type)`,
    `CREATE INDEX IF NOT EXISTS idx_memo_emb_user ON memo_embeddings (user_id)`,
  ];

  for (const stmt of ddlStatements) {
    try { await prisma.$executeRawUnsafe(stmt); } catch (err: any) {
      if (!err.message?.includes('already exists')) console.warn('SQL:', err.message?.slice(0, 80));
    }
  }

  // Unique index (may fail if duplicates exist)
  try {
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS idx_memo_emb_source ON memo_embeddings (source_id, source_type, chunk_index)`);
  } catch { /* ignore */ }

  console.log('[ok] Table ready');

  console.log('\n[load] Step 2: Loading existing data...');
  const [memos, members, projects, pubs] = await Promise.all([
    prisma.memo.findMany(),
    prisma.labMember.findMany({ where: { active: true } }),
    prisma.project.findMany(),
    prisma.publication.findMany(),
  ]);

  console.log(`  Memos: ${memos.length}`);
  console.log(`  Members: ${members.length}`);
  console.log(`  Projects: ${projects.length}`);
  console.log(`  Publications: ${pubs.length}`);

  const records: EmbeddableRecord[] = [
    ...memos.map(m => ({
      sourceType: 'memo' as const,
      sourceId: m.id,
      labId: m.labId,
      userId: m.userId,
      title: m.title || '',
      content: m.content,
      tags: m.tags,
      source: m.source || 'memo',
      metadata: { source: m.source, accessCount: m.accessCount, confidence: m.confidence },
    })),
    ...members.map(m => ({
      sourceType: 'member' as const,
      sourceId: m.id,
      labId: m.labId,
      userId: null,
      title: m.name,
      content: `${m.name} (${m.role || ''}) ${m.team || ''}\n이메일: ${m.email || ''}\n전화: ${m.phone || ''}`,
      tags: [m.role || '', m.team || ''].filter(Boolean),
      source: 'member',
      metadata: { role: m.role, team: m.team },
    })),
    ...projects.map(p => ({
      sourceType: 'project' as const,
      sourceId: p.id,
      labId: p.labId,
      userId: null,
      title: p.name,
      content: `${p.name}\n지원기관: ${p.funder || ''}\nPM: ${p.pm || ''}\n기간: ${p.period || ''}\n상태: ${p.status || ''}`,
      tags: [p.funder || '', p.status || ''].filter(Boolean),
      source: 'project',
      metadata: { funder: p.funder, status: p.status },
    })),
    ...pubs.map(p => ({
      sourceType: 'publication' as const,
      sourceId: p.id,
      labId: p.labId,
      userId: null,
      title: p.title,
      content: `${p.title}\n저널: ${p.journal || ''} (${p.year || ''})\n저자: ${p.authors || ''}\n${p.abstract || ''}`,
      tags: [p.journal || ''].filter(Boolean),
      source: 'publication',
      metadata: { journal: p.journal, year: p.year },
    })),
  ];

  console.log(`\n[embed] Step 3: Embedding ${records.length} records...`);
  const result = await embedBatch(prisma, records, 50);

  console.log(`\n[done] Done!`);
  console.log(`  Embedded: ${result.success}`);
  console.log(`  Skipped (unchanged): ${result.skipped}`);
  console.log(`  Failed: ${result.failed}`);

  // Analyze index
  try {
    await prisma.$executeRawUnsafe('ANALYZE memo_embeddings;');
    console.log('  Index analyzed [ok]');
  } catch {}

  process.exit(0);
}

main().catch(err => {
  console.error('[error] Embedding failed:', err);
  process.exit(1);
});
