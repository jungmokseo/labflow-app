/**
 * LabFlow Web API 클라이언트
 *
 * Clerk 인증 토큰을 자동으로 첨부합니다.
 * 서버 컴포넌트에서는 auth()로 토큰을 가져오고,
 * 클라이언트 컴포넌트에서는 useAuth().getToken()을 사용합니다.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'https://labflow-app-production.up.railway.app';

// ── 토큰 getter (클라이언트 사이드용) ───────────────
let tokenGetter: (() => Promise<string | null>) | null = null;

export function setAuthTokenGetter(fn: () => Promise<string | null>) {
  tokenGetter = fn;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (tokenGetter) {
    const token = await tokenGetter();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
      return headers;
    }
  }

  // Fallback: dev mode
  headers['X-Dev-User-Id'] = 'dev-user-seo';
  return headers;
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${API_BASE}${path}`;
  const authHeaders = await getAuthHeaders();

  const res = await fetch(url, {
    ...options,
    headers: { ...authHeaders, ...options.headers },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error || `API Error: ${res.status}`);
  }

  return res.json();
}

// ── 캡처 ──────────────────────────────────────────
export interface Capture {
  id: string;
  content: string;
  summary: string;
  category: string;
  tags: string[];
  priority: string;
  completed: boolean;
  createdAt: string;
}

export async function getCaptures(limit = 20) {
  return apiFetch<{ success: boolean; data: Capture[]; meta: any }>(`/api/captures?limit=${limit}&sort=newest`);
}

export async function createCapture(content: string) {
  return apiFetch<{ success: boolean; data: Capture }>('/api/captures', {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

export async function updateCapture(id: string, data: Partial<Pick<Capture, 'content' | 'completed'>>) {
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
  return apiFetch<{ success: boolean; connected: boolean; hasProfile?: boolean }>('/api/email/status');
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

export async function updateMeeting(id: string, data: Partial<Pick<Meeting, 'title' | 'summary'>>) {
  return apiFetch<{ success: boolean; data: Meeting }>(`/api/meetings/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteMeeting(id: string) {
  return apiFetch<{ success: boolean }>(`/api/meetings/${id}`, { method: 'DELETE' });
}

export async function uploadMeetingAudio(
  audio: File,
  opts?: { title?: string; duration?: number }
): Promise<{ success: boolean; data: Meeting }> {
  const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'https://labflow-app-production.up.railway.app';
  const formData = new FormData();
  formData.append('audio', audio);
  if (opts?.title) formData.append('title', opts.title);
  if (opts?.duration != null) formData.append('duration', String(opts.duration));

  const headers: Record<string, string> = {};
  if (tokenGetter) {
    const token = await tokenGetter();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  if (!headers['Authorization']) headers['X-Dev-User-Id'] = 'dev-user-seo';

  const res = await fetch(`${API_BASE}/api/meetings`, {
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
export type BrainTool = 'general' | 'email' | 'papers' | 'meeting' | 'calendar';

export async function brainChat(message: string, channelId?: string, tool?: BrainTool, fileId?: string) {
  return apiFetch<{ response: string; channelId: string; intent: string; tool?: string; metadata?: any }>('/api/brain/chat', {
    method: 'POST',
    body: JSON.stringify({ message, channelId, tool: tool || 'general', fileId }),
  });
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
  const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'https://labflow-app-production.up.railway.app';
  const formData = new FormData();
  formData.append('file', file);

  const headers: Record<string, string> = {};
  if (tokenGetter) {
    const token = await tokenGetter();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  if (!headers['Authorization']) headers['X-Dev-User-Id'] = 'dev-user-seo';

  const res = await fetch(`${API_BASE}/api/brain/upload`, {
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

// Alias for backward compat
export const getChannelMessages = getBrainMessages;

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

export async function getBriefingHistory(days = 7) {
  return apiFetch<{ briefings: unknown[]; count: number }>(`/api/briefing/history?days=${days}`);
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

export async function completeOnboarding(data: {
  homepageUrl?: string;
  keywords?: string[];
  researchThemes?: Array<{ name: string; keywords: string[]; journals?: string[] }>;
  emailAccounts?: Array<{ name: string; domains: string[]; emoji: string }>;
}) {
  return apiFetch<{ lab: LabProfile; extractedKeywords: string[] }>('/api/lab/onboarding', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getLabCompleteness() {
  return apiFetch<{ completeness: number; missing: string[]; suggestions: string[] }>('/api/lab/completeness');
}

export async function getLabMembers() {
  return apiFetch<Array<{ id: string; name: string; role: string; email: string; phone: string }>>('/api/lab/members');
}

export async function addLabMember(data: { name: string; email?: string; role?: string; phone?: string }) {
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
  return apiFetch<{ success: boolean; sampleCount: number }>('/api/papers/journals/custom', {
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
  const path = alertId ? `/api/papers/alerts/${alertId}/run` : '/api/papers/crawl';
  return apiFetch<{ success: boolean; data: PaperAlertResult[]; count: number }>(path, {
    method: 'POST',
  });
}

export async function getPaperAlertResults(alertId?: string) {
  const path = alertId ? `/api/papers/alerts/${alertId}/results` : '/api/papers/results';
  return apiFetch<{ success: boolean; data: PaperAlertResult[]; results?: PaperAlertResult[]; unreadCount?: number }>(path);
}

export async function markPaperRead(resultId: string) {
  return apiFetch<{ success: boolean }>(`/api/papers/results/${resultId}/read`, { method: 'PATCH' });
}

export async function uploadPaperPdf(file: File): Promise<{ success: boolean; message: string; paperId?: string; title?: string; status?: string }> {
  const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'https://labflow-app-production.up.railway.app';
  const formData = new FormData();
  formData.append('file', file);

  const headers: Record<string, string> = {};
  if (tokenGetter) {
    const token = await tokenGetter();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  if (!headers['Authorization']) headers['X-Dev-User-Id'] = 'dev-user-seo';

  const res = await fetch(`${API_BASE}/api/papers/upload`, {
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

// ── 헬스 체크 ──────────────────────────────────────
export async function checkHealth() {
  try {
    const res = await apiFetch<{ status: string }>('/health');
    return res.status === 'healthy';
  } catch {
    return false;
  }
}
