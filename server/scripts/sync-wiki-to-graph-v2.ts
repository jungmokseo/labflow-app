/**
 * sync-wiki-to-graph v2 — 안정화 버전.
 *
 * 개선사항:
 *   - 진행상태 파일(sync-progress.json)에 처리된 article ID 기록 → 재시작 시 skip
 *   - 호출당 60초 timeout — stuck 방지
 *   - 호출 간 500ms 딜레이 — Gemini rate limit 회피
 *   - 에러 발생 시 3회 재시도 (지수 백오프)
 *   - stdout flush — 실시간 진행 확인 가능
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { prisma } from '../src/config/prisma.js';
import { buildGraphFromText } from '../src/services/knowledge-graph.js';

const LAB_ID = (process.env.LAB_ID ?? '').replace(/^"|"$/g, '');
const PROGRESS_FILE = path.join(process.cwd(), 'scripts', 'sync-progress.json');

const CALL_TIMEOUT_MS = 60_000;
const BETWEEN_CALLS_MS = 500;

function log(msg: string): void {
  process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${msg}\n`);
}

function loadProgress(): Set<string> {
  if (fs.existsSync(PROGRESS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      return new Set(data.processedIds ?? []);
    } catch { /* skip */ }
  }
  return new Set();
}

function saveProgress(processed: Set<string>): void {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({
    processedIds: [...processed],
    savedAt: new Date().toISOString(),
  }, null, 2));
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms)),
  ]);
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const lab = await prisma.lab.findUnique({ where: { id: LAB_ID }, select: { ownerId: true, name: true } });
  if (!lab) { log('lab 없음'); process.exit(1); }
  const userId = lab.ownerId;
  log(`Lab: ${lab.name} / Owner: ${userId}`);

  const articles = await prisma.wikiArticle.findMany({
    where: { labId: LAB_ID },
    select: { id: true, title: true, content: true, category: true },
    orderBy: { updatedAt: 'desc' },
  });

  const processed = loadProgress();
  const remaining = articles.filter(a => !processed.has(a.id));
  log(`총 ${articles.length}개 / 이미 처리 ${processed.size} / 남은 ${remaining.length}`);

  if (remaining.length === 0) {
    log('✓ 전부 처리됨. 종료.');
    await prisma.$disconnect();
    return;
  }

  const startedAt = Date.now();
  let ok = 0, failed = 0;

  for (let i = 0; i < remaining.length; i++) {
    const a = remaining[i];
    const text = `# ${a.title} [${a.category}]\n\n${a.content}`;
    let success = false;

    for (let attempt = 1; attempt <= 3 && !success; attempt++) {
      try {
        await withTimeout(buildGraphFromText(userId, text, 'wiki'), CALL_TIMEOUT_MS);
        success = true;
      } catch (err: any) {
        if (attempt === 3) {
          failed++;
          log(`  ✗ [${i + 1}/${remaining.length}] ${a.title.slice(0, 50)} — ${err.message?.slice(0, 80)}`);
        } else {
          await sleep(1000 * attempt); // 지수 백오프: 1s, 2s
        }
      }
    }

    if (success) {
      ok++;
      processed.add(a.id);
      // 10개마다 진행상태 저장
      if (ok % 10 === 0) saveProgress(processed);
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      log(`  ✓ [${i + 1}/${remaining.length}] ${elapsed}s ${a.title.slice(0, 60)}`);
    }

    await sleep(BETWEEN_CALLS_MS);
  }

  saveProgress(processed);

  const finalNodes = await prisma.knowledgeNode.count({ where: { userId } });
  const finalEdges = await prisma.knowledgeEdge.count({ where: { userId } });
  log(`\n완료: 성공 ${ok} / 실패 ${failed}`);
  log(`최종 graph: ${finalNodes} nodes / ${finalEdges} edges`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
