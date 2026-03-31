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
  console.log('🔧 Step 1: Running SQL migration...');
  const sql = readFileSync(join(__dirname, '..', 'migrations', 'memo_embeddings.sql'), 'utf-8');
  // Execute statements one by one (multi-statement may fail)
  const statements = sql
    .split(/;\s*\n/)
    .map(s => s.trim())
    .filter(s => s.length > 10);

  for (const stmt of statements) {
    try {
      await prisma.$executeRawUnsafe(stmt + ';');
    } catch (err: any) {
      // Ignore "already exists" errors
      if (!err.message?.includes('already exists')) {
        console.warn('SQL warning:', err.message?.slice(0, 100));
      }
    }
  }
  console.log('✅ SQL migration complete');

  console.log('\n📦 Step 2: Loading existing data...');
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

  console.log(`\n🚀 Step 3: Embedding ${records.length} records...`);
  const result = await embedBatch(prisma, records, 50);

  console.log(`\n✅ Done!`);
  console.log(`  Embedded: ${result.success}`);
  console.log(`  Skipped (unchanged): ${result.skipped}`);
  console.log(`  Failed: ${result.failed}`);

  // Analyze index
  try {
    await prisma.$executeRawUnsafe('ANALYZE memo_embeddings;');
    console.log('  Index analyzed ✅');
  } catch {}

  process.exit(0);
}

main().catch(err => {
  console.error('❌ Embedding failed:', err);
  process.exit(1);
});
