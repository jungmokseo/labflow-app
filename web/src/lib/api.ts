/**
 * LabFlow Web API 클라이언트
 *
 * Clerk 인증 토큰을 자동으로 첨부합니다.
 * 서버 컴포넌트에서는 auth()로 토큰을 가져오고,
 * 클라이언트 컴포넌트에서는 useAuth().getToken()을 사용합니다.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'https://labflow-api.onrender.com';

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
  headers['X-Dev-User-Id'] = 'dev-user-001';
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
  summary: string;
  category: string;
  categoryEmoji: string;
  date: string;
  group?: string;
  groupEmoji?: string;
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
  return apiFetch<{ success: boolean; url: string }>('/api/email/auth/url');
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

// ── 미니브레인 (Lab Memory) ──────────────────────────
export interface BrainChannel {
  id: string;
  type: string;
  name: string | null;
  createdAt: string;
  _count: { messages: number };
}

export interface BrainMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
}

export async function brainChat(message: string, channelId?: string) {
  return apiFetch<{ response: string; channelId: string; intent: string; dbResult: boolean }>('/api/brain/chat', {
    method: 'POST',
    body: JSON.stringify({ message, channelId }),
  });
}

export async function getBrainChannels() {
  return apiFetch<BrainChannel[]>('/api/brain/channels');
}

export async function getChannelMessages(channelId: string) {
  return apiFetch<BrainMessage[]>(`/api/brain/channels/${channelId}`);
}

export async function searchBrainMemory(query: string) {
  return apiFetch<any>(`/api/brain/search?query=${encodeURIComponent(query)}`);
}

export async function saveMemo(content: string, source = 'manual') {
  return apiFetch<any>('/api/brain/memo', {
    method: 'POST',
    body: JSON.stringify({ content, source }),
  });
}

// ── Lab Profile ─────────────────────────────────────
export interface Lab {
  id: string;
  name: string;
  institution: string | null;
  department: string | null;
  piName: string | null;
  researchFields: string[];
  onboardingDone: boolean;
  members: LabMember[];
  projects: LabProject[];
  domainDict: DictEntry[];
  _count: { publications: number; memos: number };
}

export interface LabMember {
  id: string;
  name: string;
  email: string | null;
  role: string;
}

export interface LabProject {
  id: string;
  name: string;
  number: string | null;
  funder: string | null;
  status: string;
}

export interface DictEntry {
  id: string;
  wrongForm: string;
  correctForm: string;
  category: string | null;
}

export async function getLabProfile() {
  return apiFetch<Lab>('/api/lab');
}

export async function createLab(data: { name: string; institution?: string; department?: string; piName?: string; researchFields?: string[] }) {
  return apiFetch<Lab>('/api/lab', { method: 'POST', body: JSON.stringify(data) });
}

export async function updateLab(data: Partial<Lab>) {
  return apiFetch<Lab>('/api/lab', { method: 'PUT', body: JSON.stringify(data) });
}

export async function completeOnboarding(data: { homepageUrl?: string; keywords?: string[] }) {
  return apiFetch<{ lab: Lab; extractedKeywords: string[] }>('/api/lab/onboarding', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function addLabMember(data: { name: string; email?: string; role?: string }) {
  return apiFetch<LabMember>('/api/lab/members', { method: 'POST', body: JSON.stringify(data) });
}

export async function addLabProject(data: { name: string; number?: string; funder?: string; acknowledgment?: string }) {
  return apiFetch<LabProject>('/api/lab/projects', { method: 'POST', body: JSON.stringify(data) });
}

export async function addDictEntry(data: { wrongForm: string; correctForm: string; category?: string }) {
  return apiFetch<DictEntry>('/api/lab/dictionary', { method: 'POST', body: JSON.stringify(data) });
}

export async function analyzeSeedPapers(papers: string[]) {
  return apiFetch<{
    papers: Array<{ title: string; authors: string[]; abstract: string; journal: string; year: number; doi: string; citationCount: number; url: string; extractedKeywords: string[]; extractedTerms: Array<{ term: string; definition: string; category: string }>; coauthors: Array<{ name: string }>; relatedJournals: string[]; suggestedRssKeywords: string[] }>;
    mergedKeywords: string[];
    mergedTerms: Array<{ term: string; definition: string; category: string }>;
    mergedJournals: string[];
    mergedRssKeywords: string[];
  }>('/api/lab/seed-paper', { method: 'POST', body: JSON.stringify({ papers }) });
}

export async function applySeedPaperResults(data: {
  keywords?: string[];
  terms?: Array<{ term: string; definition: string; category: string }>;
  papers?: Array<{ title: string; authors?: string; journal?: string; year?: number; doi?: string }>;
  rssKeywords?: string[];
  rssJournals?: string[];
  setupPaperAlert?: boolean;
}) {
  return apiFetch<{ success: boolean; applied: string[] }>('/api/lab/seed-paper/apply', { method: 'POST', body: JSON.stringify(data) });
}

export async function getLabCompleteness() {
  return apiFetch<{ percentage: number; checks: Array<{ item: string; done: boolean; weight: number }>; missingItems: string[]; suggestions: string[] }>('/api/lab/completeness');
}

// ── 논문 알림 ──────────────────────────────────────
export interface PaperAlertSetting {
  id: string;
  keywords: string[];
  journals: string[];
  schedule: string;
  lastRunAt: string | null;
}

export interface PaperAlertResult {
  id: string;
  title: string;
  authors: string | null;
  journal: string | null;
  url: string | null;
  aiSummary: string | null;
  relevance: number | null;
  read: boolean;
  createdAt: string;
}

export async function getPaperAlerts() {
  return apiFetch<{ alerts: PaperAlertSetting[]; availableJournals: string[] }>('/api/papers/alerts');
}

export async function savePaperAlert(data: { keywords: string[]; journals?: string[]; schedule?: string }) {
  return apiFetch<PaperAlertSetting>('/api/papers/alerts', { method: 'POST', body: JSON.stringify(data) });
}

export async function runPaperCrawl() {
  return apiFetch<{ totalFetched: number; matched: number; newSaved: number }>('/api/papers/alerts/run', { method: 'POST' });
}

export async function getPaperAlertResults(unread = false) {
  return apiFetch<{ results: PaperAlertResult[]; unreadCount: number }>(`/api/papers/alerts/results${unread ? '?unread=true' : ''}`);
}

export async function markPaperRead(id: string) {
  return apiFetch<{ success: boolean }>(`/api/papers/alerts/results/${id}`, { method: 'PATCH' });
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
