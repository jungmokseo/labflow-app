/**
 * Research Flow Web API 클라이언트
 *
 * Supabase Auth 토큰을 자동으로 첨부합니다.
 * Vercel rewrites가 /api/* → Railway로 프록시하므로 브라우저에서는 같은 origin 사용 (CORS 불필요)
 */

const API_BASE = typeof window !== 'undefined' ? '' : (typeof window !== 'undefined' ? '' : (process.env.NEXT_PUBLIC_API_URL || 'https://labflow-app-production.up.railway.app'));

// ── 토큰 getter (클라이언트 사이드용) ───────────────
let tokenGetter: (() => Promise<string | null>) | null = null;

export function setAuthTokenGetter(fn: () => Promise<string | null>) {
  tokenGetter = fn;
}

// ── Auth token cache — avoid repeated async lookups ──
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Use cached token if valid (refresh 60s before expiry)
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    headers['Authorization'] = `Bearer ${cachedToken}`;
    return headers;
  }

  // tokenGetter가 설정되어 있으면 사용
  if (tokenGetter) {
    const token = await tokenGetter();
    if (token) {
      cachedToken = token;
      tokenExpiresAt = Date.now() + 3600000; // 1 hour default
      headers['Authorization'] = `Bearer ${token}`;
      return headers;
    }
  }

  // fallback: Supabase 클라이언트에서 직접 토큰 가져오기
  if (typeof window !== 'undefined') {
    try {
      const { createClient } = await import('./supabase');
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) {
        cachedToken = session.access_token;
        // Use actual expiry if available
        tokenExpiresAt = session.expires_at ? session.expires_at * 1000 : Date.now() + 3600000;
        headers['Authorization'] = `Bearer ${session.access_token}`;
      }
    } catch { /* ignore */ }
  }

  return headers;
}

// Export for AuthInit to invalidate on auth state change
export function clearTokenCache() {
  cachedToken = null;
  tokenExpiresAt = 0;
}

// Offline queue replay가 사용할 최신 헤더 생성기 (Authorization 포함)
export function getAuthHeadersForReplay(): Promise<Record<string, string>> {
  return getAuthHeaders();
}

// Offline queue에 담지 않을 경로 (SSE 스트리밍, 파일 업로드 등)
const OFFLINE_QUEUE_BLOCKLIST = [
  '/api/brain/chat',      // SSE 스트리밍
  '/api/brain/upload',    // FormData
  '/api/meetings',        // FormData (POST /api/meetings — 파일 업로드 경로)
  '/api/papers/upload',   // FormData
  '/api/email/auth',      // OAuth 흐름
  '/api/wiki/ingest',     // 장기 작업
  '/api/wiki/synthesis',
  '/api/wiki/weekly-briefing',
  '/api/papers/alerts/run',
];

function shouldQueueOffline(path: string, method: string, body: unknown): boolean {
  if (method === 'GET') return false;
  if (typeof body !== 'string') return false; // FormData/Blob 큐잉 불가
  // POST /api/meetings는 파일 업로드이지만 PATCH/DELETE는 JSON — method도 함께 판단
  if (method === 'POST' && path === '/api/meetings') return false;
  return !OFFLINE_QUEUE_BLOCKLIST.some((p) => path.startsWith(p));
}

// Online 복귀 시 자동 flush (모듈 로드 시 1회 등록)
if (typeof window !== 'undefined') {
  const trigger = () => {
    import('./offline-queue').then((m) => {
      m.flushOfflineQueue(getAuthHeaders).catch(() => {});
    });
  };
  window.addEventListener('online', trigger);
  // 초기 로드 시에도 시도 (페이지 열 때 이미 online인 경우)
  if (navigator.onLine) setTimeout(trigger, 1500);
}

export async function apiFetch<T>(path: string, options: RequestInit = {}, retries = 2, timeoutMs = 30000): Promise<T> {
  const url = `${API_BASE}${path}`;
  const method = (options.method || 'GET').toUpperCase();

  // 오프라인 + 큐잉 가능 요청 → IndexedDB 큐에 저장하고 성공 응답 유사 객체 반환
  if (
    typeof window !== 'undefined' &&
    !navigator.onLine &&
    shouldQueueOffline(path, method, options.body)
  ) {
    const { enqueueOfflineRequest } = await import('./offline-queue');
    const body = typeof options.body === 'string' ? options.body : undefined;
    const entry = await enqueueOfflineRequest({
      method,
      url: path,
      body,
      contentType: 'application/json',
      label: `${method} ${path}`,
    });
    return {
      success: true,
      _queued: true,
      _queueId: entry.id,
      data: null,
      message: '오프라인 상태입니다. 온라인 복귀 시 자동 동기화됩니다.',
    } as unknown as T;
  }

  const authHeaders = await getAuthHeaders();
  const headers = { ...authHeaders, ...options.headers } as Record<string, string>;
  if (!options.body && headers['Content-Type'] === 'application/json') {
    delete headers['Content-Type'];
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        const details = err.details ? ` (${JSON.stringify(err.details).slice(0, 200)})` : '';
        throw new Error((err.error || `API Error: ${res.status}`) + details);
      }

      return res.json();
    } catch (err: any) {
      lastError = err;
      // Don't retry POST/PATCH/DELETE (non-idempotent) or 4xx client errors
      const method = (options.method || 'GET').toUpperCase();
      const isClientError = err.message?.includes('API Error: 4');
      if (method !== 'GET' || isClientError || attempt === retries) break;
      // Exponential backoff: 1s, 3s
      await new Promise(r => setTimeout(r, (attempt + 1) * 1500));
    }
  }

  throw lastError || new Error('Request failed');
}

// ── 캡처 ──────────────────────────────────────────
export interface Capture {
  id: string;
  content: string;
  summary: string;
  category: string;
  tags: string[];
  priority: string;
  confidence: number | null;
  actionDate: string | null;
  completed: boolean;
  completedAt: string | null;
  status: string;
  reviewed: boolean;
  sourceType: string;
  modelUsed: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function getCaptures(params?: {
  category?: string;
  completed?: string;
  sort?: string;
  search?: string;
  page?: number;
  limit?: number;
}) {
  const qs = new URLSearchParams();
  if (params?.category) qs.set('category', params.category);
  if (params?.completed) qs.set('completed', params.completed);
  qs.set('sort', params?.sort || 'newest');
  if (params?.search) qs.set('search', params.search);
  if (params?.page) qs.set('page', String(params.page));
  qs.set('limit', String(params?.limit || 50));
  return apiFetch<{ success: boolean; data: Capture[]; meta: any }>(`/api/captures?${qs.toString()}`);
}

export async function createCapture(content: string, category?: string) {
  return apiFetch<{ success: boolean; data: Capture }>('/api/captures', {
    method: 'POST',
    body: JSON.stringify({ content, category }),
  });
}

export async function updateCapture(id: string, data: Partial<Pick<Capture, 'content' | 'summary' | 'completed' | 'category' | 'tags' | 'priority' | 'actionDate' | 'reviewed'>>) {
  return apiFetch<{ success: boolean; data: Capture }>(`/api/captures/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteCapture(id: string) {
  return apiFetch<{ success: boolean }>(`/api/captures/${id}`, { method: 'DELETE' });
}

export async function classifyCapture(id: string) {
  return apiFetch<{ success: boolean; data: Capture }>('/api/captures/classify', {
    method: 'POST',
    body: JSON.stringify({ captureId: id }),
  });
}

export async function deleteCompletedCaptures() {
  return apiFetch<{ success: boolean; deletedCount: number }>('/api/captures/completed', { method: 'DELETE' });
}

// ── BLISS 검토 대기 큐 ─────────────────────────────
export type BlissTaskPriority = 'HIGH' | 'MEDIUM' | 'LOW';

export interface BlissTaskSource {
  sourceChannel?: string;
  slackPermalink?: string;
  slackUserId?: string;
  requesterName?: string;
}

export interface BlissTaskDirect {
  assignedOwner?: string;
  notifiedAt?: string;
}

export interface BlissTaskMetadata {
  blissSource?: BlissTaskSource;
  blissDirect?: BlissTaskDirect;
  heldAt?: string;
  notifiedAt?: string;
  assignedOwner?: string;
  [key: string]: unknown;
}

export interface BlissTaskReviewItem {
  id: string;
  title: string;
  content: string;
  metadata: BlissTaskMetadata | null;
  createdAt: string;
}

export async function getBlissTaskReviewQueue() {
  return apiFetch<BlissTaskReviewItem[]>('/api/bliss-tasks/review-queue');
}

export async function confirmBlissTask(
  id: string,
  data: {
    actionDate: string;
    ownerName: string;
    priority?: BlissTaskPriority;
    memo?: string;
  },
) {
  return apiFetch<{ success: boolean; notified: boolean; error?: string }>(`/api/bliss-tasks/${id}/confirm`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function holdBlissTask(id: string) {
  return apiFetch<{ success: boolean }>(`/api/bliss-tasks/${id}/hold`, { method: 'PATCH' });
}

export async function archiveBlissTask(id: string) {
  return apiFetch<{ success: boolean }>(`/api/bliss-tasks/${id}/archive`, { method: 'PATCH' });
}

// 직접 추가 (검토 단계 건너뛰고 즉시 학생 알림)
export async function createBlissTaskDirect(data: {
  title: string;
  content?: string;
  actionDate: string;
  ownerName: string;
  priority?: BlissTaskPriority;
  memo?: string;
}) {
  return apiFetch<{ success: boolean; captureId: string; notified: boolean; error?: string }>(
    '/api/bliss-tasks/direct-create',
    { method: 'POST', body: JSON.stringify(data) },
  );
}

// 진행 중 task 목록
export interface BlissTaskActiveItem {
  id: string;
  title: string;
  content: string;
  metadata: BlissTaskMetadata | null;
  actionDate: string | null;
  priority: BlissTaskPriority;
  completed: boolean;
  completedAt: string | null;
  createdAt: string;
}

export async function getBlissActiveTasks() {
  return apiFetch<BlissTaskActiveItem[]>('/api/bliss-tasks/active');
}

export async function completeBlissTask(id: string, done = true) {
  return apiFetch<{ success: boolean; completed: boolean }>(`/api/bliss-tasks/${id}/complete`, {
    method: 'PATCH',
    body: JSON.stringify({ done }),
  });
}

// ── BLISS-bot 미답변 질문 (Follow-up) ──────────────────
export interface FollowUpItem {
  id: string;
  question: string;
  askedBy: string;
  reason: string | null;
  channelId: string | null;
  slackUserId: string | null;
  slackChannelId: string | null;
  answer: string | null;
  category: string | null;
  faqId: string | null;
  resolvedVia: string | null;
  resolvedBy: string | null;
  exportedAt: string | null;
  answeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FollowUpListResponse {
  items: FollowUpItem[];
  nextCursor: string | null;
  counts: { pending: number; answered: number };
}

export async function getFollowUpList(params: { status?: 'pending' | 'answered' | 'all'; limit?: number; cursor?: string } = {}) {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.cursor) qs.set('cursor', params.cursor);
  const path = `/api/follow-up${qs.toString() ? `?${qs}` : ''}`;
  return apiFetch<FollowUpListResponse>(path);
}

export async function answerFollowUp(
  id: string,
  data: { answer: string; category?: string; addToFaq?: boolean; notifyStudent?: boolean },
) {
  return apiFetch<{
    success: boolean;
    item: FollowUpItem;
    faqAdded: boolean;
    faqId: string | null;
    notify: { ok: boolean; reason?: string } | null;
  }>(`/api/follow-up/${id}/answer`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function skipFollowUp(id: string, reason?: string) {
  return apiFetch<{ success: boolean; item: FollowUpItem }>(`/api/follow-up/${id}/skip`, {
    method: 'PATCH',
    body: JSON.stringify({ reason }),
  });
}

export async function deleteFollowUp(id: string) {
  return apiFetch<{ success: boolean }>(`/api/follow-up/${id}`, { method: 'DELETE' });
}

// ── 휴가 (read-only, labflow-member proxy) ──────────────
export interface VacationRecentItem {
  id: string;
  memberId: string;
  memberName: string;
  memberEmail: string | null;
  type: 'ANNUAL' | 'SICK' | 'SPECIAL' | 'OFFICIAL';
  startDate: string;
  endDate: string;
  days: number;
  reason: string | null;
  status: 'APPROVED' | 'CANCELLED';
  createdAt: string;
}

export interface VacationBalanceItem {
  memberId: string;
  name: string;
  email: string | null;
  role: 'PI' | 'STUDENT' | 'ADMIN';
  totalDays: number;
  usedDays: number;
  remainingDays: number;
}

export async function getRecentVacations(limit = 50) {
  return apiFetch<{ items: VacationRecentItem[] }>(`/api/lab-data/vacations/recent?limit=${limit}`);
}

export async function getVacationBalances() {
  return apiFetch<{ year: number; items: VacationBalanceItem[] }>(`/api/lab-data/vacations/balance`);
}

// 참고: Lab 계정 정보는 Slack BLISS-bot의 search_faq로 이전됨 (학생들이 같이 검색).
// server의 /api/lab-data/lab-accounts 엔드포인트와 데이터(labflow-member)는 보존.

// ── 이메일 브리핑 ──────────────────────────────────
export interface EmailBriefingItem {
  sender: string;
  senderName: string;
  subject: string;
  snippet?: string;
  summary: string;
  body?: string;
  category: string;
  categoryEmoji: string;
  date: string;
  dateLocal?: string;
  dateSender?: string;
  dateSenderLabel?: string;
  messageId?: string;
  threadId?: string;
  group?: string;
  groupEmoji?: string;
  matchedTimezone?: string;
}

export interface EmailProfile {
  displayName: string;
  accounts: { email: string; label: string }[];
  briefingTime: string;
  briefingDays: string[];
}

export async function getEmailStatus() {
  return apiFetch<{ success: boolean; connected: boolean; tokenValid?: boolean; needsReauth?: boolean; tokenError?: string; hasProfile?: boolean; message?: string; calendarConnected?: boolean; calendarError?: string | null; calendarMessage?: string | null }>('/api/email/status');
}

export async function getEmailAuthUrl() {
  const res = await apiFetch<{ success: boolean; authUrl: string }>('/api/email/auth/url');
  return { ...res, url: res.authUrl };
}

export async function getEmailBriefing(maxResults = 15) {
  return apiFetch<{ success: boolean; data: EmailBriefingItem[]; meta: any }>(`/api/email/briefing?maxResults=${maxResults}`);
}

export async function getEmailProfile() {
  return apiFetch<{ success: boolean; data: EmailProfile }>('/api/email/profile');
}

export async function updateEmailProfile(data: Partial<EmailProfile>) {
  return apiFetch<{ success: boolean; data: EmailProfile }>('/api/email/profile', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export interface EmailBriefingHistoryEntry {
  id: string;
  date: string;
  time: string;
  title: string;
  briefings: EmailBriefingItem[];
  meta: { total: number; categories: Record<string, number>; groups: Record<string, number> };
}

export async function getEmailBriefingHistory(days = 30, limit = 20) {
  return apiFetch<{ success: boolean; data: EmailBriefingHistoryEntry[]; count: number }>(
    `/api/email/briefing/history?days=${days}&limit=${limit}`
  );
}

export async function getNarrativeBriefing(maxResults = 30) {
  return apiFetch<{ success: boolean; markdown: string; emailCount: number; generatedAt: string }>(
    `/api/email/narrative-briefing?maxResults=${maxResults}&includeBody=true`
  );
}

export async function initEmailProfile() {
  return apiFetch<{ success: boolean; initialized: boolean; data?: any }>('/api/email/profile/init', {
    method: 'POST',
  });
}

// ── 회의 ──────────────────────────────────────────
export interface Meeting {
  id: string;
  title: string;
  summary: string | null;
  transcription: string | null;
  discussions: string | null;
  agenda: string[];
  actionItems: string[];
  nextSteps: string[];
  createdAt: string;
}

export async function getMeetings(limit = 10) {
  return apiFetch<{ success: boolean; data: Meeting[]; meta: any }>(`/api/meetings?limit=${limit}`);
}

export async function createMeeting(data: { title: string; agenda?: string[] }) {
  return apiFetch<{ success: boolean; data: Meeting }>('/api/meetings', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateMeeting(id: string, data: Partial<Pick<Meeting, 'title' | 'summary' | 'transcription'>> & { agenda?: string[]; discussions?: string; actionItems?: string[]; nextSteps?: string[]; corrections?: Array<{ wrong: string; correct: string }> }) {
  return apiFetch<{ success: boolean; data: Meeting }>(`/api/meetings/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteMeeting(id: string) {
  return apiFetch<{ success: boolean }>(`/api/meetings/${id}`, { method: 'DELETE' });
}

export async function exportMeetingToGDocs(id: string) {
  return apiFetch<{ success: boolean; docUrl?: string; docId?: string; error?: string }>(`/api/meetings/${id}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export async function uploadMeetingAudio(
  audio: File,
  opts?: { title?: string; duration?: number }
): Promise<{ success: boolean; data: Meeting }> {
  // 파일 업로드는 Vercel 프록시 우회 — Railway 직접 전송 (Vercel body size 4.5MB 제한 회피)
  const DIRECT_API = process.env.NEXT_PUBLIC_API_URL || 'https://labflow-app-production.up.railway.app';
  const formData = new FormData();
  formData.append('audio', audio);
  if (opts?.title) formData.append('title', opts.title);
  if (opts?.duration != null) formData.append('duration', String(opts.duration));

  const headers: Record<string, string> = {};
  if (tokenGetter) {
    const token = await tokenGetter();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${DIRECT_API}/api/meetings`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Upload failed' }));
    throw new Error(err.error || `Upload Error: ${res.status}`);
  }

  return res.json();
}

// ── 지식 그래프 ──────────────────────────────────────
export interface GraphNode {
  id: string;
  name: string;
  entityType: string;
  entityId: string | null;
  metadata: any;
  edgeCount: number;
  updatedAt: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  relation: string;
  weight: number;
  source: string;
  evidence: string | null;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: { totalNodes: number; returnedNodes: number; totalEdges: number };
}

export async function getKnowledgeGraph(opts?: { entityType?: string; limit?: number }) {
  const params = new URLSearchParams();
  if (opts?.entityType) params.set('entityType', opts.entityType);
  if (opts?.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return apiFetch<{ success: boolean; data: GraphData }>(`/api/graph${qs ? `?${qs}` : ''}`);
}

export async function getGraphNodeConnections(nodeId: string) {
  return apiFetch<{ success: boolean; data: any }>(`/api/graph/node/${nodeId}`);
}

export async function getGraphConnectionsByType(entityType: string) {
  return apiFetch<{ success: boolean; data: any[] }>(`/api/graph/connections/${entityType}`);
}

export async function getGraphInsights() {
  return apiFetch<{ success: boolean; data: any }>('/api/graph/insights');
}

export async function seedKnowledgeGraph() {
  return apiFetch<{ success: boolean; data: { nodesCreated: number; edgesCreated: number }; message: string }>('/api/graph/seed', { method: 'POST' });
}

// ── 미니브레인 (Brain Chat) ─────────────────────────
export async function brainChat(message: string, channelId?: string, fileId?: string, newSession?: boolean) {
  return apiFetch<{ response: string; channelId: string; intent: string; metadata?: any }>('/api/brain/chat', {
    method: 'POST',
    body: JSON.stringify({ message, channelId, fileId, newSession }),
  });
}

export type BrainChatResult = { response: string; channelId: string; intent: string; isNewSession?: boolean; autoCaptured?: any };

/**
 * SSE 스트리밍 Brain Chat — 실시간 진행 표시 지원
 * onProgress 콜백으로 각 처리 단계를 전달받고, 최종 결과를 Promise로 반환
 */
export interface PendingAction {
  type: 'send_draft' | 'send_email';
  draftId: string;
  to: string;
  subject: string;
  preview: string;
}

export async function brainChatStream(
  message: string,
  onProgress: (step: string) => void,
  onToken?: (token: string) => void,
  channelId?: string,
  fileId?: string,
  newSession?: boolean,
  fileIds?: string[],
  onAction?: (action: PendingAction) => void,
  externalSignal?: AbortSignal,
): Promise<BrainChatResult> {
  const API_BASE_URL = typeof window !== 'undefined' ? '' : (typeof window !== 'undefined' ? '' : (process.env.NEXT_PUBLIC_API_URL || 'https://labflow-app-production.up.railway.app'));
  const body = JSON.stringify({ message, channelId, fileId, fileIds, newSession, stream: true });

  // Retry with progressive backoff (handles Railway cold start)
  let res: Response | null = null;
  let lastError: Error | null = null;
  const RETRY_DELAYS = [0, 2500, 5000]; // 3 attempts: immediate, 2.5s, 5s

  for (let attempt = 0; attempt < 3; attempt++) {
    // 외부에서 abort된 경우 즉시 중단
    if (externalSignal?.aborted) throw new Error('AbortError: 사용자가 중단했습니다.');

    // On retry: wake up server with lightweight ping, then wait
    if (attempt > 0) {
      clearTokenCache();
      // Wake-up ping (fire-and-forget, don't wait for response)
      fetch(`${API_BASE_URL}/health`, { method: 'GET' }).catch(() => {});
      await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
      onProgress(`서버에 다시 연결하고 있습니다... (${attempt}/2)`);
    }
    const authHeaders = await getAuthHeaders();

    if (!authHeaders['Authorization']) {
      throw new Error('인증 토큰을 가져올 수 없습니다. 페이지를 새로고침해주세요.');
    }

    // 타임아웃 + 외부 abort signal 합성
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), 120000); // 120s timeout
    const combinedSignal = externalSignal
      ? AbortSignal.any([timeoutController.signal, externalSignal])
      : timeoutController.signal;

    try {
      res = await fetch(`${API_BASE_URL}/api/brain/chat?_t=${Date.now()}`, {
        method: 'POST',
        headers: { ...authHeaders },
        body,
        signal: combinedSignal,
        cache: 'no-store',
      });
      clearTimeout(timeoutId);
      break; // success — exit retry loop
    } catch (fetchErr: any) {
      clearTimeout(timeoutId);
      if (fetchErr.name === 'AbortError') {
        if (externalSignal?.aborted) throw new Error('사용자가 생성을 중단했습니다.');
        throw new Error('응답 시간이 초과되었습니다. 다시 시도해주세요.');
      }
      lastError = fetchErr;
      console.error(`[brainChatStream] attempt ${attempt + 1} failed:`, fetchErr.name, fetchErr.message);
      if (attempt === 2) {
        throw new Error(`서버 연결 실패: ${fetchErr.message}`);
      }
      // attempt failed — retry
    }
  }

  if (!res) {
    throw new Error(`서버 연결 실패: ${lastError?.message || 'Unknown'}`);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || `API Error: ${res.status}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('ReadableStream not supported');

  // 외부 abort signal과 reader 연결 — signal.abort() → reader.cancel()
  // (fetch signal만으로는 stream reader가 즉시 중단되지 않는 브라우저가 있음)
  const onAbort = () => { reader.cancel().catch(() => {}); };
  externalSignal?.addEventListener('abort', onAbort, { once: true });

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      // 루프 진입 전 abort 체크 — reader.read()가 resolve되기 전에 즉시 빠져나감
      if (externalSignal?.aborted) {
        await reader.cancel().catch(() => {});
        throw new Error('사용자가 생성을 중단했습니다.');
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';   // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === 'progress') {
            onProgress(event.step);
          } else if (event.type === 'token') {
            onToken?.(event.content);
          } else if (event.type === 'action') {
            onAction?.(event.action);
          } else if (event.type === 'done') {
            return event as BrainChatResult;
          } else if (event.type === 'error') {
            throw new Error(event.error || '처리 중 오류가 발생했습니다');
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;   // partial JSON, skip
          throw e;
        }
      }
    }
  } finally {
    externalSignal?.removeEventListener('abort', onAbort);
  }

  throw new Error('스트림이 예기치 않게 종료되었습니다');
}

export interface UploadResult {
  success: boolean;
  fileId: string;
  type: string;
  filename: string;
  suggestedAction: string;
  message: string;
  preview: string;
  structured?: any;
  metadata?: any;
}

export async function brainUpload(file: File): Promise<UploadResult> {
  // 파일 업로드는 Vercel 프록시 우회 — Railway 직접 전송 (Vercel body size 4.5MB 제한 회피)
  const DIRECT_API = process.env.NEXT_PUBLIC_API_URL || 'https://labflow-app-production.up.railway.app';
  const formData = new FormData();
  formData.append('file', file);

  const headers: Record<string, string> = {};
  if (tokenGetter) {
    const token = await tokenGetter();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${DIRECT_API}/api/brain/upload`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Upload failed' }));
    throw new Error(err.error || `Upload Error: ${res.status}`);
  }

  return res.json();
}

export async function getBrainChannels() {
  return apiFetch<{ data: Array<{ id: string; name: string; type: string; createdAt: string }> }>('/api/brain/channels');
}

export async function createBrainChannel(type = 'BRAIN', name?: string) {
  return apiFetch<{ data: { id: string } }>('/api/brain/channels', {
    method: 'POST',
    body: JSON.stringify({ type, name }),
  });
}

export async function getBrainMessages(channelId: string) {
  return apiFetch<{ data: BrainMessage[] }>(`/api/brain/channels/${channelId}`);
}

/**
 * Polling 복구 — 모바일 화면 sleep 등으로 SSE 끊김 시 사용.
 * 마지막 user 메시지 이후의 새 assistant 메시지가 나타날 때까지 polling.
 *
 * @param channelId 대상 채널
 * @param afterIso  이 시각보다 이후에 생성된 assistant 메시지를 찾음
 * @param onAttempt 폴링 시도마다 호출 (UI 표시용)
 * @param maxMs     최대 대기 시간 (기본 5분)
 */
export async function pollForAssistantMessage(
  channelId: string,
  afterIso: string,
  onAttempt?: (attempt: number) => void,
  maxMs = 5 * 60 * 1000,
): Promise<BrainMessage | null> {
  const startedAt = Date.now();
  const afterTime = new Date(afterIso).getTime();
  let attempt = 0;

  while (Date.now() - startedAt < maxMs) {
    attempt++;
    onAttempt?.(attempt);
    try {
      const res = await getBrainMessages(channelId);
      const messages = (res as any).data || res || [];
      if (Array.isArray(messages)) {
        // 가장 최신의 assistant 메시지 찾기 (afterTime 이후)
        const found = messages
          .filter((m: BrainMessage) => m.role === 'assistant' && new Date(m.createdAt).getTime() > afterTime)
          .sort((a: BrainMessage, b: BrainMessage) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
        if (found) return found;
      }
    } catch {
      /* ignore — retry */
    }
    // Progressive backoff: 2s, 3s, 4s, 5s, 5s, 5s...
    const delay = Math.min(2000 + attempt * 1000, 5000);
    await new Promise(r => setTimeout(r, delay));
  }
  return null;
}

// Alias for backward compat
export const getChannelMessages = getBrainMessages;

export async function deleteBrainChannel(channelId: string) {
  return apiFetch<{ success: boolean }>(`/api/brain/channels/${channelId}`, { method: 'DELETE' });
}

// ── Brain 타입 ──────────────────────────────────
export interface BrainChannel {
  id: string;
  name: string;
  type: string;
  createdAt: string;
}

export interface BrainMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
}

export async function searchBrainMemory(query: string, type = 'all') {
  return apiFetch<{ data: unknown[] }>(`/api/brain/search?query=${encodeURIComponent(query)}&type=${type}`);
}

// ── 브리핑 ──────────────────────────────────────
export async function getBriefing() {
  return apiFetch<{ date: string; urgent: unknown[]; important: unknown[]; info: unknown[]; stats: { totalEmails: number; newPapers: number; pendingCaptures: number; upcomingMeetings: number } }>('/api/briefing');
}

// ── Lab Profile ─────────────────────────────────
export interface LabProfile {
  id: string;
  name: string;
  institution?: string;
  department?: string;
  piName?: string;
  piEmail?: string;
  researchFields: string[];
  researchThemes?: Array<{ name: string; keywords: string[]; journals?: string[] }>;
  homepageUrl?: string;
  onboardingDone: boolean;
  members?: Array<{ id: string; name: string; email?: string; role: string; permission?: string; team?: string }>;
  projects?: Array<{ id: string; name: string; funder?: string; pi?: string; pm?: string; status?: string }>;
  domainDict?: Array<{ id: string; wrongForm: string; correctForm: string; category?: string }>;
}

export async function getLabProfile() {
  return apiFetch<LabProfile>('/api/lab');
}

export async function createLab(data: {
  name: string;
  institution?: string;
  department?: string;
  piName?: string;
  piEmail?: string;
  researchFields?: string[];
  homepageUrl?: string;
}) {
  return apiFetch<LabProfile>('/api/lab', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateLab(data: Partial<LabProfile & {
  acknowledgment?: string;
  responseStyle?: string;
}>) {
  return apiFetch<LabProfile>('/api/lab', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

// ── AI 지침 설정 관리 ──────────────────────────────────────────────────

export interface SettingsSummary {
  brain: {
    responseStyle: string;
    instructions: string[];
  };
  email: {
    briefingInstructions: string[];
    importanceRules: Array<{ condition: string; action: string; description?: string }>;
    keywords: string[];
  };
}

export async function getSettingsSummary() {
  return apiFetch<SettingsSummary>('/api/brain/settings-summary');
}

export async function deleteBrainInstruction(index: number) {
  return apiFetch<{ instructions: string[] }>(`/api/brain/settings/brain-instruction/${index}`, { method: 'DELETE' });
}

export async function deleteBriefingInstruction(index: number) {
  return apiFetch<{ instructions: string[] }>(`/api/brain/settings/briefing-instruction/${index}`, { method: 'DELETE' });
}

export async function deleteImportanceRule(index: number) {
  return apiFetch<{ importanceRules: any[] }>(`/api/brain/settings/importance-rule/${index}`, { method: 'DELETE' });
}

export async function deleteKeyword(keyword: string) {
  return apiFetch<{ keywords: string[] }>(`/api/brain/settings/keyword/${encodeURIComponent(keyword)}`, { method: 'DELETE' });
}

export async function getLabCompleteness() {
  return apiFetch<{ completeness: number; missing: string[]; suggestions: string[] }>('/api/lab/completeness');
}

export interface LabMemberOption {
  id: string;
  name: string;
  role: string;
  email?: string | null;
  phone?: string | null;
  team?: string | null;
}

export async function getLabMembers() {
  return apiFetch<LabMemberOption[]>('/api/lab/members');
}

export async function addLabMember(data: { name: string; nameEn?: string; email?: string; role?: string; phone?: string }) {
  return apiFetch<{ id: string }>('/api/lab/members', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function removeLabMember(id: string) {
  return apiFetch<{ success: boolean }>(`/api/lab/members/${id}`, { method: 'DELETE' });
}

export async function getLabProjects() {
  return apiFetch<Array<{ id: string; name: string; funder: string; pm: string; status: string }>>('/api/lab/projects');
}

export async function getLabDictionary() {
  return apiFetch<Array<{ id: string; wrongForm: string; correctForm: string; category: string }>>('/api/lab/dictionary');
}

export async function addDictEntry(data: { wrongForm: string; correctForm: string; category?: string }) {
  return apiFetch<{ id: string }>('/api/lab/dictionary', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ── 논문 알림 ──────────────────────────────────────
export interface PaperAlertSetting {
  id: string;
  keywords: string[];
  journals: string[];
  schedule: string;
  active: boolean;
  lastRunAt: string | null;
}

export interface PaperAlertResult {
  id: string;
  title: string;
  journal: string;
  authors: string[];
  abstract: string;
  doi: string | null;
  url?: string;
  relevance: number;
  read: boolean;
  theme: string | null;
  aiSummary?: string;
  aiReason?: string;
  matchedKeywords?: string[];
  publishedAt: string | null;
  createdAt: string;
}

export async function getPaperAlerts() {
  return apiFetch<{
    success: boolean; data: PaperAlertSetting[];
    alerts?: PaperAlertSetting[]; availableJournals?: string[];
    journalCategories?: Record<string, string[]>;
    researchThemes?: Array<{ name: string; keywords: string[] }>;
  }>('/api/papers/alerts');
}

export async function getJournalFields() {
  return apiFetch<{
    fields: string[];
    journalsByField: Record<string, Array<{ name: string; publisher: string; hasRss: boolean }>>;
    totalJournals: number;
  }>('/api/papers/journals/fields');
}

export async function searchJournals(query: string) {
  return apiFetch<{
    results: Array<{ name: string; publisher: string | null; rssUrl: string | null; source: string; citedByCount: number }>;
  }>('/api/papers/journals/search', {
    method: 'POST',
    body: JSON.stringify({ query }),
  });
}

export async function addCustomJournal(data: { name: string; rssUrl: string; publisher?: string }) {
  return apiFetch<{ success: boolean; sampleCount: number }>('/api/papers/journals/add', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function validateRssUrl(rssUrl: string) {
  return apiFetch<{ valid: boolean; itemCount: number; sampleTitle: string | null }>('/api/papers/journals/validate', {
    method: 'POST',
    body: JSON.stringify({ rssUrl }),
  });
}

export async function savePaperAlert(data: { keywords: string[]; journals: string[]; schedule?: string }) {
  return apiFetch<{ success: boolean; data: PaperAlertSetting }>('/api/papers/alerts', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function runPaperCrawl(alertId?: string) {
  const path = alertId ? `/api/papers/alerts/${alertId}/run` : '/api/papers/alerts/run';
  return apiFetch<{ success: boolean; data: PaperAlertResult[]; count: number }>(path, {
    method: 'POST',
  });
}

export async function getPaperAlertResults(alertId?: string) {
  const path = alertId ? `/api/papers/alerts/${alertId}/results` : '/api/papers/alerts/results';
  return apiFetch<{ success: boolean; data: PaperAlertResult[]; results?: PaperAlertResult[]; unreadCount?: number }>(path);
}

export async function resetPaperAlertResults() {
  return apiFetch<{ success: boolean; deleted: number; message: string }>('/api/papers/alerts/results', { method: 'DELETE' });
}

export async function markPaperRead(resultId: string) {
  return apiFetch<{ success: boolean }>(`/api/papers/alerts/results/${resultId}`, { method: 'PATCH' });
}

export async function uploadPaperPdf(file: File): Promise<{ success: boolean; message: string; paperId?: string; title?: string; status?: string }> {
  // 파일 업로드는 Vercel 프록시 우회 — Railway 직접 전송 (Vercel body size 4.5MB 제한 회피)
  const DIRECT_API = process.env.NEXT_PUBLIC_API_URL || 'https://labflow-app-production.up.railway.app';
  const formData = new FormData();
  formData.append('file', file);

  const headers: Record<string, string> = {};
  if (tokenGetter) {
    const token = await tokenGetter();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${DIRECT_API}/api/papers/upload`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Upload failed' }));
    throw new Error(err.error || `Upload Error: ${res.status}`);
  }

  return res.json();
}

// ── Lab Profile 추가 기능 ──────────────────────────
export type Lab = LabProfile;

export async function addLabProject(data: { name: string; funder?: string; pi?: string; pm?: string }) {
  return apiFetch<{ id: string }>('/api/lab/projects', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function analyzeSeedPapers(data: string[] | { dois?: string[]; titles?: string[] }) {
  const body = Array.isArray(data) ? { dois: data } : data;
  return apiFetch<{ success: boolean; results: any[] }>('/api/lab/seed-paper', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function applySeedPaperResults(data: { keywords?: string[]; terms?: any[]; papers?: any[]; rssKeywords?: string[]; rssJournals?: string[]; setupAlerts?: boolean; setupPaperAlert?: boolean }) {
  return apiFetch<{ success: boolean }>('/api/lab/seed-paper/apply', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ── 캘린더 ──────────────────────────────────────
export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  allDay: boolean;
  htmlLink?: string;
}

export interface PendingEvent {
  id: string;
  title: string;
  date: string;
  time?: string;
  location?: string;
  description?: string;
  source: string;
  confidence: number;
  createdAt: string;
}

export async function getCalendarToday() {
  return apiFetch<{ success: boolean; events: CalendarEvent[]; count: number }>('/api/calendar/today');
}

export async function getCalendarWeek() {
  return apiFetch<{ success: boolean; events: CalendarEvent[]; count: number }>('/api/calendar/week');
}

export async function getPendingEvents() {
  return apiFetch<{ success: boolean; pending: PendingEvent[]; count: number }>('/api/calendar/pending');
}

export async function approvePendingEvent(id: string) {
  return apiFetch<{ success: boolean; eventId: string; htmlLink: string; message: string }>(`/api/calendar/pending/${id}/approve`, { method: 'POST' });
}

export async function dismissPendingEvent(id: string) {
  return apiFetch<{ success: boolean }>(`/api/calendar/pending/${id}/dismiss`, { method: 'POST' });
}

export async function createCalendarEventApi(data: { title: string; date: string; time?: string; location?: string; description?: string }) {
  return apiFetch<{ success: boolean; eventId: string; htmlLink: string }>('/api/calendar/create', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ── AI 비용 요약 ──────────────────────────────────────
export interface CostSummary {
  totalCost: number;
  totalCalls: number;
  todayCost: number;
  todayCalls: number;
  days: number;
  byService: Record<string, { calls: number; cost: number }>;
  byDay: Record<string, { calls: number; cost: number }>;
  byIntent: Record<string, { calls: number; cost: number }>;
}

export async function getCostSummary(days = 30): Promise<CostSummary> {
  return apiFetch<CostSummary>(`/api/brain/cost-summary?days=${days}`);
}

export async function costCorrection() {
  return apiFetch<{ success: boolean; message: string; totalCorrected: number; corrections: any[] }>('/api/brain/cost-correction', { method: 'POST' });
}

// ── 헬스 체크 ──────────────────────────────────────
export async function checkHealth() {
  try {
    const res = await apiFetch<{ status: string }>('/health');
    return res.status === 'healthy';
  } catch {
    return false;
  }
}

// ── 에러 로그 ──────────────────────────────────────
export interface ErrorLogEntry {
  id: string;
  category: string;
  severity: string;
  message: string;
  context: Record<string, unknown> | null;
  resolved: boolean;
  resolvedAt: string | null;
  createdAt: string;
}

export interface ErrorSummary {
  category: string;
  severity: string;
  count: number;
}

export async function getErrorLogs(params?: { category?: string; resolved?: boolean; limit?: number; offset?: number }) {
  const q = new URLSearchParams();
  if (params?.category) q.set('category', params.category);
  if (params?.resolved !== undefined) q.set('resolved', String(params.resolved));
  if (params?.limit) q.set('limit', String(params.limit));
  if (params?.offset) q.set('offset', String(params.offset));
  return apiFetch<{ errors: ErrorLogEntry[]; total: number }>(`/api/errors?${q}`);
}

export async function getErrorSummary() {
  return apiFetch<{ summary: ErrorSummary[]; totalUnresolved: number }>('/api/errors/summary');
}

export async function resolveError(id: string) {
  return apiFetch<{ success: boolean }>(`/api/errors/${id}/resolve`, { method: 'PATCH' });
}

export async function resolveAllErrors(category?: string) {
  return apiFetch<{ success: boolean; resolvedCount: number }>('/api/errors/resolve-all', {
    method: 'PATCH',
    body: JSON.stringify(category ? { category } : {}),
  });
}

export async function cleanupOldErrors() {
  return apiFetch<{ success: boolean; deletedCount: number }>('/api/errors/cleanup', { method: 'DELETE' });
}

// ── Wiki ──────────────────────────────────────────────────
export interface WikiArticle {
  id: string;
  title: string;
  category: string;
  content: string;
  tags: string[];
  sources: Array<{ type: string; id: string; date?: string }>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface WikiStatus {
  totalArticles: number;
  categoryDistribution: Record<string, number>;
  pendingQueueItems: number;
  lastIngestAt: string | null;
}

export async function getWikiArticles(params?: { category?: string; limit?: number }) {
  const q = new URLSearchParams();
  if (params?.category) q.set('category', params.category);
  if (params?.limit) q.set('limit', String(params.limit));
  return apiFetch<{ articles: WikiArticle[]; total: number }>(`/api/wiki?${q}`);
}

export async function getWikiArticle(id: string) {
  return apiFetch<WikiArticle>(`/api/wiki/${id}`);
}

export async function getWikiStatus() {
  return apiFetch<WikiStatus>('/api/wiki/status');
}

export async function updateWikiArticle(id: string, data: { title?: string; category?: string; content?: string; tags?: string[] }) {
  return apiFetch<WikiArticle>(`/api/wiki/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function deleteWikiArticle(id: string) {
  return apiFetch<{ message: string; id: string }>(`/api/wiki/${id}`, { method: 'DELETE' });
}

export async function triggerWikiIngest() {
  return apiFetch<{ message: string; status?: string; enqueued?: number; processed?: number; updated?: string[] }>('/api/wiki/ingest', { method: 'POST' }, 0, 15000);
}

export async function triggerWikiSynthesis() {
  return apiFetch<{ message: string }>('/api/wiki/synthesis', { method: 'POST' }, 0, 180000);
}

export async function resetWikiNotionQueue() {
  return apiFetch<{ message: string; deleted: number }>('/api/wiki/reset-notion', { method: 'POST' }, 0, 30000);
}

export async function generateWeeklyBriefing(days?: number) {
  const q = days ? `?days=${days}` : '';
  return apiFetch<{
    message: string;
    title: string;
    stats: { historyCount: number; newMeetings: number; newInsights: number; createdArticles: number; updatedArticles: number };
    briefing: string;
  }>(`/api/wiki/weekly-briefing${q}`, { method: 'POST' }, 0, 120000);
}

export interface IngestLogEvent {
  ts: number;
  level: 'info' | 'warn' | 'error' | 'progress';
  message: string;
  labId: string;
}

export async function getIngestLog(sinceTs?: number) {
  const q = sinceTs ? `?since=${sinceTs}` : '';
  return apiFetch<{ events: IngestLogEvent[]; isRunning: boolean }>(`/api/wiki/ingest-log${q}`, { method: 'GET' }, 0, 15000);
}

export async function diagnoseNotion() {
  return apiFetch<{
    apiKeySet: boolean;
    rawProcessEnvSet?: boolean;
    rawKeyLength?: number;
    keyPreview?: string;
    integrationName?: string;
    accessiblePageCount?: number;
    error?: string;
    sampleTitles?: string[];
    notionRelatedEnvVars?: string[];
  }>('/api/wiki/notion-diagnosis', { method: 'GET' }, 0, 15000);
}
