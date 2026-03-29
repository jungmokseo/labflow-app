/**
 * LabFlow API 클라이언트
 *
 * Expo 앱 ↔ Fastify 백엔드 통신 레이어
 * - 오프라인 fallback: API 실패 시 로컬 AsyncStorage 사용
 * - 인증 헤더 자동 추가 (Clerk 연동 후)
 */

import { CaptureItem, CaptureCategory } from '../types';

// ── 설정 ──────────────────────────────────────────
const API_BASE = __DEV__
  ? 'http://localhost:3001'        // 로컬 개발
  : 'https://labflow-app-production.up.railway.app';  // Railway 배포

const DEFAULT_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'X-Dev-User-Id': 'dev-user-seo',  // 개발 중 인증 우회
};

// ── 인증 토큰 주입 (Clerk 연동 후 사용) ──────────────
let _getToken: (() => Promise<string | null>) | null = null;

/** AuthProvider에서 호출 — Clerk 토큰 getter 주입 */
export function setAuthTokenGetter(getter: () => Promise<string | null>) {
  _getToken = getter;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  if (_getToken) {
    try {
      const token = await _getToken();
      if (token) {
        return { Authorization: `Bearer ${token}` };
      }
    } catch { /* fallback to dev headers */ }
  }
  return { 'X-Dev-User-Id': 'dev-user-seo' };
}

// ── API 응답 타입 ─────────────────────────────────
interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
  meta?: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    counts: { all: number; idea: number; task: number; memo: number };
    taskStats: { total: number; completed: number; pending: number };
  };
}

interface ApiCapture {
  id: string;
  content: string;
  summary: string;
  category: string;
  tags: string[];
  priority: string;
  confidence: number | null;
  actionDate: string | null;
  modelUsed: string | null;
  completed: boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── API → 앱 타입 변환 ───────────────────────────────
function toAppCapture(api: ApiCapture): CaptureItem {
  return {
    id: api.id,
    content: api.content,
    summary: api.summary,
    category: api.category as CaptureCategory,
    tags: api.tags,
    timestamp: new Date(api.createdAt),
    confidence: api.confidence ?? undefined,
    priority: api.priority as 'high' | 'medium' | 'low',
    actionDate: api.actionDate ?? undefined,
    modelUsed: api.modelUsed ?? undefined,
    completed: api.completed,
    completedAt: api.completedAt ? new Date(api.completedAt) : undefined,
  };
}

// ── 공통 fetch 래퍼 ──────────────────────────────────
async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<ApiResponse<T>> {
  const url = `${API_BASE}${path}`;
  const authHeaders = await getAuthHeaders();
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeaders, ...options.headers },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `API Error: ${response.status}`);
  }

  return response.json();
}

// ── 캡처 API ────────────────────────────────────────

/** 새 캡처 생성 (AI 자동분류) */
export async function createCapture(
  content: string,
  options?: { useAI?: boolean; category?: CaptureCategory },
): Promise<CaptureItem> {
  const result = await apiFetch<ApiCapture>('/api/captures', {
    method: 'POST',
    body: JSON.stringify({
      content,
      useAI: options?.useAI ?? true,
      category: options?.category?.toUpperCase(),
    }),
  });
  return toAppCapture(result.data);
}

/** 캡처 목록 조회 */
export async function listCaptures(params?: {
  category?: CaptureCategory;
  completed?: boolean;
  sort?: 'oldest' | 'newest' | 'dueDate';
  page?: number;
  limit?: number;
  search?: string;
}): Promise<{
  items: CaptureItem[];
  meta: ApiResponse<any>['meta'];
}> {
  const query = new URLSearchParams();
  if (params?.category) query.set('category', params.category.toUpperCase());
  if (params?.completed !== undefined) query.set('completed', String(params.completed));
  if (params?.sort) query.set('sort', params.sort);
  if (params?.page) query.set('page', String(params.page));
  if (params?.limit) query.set('limit', String(params.limit));
  if (params?.search) query.set('search', params.search);

  const result = await apiFetch<ApiCapture[]>(`/api/captures?${query.toString()}`);
  return {
    items: result.data.map(toAppCapture),
    meta: result.meta,
  };
}

/** 캡처 수정 */
export async function updateCapture(
  id: string,
  updates: {
    content?: string;
    category?: CaptureCategory;
    tags?: string[];
    priority?: 'high' | 'medium' | 'low';
    completed?: boolean;
    actionDate?: string | null;
  },
): Promise<CaptureItem> {
  const body: any = { ...updates };
  if (body.category) body.category = body.category.toUpperCase();
  if (body.priority) body.priority = body.priority.toUpperCase();

  const result = await apiFetch<ApiCapture>(`/api/captures/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return toAppCapture(result.data);
}

/** 캡처 삭제 */
export async function deleteCapture(id: string): Promise<void> {
  await apiFetch(`/api/captures/${id}`, { method: 'DELETE' });
}

/** 완료된 캡처 일괄 삭제 */
export async function clearCompletedCaptures(): Promise<number> {
  const result = await apiFetch<{ deleted: number }>('/api/captures/completed', {
    method: 'DELETE',
  });
  return (result as any).deleted;
}

/** AI 분류만 (저장 없이) */
export async function classifyText(content: string): Promise<{
  category: CaptureCategory;
  confidence: number;
  summary: string;
  tags: string[];
  actionDate: string | null;
  priority: 'high' | 'medium' | 'low';
}> {
  const result = await apiFetch<any>('/api/captures/classify', {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
  return {
    ...result.data,
    category: result.data.category.toLowerCase(),
    priority: result.data.priority.toLowerCase(),
  };
}

/** 음성 캡처 (전사 + 분류 + 저장) */
export async function createVoiceCapture(
  audioUri: string,
  mimeType: string = 'audio/m4a',
): Promise<CaptureItem & { transcription: string }> {
  const formData = new FormData();
  formData.append('file', {
    uri: audioUri,
    type: mimeType,
    name: `voice-${Date.now()}.${mimeType.split('/')[1] || 'm4a'}`,
  } as any);

  const url = `${API_BASE}/api/captures/voice`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Dev-User-Id': 'dev-user-seo',
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `Voice API Error: ${response.status}`);
  }

  const result = await response.json();
  return {
    ...toAppCapture(result.data),
    transcription: result.data.transcription,
  };
}

/** 음성 전사만 (저장 없이, 분류 결과 포함) */
export async function transcribeVoice(
  audioUri: string,
  mimeType: string = 'audio/m4a',
): Promise<{
  transcription: string;
  classification: {
    category: CaptureCategory;
    confidence: number;
    summary: string;
    tags: string[];
    actionDate: string | null;
    priority: 'high' | 'medium' | 'low';
  };
}> {
  const formData = new FormData();
  formData.append('file', {
    uri: audioUri,
    type: mimeType,
    name: `voice-${Date.now()}.${mimeType.split('/')[1] || 'm4a'}`,
  } as any);

  const url = `${API_BASE}/api/captures/voice/transcribe`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Dev-User-Id': 'dev-user-seo',
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `Transcribe API Error: ${response.status}`);
  }

  const result = await response.json();
  return {
    transcription: result.data.transcription,
    classification: {
      ...result.data.classification,
      category: result.data.classification.category.toLowerCase(),
      priority: result.data.classification.priority.toLowerCase(),
    },
  };
}

// ── 이메일 브리핑 API ─────────────────────────────────

/** Gmail 연동 상태 확인 */
export async function checkEmailStatus(): Promise<{
  connected: boolean;
  expiresAt: string | null;
  hasProfile: boolean;
  classifyByGroup: boolean;
  groupCount: number;
  message: string;
}> {
  const result = await apiFetch<any>('/api/email/status');
  return {
    connected: result.data?.connected ?? (result as any).connected ?? false,
    expiresAt: result.data?.expiresAt ?? (result as any).expiresAt ?? null,
    hasProfile: result.data?.hasProfile ?? (result as any).hasProfile ?? false,
    classifyByGroup: result.data?.classifyByGroup ?? false,
    groupCount: result.data?.groupCount ?? 0,
    message: result.data?.message ?? (result as any).message ?? '',
  };
}

/** Gmail OAuth 인증 URL 가져오기 */
export async function getEmailAuthUrl(): Promise<string> {
  const result = await apiFetch<any>('/api/email/auth/url');
  return result.data?.authUrl ?? (result as any).authUrl ?? '';
}

/** 이메일 프로필 (완전 개인화 설정) */
export interface EmailGroup {
  name: string;
  domains: string[];
  emoji: string;
}

export interface ExcludePattern {
  field: 'subject' | 'from';
  pattern: string;
}

export interface ImportanceRule {
  condition: string;
  action: string;
  description?: string;
}

export interface SenderTimezone {
  domains: string[];
  timezone: string;
  label?: string;
}

export interface EmailProfile {
  classifyByGroup: boolean;
  groups: EmailGroup[];
  excludePatterns: ExcludePattern[];
  keywords: string[];
  importanceRules: ImportanceRule[];
  senderTimezones: SenderTimezone[];
  timezone: string;
}

/** 이메일 프로필 조회 */
export async function getEmailProfile(): Promise<EmailProfile & { lastBriefingAt: string | null }> {
  const result = await apiFetch<EmailProfile & { lastBriefingAt: string | null }>('/api/email/profile');
  return result.data;
}

/** 이메일 프로필 저장 */
export async function updateEmailProfile(profile: Partial<EmailProfile> & { classifyByGroup: boolean; groups: EmailGroup[] }): Promise<EmailProfile & { lastBriefingAt: string | null }> {
  const result = await apiFetch<EmailProfile & { lastBriefingAt: string | null }>('/api/email/profile', {
    method: 'PUT',
    body: JSON.stringify(profile),
  });
  return result.data;
}

/** 이메일 브리핑 데이터 */
export interface EmailBriefingItem {
  sender: string;
  senderName: string;
  subject: string;
  snippet: string;
  body?: string;              // 긴급/대응필요만 포함
  date: string;
  dateSender?: string;        // 발신자 시간대 (매핑 시)
  dateSenderLabel?: string;   // 발신자 시간대 라벨
  dateLocal: string;          // 사용자 기본 시간대 표기
  category: 'urgent' | 'action-needed' | 'schedule' | 'info' | 'ads';
  categoryEmoji: string;
  group?: string;             // 기관 그룹명 (다계정 시)
  groupEmoji?: string;        // 기관 이모지
  summary: string;
  messageId: string;
  threadId?: string;
  matchedTimezone?: string;   // 매칭된 발신자 시간대 ID
}

export interface EmailBriefingMeta {
  total: number;
  maxResults: number;
  categories: {
    urgent: number;
    'action-needed': number;
    schedule: number;
    info: number;
    ads: number;
  };
  groups: Record<string, number>;
  classifiedBy: string;
}

/** 이메일 브리핑 조회 (AI 분류 포함) */
export async function getEmailBriefing(params?: {
  maxResults?: number;
  includeSpam?: boolean;
}): Promise<{
  items: EmailBriefingItem[];
  meta: EmailBriefingMeta;
}> {
  const query = new URLSearchParams();
  if (params?.maxResults) query.set('maxResults', String(params.maxResults));
  if (params?.includeSpam !== undefined) query.set('includeSpam', String(params.includeSpam));

  const qs = query.toString();
  const result = await apiFetch<EmailBriefingItem[]>(`/api/email/briefing${qs ? `?${qs}` : ''}`);
  return {
    items: result.data,
    meta: result.meta as unknown as EmailBriefingMeta,
  };
}

/** 이메일 번역 (Gemini Flash) */
export async function translateEmail(
  text: string,
  targetLang: string = 'ko',
): Promise<{ translated: string; targetLang: string }> {
  const result = await apiFetch<any>('/api/email/translate', {
    method: 'POST',
    body: JSON.stringify({ text, targetLang }),
  });
  return { translated: result.data?.translated ?? (result as any).translated, targetLang };
}

/** 답장 초안 생성 → Gmail 임시보관함 저장 */
export async function createEmailDraft(params: {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
}): Promise<{ draftId: string; message: string }> {
  const result = await apiFetch<any>('/api/email/draft', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  return {
    draftId: result.data?.draftId ?? (result as any).draftId,
    message: result.data?.message ?? (result as any).message,
  };
}

/** 이메일에서 할일/일정 추출 → Capture 생성 */
export async function extractEmailActions(params: {
  subject: string;
  body: string;
  sender?: string;
}): Promise<{
  tasks: Array<{ title: string; priority: string; dueDate: string | null }>;
  events: Array<{ title: string; date: string; time: string | null; location: string | null; description: string }>;
  captures: any[];
  message: string;
}> {
  const result = await apiFetch<any>('/api/email/extract-actions', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  return result.data ?? result;
}

/** Google Calendar 이벤트 생성 */
export async function createCalendarEvent(params: {
  title: string;
  date: string;
  time?: string;
  duration?: number;
  location?: string;
  description?: string;
}): Promise<{ eventId: string; htmlLink: string; message: string }> {
  const result = await apiFetch<any>('/api/email/calendar-event', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  return result.data ?? result;
}

// ── 미니브레인 (Lab Memory) API ─────────────────────────

/** 미니브레인 대화 */
export async function brainChat(params: {
  message: string;
  channelId?: string;
  labId?: string;
}): Promise<{
  reply: string;
  intent?: string;
  sources?: any[];
  channelId?: string;
}> {
  const result = await apiFetch<any>('/api/brain/chat', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  return result.data ?? result;
}

/** 채널 목록 조회 */
export async function listBrainChannels(): Promise<any[]> {
  const result = await apiFetch<any[]>('/api/brain/channels');
  return result.data;
}

/** 새 채널 생성 */
export async function createBrainChannel(name?: string): Promise<any> {
  const result = await apiFetch<any>('/api/brain/channels', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  return result.data;
}

/** 채널 메시지 조회 */
export async function getBrainChannelMessages(channelId: string): Promise<any[]> {
  const result = await apiFetch<any[]>(`/api/brain/channels/${channelId}`);
  return result.data;
}

/** 채널 삭제 */
export async function deleteBrainChannel(channelId: string): Promise<void> {
  await apiFetch(`/api/brain/channels/${channelId}`, { method: 'DELETE' });
}

/** Lab Memory 검색 */
export async function searchBrain(query: string, labId?: string): Promise<any[]> {
  const params = new URLSearchParams({ q: query });
  if (labId) params.set('labId', labId);
  const result = await apiFetch<any[]>(`/api/brain/search?${params.toString()}`);
  return result.data;
}

// ── 지식 그래프 API ─────────────────────────────────────

/** 전체 지식 그래프 */
export async function getKnowledgeGraph(params?: {
  entityType?: string;
  limit?: number;
}): Promise<{ nodes: any[]; edges: any[] }> {
  const query = new URLSearchParams();
  if (params?.entityType) query.set('entityType', params.entityType);
  if (params?.limit) query.set('limit', String(params.limit));
  const qs = query.toString();
  const result = await apiFetch<any>(`/api/graph${qs ? `?${qs}` : ''}`);
  return result.data;
}

/** 특정 노드의 연결 관계 */
export async function getGraphNodeConnections(nodeId: string): Promise<any> {
  const result = await apiFetch<any>(`/api/graph/node/${nodeId}`);
  return result.data;
}

// ── 논문 알림 API ───────────────────────────────────────

/** 논문 알림 설정 조회 */
export async function getPaperAlerts(): Promise<any> {
  const result = await apiFetch<any>('/api/papers/alerts');
  return result.data;
}

/** 논문 알림 결과 목록 */
export async function getPaperAlertResults(): Promise<any[]> {
  const result = await apiFetch<any[]>('/api/papers/alerts/results');
  return result.data;
}

/** 논문 알림 수동 실행 */
export async function runPaperAlerts(): Promise<any> {
  const result = await apiFetch<any>('/api/papers/alerts/run', { method: 'POST' });
  return result.data;
}

/** 논문 알림 읽음 표시 */
export async function markPaperAlertRead(id: string): Promise<void> {
  await apiFetch(`/api/papers/alerts/results/${id}`, { method: 'PATCH' });
}

// ── Lab 프로필 API ──────────────────────────────────────

/** Lab 프로필 조회 */
export async function getLabProfile(): Promise<any> {
  const result = await apiFetch<any>('/api/lab');
  return result.data;
}

/** Lab 온보딩 완료도 */
export async function getLabCompleteness(): Promise<any> {
  const result = await apiFetch<any>('/api/lab/completeness');
  return result.data;
}

// ── Voice Chatbot API ───────────────────────────────────

/** 보이스 챗봇 페르소나 목록 */
export async function getVoicePersonas(): Promise<any[]> {
  const result = await apiFetch<any>('/api/voice/personas');
  return result.data?.personas ?? (result as any).personas ?? [];
}

/** 보이스 세션 시작 */
export async function createVoiceSession(params: {
  personaId: 'research-bot' | 'english-tutor';
  voiceId?: string;
}): Promise<any> {
  const result = await apiFetch<any>('/api/voice/session', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  return result.data ?? result;
}

// ── 회의 노트 API ──────────────────────────────────────

export interface MeetingItem {
  id: string;
  title: string;
  transcription: string | null;
  summary: string | null;
  agenda: string[];
  discussions: Array<{ topic: string; content: string }> | string | null;
  actionItems: string[];
  nextSteps: string[];
  duration: number | null;
  modelUsed: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 음성 녹음으로 회의 생성 (2단계: Gemini STT → Sonnet 요약) */
export async function createMeeting(
  audioUri: string,
  mimeType: string = 'audio/m4a',
  duration?: number,
): Promise<MeetingItem> {
  const formData = new FormData();
  formData.append('file', {
    uri: audioUri,
    type: mimeType,
    name: `meeting-${Date.now()}.${mimeType.split('/')[1] || 'm4a'}`,
  } as any);
  if (duration !== undefined) {
    formData.append('duration', String(duration));
  }

  const url = `${API_BASE}/api/meetings`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'X-Dev-User-Id': 'dev-user-seo' },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `Meeting API Error: ${response.status}`);
  }

  const result = await response.json();
  return result.data;
}

/** 회의 목록 조회 */
export async function listMeetings(params?: {
  page?: number;
  limit?: number;
}): Promise<{
  items: MeetingItem[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}> {
  const query = new URLSearchParams();
  if (params?.page) query.set('page', String(params.page));
  if (params?.limit) query.set('limit', String(params.limit));

  const qs = query.toString();
  const result = await apiFetch<MeetingItem[]>(`/api/meetings${qs ? `?${qs}` : ''}`);
  return {
    items: result.data,
    meta: result.meta as any,
  };
}

/** 단일 회의 조회 */
export async function getMeeting(id: string): Promise<MeetingItem> {
  const result = await apiFetch<MeetingItem>(`/api/meetings/${id}`);
  return result.data;
}

/** 회의 삭제 */
export async function deleteMeeting(id: string): Promise<void> {
  await apiFetch(`/api/meetings/${id}`, { method: 'DELETE' });
}

/** API 서버 상태 확인 */
export async function checkHealth(): Promise<boolean> {
  try {
    const result = await apiFetch<any>('/health');
    return result.status === 'healthy';
  } catch {
    return false;
  }
}

export { API_BASE };
