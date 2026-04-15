/**
 * Wiki Engine — Karpathy 스타일 LLM 지식 위키 시스템
 *
 * 연구실 데이터(미팅, 대화, 논문 알림, 캡처)를 주기적으로 수집(ingest)하여
 * 마크다운 아티클 형태의 지식 위키를 자동 생성·업데이트합니다.
 *
 * 흐름:
 *   enqueueNewData() → WikiRawQueue 추가 (중복 방지)
 *   ingestAndCompile() → Claude Sonnet으로 위키 업데이트
 *   deepSynthesis() → Claude Opus로 전체 딥 리뷰
 */

import Anthropic from '@anthropic-ai/sdk';
import { Client as NotionClient } from '@notionhq/client';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { logError } from './error-logger.js';
import { buildGraphFromText } from './knowledge-graph.js';
import { logApiCost } from './cost-logger.js';

// ── Anthropic 클라이언트 ──────────────────────────────────
function getAnthropicClient(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY가 설정되지 않았습니다');
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

// ── JSON 파싱 헬퍼 ────────────────────────────────────────
function extractJsonArray(text: string): any[] {
  // 코드 블록 안 JSON 추출
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = codeBlockMatch ? codeBlockMatch[1] : text;

  // 배열 구간 추출
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) return [];

  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    console.warn('[wiki-engine] JSON 파싱 실패, 빈 배열 반환');
    return [];
  }
}

// ── CUID 생성 (prisma cuid()와 동일한 패턴) ──────────────
function generateId(): string {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 9);
  return `c${timestamp}${randomPart}`;
}

// ── Notion 헬퍼 ───────────────────────────────────────────

/** Notion RichText 배열 → 일반 문자열 */
function richTextToStr(richText: any[]): string {
  if (!Array.isArray(richText)) return '';
  return richText.map((t: any) => t.plain_text ?? '').join('');
}

/** 단일 Notion 블록 → 마크다운 한 줄 (자식은 별도 처리) */
function blockToLine(b: any): string {
  switch (b.type) {
    case 'paragraph':         return richTextToStr(b.paragraph?.rich_text ?? []);
    case 'heading_1':         return '# ' + richTextToStr(b.heading_1?.rich_text ?? []);
    case 'heading_2':         return '## ' + richTextToStr(b.heading_2?.rich_text ?? []);
    case 'heading_3':         return '### ' + richTextToStr(b.heading_3?.rich_text ?? []);
    case 'bulleted_list_item':return '- ' + richTextToStr(b.bulleted_list_item?.rich_text ?? []);
    case 'numbered_list_item':return '1. ' + richTextToStr(b.numbered_list_item?.rich_text ?? []);
    case 'to_do':             return (b.to_do?.checked ? '[x] ' : '[ ] ') + richTextToStr(b.to_do?.rich_text ?? []);
    case 'quote':             return '> ' + richTextToStr(b.quote?.rich_text ?? []);
    case 'callout':           return richTextToStr(b.callout?.rich_text ?? []);
    case 'toggle':            return richTextToStr(b.toggle?.rich_text ?? []);
    case 'code':              return '```\n' + richTextToStr(b.code?.rich_text ?? []) + '\n```';
    case 'equation':          return b.equation?.expression ? `$${b.equation.expression}$` : '';
    case 'table_row':         return '| ' + (b.table_row?.cells ?? []).map((c: any[]) => richTextToStr(c)).join(' | ') + ' |';
    case 'child_page':        return `[하위 페이지] ${b.child_page?.title ?? ''}`;
    case 'child_database':    return `[하위 DB] ${b.child_database?.title ?? ''}`;
    case 'bookmark':          return b.bookmark?.url ? `[북마크] ${b.bookmark.url}` : '';
    case 'link_to_page':      return '[페이지 링크]';
    default: return '';
  }
}

/**
 * 블록 배열 재귀 변환 — 깊이 무제한, 안전장치 포함.
 * 안전장치: 순환 참조 방지(visited Set), 페이지당 최대 블록 수 제한(MAX_BLOCKS_PER_PAGE)
 */
const MAX_BLOCKS_PER_PAGE = 2000; // 페이지 하나당 최대 블록 수 (안전 한계)

async function blocksToMarkdownRecursive(
  notion: NotionClient,
  blocks: any[],
  depth: number = 0,
  visited: Set<string> = new Set(),
  counter: { count: number } = { count: 0 },
): Promise<string> {
  const lines: string[] = [];
  const indent = '  '.repeat(depth);

  for (const b of blocks) {
    if (counter.count >= MAX_BLOCKS_PER_PAGE) break;
    if (visited.has(b.id)) continue;
    visited.add(b.id);
    counter.count++;

    const line = blockToLine(b);
    if (line) lines.push(indent + line);

    // has_children이면 자식 재귀 (깊이 제한 없음)
    if (b.has_children && counter.count < MAX_BLOCKS_PER_PAGE) {
      try {
        let children: any[] = [];
        let cursor: string | undefined = undefined;
        do {
          const res: any = await notion.blocks.children.list({
            block_id: b.id,
            page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}),
          });
          children = children.concat(res.results as any[]);
          cursor = res.has_more ? res.next_cursor : undefined;
        } while (cursor);

        if (children.length > 0) {
          const childMd = await blocksToMarkdownRecursive(notion, children, depth + 1, visited, counter);
          if (childMd) lines.push(childMd);
        }
      } catch { /* 자식 fetch 실패 시 스킵 */ }
    }
  }
  return lines.filter(Boolean).join('\n');
}

/** Notion 페이지 제목 추출 */
function getPageTitle(page: any): string {
  const props = page.properties ?? {};
  for (const key of Object.keys(props)) {
    const p = props[key];
    if (p.type === 'title' && Array.isArray(p.title)) {
      return richTextToStr(p.title) || '(제목 없음)';
    }
  }
  return '(제목 없음)';
}

/** Notion 페이지 properties → 텍스트 요약 (title 제외) */
function propsToText(props: Record<string, any>): string {
  const lines: string[] = [];
  for (const [key, p] of Object.entries(props)) {
    if (p.type === 'title') continue;
    let val = '';
    switch (p.type) {
      case 'rich_text':   val = richTextToStr(p.rich_text ?? []); break;
      case 'select':      val = p.select?.name ?? ''; break;
      case 'multi_select':val = (p.multi_select ?? []).map((s: any) => s.name).join(', '); break;
      case 'date':        val = p.date?.start ?? ''; break;
      case 'checkbox':    val = p.checkbox ? '예' : '아니오'; break;
      case 'number':      val = p.number?.toString() ?? ''; break;
      case 'url':         val = p.url ?? ''; break;
      case 'email':       val = p.email ?? ''; break;
      case 'phone_number':val = p.phone_number ?? ''; break;
      case 'status':      val = p.status?.name ?? ''; break;
      case 'people':      val = (p.people ?? []).map((u: any) => u.name ?? '').join(', '); break;
      default: break;
    }
    if (val) lines.push(`${key}: ${val}`);
  }
  return lines.join('\n');
}

/**
 * Notion 전체 워크스페이스를 탐색해 WikiRawQueue에 추가.
 * notion.search()로 모든 페이지를 한 번에 수집 — 하드코딩 소스 목록 불필요.
 * 계정 정보 DB(4e835742...) 및 그 하위 페이지만 보안상 제외.
 */

// 보안상 수집 제외할 Notion 페이지/DB ID (대시 없는 형태)
const NOTION_EXCLUDED_IDS = new Set([
  '4e835742f14748f09e22b19ef9fe24b8', // 🔑 계정 정보 DB
]);

async function enqueueNotionData(labId: string): Promise<number> {
  if (!env.NOTION_API_KEY) {
    console.warn('[wiki-engine] NOTION_API_KEY 미설정 — Notion 수집 건너뜀');
    return 0;
  }

  const notion = new NotionClient({ auth: env.NOTION_API_KEY });
  let enqueued = 0;
  let searchCursor: string | undefined = undefined;
  let totalPagesFound = 0;

  do {
    let res: any;
    try {
      res = await notion.search({
        filter: { property: 'object', value: 'page' },
        page_size: 100,
        ...(searchCursor ? { start_cursor: searchCursor } : {}),
      });
      totalPagesFound += res.results.length;
    } catch (err) {
      console.error('[wiki-engine] Notion search 실패:', err);
      logError('background', '[wiki-engine] Notion search 실패', { labId })(err);
      break;
    }

    for (const page of res.results) {
      try {
        const pageId = (page.id as string).replace(/-/g, '');

        // 제외 목록 체크
        if (NOTION_EXCLUDED_IDS.has(pageId)) continue;

        // 부모가 제외 DB/페이지인 경우 스킵
        const parentDbId = ((page.parent as any)?.database_id ?? '').replace(/-/g, '');
        const parentPageId = ((page.parent as any)?.page_id ?? '').replace(/-/g, '');
        if (NOTION_EXCLUDED_IDS.has(parentDbId) || NOTION_EXCLUDED_IDS.has(parentPageId)) continue;

        const sourceId = `notion_${pageId}`;
        const lastEditedTime = new Date((page as any).last_edited_time);

        // 큐 항목 확인 — last_edited_time 기준으로 변경 시만 재큐
        const existing = await prisma.wikiRawQueue.findFirst({ where: { labId, sourceId } });
        if (existing) {
          // 대기 중이거나 처리 후 변경 없으면 skip
          if (existing.processedAt === null || lastEditedTime <= existing.processedAt) continue;
          // 처리 후 Notion에서 수정된 경우 → 기존 항목 삭제 후 재큐
          await prisma.wikiRawQueue.delete({ where: { id: existing.id } });
        }

        // 페이지 제목 + DB 속성
        const title = getPageTitle(page);
        const propText = propsToText((page as any).properties ?? {});

        // 직접 블록 수집 (모든 블록 포함, 자식까지 재귀 추출)
        let bodyText = '';
        try {
          let bodyBlocks: any[] = [];
          let blockCursor: string | undefined = undefined;
          do {
            const blockRes: any = await notion.blocks.children.list({
              block_id: page.id as string,
              page_size: 100,
              ...(blockCursor ? { start_cursor: blockCursor } : {}),
            });
            bodyBlocks = bodyBlocks.concat(blockRes.results as any[]);
            blockCursor = blockRes.has_more ? blockRes.next_cursor : undefined;
          } while (blockCursor);
          bodyText = await blocksToMarkdownRecursive(notion, bodyBlocks);
        } catch { /* 블록 없으면 생략 */ }

        const content = [
          `[노션] ${title}`,
          propText,
          bodyText,
        ].filter(Boolean).join('\n').slice(0, 30000);

        if (content.length < 20) continue; // 빈 페이지 스킵

        await prisma.wikiRawQueue.create({
          data: { id: generateId(), labId, sourceType: 'notion_page', sourceId, content },
        });
        enqueued++;
      } catch { /* 개별 페이지 실패 무시 */ }
    }

    searchCursor = res.has_more ? res.next_cursor : undefined;
  } while (searchCursor);

  console.log(`[wiki-engine] enqueueNotionData 완료: 검색된 ${totalPagesFound}개 / 큐 추가 ${enqueued}개 (labId: ${labId})`);
  return enqueued;
}

/** Notion 연결 진단 — API 키 존재/유효성 및 접근 가능 페이지 수 확인 */
export async function diagnoseNotion(): Promise<{
  apiKeySet: boolean;
  integrationName?: string;
  accessiblePageCount?: number;
  error?: string;
  sampleTitles?: string[];
}> {
  if (!env.NOTION_API_KEY) {
    return { apiKeySet: false };
  }

  const notion = new NotionClient({ auth: env.NOTION_API_KEY });

  try {
    // 1. 봇 본인 정보 — API 키 유효성 확인
    const me: any = await notion.users.me({});
    const integrationName = me?.name ?? me?.bot?.owner?.type ?? 'unknown';

    // 2. 검색으로 접근 가능한 페이지 수 확인 (첫 페이지만)
    const searchRes: any = await notion.search({
      filter: { property: 'object', value: 'page' },
      page_size: 10,
    });

    const sampleTitles = (searchRes.results as any[]).slice(0, 5).map((p: any) => {
      for (const key of Object.keys(p.properties ?? {})) {
        const prop = p.properties[key];
        if (prop.type === 'title' && Array.isArray(prop.title)) {
          return prop.title.map((t: any) => t.plain_text ?? '').join('') || '(제목 없음)';
        }
      }
      return '(제목 없음)';
    });

    return {
      apiKeySet: true,
      integrationName,
      accessiblePageCount: searchRes.results.length,
      sampleTitles,
    };
  } catch (err: any) {
    return {
      apiKeySet: true,
      error: err?.message ?? String(err),
    };
  }
}

// ── enqueueNewData ────────────────────────────────────────

/**
 * 지난 25시간 내 새로 생성된 데이터를 WikiRawQueue에 추가.
 * sourceId 체크로 중복 방지.
 *
 * @returns 새로 enqueue된 항목 수
 */
export async function enqueueNewData(labId: string, userId: string): Promise<number> {
  const since = new Date(Date.now() - 25 * 60 * 60 * 1000);
  let enqueued = 0;

  // ── Meeting ──────────────────────────────────────────────
  try {
    const meetings = await prisma.meeting.findMany({
      where: { userId, createdAt: { gte: since } },
      select: {
        id: true,
        title: true,
        summary: true,
        actionItems: true,
        createdAt: true,
      },
    });

    for (const m of meetings) {
      const existing = await prisma.wikiRawQueue.findFirst({
        where: { labId, sourceId: m.id },
      });
      if (existing) continue;

      const parts: string[] = [`[미팅] ${m.title}`, `날짜: ${m.createdAt.toISOString().split('T')[0]}`];
      if (m.summary) parts.push(`요약: ${m.summary.slice(0, 1000)}`);
      if (m.actionItems.length > 0) parts.push(`액션아이템:\n${m.actionItems.map(a => `- ${a}`).join('\n')}`);

      await prisma.wikiRawQueue.create({
        data: {
          id: generateId(),
          labId,
          sourceType: 'meeting',
          sourceId: m.id,
          content: parts.join('\n'),
        },
      });
      enqueued++;
    }
  } catch (err) {
    logError('background', '[wiki-engine] Meeting enqueue 실패', { labId })(err);
  }

  // ── Brain Message (role=assistant, 채널별 user+assistant 쌍) ──
  try {
    const channels = await prisma.channel.findMany({
      where: { userId, shadow: false, archived: false },
      select: { id: true, name: true },
    });

    for (const ch of channels) {
      // 채널별 최근 메시지 쌍 (user + 바로 뒤 assistant)
      const messages = await prisma.message.findMany({
        where: { channelId: ch.id, createdAt: { gte: since } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, role: true, content: true, createdAt: true },
      });

      if (messages.length === 0) continue;

      // user+assistant 쌍으로 묶기
      const pairs: Array<{ user: string; assistant: string; date: string }> = [];
      for (let i = 0; i < messages.length - 1; i++) {
        if (messages[i].role === 'user' && messages[i + 1].role === 'assistant') {
          pairs.push({
            user: messages[i].content.slice(0, 300),
            assistant: messages[i + 1].content.slice(0, 500),
            date: messages[i].createdAt.toISOString().split('T')[0],
          });
          i++; // 다음 메시지 건너뜀
        }
      }
      if (pairs.length === 0) continue;

      // 채널+날짜 기준 sourceId
      const today = new Date().toISOString().split('T')[0];
      const sourceId = `brain_${ch.id}_${today}`;

      const existing = await prisma.wikiRawQueue.findFirst({
        where: { labId, sourceId },
      });
      if (existing) continue;

      const content = `[대화 요약] 채널: ${ch.name || ch.id}\n날짜: ${today}\n\n` +
        pairs.map((p, i) => `Q${i + 1}: ${p.user}\nA${i + 1}: ${p.assistant}`).join('\n\n');

      await prisma.wikiRawQueue.create({
        data: {
          id: generateId(),
          labId,
          sourceType: 'brain_message',
          sourceId,
          content: content.slice(0, 3000),
        },
      });
      enqueued++;
    }
  } catch (err) {
    logError('background', '[wiki-engine] Brain Message enqueue 실패', { labId })(err);
  }

  // ── PaperAlertResult (stars >= 2, 시간 제한 없이 미처리만) ────
  // 시간 필터 제거: 주간 알림은 주 1회 batch로 들어오므로 시간 윈도우에 의존 불가.
  // sourceId(paper result id) 기반 dedup으로 이미 큐에 있던 것만 건너뜀.
  try {
    const alerts = await prisma.paperAlert.findMany({
      where: { labId },
      select: { id: true },
    });
    const alertIds = alerts.map(a => a.id);

    if (alertIds.length > 0) {
      const papers = await prisma.paperAlertResult.findMany({
        where: {
          alertId: { in: alertIds },
          stars: { gte: 2 },
        },
        select: {
          id: true,
          title: true,
          aiSummary: true,
          aiReason: true,
          journal: true,
          pubDate: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      for (const p of papers) {
        const existing = await prisma.wikiRawQueue.findFirst({
          where: { labId, sourceId: p.id },
        });
        if (existing) continue;

        const parts: string[] = [
          `[논문 알림] ${p.title}`,
          `저널: ${p.journal || '미상'}`,
          `날짜: ${(p.pubDate || p.createdAt).toISOString().split('T')[0]}`,
        ];
        if (p.aiSummary) parts.push(`AI 요약: ${p.aiSummary.slice(0, 500)}`);
        if (p.aiReason) parts.push(`관련도 이유: ${p.aiReason.slice(0, 300)}`);

        await prisma.wikiRawQueue.create({
          data: {
            id: generateId(),
            labId,
            sourceType: 'paper_alert',
            sourceId: p.id,
            content: parts.join('\n'),
          },
        });
        enqueued++;
      }
    }
  } catch (err) {
    logError('background', '[wiki-engine] PaperAlertResult enqueue 실패', { labId })(err);
  }

  // ── Capture (IDEA or TASK만) ─────────────────────────────
  try {
    const captures = await prisma.capture.findMany({
      where: {
        labId,
        category: { in: ['IDEA', 'TASK'] },
        createdAt: { gte: since },
      },
      select: {
        id: true,
        content: true,
        category: true,
        tags: true,
        createdAt: true,
      },
    });

    for (const c of captures) {
      const existing = await prisma.wikiRawQueue.findFirst({
        where: { labId, sourceId: c.id },
      });
      if (existing) continue;

      const content = [
        `[캡처] ${c.category === 'IDEA' ? '아이디어' : '태스크'}`,
        `날짜: ${c.createdAt.toISOString().split('T')[0]}`,
        `내용: ${c.content.slice(0, 500)}`,
        c.tags.length > 0 ? `태그: ${c.tags.join(', ')}` : '',
      ].filter(Boolean).join('\n');

      await prisma.wikiRawQueue.create({
        data: {
          id: generateId(),
          labId,
          sourceType: 'capture',
          sourceId: c.id,
          content,
        },
      });
      enqueued++;
    }
  } catch (err) {
    logError('background', '[wiki-engine] Capture enqueue 실패', { labId })(err);
  }

  // ── GDrive 기반 소스 재큐 헬퍼 ─────────────────────────────
  // project / lab_member / member_info / acknowledgment 는 GDrive가 진실의 원천.
  // - 큐에 없으면 → 신규 생성
  // - 큐에 있고 미처리(processedAt=null) → skip (곧 처리됨)
  // - 큐에 있고 처리완료(processedAt!=null) → DB updatedAt > processedAt 일 때만 재큐
  async function requeueIfChanged(
    sourceType: string,
    sourceId: string,
    content: string,
    dbUpdatedAt: Date,
  ): Promise<void> {
    const existing = await prisma.wikiRawQueue.findFirst({ where: { labId, sourceId } });
    if (!existing) {
      // 최초 등록
      await prisma.wikiRawQueue.create({
        data: { id: generateId(), labId, sourceType, sourceId, content },
      });
      enqueued++;
    } else if (existing.processedAt !== null && dbUpdatedAt > existing.processedAt) {
      // 처리된 이후 DB가 갱신된 경우만 재큐
      await prisma.wikiRawQueue.delete({ where: { id: existing.id } });
      await prisma.wikiRawQueue.create({
        data: { id: generateId(), labId, sourceType, sourceId, content },
      });
      enqueued++;
    }
    // processedAt=null(대기중) 또는 변경 없음 → skip
  }

  // ── LabMember (GDrive 연동 — 변경 시만 재큐) ───────────────
  try {
    const members = await prisma.labMember.findMany({
      where: { labId, active: true },
      select: { id: true, name: true, nameEn: true, role: true, email: true, team: true, metadata: true, updatedAt: true },
    });

    for (const m of members) {
      const parts: string[] = [`[연구원] ${m.name}${m.nameEn ? ` (${m.nameEn})` : ''}`];
      if (m.role) parts.push(`역할: ${m.role}`);
      if (m.team) parts.push(`팀: ${m.team}`);
      if (m.email) parts.push(`이메일: ${m.email}`);
      if (m.metadata && typeof m.metadata === 'object' && Object.keys(m.metadata as object).length > 0) {
        parts.push(`추가정보: ${JSON.stringify(m.metadata)}`);
      }
      await requeueIfChanged('lab_member', `labmember_${m.id}`, parts.join('\n'), m.updatedAt);
    }
  } catch (err) {
    logError('background', '[wiki-engine] LabMember enqueue 실패', { labId })(err);
  }

  // ── Project (GDrive 연동 — 변경 시만 재큐) ──────────────────
  try {
    const projects = await prisma.project.findMany({
      where: { labId, status: 'active' },
      select: {
        id: true, name: true, shortName: true, businessName: true,
        funder: true, period: true, pi: true, pm: true,
        ministry: true, responsibility: true,
        acknowledgmentKo: true, acknowledgmentEn: true,
        updatedAt: true,
      },
    });

    for (const p of projects) {
      const parts: string[] = [`[과제] ${p.name}`];
      if (p.shortName) parts.push(`과제번호/약칭: ${p.shortName}`);
      if (p.businessName) parts.push(`사업명: ${p.businessName}`);
      if (p.funder) parts.push(`지원기관: ${p.funder}`);
      if (p.ministry) parts.push(`주관부처: ${p.ministry}`);
      if (p.period) parts.push(`기간: ${p.period}`);
      if (p.pi) parts.push(`PI: ${p.pi}`);
      if (p.pm) parts.push(`PM: ${p.pm}`);
      if (p.responsibility) parts.push(`책임내용: ${p.responsibility}`);
      if (p.acknowledgmentKo) parts.push(`사사문구(한): ${p.acknowledgmentKo.slice(0, 300)}`);
      if (p.acknowledgmentEn) parts.push(`사사문구(영): ${p.acknowledgmentEn.slice(0, 300)}`);
      await requeueIfChanged('project', `project_${p.id}`, parts.join('\n'), p.updatedAt);
    }
  } catch (err) {
    logError('background', '[wiki-engine] Project enqueue 실패', { labId })(err);
  }

  // ── Publication (기초 데이터 — 미처리 항목만, 시간 제한 없음) ─
  try {
    const publications = await prisma.publication.findMany({
      where: { labId },
      select: { id: true, title: true, authors: true, journal: true, year: true, abstract: true, nickname: true },
      orderBy: { year: 'desc' },
    });

    for (const pub of publications) {
      const sourceId = `publication_${pub.id}`;
      const existing = await prisma.wikiRawQueue.findFirst({ where: { labId, sourceId } });
      if (existing) continue;

      const parts: string[] = [`[논문] ${pub.title}`];
      if (pub.nickname) parts.push(`별칭: ${pub.nickname}`);
      if (pub.authors) parts.push(`저자: ${pub.authors.slice(0, 200)}`);
      if (pub.journal) parts.push(`저널: ${pub.journal}`);
      if (pub.year) parts.push(`연도: ${pub.year}`);
      if (pub.abstract) parts.push(`초록: ${pub.abstract.slice(0, 500)}`);

      await prisma.wikiRawQueue.create({
        data: {
          id: generateId(),
          labId,
          sourceType: 'publication',
          sourceId,
          content: parts.join('\n'),
        },
      });
      enqueued++;
    }
  } catch (err) {
    logError('background', '[wiki-engine] Publication enqueue 실패', { labId })(err);
  }

  // ── Acknowledgment (GDrive 연동 — 변경 시만 재큐) ───────────
  try {
    const acks = await prisma.acknowledgment.findMany({
      where: { labId },
      select: {
        id: true, type: true, paperTitle: true, authors: true,
        journal: true, publishedAt: true, acknowledgedProjects: true,
        updatedAt: true,
      },
    });

    for (const a of acks) {
      const parts: string[] = [`[사사기록] ${a.paperTitle}`];
      if (a.type) parts.push(`유형: ${a.type}`);
      if (a.authors) parts.push(`저자: ${a.authors.slice(0, 200)}`);
      if (a.journal) parts.push(`저널/학회: ${a.journal}`);
      if (a.publishedAt) parts.push(`발표일: ${a.publishedAt}`);
      if (a.acknowledgedProjects) parts.push(`사사 과제: ${a.acknowledgedProjects.slice(0, 300)}`);
      await requeueIfChanged('acknowledgment', `acknowledgment_${a.id}`, parts.join('\n'), a.updatedAt);
    }
  } catch (err) {
    logError('background', '[wiki-engine] Acknowledgment enqueue 실패', { labId })(err);
  }

  // ── MemberInfo (GDrive 연동 — 변경 시만 재큐, 민감정보 제외) ─
  try {
    const memberInfos = await prisma.memberInfo.findMany({
      where: { labId },
      select: {
        id: true, name: true, degree: true, department: true,
        joinYear: true, graduationYear: true, researcherId: true,
        updatedAt: true,
        // bankName/accountNumber 제외 (민감 정보)
      },
    });

    for (const mi of memberInfos) {
      const parts: string[] = [`[인적사항] ${mi.name}`];
      if (mi.degree) parts.push(`학위과정: ${mi.degree}`);
      if (mi.department) parts.push(`학과: ${mi.department}`);
      if (mi.joinYear) parts.push(`입학년도: ${mi.joinYear}`);
      if (mi.graduationYear) parts.push(`졸업년도: ${mi.graduationYear}`);
      if (mi.researcherId) parts.push(`연구자번호: ${mi.researcherId}`);
      await requeueIfChanged('member_info', `memberinfo_${mi.id}`, parts.join('\n'), mi.updatedAt);
    }
  } catch (err) {
    logError('background', '[wiki-engine] MemberInfo enqueue 실패', { labId })(err);
  }

  // ── Notion ───────────────────────────────────────────────
  try {
    const notionCount = await enqueueNotionData(labId);
    enqueued += notionCount;
  } catch (err) {
    logError('background', '[wiki-engine] Notion enqueue 실패', { labId })(err);
  }

  // ── Slack (future) ────────────────────────────────────────
  // TODO: Slack 연동 시 여기에 추가

  console.log(`[wiki-engine] enqueueNewData 완료: ${enqueued}개 항목 추가 (labId: ${labId})`);
  return enqueued;
}

// ── ingestAndCompile ──────────────────────────────────────

/**
 * 미처리 큐 항목을 Claude Sonnet으로 처리하여 위키 업데이트.
 *
 * @returns { processed: number, updated: string[] }
 */
export async function ingestAndCompile(labId: string, userId?: string): Promise<{ processed: number; updated: string[] }> {
  // 1. 미처리 큐 항목 가져오기 (페이지당 컨텐츠가 최대 30k이므로 10개씩)
  const queue = await prisma.wikiRawQueue.findMany({
    where: { labId, processedAt: null },
    orderBy: { createdAt: 'asc' },
    take: 10,
  });

  if (queue.length === 0) {
    console.log('[wiki-engine] ingestAndCompile: 처리할 큐 항목 없음');
    return { processed: 0, updated: [] };
  }

  // 2. 기존 위키 아티클 인덱스
  const existingArticles = await prisma.wikiArticle.findMany({
    where: { labId },
    select: { title: true, category: true, tags: true },
  });

  // 2-1. 논문 알림이 큐에 있으면 연구 관련 아티클(project, publication, research_trend, experiment)의
  //      본문을 추가로 제공해서 LLM이 실제로 크로스 레퍼런스할 수 있도록 한다.
  const hasPaperAlert = queue.some(q => q.sourceType === 'paper_alert');
  let researchContext = '';
  if (hasPaperAlert) {
    const researchArticles = await prisma.wikiArticle.findMany({
      where: {
        labId,
        category: { in: ['project', 'publication', 'research_trend', 'experiment'] },
      },
      select: { title: true, category: true, content: true },
      orderBy: { updatedAt: 'desc' },
      take: 30, // 최신 30개
    });
    if (researchArticles.length > 0) {
      researchContext = '\n\n[기존 연구 아티클 본문 — 논문 알림과 연계 판단용]\n' +
        researchArticles.map(a =>
          `### ${a.title} (${a.category})\n${a.content.slice(0, 800)}`
        ).join('\n\n---\n\n');
    }
  }

  const anthropic = getAnthropicClient();

  // 3. Claude Sonnet 호출
  const queueText = queue.map((q, i) =>
    `[${i + 1}] (${q.sourceType})\n${q.content}`
  ).join('\n\n---\n\n');

  const existingText = existingArticles.length > 0
    ? existingArticles.map(a =>
        `- ${a.title} (${a.category}) [태그: ${a.tags.join(', ')}]`
      ).join('\n')
    : '(아직 아티클 없음)';

  const prompt = `당신은 BLISS Lab(연세대 바이오센서/유연전자소자 연구실) 지식 위키의 관리자입니다.

[소스 우선순위 — 중요]
아래 순서로 신뢰도가 높습니다. 동일 주제에 대해 내용이 충돌하면 우선순위가 높은 소스를 따르세요.
1순위 (GDrive DB, 항상 최신 정확): project, lab_member, member_info, acknowledgment
2순위 (직접 기록): meeting, brain_message, capture
3순위 (참고): notion_page, paper_alert, publication

[새로 들어온 데이터]
${queueText}

[기존 위키 아티클 목록]
${existingText}${researchContext}

지시사항:
1. 새 데이터를 분석해서 관련 있는 기존 아티클을 업데이트하거나, 없으면 새 아티클 생성
2. 1순위 소스(GDrive)의 내용은 기존 아티클 내용을 덮어씀 — notion_page 등 3순위 소스의 내용과 충돌하면 GDrive 값을 우선
3. 각 아티클은 [[다른아티클제목]] 형식으로 크로스레퍼런스 포함
4. 카테고리: person(연구자), project(과제), research_trend(연구동향), meeting_thread(미팅주제), experiment(실험), collaboration(협업), general
5. 마크다운 형식, 간결하고 정보 밀도 높게
6. 날짜 정보는 반드시 포함
7. 이모지 사용 금지

[논문 알림(paper_alert) 처리 규칙 — 매우 중요]
연구동향 아티클은 BLISS Lab의 기존 연구(과제·논문·실험)와 반드시 연계되어야 가치가 있습니다.
paper_alert 데이터를 처리할 때는 다음을 준수하세요:
- 위에 제공된 [기존 연구 아티클 본문]을 읽고, 논문과 관련 있는 내부 과제/논문/실험을 찾아내세요
- 새로 만드는 연구동향 아티클의 내용에 "관련 내부 연구" 섹션을 포함하고, 어떤 기존 연구와 어떻게 연결되는지(유사 접근법/보완/경쟁 등) 구체적으로 서술하세요
- 해당 기존 연구 아티클들을 [[아티클제목]] 형식으로 명시적으로 참조하세요
- 관련 내부 연구가 없으면 "관련 내부 연구 없음 — 신규 탐색 영역"으로 명시하세요

JSON 출력 형식 (배열만 출력, 다른 텍스트 없이):
[
  {
    "title": "아티클 제목",
    "category": "카테고리",
    "content": "마크다운 내용",
    "tags": ["태그1", "태그2"],
    "sources": [{"type": "meeting", "id": "...", "date": "..."}]
  }
]`;

  let articles: any[] = [];
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    logApiCost(userId ?? 'system', 'claude-sonnet-4-6', response.usage.input_tokens, response.usage.output_tokens, 'wiki_ingest').catch(() => {});
    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    articles = extractJsonArray(text);
  } catch (err) {
    logError('background', '[wiki-engine] Sonnet ingest 호출 실패', { labId })(err);
    return { processed: 0, updated: [] };
  }

  // 4. 파싱된 아티클 upsert
  const updatedTitles: string[] = [];
  const now = new Date();

  for (const article of articles) {
    if (!article.title || !article.category || !article.content) continue;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO wiki_articles (id, lab_id, title, category, content, tags, sources, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 1, $8, $8)
         ON CONFLICT (lab_id, title)
         DO UPDATE SET
           category   = EXCLUDED.category,
           content    = EXCLUDED.content,
           tags       = EXCLUDED.tags,
           sources    = EXCLUDED.sources,
           version    = wiki_articles.version + 1,
           updated_at = EXCLUDED.updated_at`,
        generateId(),
        labId,
        article.title,
        article.category,
        article.content,
        article.tags || [],
        JSON.stringify(article.sources || []),
        now,
      );
      updatedTitles.push(article.title);

      // 지식 그래프 연계 — 아티클 내용에서 엔티티/관계 비동기 추출
      if (userId) {
        setImmediate(() => {
          buildGraphFromText(userId, `${article.title}\n${article.content}`, 'wiki').catch(() => {});
        });
      }
    } catch (err) {
      logError('background', `[wiki-engine] 아티클 upsert 실패: ${article.title}`, { labId })(err);
    }
  }

  // 5. 처리된 큐 항목 processedAt 업데이트
  await prisma.wikiRawQueue.updateMany({
    where: { id: { in: queue.map(q => q.id) } },
    data: { processedAt: now },
  });

  console.log(`[wiki-engine] ingestAndCompile 완료: ${queue.length}개 처리, ${updatedTitles.length}개 아티클 업데이트`);
  return { processed: queue.length, updated: updatedTitles };
}

// ── deepSynthesis ─────────────────────────────────────────

/**
 * Claude Opus로 전체 위키 딥 리뷰.
 * 아티클 간 연결고리 발견, 패턴 분석, 모순 수정, 인사이트 아티클 생성.
 */
export async function deepSynthesis(labId: string, userId?: string): Promise<void> {
  // 1. 전체 위키 아티클 가져오기 (최대 30개, content 포함)
  const articles = await prisma.wikiArticle.findMany({
    where: { labId },
    orderBy: { updatedAt: 'desc' },
    take: 30,
  });

  if (articles.length === 0) {
    console.log('[wiki-engine] deepSynthesis: 아티클 없음, 건너뜀');
    return;
  }

  const anthropic = getAnthropicClient();

  // 2. Claude Opus 호출
  const articlesText = articles.map(a =>
    `### ${a.title} (${a.category}) [v${a.version}]\n${a.content}`
  ).join('\n\n---\n\n');

  const prompt = `당신은 BLISS Lab 연구실의 지식 위키 전문 편집자입니다.

[전체 위키 아티클]
${articlesText}

다음을 수행하세요:
1. 아티클 간 놓친 연결고리 발견 및 [[크로스레퍼런스]] 추가
2. 여러 데이터에서 패턴 발견 (예: 특정 연구 방향의 발전 흐름)
3. 모순되거나 오래된 정보 수정
4. 중요한 인사이트를 새 "synthesis" 아티클로 생성 (category: general, title: "인사이트: ...")
5. 각 아티클의 version +1 (실제 버전은 DB에서 +1됨)

이모지 사용 금지.
업데이트할 아티클만 JSON 배열로 반환 (변경 없는 것은 제외, 다른 텍스트 없이):
[{"title": "...", "category": "...", "content": "...", "tags": [...], "sources": [...]}]`;

  let updatedArticles: any[] = [];
  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    });

    logApiCost(userId ?? 'system', 'claude-opus-4-6', response.usage.input_tokens, response.usage.output_tokens, 'wiki_deep_synthesis').catch(() => {});
    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    updatedArticles = extractJsonArray(text);
  } catch (err) {
    logError('background', '[wiki-engine] Opus deepSynthesis 호출 실패', { labId })(err);
    return;
  }

  // 3. 업데이트된 아티클 upsert
  const now = new Date();
  let updateCount = 0;

  for (const article of updatedArticles) {
    if (!article.title || !article.category || !article.content) continue;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO wiki_articles (id, lab_id, title, category, content, tags, sources, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 1, $8, $8)
         ON CONFLICT (lab_id, title)
         DO UPDATE SET
           category   = EXCLUDED.category,
           content    = EXCLUDED.content,
           tags       = EXCLUDED.tags,
           sources    = EXCLUDED.sources,
           version    = wiki_articles.version + 1,
           updated_at = EXCLUDED.updated_at`,
        generateId(),
        labId,
        article.title,
        article.category,
        article.content,
        article.tags || [],
        JSON.stringify(article.sources || []),
        now,
      );
      updateCount++;
    } catch (err) {
      logError('background', `[wiki-engine] deepSynthesis upsert 실패: ${article.title}`, { labId })(err);
    }
  }

  console.log(`[wiki-engine] deepSynthesis 완료: ${updateCount}개 아티클 업데이트`);
}

// ── searchWiki ────────────────────────────────────────────

/**
 * 위키 검색 — 제목/태그/카테고리/내용에서 키워드 매칭.
 * 관련도 순 정렬: 제목 매칭 > 태그 매칭 > 내용 매칭
 */
export async function searchWiki(labId: string, query: string, limit = 5): Promise<any[]> {
  const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 1);
  if (keywords.length === 0) return [];

  // 모든 아티클 가져오기 (대용량 위키가 아닌 연구실 특성상 전체 로드 후 메모리 필터링)
  const articles = await prisma.wikiArticle.findMany({
    where: { labId },
    select: {
      id: true,
      title: true,
      category: true,
      content: true,
      tags: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: 'desc' },
  });

  // 관련도 점수 계산
  const scored = articles.map(a => {
    const titleLow = a.title.toLowerCase();
    const tagsLow = a.tags.map(t => t.toLowerCase());
    const contentLow = a.content.toLowerCase();
    let score = 0;

    for (const kw of keywords) {
      if (titleLow.includes(kw)) score += 10;
      if (tagsLow.some(t => t.includes(kw))) score += 5;
      if (contentLow.includes(kw)) score += 1;
    }

    return {
      ...a,
      content: a.content.slice(0, 500), // truncate
      score,
    };
  });

  return scored
    .filter(a => a.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score: _s, ...rest }) => rest);
}

// ── getWikiStatus ─────────────────────────────────────────

/**
 * 현재 위키 상태 조회.
 */
export async function getWikiStatus(labId: string): Promise<object> {
  const [articles, pendingCount, lastProcessed] = await Promise.all([
    prisma.wikiArticle.findMany({
      where: { labId },
      select: { category: true, updatedAt: true },
    }),
    prisma.wikiRawQueue.count({
      where: { labId, processedAt: null },
    }),
    prisma.wikiRawQueue.findFirst({
      where: { labId, processedAt: { not: null } },
      orderBy: { processedAt: 'desc' },
      select: { processedAt: true },
    }),
  ]);

  // 카테고리별 분포
  const categoryDist: Record<string, number> = {};
  for (const a of articles) {
    categoryDist[a.category] = (categoryDist[a.category] || 0) + 1;
  }

  return {
    totalArticles: articles.length,
    categoryDistribution: categoryDist,
    pendingQueueItems: pendingCount,
    lastIngestAt: lastProcessed?.processedAt ?? null,
  };
}
