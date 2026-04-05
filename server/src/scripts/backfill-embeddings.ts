/**
 * Backfill embeddings for ChannelSummary, Memo, Meeting, KnowledgeNode
 * into the MemoEmbedding table using the existing RAG engine.
 *
 * Usage: npx tsx src/scripts/backfill-embeddings.ts
 */

import { PrismaClient } from '@prisma/client';
import { generateEmbedding } from '../services/embedding-service.js';
import { createHash } from 'crypto';

const prisma = new PrismaClient();

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

async function backfillTable(
  tableName: string,
  records: Array<{ id: string; text: string; title?: string; labId?: string | null; userId?: string | null }>,
  sourceType: string,
) {
  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < records.length; i += 50) {
    const batch = records.slice(i, i + 50);

    for (const rec of batch) {
      try {
        const hash = contentHash(rec.text);

        // Check if already embedded
        const existing = await prisma.memoEmbedding.findFirst({
          where: { sourceId: rec.id, sourceType },
        });

        if (existing && (existing as any).contentHash === hash) {
          skipped++;
          continue;
        }

        const result = await generateEmbedding(rec.text);
        const vectorStr = `[${result.embedding.join(',')}]`;

        if (existing) {
          await prisma.$executeRawUnsafe(
            `UPDATE memo_embeddings SET embedding = $1::vector, chunk_text = $2, content_hash = $3, title = $4, updated_at = NOW() WHERE id = $5`,
            vectorStr, rec.text.slice(0, 2000), hash, rec.title || null, (existing as any).id
          );
        } else {
          await prisma.$executeRawUnsafe(
            `INSERT INTO memo_embeddings (source_type, source_id, lab_id, user_id, title, chunk_index, chunk_text, content_hash, embedding, metadata)
             VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8::vector, '{}')`,
            sourceType, rec.id, rec.labId || null, rec.userId || null, rec.title || null, rec.text.slice(0, 2000), hash, vectorStr
          );
        }
        success++;
      } catch (err) {
        failed++;
        console.warn(`[backfill] ${tableName} ${rec.id} failed:`, (err as Error).message);
      }
    }

    console.log(`[backfill] ${tableName}: ${success + skipped + failed}/${records.length} processed (${success} embedded, ${skipped} skipped, ${failed} failed)`);

    // Rate limit pause between batches
    if (i + 50 < records.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  return { success, skipped, failed };
}

async function main() {
  console.log('=== Backfill Embeddings Start ===');

  // 1. ChannelSummary
  const summaries = await prisma.channelSummary.findMany();
  const summaryRecords = summaries.map(s => ({
    id: s.id,
    text: s.summaryText,
    title: 'Channel Summary',
    userId: s.userId,
    labId: null as string | null,
  }));
  const r1 = await backfillTable('ChannelSummary', summaryRecords, 'channel_summary');

  // 2. Memo
  const memos = await prisma.memo.findMany();
  const memoRecords = memos.map(m => ({
    id: m.id,
    text: [m.title, m.content].filter(Boolean).join('\n'),
    title: m.title || undefined,
    userId: m.userId,
    labId: m.labId,
  }));
  const r2 = await backfillTable('Memo', memoRecords, 'memo');

  // 3. Meeting
  const meetings = await prisma.meeting.findMany();
  const meetingRecords = meetings.map(m => ({
    id: m.id,
    text: [m.title, m.summary || ''].filter(Boolean).join('\n'),
    title: m.title,
    userId: m.userId,
    labId: null as string | null,
  }));
  const r3 = await backfillTable('Meeting', meetingRecords, 'meeting');

  // 4. KnowledgeNode
  const nodes = await prisma.knowledgeNode.findMany();
  const nodeRecords = nodes.map(n => ({
    id: n.id,
    text: [n.name, (n.metadata as any)?.description || ''].filter(Boolean).join('\n'),
    title: n.name,
    userId: n.userId,
    labId: null as string | null,
  }));
  const r4 = await backfillTable('KnowledgeNode', nodeRecords, 'knowledge_node');

  // 5. Capture
  const captures = await prisma.capture.findMany();
  const captureRecords = captures.map(c => ({
    id: c.id,
    text: [c.summary, c.content].filter(Boolean).join('\n'),
    title: c.summary || undefined,
    userId: c.userId,
    labId: c.labId,
  }));
  const r5 = await backfillTable('Capture', captureRecords, 'capture');

  console.log('\n=== Backfill Summary ===');
  console.log(`ChannelSummary: ${r1.success} embedded, ${r1.skipped} skipped, ${r1.failed} failed`);
  console.log(`Memo: ${r2.success} embedded, ${r2.skipped} skipped, ${r2.failed} failed`);
  console.log(`Meeting: ${r3.success} embedded, ${r3.skipped} skipped, ${r3.failed} failed`);
  console.log(`KnowledgeNode: ${r4.success} embedded, ${r4.skipped} skipped, ${r4.failed} failed`);
  console.log(`Capture: ${r5.success} embedded, ${r5.skipped} skipped, ${r5.failed} failed`);

  await prisma.$disconnect();
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
