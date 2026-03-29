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

// ── 헬스 체크 ──────────────────────────────────────
export async function checkHealth() {
  try {
    const res = await apiFetch<{ status: string }>('/health');
    return res.status === 'healthy';
  } catch {
    return false;
  }
}
