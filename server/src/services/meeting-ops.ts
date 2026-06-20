export type MeetingDiscussion = {
  topic: string;
  bullets?: string[];
  content?: string;
};

export type MeetingTaskPriority = 'HIGH' | 'MEDIUM' | 'LOW';

export type MeetingTaskCandidate = {
  id: string;
  title: string;
  evidence: string;
  source: 'action_item' | 'next_step';
  sourceIndex: number;
  ownerName: string | null;
  dueDate: string | null;
  dueText: string | null;
  priority: MeetingTaskPriority;
  reviewReason: string[];
  status: 'queued_for_review';
};

export type MeetingOpsPacket = {
  version: 1;
  generatedAt: string;
  decisions: string[];
  openQuestions: string[];
  contextForAgents: string[];
  taskCandidates: MeetingTaskCandidate[];
  integrationEvents: Array<{
    target: 'tasks' | 'calendar' | 'knowledge' | 'google_docs';
    status: 'ready' | 'queued' | 'manual_review' | 'synced';
    label: string;
    count?: number;
  }>;
  readiness: {
    score: number;
    summary: string;
    missing: string[];
  };
};

export type BuildMeetingOpsPacketInput = {
  title: string;
  agenda?: string[];
  discussions?: MeetingDiscussion[];
  actionItems?: string[];
  nextSteps?: string[];
  summary?: string | null;
  createdAt?: Date | string;
  participants?: string[];
  team?: string;
  decisions?: string[];
  openQuestions?: string[];
};

function normalizeLine(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function uniqueNonEmpty(values: unknown[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = normalizeLine(value).replace(/^[-*]\s*/, '');
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function stableId(parts: string[]): string {
  const raw = parts.join('|');
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return `mt_${Math.abs(hash).toString(36)}`;
}

function toDateOnly(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function rollForwardIfPast(date: Date, baseDate: Date): Date {
  const rolled = new Date(date);
  if (rolled.getTime() < baseDate.getTime() - 30 * 86_400_000) {
    rolled.setFullYear(rolled.getFullYear() + 1);
  }
  return rolled;
}

function weekStartMonday(baseDate: Date): Date {
  const start = new Date(baseDate);
  const day = start.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diff);
  start.setHours(0, 0, 0, 0);
  return start;
}

const KOREAN_WEEKDAY_INDEX: Record<string, number> = {
  월: 0,
  화: 1,
  수: 2,
  목: 3,
  금: 4,
  토: 5,
  일: 6,
};

function coerceBaseDate(value?: Date | string): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

export function parseActionDueDate(text: string, baseDate: Date = new Date()): { dueDate: string | null; dueText: string | null } {
  const normalized = normalizeLine(text);

  const iso = normalized.match(/\b(20\d{2})[./-](\d{1,2})[./-](\d{1,2})\b/);
  if (iso) {
    const date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return { dueDate: toDateOnly(date), dueText: iso[0] };
  }

  const koreanDate = normalized.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (koreanDate) {
    const date = rollForwardIfPast(
      new Date(baseDate.getFullYear(), Number(koreanDate[1]) - 1, Number(koreanDate[2])),
      baseDate,
    );
    return { dueDate: toDateOnly(date), dueText: koreanDate[0] };
  }

  const slashDate = normalized.match(/\b(\d{1,2})[./](\d{1,2})\b/);
  if (slashDate) {
    const date = rollForwardIfPast(
      new Date(baseDate.getFullYear(), Number(slashDate[1]) - 1, Number(slashDate[2])),
      baseDate,
    );
    return { dueDate: toDateOnly(date), dueText: slashDate[0] };
  }

  const weekday = normalized.match(/(이번|다음)\s*주\s*([월화수목금토일])(?:요일)?(?:까지|중|안에)?/);
  if (weekday) {
    const start = weekStartMonday(baseDate);
    const date = new Date(start);
    date.setDate(start.getDate() + KOREAN_WEEKDAY_INDEX[weekday[2]] + (weekday[1] === '다음' ? 7 : 0));
    return { dueDate: toDateOnly(date), dueText: weekday[0] };
  }

  const relative: Array<[RegExp, number, string]> = [
    [/오늘까지|오늘 중|오늘 안에/, 0, '오늘'],
    [/내일까지|내일 중|내일 안에/, 1, '내일'],
    [/모레까지|모레 중|모레 안에/, 2, '모레'],
    [/다음\s*주까지|다음\s*주 중/, 7, '다음 주'],
  ];
  for (const [pattern, addDays, dueText] of relative) {
    if (!pattern.test(normalized)) continue;
    const date = new Date(baseDate);
    date.setDate(date.getDate() + addDays);
    return { dueDate: toDateOnly(date), dueText };
  }

  return { dueDate: null, dueText: null };
}

function extractOwner(text: string): { ownerName: string | null; title: string; inferred: boolean } {
  const normalized = normalizeLine(text);

  const explicit = normalized.match(/(?:담당|owner|assignee)\s*[:：]\s*([^,).]+)[,).]?\s*(.*)$/i);
  if (explicit) {
    const ownerName = explicit[1].trim();
    const title = normalizeLine(explicit[2]);
    return { ownerName, title: title || normalized, inferred: false };
  }

  const looseExplicit = normalized.match(/(?:담당자?|owner|assignee)\s+([가-힣]{2,4}|[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)[,).:：-]?\s*(.{4,})$/i);
  if (looseExplicit && !/지정|미정|필요/.test(looseExplicit[1])) {
    return { ownerName: looseExplicit[1].trim(), title: looseExplicit[2].trim(), inferred: false };
  }

  const prefix = normalized.match(/^([가-힣]{2,4}|[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\s*[:：-]\s*(.{4,})$/);
  if (prefix) {
    return { ownerName: prefix[1].trim(), title: prefix[2].trim(), inferred: true };
  }

  const koreanSubject = normalized.match(/^([가-힣]{2,4})(?:\s*(?:학생|박사|석사|연구원|님))?(?:이|가|은|는)\s+(.{4,})$/);
  if (koreanSubject) {
    return { ownerName: koreanSubject[1].trim(), title: koreanSubject[2].trim(), inferred: true };
  }

  return { ownerName: null, title: normalized, inferred: false };
}

function inferPriority(text: string, dueDate: string | null, baseDate: Date): MeetingTaskPriority {
  if (/긴급|급히|즉시|오늘|내일|이번\s*주|urgent|asap/i.test(text)) return 'HIGH';
  if (dueDate) {
    const due = new Date(`${dueDate}T00:00:00`);
    const diffDays = Math.ceil((due.getTime() - baseDate.getTime()) / 86_400_000);
    if (diffDays <= 3) return 'HIGH';
    if (diffDays > 21) return 'LOW';
  }
  if (/가능하면|나중에|아이디어|검토만|참고/i.test(text)) return 'LOW';
  return 'MEDIUM';
}

export function buildTaskCandidate(
  item: string,
  source: 'action_item' | 'next_step',
  sourceIndex: number,
  baseDate: Date = new Date(),
): MeetingTaskCandidate | null {
  const evidence = normalizeLine(item);
  if (!evidence) return null;

  const owner = extractOwner(evidence);
  const due = parseActionDueDate(evidence, baseDate);
  const reviewReason: string[] = [];
  if (!owner.ownerName) reviewReason.push('owner_missing');
  if (owner.inferred) reviewReason.push('owner_inferred');
  if (!due.dueDate) reviewReason.push('due_date_missing');

  return {
    id: stableId([source, String(sourceIndex), evidence]),
    title: owner.title,
    evidence,
    source,
    sourceIndex,
    ownerName: owner.ownerName,
    dueDate: due.dueDate,
    dueText: due.dueText,
    priority: inferPriority(evidence, due.dueDate, baseDate),
    reviewReason,
    status: 'queued_for_review',
  };
}

function discussionLines(discussions: MeetingDiscussion[] = []): string[] {
  return discussions.flatMap(d => [
    d.topic,
    ...(d.bullets ?? []),
    d.content ?? '',
  ]).map(normalizeLine).filter(Boolean);
}

function extractDecisions(input: BuildMeetingOpsPacketInput): string[] {
  const explicit = input.decisions ?? [];
  const lines = [
    ...explicit,
    ...discussionLines(input.discussions),
    ...(input.summary?.split('\n') ?? []),
  ];
  return uniqueNonEmpty(
    lines.filter(line => /결정|확정|승인|채택|진행하기로|하기로|go\/no-go|go-no-go/i.test(normalizeLine(line))),
    8,
  );
}

function extractOpenQuestions(input: BuildMeetingOpsPacketInput): string[] {
  const explicit = input.openQuestions ?? [];
  const lines = [
    ...explicit,
    ...discussionLines(input.discussions),
    ...(input.summary?.split('\n') ?? []),
  ];
  return uniqueNonEmpty(
    lines.filter(line => /확인 필요|미정|보류|리스크|이슈|질문|추가 논의|논의 필요|unclear|risk/i.test(normalizeLine(line))),
    8,
  );
}

function buildContextForAgents(input: BuildMeetingOpsPacketInput, decisions: string[]): string[] {
  const topicLines = discussionLines(input.discussions)
    .filter(line => line.length >= 8 && !/액션|할 일|담당/.test(line));
  return uniqueNonEmpty([
    input.team ? `팀: ${input.team}` : '',
    input.participants?.length ? `참석자: ${input.participants.join(', ')}` : '',
    ...(input.agenda ?? []).map(a => `안건: ${a}`),
    ...decisions.map(d => `결정: ${d}`),
    ...topicLines,
  ], 10);
}

function readinessSummary(score: number): string {
  if (score >= 90) return '회의 결과가 바로 운영 큐로 반영될 수 있습니다.';
  if (score >= 70) return '주요 후속 작업은 잡혔고, 일부 담당자/기한 확인만 필요합니다.';
  if (score >= 45) return '요약은 되었지만 운영 반영 전 검토가 필요합니다.';
  return '후속 실행 정보가 부족합니다. 담당자, 기한, 결정사항을 보강해야 합니다.';
}

export function buildMeetingOpsPacket(input: BuildMeetingOpsPacketInput): MeetingOpsPacket {
  const baseDate = coerceBaseDate(input.createdAt);
  const actionItems = input.actionItems ?? [];
  const nextSteps = input.nextSteps ?? [];
  const taskCandidates = [
    ...actionItems.map((item, idx) => buildTaskCandidate(item, 'action_item', idx, baseDate)),
    ...nextSteps.map((item, idx) => buildTaskCandidate(item, 'next_step', idx, baseDate)),
  ].filter((task): task is MeetingTaskCandidate => task !== null);

  const decisions = extractDecisions(input);
  const openQuestions = extractOpenQuestions(input);
  const contextForAgents = buildContextForAgents(input, decisions);

  const missing = new Set<string>();
  if (decisions.length === 0) missing.add('decision');
  if (taskCandidates.length === 0) missing.add('task');
  if (taskCandidates.some(t => !t.ownerName)) missing.add('owner');
  if (taskCandidates.some(t => !t.dueDate)) missing.add('due_date');

  const totalTasks = Math.max(taskCandidates.length, 1);
  const ownerCoverage = taskCandidates.filter(t => t.ownerName).length / totalTasks;
  const dueCoverage = taskCandidates.filter(t => t.dueDate).length / totalTasks;
  const score = Math.max(0, Math.min(100, Math.round(
    25
    + Math.min(decisions.length, 3) * 10
    + Math.min(taskCandidates.length, 5) * 5
    + ownerCoverage * 20
    + dueCoverage * 20,
  )));

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    decisions,
    openQuestions,
    contextForAgents,
    taskCandidates,
    integrationEvents: [
      {
        target: 'tasks',
        status: taskCandidates.length > 0 ? 'queued' : 'manual_review',
        label: taskCandidates.length > 0 ? 'Tasks 검토 큐 반영' : 'Tasks 후보 없음',
        count: taskCandidates.length,
      },
      {
        target: 'calendar',
        status: taskCandidates.some(t => t.dueDate) ? 'ready' : 'manual_review',
        label: taskCandidates.some(t => t.dueDate) ? '기한 기반 일정 후보 있음' : '일정 후보 검토 필요',
        count: taskCandidates.filter(t => t.dueDate).length,
      },
      {
        target: 'knowledge',
        status: contextForAgents.length > 0 ? 'queued' : 'manual_review',
        label: '에이전트 컨텍스트 적재',
        count: contextForAgents.length,
      },
    ],
    readiness: {
      score,
      summary: readinessSummary(score),
      missing: Array.from(missing),
    },
  };
}
