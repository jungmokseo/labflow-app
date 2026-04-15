'use client';

import { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  getWikiArticles, getWikiArticle, getWikiStatus, updateWikiArticle,
  deleteWikiArticle, triggerWikiIngest, triggerWikiSynthesis, resetWikiNotionQueue, diagnoseNotion, getIngestLog,
  type WikiArticle, type WikiStatus, type IngestLogEvent,
} from '@/lib/api';
import {
  BookOpen, RefreshCw, Pencil, Trash2, Save, X, ChevronRight,
  Tag, Clock, Hash, Loader2, Sparkles, Zap, Filter, Terminal, ChevronLeft,
} from 'lucide-react';

const CATEGORIES = [
  { value: '', label: '전체' },
  { value: 'person', label: '연구원' },
  { value: 'project', label: '과제' },
  { value: 'research_trend', label: '연구동향' },
  { value: 'meeting_thread', label: '미팅' },
  { value: 'experiment', label: '실험' },
  { value: 'collaboration', label: '협업' },
  { value: 'general', label: '일반' },
];

const CATEGORY_BADGE: Record<string, string> = {
  person: 'bg-blue-100 text-blue-700',
  project: 'bg-green-100 text-green-700',
  research_trend: 'bg-purple-100 text-purple-700',
  meeting_thread: 'bg-amber-100 text-amber-700',
  experiment: 'bg-rose-100 text-rose-700',
  collaboration: 'bg-cyan-100 text-cyan-700',
  general: 'bg-gray-100 text-gray-600',
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  return new Date(dateStr).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

function CategoryBadge({ category }: { category: string }) {
  const label = CATEGORIES.find(c => c.value === category)?.label ?? category;
  const cls = CATEGORY_BADGE[category] ?? 'bg-gray-100 text-gray-600';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {label}
    </span>
  );
}

export default function WikiPage() {
  const [articles, setArticles] = useState<WikiArticle[]>([]);
  const [status, setStatus] = useState<WikiStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WikiArticle | null>(null);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [ingestLoading, setIngestLoading] = useState(false);
  const [synthLoading, setSynthLoading] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);

  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editTagsStr, setEditTagsStr] = useState('');

  const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'err' } | null>(null);

  // Ingest 모니터링 로그
  const [logs, setLogs] = useState<IngestLogEvent[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [isIngestRunning, setIsIngestRunning] = useState(false);

  // 모바일 사이드바 토글
  const [mobileListOpen, setMobileListOpen] = useState(true);

  function showToast(msg: string, type: 'ok' | 'err' = 'ok') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  const loadArticles = useCallback(async () => {
    setLoading(true);
    try {
      const articlesRes = await getWikiArticles({ category: categoryFilter || undefined, limit: 200 });
      setArticles(articlesRes.articles ?? []);
    } catch (err: any) {
      showToast('아티클 로드 실패: ' + (err?.message ?? '알 수 없는 오류'), 'err');
    } finally {
      setLoading(false);
    }
    // status는 아티클 로드와 독립적으로 처리
    try {
      const statusRes = await getWikiStatus();
      setStatus(statusRes as WikiStatus);
    } catch {
      // status 실패는 무시 (아티클은 이미 로드됨)
    }
  }, [categoryFilter]);

  useEffect(() => { loadArticles(); }, [loadArticles]);

  // Ingest 로그 주기 폴링 (로그 창이 열려있거나 실행 중이면)
  useEffect(() => {
    if (!logOpen && !isIngestRunning) return;
    const interval = setInterval(async () => {
      try {
        const sinceTs = logs.length > 0 ? logs[logs.length - 1].ts : undefined;
        const res = await getIngestLog(sinceTs);
        setIsIngestRunning(res.isRunning);
        if (res.events.length > 0) {
          setLogs(prev => [...prev, ...res.events].slice(-200));
        }
      } catch { /* 로그 폴링 실패 무시 */ }
    }, 2000);
    return () => clearInterval(interval);
  }, [logOpen, isIngestRunning, logs]);

  async function loadDetail(id: string) {
    setSelectedId(id);
    setEditing(false);
    setDetailLoading(true);
    try {
      const article = await getWikiArticle(id);
      setDetail(article as WikiArticle);
    } catch {
      showToast('아티클 조회 실패', 'err');
    } finally {
      setDetailLoading(false);
    }
  }

  function startEdit() {
    if (!detail) return;
    setEditTitle(detail.title);
    setEditCategory(detail.category);
    setEditContent(detail.content);
    setEditTagsStr(detail.tags.join(', '));
    setEditing(true);
  }

  async function saveEdit() {
    if (!detail) return;
    setSaveLoading(true);
    try {
      const tags = editTagsStr.split(',').map(t => t.trim()).filter(Boolean);
      const updated = await updateWikiArticle(detail.id, {
        title: editTitle,
        category: editCategory,
        content: editContent,
        tags,
      }) as WikiArticle;
      setDetail(updated);
      setArticles(prev => prev.map(a => a.id === updated.id ? { ...a, title: updated.title, category: updated.category, tags: updated.tags, updatedAt: updated.updatedAt, version: updated.version } : a));
      setEditing(false);
      showToast('저장 완료');
    } catch {
      showToast('저장 실패', 'err');
    } finally {
      setSaveLoading(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('이 아티클을 삭제하시겠습니까?')) return;
    try {
      await deleteWikiArticle(id);
      setArticles(prev => prev.filter(a => a.id !== id));
      if (selectedId === id) { setSelectedId(null); setDetail(null); }
      showToast('삭제 완료');
    } catch {
      showToast('삭제 실패', 'err');
    }
  }

  async function handleIngest() {
    setIngestLoading(true);
    setLogs([]); // 이전 로그 초기화
    setLogOpen(true); // 로그 창 자동 오픈
    setIsIngestRunning(true);
    showToast('Ingest 시작됨 — 백그라운드에서 처리 중입니다');

    // 동작 원리:
    // - pending 또는 lastIngestAt이 변하면 Railway가 작업 중 (대기)
    // - 둘 다 IDLE_MS 동안 변화 없으면 Railway 배치가 멈춤 → 재트리거
    // - pending === 0이면 완료
    // - 전체 HARD_TIMEOUT_MS 초과 시 안전 종료
    const POLL_MS = 3000;
    const IDLE_MS = 120_000;       // 2분 — Sonnet 호출 1회(30-60초) 넉넉히 포용
    const HARD_TIMEOUT_MS = 60 * 60 * 1000; // 1시간 안전 차단

    let lastPending = -1;
    let lastIngestAtStr: string | null | undefined = undefined;
    let lastActivityAt = Date.now();
    let isTriggering = false;
    let retriggerCount = 0;
    const startedAt = Date.now();

    const triggerSafely = async (): Promise<boolean> => {
      if (isTriggering) return false;
      isTriggering = true;
      try {
        await triggerWikiIngest();
        return true;
      } catch {
        return false;
      } finally {
        isTriggering = false;
      }
    };

    // 첫 트리거
    const firstOk = await triggerSafely();
    if (!firstOk) {
      setIngestLoading(false);
      showToast('Ingest 요청 실패', 'err');
      return;
    }

    const interval = setInterval(async () => {
      try {
        const s = (await getWikiStatus()) as WikiStatus;
        setStatus(s);
        const pending = s.pendingQueueItems;
        const lastIngestAt = s.lastIngestAt;

        // 완료
        if (pending === 0) {
          clearInterval(interval);
          await loadArticles();
          setIngestLoading(false);
          showToast(retriggerCount > 0 ? `Ingest 완료 (배치 ${retriggerCount + 1}회)` : 'Ingest 완료');
          return;
        }

        // 안전 타임아웃
        if (Date.now() - startedAt > HARD_TIMEOUT_MS) {
          clearInterval(interval);
          await loadArticles();
          setIngestLoading(false);
          showToast(`Ingest 1시간 초과 — 중단 (대기 ${pending}건). 다시 눌러주세요.`, 'err');
          return;
        }

        // 활동 감지: pending 또는 lastIngestAt 변화
        const activityDetected =
          pending !== lastPending ||
          (lastIngestAtStr !== undefined && lastIngestAt !== lastIngestAtStr);

        if (activityDetected) {
          lastActivityAt = Date.now();
        }
        lastPending = pending;
        lastIngestAtStr = lastIngestAt;

        // 2분간 활동 없음 → Railway 배치 종료로 판단, 재트리거
        if (Date.now() - lastActivityAt >= IDLE_MS) {
          lastActivityAt = Date.now(); // 다음 IDLE 체크까지 2분 확보
          retriggerCount++;
          showToast(`배치 재시작 ${retriggerCount}회 — 대기 ${pending}건`);
          void triggerSafely(); // 폴링은 계속 진행
        }
      } catch {
        // 폴링 실패는 무시하고 계속 (네트워크 일시 오류 등)
      }
    }, POLL_MS);
  }

  async function handleDiagnoseNotion() {
    try {
      const res = await diagnoseNotion();
      const lines: string[] = [];

      // 항상 표시하는 raw env 정보 (구버전 서버 호환 — undefined 방어)
      if (typeof res.rawProcessEnvSet === 'boolean') {
        lines.push(`process.env.NOTION_API_KEY: ${res.rawProcessEnvSet ? `설정됨 (길이 ${res.rawKeyLength ?? '?'})` : '미설정'}`);
      }
      if (Array.isArray(res.notionRelatedEnvVars)) {
        lines.push(`NOTION 관련 env 변수명: [${res.notionRelatedEnvVars.join(', ') || '없음'}]`);
      }
      if (typeof res.rawProcessEnvSet === 'boolean' || Array.isArray(res.notionRelatedEnvVars)) {
        lines.push('');
      }

      if (!res.apiKeySet) {
        lines.push('❌ env.NOTION_API_KEY (zod 검증 후) 미설정');
        if (res.rawProcessEnvSet) {
          lines.push('→ process.env에는 있지만 zod가 걸러냄. 서버 재시작 필요할 수도.');
        } else {
          lines.push('→ Railway 환경변수가 서버 컨테이너에 주입되지 않음');
          lines.push('  1. Railway Variables 탭에서 정확히 "NOTION_API_KEY"로 저장됐는지 확인');
          lines.push('  2. Deployments 탭에서 최신 배포가 성공했는지 확인');
          lines.push('  3. 수동 Redeploy 시도');
        }
      } else if (res.error) {
        lines.push('❌ Notion API 호출 실패');
        if (res.keyPreview) lines.push(`키: ${res.keyPreview}`);
        lines.push(`에러: ${res.error}`);
      } else {
        lines.push('✓ API 키 정상');
        if (res.keyPreview) lines.push(`키: ${res.keyPreview}`);
        if (res.integrationName) lines.push(`통합: ${res.integrationName}`);
        lines.push(`접근 가능 페이지: ${res.accessiblePageCount ?? 0}개 (샘플)`);
        if (res.sampleTitles && res.sampleTitles.length > 0) {
          lines.push('\n샘플 제목:');
          res.sampleTitles.forEach(t => lines.push(`  - ${t}`));
        }
        if ((res.accessiblePageCount ?? 0) === 0) {
          lines.push('\n⚠️ 페이지가 0개입니다. Notion 통합에 페이지가 연결되어 있지 않습니다.');
          lines.push('Notion 워크스페이스에서 통합에 페이지 접근 권한을 부여하세요.');
        }
      }
      alert(lines.join('\n'));
    } catch (err: any) {
      alert('진단 실패: ' + (err?.message ?? '알 수 없는 오류'));
    }
  }

  async function handleResetNotion() {
    if (!confirm('Notion 페이지 큐를 초기화합니다.\n처리 완료된 모든 Notion 항목이 삭제되고, 다음 Ingest에서 개선된 추출 로직으로 전체 재처리됩니다.\n\n진행할까요?')) return;
    try {
      const res = await resetWikiNotionQueue();
      showToast(res.message);
      const s = await getWikiStatus();
      setStatus(s as WikiStatus);
    } catch {
      showToast('초기화 실패', 'err');
    }
  }

  async function handleSynthesis() {
    if (!confirm('Opus 딥 리뷰를 실행합니다. 시간이 걸릴 수 있습니다.')) return;
    setSynthLoading(true);
    try {
      await triggerWikiSynthesis();
      showToast('Deep synthesis 완료');
      await loadArticles();
    } catch {
      showToast('Synthesis 실패', 'err');
    } finally {
      setSynthLoading(false);
    }
  }

  const filtered = articles.filter(a => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return a.title.toLowerCase().includes(q) || a.tags.some(t => t.toLowerCase().includes(q));
  });

  return (
    <div className="flex flex-col h-[calc(100dvh-3.5rem)] md:h-[calc(100dvh-1.5rem)] overflow-hidden">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-2 rounded-lg text-sm font-medium shadow-lg transition-all ${
          toast.type === 'ok' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
        }`}>
          {toast.msg}
        </div>
      )}

      {/* Header — 모바일: 세로 쌓기, 데스크탑: 가로 */}
      <div className="px-4 md:px-6 py-3 md:py-4 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-3">
          <BookOpen className="w-5 h-5 text-primary flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <h1 className="text-base md:text-lg font-bold text-text-heading">지식 위키</h1>
            {status && (
              <p className="text-[11px] md:text-xs text-text-muted truncate">
                {status.totalArticles}개 · 대기 {status.pendingQueueItems}건
                {status.lastIngestAt && ` · ${timeAgo(status.lastIngestAt)}`}
              </p>
            )}
          </div>
          {/* 모바일: 로그 토글 + 목록/상세 토글 */}
          <div className="flex items-center gap-1 md:hidden">
            <button
              onClick={() => setLogOpen(!logOpen)}
              className={`p-2 rounded-lg ${logOpen ? 'bg-primary text-white' : 'bg-bg-input text-text-muted'}`}
              aria-label="로그"
            >
              <Terminal className="w-4 h-4" />
            </button>
          </div>
        </div>
        {/* 액션 버튼 묶음 — 모바일에서 가로 스크롤 */}
        <div className="flex items-center gap-2 mt-2 md:mt-3 overflow-x-auto -mx-1 px-1 pb-1 md:flex-wrap md:overflow-visible">
          <button
            onClick={handleIngest}
            disabled={ingestLoading}
            className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50"
          >
            {ingestLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            Ingest
          </button>
          <button
            onClick={handleSynthesis}
            disabled={synthLoading}
            className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-sm bg-bg-input border border-border text-text-heading rounded-lg hover:bg-bg-hover disabled:opacity-50"
          >
            {synthLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            딥 리뷰
          </button>
          <button
            onClick={() => setLogOpen(!logOpen)}
            title="실시간 로그"
            className={`flex-shrink-0 hidden md:flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-border ${
              logOpen ? 'bg-primary text-white' : 'bg-bg-input text-text-muted hover:bg-bg-hover hover:text-text-heading'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            로그
            {isIngestRunning && <Loader2 className="w-3 h-3 animate-spin" />}
          </button>
          <button
            onClick={handleDiagnoseNotion}
            title="Notion 연결 상태 진단"
            className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-sm bg-bg-input border border-border text-text-muted rounded-lg hover:bg-bg-hover"
          >
            Notion 진단
          </button>
          <button
            onClick={handleResetNotion}
            disabled={ingestLoading}
            title="Notion 페이지 큐 초기화"
            className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-sm bg-bg-input border border-border text-text-muted rounded-lg hover:bg-bg-hover disabled:opacity-50"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            재처리
          </button>
          <button onClick={loadArticles} className="flex-shrink-0 p-1.5 text-text-muted hover:text-text-heading hover:bg-bg-hover rounded-lg">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Left panel — article list */}
        {/* 모바일: 아티클 선택 시 숨김, 데스크탑: 항상 표시 */}
        <div className={`${selectedId ? 'hidden md:flex' : 'flex'} w-full md:w-72 flex-shrink-0 border-r border-border flex-col min-h-0`}>
          {/* Search + filter */}
          <div className="p-3 space-y-2 border-b border-border">
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="제목, 태그 검색..."
              className="w-full bg-bg-input text-text-heading px-3 py-1.5 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary border border-border"
            />
            {/* Category chips */}
            <div className="flex flex-wrap gap-1">
              {CATEGORIES.map(c => (
                <button
                  key={c.value}
                  onClick={() => setCategoryFilter(c.value)}
                  className={`px-2 py-0.5 rounded text-xs transition-colors ${
                    categoryFilter === c.value
                      ? 'bg-primary text-white'
                      : 'bg-bg-input text-text-muted hover:bg-bg-hover border border-border'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          {/* Article list */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-5 h-5 animate-spin text-primary" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center px-4">
                <BookOpen className="w-8 h-8 text-text-muted mb-2" />
                <p className="text-sm text-text-muted">아티클이 없습니다</p>
                <p className="text-xs text-text-muted mt-1">Ingest를 실행하면 자동 생성됩니다</p>
              </div>
            ) : (
              filtered.map(article => (
                <button
                  key={article.id}
                  onClick={() => loadDetail(article.id)}
                  className={`w-full text-left px-3 py-3 border-b border-border hover:bg-bg-hover transition-colors ${
                    selectedId === article.id ? 'bg-primary-light border-l-2 border-l-primary' : ''
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <ChevronRight className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-text-muted transition-transform ${selectedId === article.id ? 'rotate-90 text-primary' : ''}`} />
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm font-medium truncate ${selectedId === article.id ? 'text-primary' : 'text-text-heading'}`}>
                        {article.title}
                      </p>
                      <div className="flex items-center gap-2 mt-1">
                        <CategoryBadge category={article.category} />
                        <span className="text-[10px] text-text-muted">v{article.version}</span>
                      </div>
                      {article.tags.length > 0 && (
                        <p className="text-[10px] text-text-muted mt-1 truncate">
                          {article.tags.slice(0, 3).join(' · ')}
                        </p>
                      )}
                      <p className="text-[10px] text-text-muted mt-0.5">{timeAgo(article.updatedAt)}</p>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>

          {/* Footer count */}
          <div className="px-3 py-2 border-t border-border">
            <p className="text-xs text-text-muted flex items-center gap-1">
              <Filter className="w-3 h-3" />
              {filtered.length}개 표시
            </p>
          </div>
        </div>

        {/* Right panel — article detail / editor */}
        {/* 모바일: 아티클 미선택 시 숨김 */}
        <div className={`${selectedId ? 'flex' : 'hidden md:flex'} flex-1 min-w-0 flex-col min-h-0`}>
          {!selectedId ? (
            <div className="flex-1 overflow-y-auto p-6 md:p-8">
              <div className="max-w-xl mx-auto">
                <div className="flex items-center gap-2 mb-3">
                  <BookOpen className="w-5 h-5 text-primary" />
                  <h2 className="text-base font-semibold text-text-heading">지식 위키 사용법</h2>
                </div>
                <p className="text-sm text-text-muted mb-4">
                  연구실의 프로젝트 · 미팅 · 인적 데이터 · 최신 동향을 통합한 연구 지식베이스입니다.
                  Notion / 미팅 노트 / GDrive 데이터를 매일 자동 수집하여 카테고리별 아티클로 정리합니다.
                </p>

                <div className="space-y-2 mb-6">
                  <div className="p-3 bg-bg-input rounded-lg border border-border">
                    <p className="text-xs font-medium text-text-heading mb-1">📂 카테고리 필터</p>
                    <p className="text-xs text-text-muted leading-relaxed">
                      상단 칩으로 연구원·과제·연구동향·미팅·실험·협업별로 좁혀볼 수 있습니다.
                    </p>
                  </div>
                  <div className="p-3 bg-bg-input rounded-lg border border-border">
                    <p className="text-xs font-medium text-text-heading mb-1">🔗 아티클 간 연결</p>
                    <p className="text-xs text-text-muted leading-relaxed">
                      본문에 나오는 <span className="text-primary">파란색 링크</span>를 누르면 관련 아티클로 바로 이동합니다 (예: 프로젝트 → 담당자, 미팅 → 관련 프로젝트).
                    </p>
                  </div>
                  <div className="p-3 bg-bg-input rounded-lg border border-border">
                    <p className="text-xs font-medium text-text-heading mb-1">🔍 검색</p>
                    <p className="text-xs text-text-muted leading-relaxed">
                      상단 검색창에 제목 또는 태그 일부를 입력하여 빠르게 찾을 수 있습니다.
                    </p>
                  </div>
                  <div className="p-3 bg-bg-input rounded-lg border border-border">
                    <p className="text-xs font-medium text-text-heading mb-1">⚡ 갱신</p>
                    <p className="text-xs text-text-muted leading-relaxed">
                      <span className="text-primary font-medium">Ingest</span> 버튼: Notion·GDrive에서 신규 변경만 가져와 반영.
                      <span className="text-primary font-medium"> 딥 리뷰</span> 버튼: 전체 위키 재분석 & 연결고리 발견.
                    </p>
                  </div>
                </div>

                {status && status.totalArticles === 0 ? (
                  <div className="p-4 bg-primary/10 rounded-xl border border-primary/30 text-sm text-text-heading">
                    아직 생성된 위키가 없습니다.<br />
                    <button onClick={handleIngest} className="text-primary font-medium underline mt-1">Ingest 버튼</button>을 눌러 시작하세요.
                  </div>
                ) : (
                  <p className="text-xs text-text-muted text-center md:text-left">
                    {status ? `${status.totalArticles}개 아티클 준비됨 — 좌측에서 선택하여 열람` : '아티클 로드 중...'}
                  </p>
                )}
              </div>
            </div>
          ) : detailLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : detail ? (
            <>
              {/* Article toolbar */}
              <div className="px-4 md:px-6 py-3 border-b border-border flex items-center gap-2 md:gap-3 flex-shrink-0">
                {/* 모바일 전용: 목록으로 돌아가기 */}
                <button
                  onClick={() => { setSelectedId(null); setDetail(null); }}
                  className="md:hidden p-1.5 text-text-muted hover:text-text-heading hover:bg-bg-hover rounded-lg"
                  aria-label="목록"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                {editing ? (
                  <>
                    <input
                      value={editTitle}
                      onChange={e => setEditTitle(e.target.value)}
                      className="flex-1 bg-bg-input text-text-heading px-3 py-1.5 rounded-lg text-sm font-semibold focus:outline-none focus:ring-1 focus:ring-primary border border-border"
                    />
                    <select
                      value={editCategory}
                      onChange={e => setEditCategory(e.target.value)}
                      className="bg-bg-input text-text-heading px-2 py-1.5 rounded-lg text-sm border border-border focus:outline-none focus:ring-1 focus:ring-primary"
                    >
                      {CATEGORIES.filter(c => c.value).map(c => (
                        <option key={c.value} value={c.value}>{c.label}</option>
                      ))}
                    </select>
                    <button
                      onClick={saveEdit}
                      disabled={saveLoading}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50"
                    >
                      {saveLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                      저장
                    </button>
                    <button
                      onClick={() => setEditing(false)}
                      className="p-1.5 text-text-muted hover:text-text-heading hover:bg-bg-hover rounded-lg"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </>
                ) : (
                  <>
                    <div className="flex-1 min-w-0">
                      <h2 className="text-base font-bold text-text-heading truncate">{detail.title}</h2>
                      <div className="flex items-center gap-2 mt-0.5">
                        <CategoryBadge category={detail.category} />
                        <span className="text-xs text-text-muted">v{detail.version}</span>
                        <span className="text-xs text-text-muted flex items-center gap-0.5">
                          <Clock className="w-3 h-3" />{timeAgo(detail.updatedAt)}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={startEdit}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-bg-input border border-border text-text-heading rounded-lg hover:bg-bg-hover transition-colors"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                      편집
                    </button>
                    <button
                      onClick={() => handleDelete(detail.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-red-500 hover:bg-red-50 border border-transparent hover:border-red-200 rounded-lg transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      삭제
                    </button>
                  </>
                )}
              </div>

              {/* Tags row */}
              {editing ? (
                <div className="px-6 py-2 border-b border-border flex-shrink-0">
                  <div className="flex items-center gap-2">
                    <Tag className="w-3.5 h-3.5 text-text-muted" />
                    <input
                      value={editTagsStr}
                      onChange={e => setEditTagsStr(e.target.value)}
                      placeholder="태그1, 태그2, 태그3 (쉼표 구분)"
                      className="flex-1 bg-bg-input text-text-heading px-2 py-1 rounded text-xs focus:outline-none focus:ring-1 focus:ring-primary border border-border"
                    />
                  </div>
                </div>
              ) : detail.tags.length > 0 ? (
                <div className="px-6 py-2 border-b border-border flex-shrink-0 flex flex-wrap gap-1.5">
                  {detail.tags.map(tag => (
                    <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 bg-bg-input border border-border rounded text-xs text-text-muted">
                      <Hash className="w-2.5 h-2.5" />{tag}
                    </span>
                  ))}
                </div>
              ) : null}

              {/* Content */}
              <div className="flex-1 overflow-y-auto">
                {editing ? (
                  <textarea
                    value={editContent}
                    onChange={e => setEditContent(e.target.value)}
                    className="w-full h-full px-4 md:px-6 py-4 bg-transparent text-text-heading text-sm font-mono resize-none focus:outline-none leading-relaxed"
                    placeholder="마크다운 내용을 입력하세요..."
                  />
                ) : (
                  <div className="px-4 md:px-6 py-4 prose prose-sm max-w-none dark:prose-invert">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: ({ href, children }) => {
                          // [[Title]] 위키링크 — 프리프로세싱 시 #wikilink:Title 로 변환된 href를 처리
                          if (href?.startsWith('#wikilink:')) {
                            const title = decodeURIComponent(href.slice('#wikilink:'.length));
                            const matched = articles.find(a => a.title === title);
                            if (matched) {
                              return (
                                <button
                                  type="button"
                                  onClick={() => loadDetail(matched.id)}
                                  className="text-primary hover:underline inline"
                                >
                                  {children}
                                </button>
                              );
                            }
                            return (
                              <span className="text-text-muted italic" title="연결된 아티클 없음">
                                {children}
                              </span>
                            );
                          }
                          return <a href={href} className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">{children}</a>;
                        },
                        code: ({ children, className }) => {
                          const isBlock = className?.startsWith('language-');
                          return isBlock ? (
                            <code className="block bg-bg-input border border-border rounded-lg px-4 py-3 text-xs overflow-x-auto font-mono">{children}</code>
                          ) : (
                            <code className="bg-bg-input border border-border rounded px-1.5 py-0.5 text-xs font-mono">{children}</code>
                          );
                        },
                        h1: ({ children }) => <h1 className="text-lg font-bold text-text-heading mt-4 mb-2">{children}</h1>,
                        h2: ({ children }) => <h2 className="text-base font-bold text-text-heading mt-3 mb-1.5">{children}</h2>,
                        h3: ({ children }) => <h3 className="text-sm font-semibold text-text-heading mt-2 mb-1">{children}</h3>,
                        p: ({ children }) => <p className="text-sm text-text-body leading-relaxed mb-2">{children}</p>,
                        ul: ({ children }) => <ul className="list-disc list-inside space-y-0.5 mb-2">{children}</ul>,
                        ol: ({ children }) => <ol className="list-decimal list-inside space-y-0.5 mb-2">{children}</ol>,
                        li: ({ children }) => <li className="text-sm text-text-body">{children}</li>,
                        blockquote: ({ children }) => <blockquote className="border-l-2 border-primary pl-3 text-text-muted italic">{children}</blockquote>,
                        table: ({ children }) => <div className="overflow-x-auto mb-2"><table className="text-sm border-collapse w-full">{children}</table></div>,
                        th: ({ children }) => <th className="border border-border px-3 py-1.5 text-left font-semibold bg-bg-input text-text-heading">{children}</th>,
                        td: ({ children }) => <td className="border border-border px-3 py-1.5 text-text-body">{children}</td>,
                        strong: ({ children }) => <strong className="font-semibold text-text-heading">{children}</strong>,
                        hr: () => <hr className="border-border my-3" />,
                      }}
                    >
                      {detail.content.replace(/\[\[([^\]]+)\]\]/g, (_: string, title: string) => `[${title}](#wikilink:${encodeURIComponent(title)})`)}
                    </ReactMarkdown>
                  </div>
                )}
              </div>

              {/* Sources footer */}
              {!editing && detail.sources && Array.isArray(detail.sources) && detail.sources.length > 0 && (
                <div className="px-6 py-2 border-t border-border flex-shrink-0 flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-text-muted">출처:</span>
                  {(detail.sources as Array<{ type: string; id: string; date?: string }>).map((s, i) => (
                    <span key={i} className="text-xs text-text-muted bg-bg-input border border-border px-1.5 py-0.5 rounded">
                      {s.type}{s.date ? ` · ${s.date}` : ''}
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>

      {/* 하단 로그 패널 — 열려있을 때만 표시 */}
      {logOpen && (
        <div className="h-56 md:h-64 border-t border-border bg-black/95 flex flex-col flex-shrink-0">
          <div className="px-3 py-2 flex items-center justify-between border-b border-white/10 flex-shrink-0">
            <div className="flex items-center gap-2 text-xs text-white">
              <Terminal className="w-3.5 h-3.5" />
              <span className="font-semibold">Ingest 실시간 로그</span>
              {isIngestRunning && (
                <span className="flex items-center gap-1 text-green-400">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  실행 중
                </span>
              )}
              <span className="text-white/40">({logs.length}개)</span>
            </div>
            <button
              onClick={() => setLogOpen(false)}
              className="p-1 text-white/60 hover:text-white hover:bg-white/10 rounded"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed">
            {logs.length === 0 ? (
              <p className="text-white/40">Ingest를 시작하면 로그가 표시됩니다</p>
            ) : (
              logs.map((ev, i) => {
                const time = new Date(ev.ts).toLocaleTimeString('ko-KR', { hour12: false });
                const color =
                  ev.level === 'error' ? 'text-red-400' :
                  ev.level === 'warn' ? 'text-yellow-400' :
                  ev.level === 'progress' ? 'text-cyan-300' :
                  'text-green-300';
                return (
                  <div key={i} className="flex gap-2">
                    <span className="text-white/40 flex-shrink-0">{time}</span>
                    <span className={`${color} flex-shrink-0 w-14`}>[{ev.level}]</span>
                    <span className="text-white/90 break-all">{ev.message}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
