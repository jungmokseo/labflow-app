'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  getEmailStatus, getEmailAuthUrl, getEmailProfile, checkHealth,
  getLabProfile, updateLab, getLabMembers, addLabMember, removeLabMember,
  getLabDictionary, addDictEntry, getLabCompleteness,
  updateEmailProfile, LabProfile,
  getErrorLogs, getErrorSummary, resolveError, resolveAllErrors, cleanupOldErrors,
  type ErrorLogEntry, type ErrorSummary,
  getSettingsSummary, deleteBrainInstruction, deleteBriefingInstruction,
  deleteImportanceRule, deleteKeyword, type SettingsSummary,
  testModels,
  getModelUsage,
  type ModelUsageResult,
  getCronStatus,
  runAllCrons,
  type CronStatusResult,
  type CronRunAllResult,
} from '@/lib/api';
import { SettingsSkeleton } from '@/components/Skeleton';
import { useToast } from '@/components/Toast';
import { BarChart3, FlaskConical, Mail, BookOpen, Settings as SettingsIcon, AlertTriangle, Brain, Trash2 } from 'lucide-react';

type Tab = 'status' | 'lab' | 'email' | 'dictionary' | 'errors' | 'ai-instructions';

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('status');
  const [health, setHealth] = useState<boolean | null>(null);
  const [emailConnected, setEmailConnected] = useState(false);
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [calendarMessage, setCalendarMessage] = useState<string | null>(null);
  const [lab, setLab] = useState<LabProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorCount, setErrorCount] = useState(0);

  useEffect(() => {
    async function load() {
      try {
        const [h, emailRes, labRes, errRes] = await Promise.allSettled([
          checkHealth(),
          getEmailStatus(),
          getLabProfile(),
          getErrorSummary(),
        ]);
        if (h.status === 'fulfilled') setHealth(h.value);
        if (emailRes.status === 'fulfilled') {
          setEmailConnected(emailRes.value.connected);
          setCalendarConnected(emailRes.value.calendarConnected ?? false);
          setCalendarMessage(emailRes.value.calendarMessage ?? null);
        }
        if (labRes.status === 'fulfilled') setLab(labRes.value as any);
        if (errRes.status === 'fulfilled') setErrorCount(errRes.value.totalUnresolved);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) return <SettingsSkeleton />;

  const TAB_ICONS: Record<Tab, React.ReactNode> = {
    status: <BarChart3 className="w-4 h-4 inline mr-1" />,
    lab: <FlaskConical className="w-4 h-4 inline mr-1" />,
    email: <Mail className="w-4 h-4 inline mr-1" />,
    dictionary: <BookOpen className="w-4 h-4 inline mr-1" />,
    errors: <AlertTriangle className="w-4 h-4 inline mr-1" />,
    'ai-instructions': <Brain className="w-4 h-4 inline mr-1" />,
  };

  const TABS: { key: Tab; label: string; badge?: number }[] = [
    { key: 'status', label: '시스템 상태' },
    { key: 'ai-instructions', label: 'AI 지침' },
    { key: 'lab', label: '연구실 프로필' },
    { key: 'email', label: '이메일 분류' },
    { key: 'dictionary', label: '용어 사전' },
    { key: 'errors', label: '에러 로그', badge: errorCount || undefined },
  ];

  return (
    <div className="min-h-full pb-20 md:pb-12">
      {/* Standard header */}
      <div className="px-4 md:px-8 pt-4 md:pt-8 pb-4">
        <div className="flex items-center gap-3 mb-1">
          <span className="w-1 h-9 md:h-11 bg-primary rounded-full flex-shrink-0" />
          <div className="min-w-0">
            <h1 className="text-2xl md:text-3xl font-bold text-text-heading tracking-tight flex items-center gap-2 leading-tight">
              <SettingsIcon className="w-6 h-6 text-primary flex-shrink-0" /> 설정
            </h1>
            <p className="text-sm md:text-base text-text-muted mt-1">연구실 설정 및 프로필 관리</p>
          </div>
        </div>
      </div>

      <div className="px-4 md:px-8 max-w-4xl mx-auto space-y-4 md:space-y-6">
        {/* Tab Navigation — 모바일에서 가로 스크롤 */}
        <div className="overflow-x-auto -mx-1 px-1 pb-0.5">
          <div className="flex gap-1 bg-bg-card rounded-lg p-1 border border-border min-w-max md:min-w-0">
            {TABS.map(t => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`flex-shrink-0 py-2 px-3 rounded-md text-sm font-medium transition-colors relative whitespace-nowrap
                  ${tab === t.key ? 'bg-primary text-white' : 'text-text-muted hover:text-text-heading hover:bg-bg-hover'}`}
              >
                {TAB_ICONS[t.key]} {t.label}
                {t.badge ? <span className="ml-1 px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-red-500 text-white">{t.badge}</span> : null}
              </button>
            ))}
          </div>
        </div>

        {tab === 'status' && <StatusTab health={health} emailConnected={emailConnected} calendarConnected={calendarConnected} calendarMessage={calendarMessage} lab={lab} />}
        {tab === 'ai-instructions' && <AIInstructionsTab />}
        {tab === 'lab' && <LabTab lab={lab} onUpdate={setLab} />}
        {tab === 'email' && <EmailTab connected={emailConnected} />}
        {tab === 'dictionary' && <DictionaryTab />}
        {tab === 'errors' && <ErrorLogTab onCountChange={setErrorCount} />}
      </div>
    </div>
  );
}

// ── AI Instructions Tab ──────────────────────────
function AIInstructionsTab() {
  const [data, setData] = useState<SettingsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    getSettingsSummary().then(setData).catch(() => {}).finally(() => setLoading(false));
  }, []);

  async function handleDelete(type: string, indexOrValue: number | string) {
    const key = `${type}-${indexOrValue}`;
    setDeleting(key);
    try {
      if (type === 'brain' && typeof indexOrValue === 'number') {
        const res = await deleteBrainInstruction(indexOrValue);
        setData(prev => prev ? { ...prev, brain: { ...prev.brain, instructions: res.instructions } } : prev);
      } else if (type === 'briefing' && typeof indexOrValue === 'number') {
        const res = await deleteBriefingInstruction(indexOrValue);
        setData(prev => prev ? { ...prev, email: { ...prev.email, briefingInstructions: res.instructions } } : prev);
      } else if (type === 'rule' && typeof indexOrValue === 'number') {
        const res = await deleteImportanceRule(indexOrValue);
        setData(prev => prev ? { ...prev, email: { ...prev.email, importanceRules: res.importanceRules } } : prev);
      } else if (type === 'keyword' && typeof indexOrValue === 'string') {
        const res = await deleteKeyword(indexOrValue);
        setData(prev => prev ? { ...prev, email: { ...prev.email, keywords: res.keywords } } : prev);
      }
    } catch { /* ignore */ } finally {
      setDeleting(null);
    }
  }

  if (loading) return <div className="py-8 text-center text-text-muted text-sm">불러오는 중...</div>;
  if (!data) return <div className="py-8 text-center text-text-muted text-sm">설정을 불러오지 못했습니다.</div>;

  const isEmpty = data.brain.instructions.length === 0 && data.email.briefingInstructions.length === 0 && data.email.importanceRules.length === 0 && data.email.keywords.length === 0;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-text-heading mb-1">AI 지침 관리</h3>
        <p className="text-sm text-text-muted">Brain과의 대화에서 "기억해줘"로 저장된 모든 설정을 확인하고 삭제할 수 있습니다.</p>
      </div>

      {isEmpty && (
        <div className="text-center py-10 text-text-muted text-sm border border-dashed border-border rounded-xl">
          저장된 지침이 없습니다.<br />Brain에서 "다음부터 ~해줘. 기억해줘" 라고 말하면 여기에 나타납니다.
        </div>
      )}

      {/* Brain 응답 지침 */}
      <InstructionSection
        title="Brain 응답 지침"
        description="Brain이 답변할 때 항상 따르는 규칙입니다."
        items={data.brain.instructions.map((inst, i) => ({
          label: inst,
          onDelete: () => handleDelete('brain', i),
          deleteKey: `brain-${i}`,
        }))}
        deleting={deleting}
        badge={data.brain.responseStyle !== 'formal' ? `스타일: ${data.brain.responseStyle === 'casual' ? '캐주얼' : data.brain.responseStyle}` : undefined}
        emptyText="저장된 Brain 지침 없음"
      />

      {/* 이메일 브리핑 지침 */}
      <InstructionSection
        title="이메일 브리핑 형식"
        description="이메일 브리핑 출력 형식에 관한 설정입니다."
        items={data.email.briefingInstructions.map((inst, i) => ({
          label: inst,
          onDelete: () => handleDelete('briefing', i),
          deleteKey: `briefing-${i}`,
        }))}
        deleting={deleting}
        emptyText="저장된 브리핑 지침 없음"
      />

      {/* 이메일 중요도 규칙 */}
      {(data.email.importanceRules.length > 0) && (
        <div className="bg-bg-card rounded-xl border border-border p-5 space-y-3">
          <div>
            <p className="font-medium text-text-heading text-sm">이메일 중요도 규칙</p>
            <p className="text-xs text-text-muted mt-0.5">이메일 분류 시 자동으로 적용되는 규칙입니다.</p>
          </div>
          <div className="space-y-2">
            {data.email.importanceRules.map((rule, i) => (
              <div key={i} className="flex items-start gap-2 bg-bg-input rounded-lg px-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-text-heading">{rule.condition}</p>
                  <p className="text-xs text-primary mt-0.5">→ {rule.action}</p>
                  {rule.description && <p className="text-xs text-text-muted mt-0.5">{rule.description}</p>}
                </div>
                <DeleteButton onClick={() => handleDelete('rule', i)} loading={deleting === `rule-${i}`} />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 이메일 중요도 키워드 */}
      {(data.email.keywords.length > 0) && (
        <div className="bg-bg-card rounded-xl border border-border p-5 space-y-3">
          <div>
            <p className="font-medium text-text-heading text-sm">이메일 중요도 키워드</p>
            <p className="text-xs text-text-muted mt-0.5">이 키워드가 이메일 제목/본문에 포함되면 중요도 1단계 상향됩니다.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {data.email.keywords.map((kw) => (
              <span key={kw} className="flex items-center gap-1.5 bg-primary/10 text-primary text-xs px-3 py-1.5 rounded-full">
                {kw}
                <button
                  onClick={() => handleDelete('keyword', kw)}
                  disabled={deleting === `keyword-${kw}`}
                  className="hover:text-red-400 transition-colors disabled:opacity-40"
                >
                  {deleting === `keyword-${kw}` ? <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin inline-block" /> : <Trash2 className="w-3 h-3" />}
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function InstructionSection({ title, description, items, deleting, badge, emptyText }: {
  title: string;
  description: string;
  items: Array<{ label: string; onDelete: () => void; deleteKey: string }>;
  deleting: string | null;
  badge?: string;
  emptyText: string;
}) {
  if (items.length === 0 && !badge) return null;
  return (
    <div className="bg-bg-card rounded-xl border border-border p-5 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium text-text-heading text-sm">{title}</p>
          <p className="text-xs text-text-muted mt-0.5">{description}</p>
        </div>
        {badge && <span className="text-xs bg-bg-input text-text-muted px-2 py-1 rounded-full flex-shrink-0">{badge}</span>}
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-text-muted italic">{emptyText}</p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.deleteKey} className="flex items-center gap-2 bg-bg-input rounded-lg px-3 py-2.5">
              <p className="flex-1 text-sm text-text-heading">{item.label}</p>
              <DeleteButton onClick={item.onDelete} loading={deleting === item.deleteKey} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DeleteButton({ onClick, loading }: { onClick: () => void; loading: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="flex-shrink-0 p-1.5 text-text-muted hover:text-red-400 hover:bg-bg-hover rounded-lg transition-colors disabled:opacity-40"
      title="삭제"
    >
      {loading
        ? <span className="w-3.5 h-3.5 border border-current border-t-transparent rounded-full animate-spin inline-block" />
        : <Trash2 className="w-3.5 h-3.5" />}
    </button>
  );
}

// ── Status Tab ──────────────────────────────────
function StatusTab({ health, emailConnected, calendarConnected, calendarMessage, lab }: { health: boolean | null; emailConnected: boolean; calendarConnected: boolean; calendarMessage: string | null; lab: LabProfile | null }) {
  const { toast } = useToast();
  const [connecting, setConnecting] = useState(false);

  // popup blocker 우회 — user gesture 시점에 즉시 빈 창 열고, await 후 URL 주입.
  // 차단되면 same-tab redirect로 fallback.
  const handleConnectGmail = async () => {
    if (connecting) return;
    setConnecting(true);
    const popup = typeof window !== 'undefined' ? window.open('about:blank', '_blank') : null;
    try {
      const res = await getEmailAuthUrl();
      const authUrl = res.url || res.authUrl;
      if (!authUrl) throw new Error('OAuth URL이 응답에 없습니다');
      if (popup && !popup.closed) {
        popup.location.href = authUrl;
      } else {
        // 팝업 차단됨 → 같은 탭에서 이동
        window.location.href = authUrl;
      }
    } catch (err: any) {
      if (popup) popup.close();
      const msg = err?.message || '재연동 실패';
      toast(`Gmail 재연동 실패: ${msg.slice(0, 100)}`, 'error');
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className="bg-bg-card rounded-xl border border-border p-4 md:p-5 space-y-4">
        <h3 className="font-semibold text-text-heading text-base">시스템 상태</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 md:gap-3">
          <StatusItem label="API 서버" status={health === true ? 'healthy' : 'error'} detail="Railway" />
          <StatusItem label="Gmail" status={emailConnected ? 'healthy' : 'disconnected'} detail={emailConnected ? '연동됨' : '미연동'} />
          <StatusItem label="Calendar" status={calendarConnected ? 'healthy' : 'error'} detail={calendarConnected ? '연동됨' : calendarMessage || '미연동'} />
          <StatusItem label="연구실" status={lab ? 'healthy' : 'disconnected'} detail={lab ? lab.name : '미설정'} />
          <StatusItem label="AI 비서" status="info" detail="활성화됨" />
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={handleConnectGmail}
            disabled={connecting}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium disabled:opacity-50"
          >
            {connecting && <span className="w-3.5 h-3.5 border border-white border-t-transparent rounded-full animate-spin" />}
            {connecting
              ? '재연동 중…'
              : (emailConnected ? 'Gmail 재연동 (토큰 갱신)' : 'Gmail 연동하기')}
          </button>
          {!calendarConnected && (
            <p className="text-xs text-text-muted/80 self-center">
              💡 Calendar 연동도 같은 OAuth로 함께 처리됩니다 (재연동 후 자동 활성)
            </p>
          )}
        </div>
      </section>

      <ModelValidationSection />
      <CronDiagnosticsSection />
    </div>
  );
}

// ── 모델 ID → AiCostLog service 매핑 (cost-logger.ts deriveService와 동일) ──
// 대시보드에서 model 단위 → service 단위로 사용량 집계 표시.
function modelToService(modelId: string): string {
  if (modelId.startsWith('claude')) {
    if (modelId.includes('opus')) return 'claude-opus';
    if (modelId.includes('haiku')) return 'claude-haiku';
    return 'claude-sonnet';
  }
  if (modelId.startsWith('gemini')) {
    return modelId.includes('pro') ? 'gemini-pro' : 'gemini-flash';
  }
  if (modelId.startsWith('gpt-realtime') || modelId.startsWith('gpt-4o-realtime')) return 'openai-realtime';
  if (modelId.startsWith('text-embedding')) return 'openai-embedding';
  return 'unknown';
}

// $0.0012 → "$0.001", $1.234 → "$1.23", $123.456 → "$123" 형태로 표시
function formatCost(usd: number): string {
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd)}`;
}

function formatCount(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

// ── Model Validation Section (OWNER 전용 — production env 키로 모든 AI 모델 ID 실측) ──
// 회사별(Anthropic / Google Gemini / OpenAI) 카드 대시보드.
// 검증 실행 전에도 현재 사용 중인 모델 카탈로그(id + 사용처)를 default로 표시.
// 사용량(today/7d/30d) 자동 로드 — AiCostLog에서 service별 집계.
function ModelValidationSection() {
  const { toast } = useToast();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof testModels>> | null>(null);
  const [usage, setUsage] = useState<ModelUsageResult | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const u = await getModelUsage();
        if (!cancelled) setUsage(u);
      } catch {
        // 사용량 fetch 실패해도 대시보드 렌더링은 계속
      } finally {
        if (!cancelled) setUsageLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 검증 실행 전 default 카탈로그 (백엔드 응답과 동일 구조)
  const defaultProviders = [
    {
      name: 'Anthropic',
      icon: '🅰️',
      envVar: 'ANTHROPIC_API_KEY',
      envSet: true,
      models: [
        { id: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', usage: '기본 LLM — 이메일 분류·brain chat·논문 분석·모든 cron 자동화', ok: false },
        { id: 'claude-opus-4-7', displayName: 'Opus 4.7', usage: 'papers tool·paper deep summary·wiki deep synthesis (1M context)', ok: false },
      ],
    },
    {
      name: 'Google Gemini',
      icon: '🟦',
      envVar: 'GEMINI_API_KEY',
      envSet: true,
      models: [
        { id: 'gemini-3.1-flash-lite', displayName: 'Flash-Lite (stable)', usage: '경량 작업 — 이메일 stage1·capture classify·calendar 추출·STT·번역·labflow-member chat lite', ok: false },
        { id: 'gemini-3.1-pro-preview', displayName: 'Pro Preview', usage: 'labflow-member RAG engine (rag-engine.ts)', ok: false },
        { id: 'gemini-3.1-pro-preview-customtools', displayName: 'Pro Custom Tools', usage: 'labflow-member FAQ tool-use (chat.ts·slack-command.ts /질문)', ok: false },
      ],
    },
    {
      name: 'OpenAI',
      icon: '🟢',
      envVar: 'OPENAI_API_KEY',
      envSet: true,
      models: [
        { id: 'gpt-realtime-2', displayName: 'Realtime 2', usage: 'labflow-app voice chatbot (routes/voice-chatbot.ts)', ok: false },
        { id: 'text-embedding-3-small', displayName: 'Embedding 3 Small', usage: 'labflow-member RAG embedding (paper/wiki/memo). 변경 시 전체 재인덱싱 필요', ok: false },
      ],
    },
  ];

  const handleTest = async () => {
    if (running) return;
    setRunning(true);
    try {
      const r = await testModels();
      setResult(r);
      const okCount = r.providers.reduce((s, p) => s + p.models.filter(m => m.ok).length, 0);
      const totalCount = r.providers.reduce((s, p) => s + p.models.length, 0);
      toast(
        r.ok ? `✅ ${okCount}/${totalCount} 모델 정상` : `⚠️ ${okCount}/${totalCount} 모델 정상 — 일부 실패`,
        r.ok ? 'success' : 'error',
      );
    } catch (err: any) {
      const msg = err?.message?.slice(0, 200) ?? 'unknown';
      toast(`모델 검증 실패: ${msg}`, 'error');
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  // 백엔드 응답이 providers를 안 보내면 (legacy) defaultProviders 사용
  const providers = result?.providers && result.providers.length > 0
    ? result.providers
    : defaultProviders;
  const hasResult = !!result;

  const totalModels = providers.reduce((s, p) => s + p.models.length, 0);
  const okModels = providers.reduce((s, p) => s + p.models.filter(m => m.ok).length, 0);

  return (
    <section className="bg-bg-card rounded-xl border border-border p-4 md:p-5 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="font-semibold text-text-heading text-base flex items-center gap-2">
            🔍 AI 모델 대시보드
            {hasResult && (
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                result?.ok
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
              }`}>
                {okModels}/{totalModels} 정상
              </span>
            )}
          </h3>
          <p className="text-xs text-text-muted mt-1">
            현재 labflow-app·labflow-member가 사용하는 모든 AI 모델 ID + 실제 사용량(USD).
            검증 실행 시 production env 키로 minimal API call하여 실측 상태 표시.
          </p>
        </div>
        <button
          onClick={handleTest}
          disabled={running}
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium disabled:opacity-50 whitespace-nowrap"
        >
          {running && <span className="w-3.5 h-3.5 border border-white border-t-transparent rounded-full animate-spin" />}
          {running ? '검증 중… (~20초)' : hasResult ? '🔄 재검증' : '🔬 검증 실행'}
        </button>
      </div>

      {/* 전체 사용량 요약 */}
      {!usageLoading && usage && (
        <div className="grid grid-cols-3 gap-2 text-center">
          <UsageTotalCard label="오늘" cost={usage.totals.today} />
          <UsageTotalCard label="최근 7일" cost={usage.totals.last7} />
          <UsageTotalCard label="최근 30일" cost={usage.totals.last30} />
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {providers.map(provider => (
          <ProviderCard
            key={provider.name}
            provider={provider}
            hasResult={hasResult}
            usage={usage}
            usageLoading={usageLoading}
          />
        ))}
      </div>

      <p className="text-[11px] text-text-muted/70 border-t border-border pt-3 space-y-1">
        {hasResult && (
          <>❌ fail이면 그 모델 ID가 invalid/deprecated. 즉시 코드 수정 필요.{' '}</>
        )}
        💰 사용량은 <code className="font-mono">ai_cost_logs</code> 테이블 최근 30일 데이터 — AiCostLog 비용 추정치.
        OpenAI Realtime/Embedding은 client-side 호출 또는 미연결로 측정 불가 (OpenAI dashboard에서 직접 확인).
      </p>
    </section>
  );
}

function UsageTotalCard({ label, cost }: { label: string; cost: number }) {
  return (
    <div className="rounded-lg border border-border bg-bg p-2">
      <div className="text-[10px] text-text-muted uppercase tracking-wide">{label}</div>
      <div className="text-lg font-bold text-text-heading mt-0.5">{formatCost(cost)}</div>
    </div>
  );
}

function ProviderCard({
  provider,
  hasResult,
  usage,
  usageLoading,
}: {
  provider: {
    name: string;
    icon: string;
    envVar: string;
    envSet: boolean;
    models: Array<{
      id: string;
      displayName: string;
      usage: string;
      ok: boolean;
      ms?: number;
      output?: string;
      error?: string;
    }>;
  };
  hasResult: boolean;
  usage: ModelUsageResult | null;
  usageLoading: boolean;
}) {
  const okCount = provider.models.filter(m => m.ok).length;
  const totalCount = provider.models.length;
  const allOk = hasResult && okCount === totalCount;
  const anyFail = hasResult && okCount < totalCount;

  // 이 provider의 모든 모델 service를 모아서 합산
  const providerServices = Array.from(new Set(provider.models.map(m => modelToService(m.id))));
  const providerTotal = (bucket?: Record<string, { cost: number; count: number }>) => {
    if (!bucket) return { cost: 0, count: 0 };
    return providerServices.reduce(
      (acc, svc) => {
        const b = bucket[svc];
        if (b) { acc.cost += b.cost; acc.count += b.count; }
        return acc;
      },
      { cost: 0, count: 0 },
    );
  };
  const todayTotal = providerTotal(usage?.today);
  const last7Total = providerTotal(usage?.last7);
  const last30Total = providerTotal(usage?.last30);

  // OpenAI는 서버 측정 불가 (voice-chatbot client WebSocket, embedding 미연결)
  const isOpenAI = provider.name === 'OpenAI';

  return (
    <div className={`rounded-lg border p-3 space-y-2 ${
      allOk ? 'border-emerald-500/30 bg-emerald-500/5'
        : anyFail ? 'border-red-500/30 bg-red-500/5'
        : 'border-border bg-bg'
    }`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-base shrink-0">{provider.icon}</span>
          <span className="font-semibold text-text-heading text-sm truncate">{provider.name}</span>
        </div>
        {hasResult && (
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${
            allOk ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
              : 'bg-red-500/15 text-red-700 dark:text-red-300'
          }`}>
            {okCount}/{totalCount}
          </span>
        )}
      </div>

      {!provider.envSet && (
        <div className="text-[10px] text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded px-1.5 py-1">
          ⚠ {provider.envVar} 미설정
        </div>
      )}

      {/* Provider 단위 사용량 요약 */}
      {!usageLoading && usage && !isOpenAI && (
        <div className="grid grid-cols-3 gap-1 text-center text-[10px] bg-bg-card/50 rounded p-1.5">
          <div>
            <div className="text-text-muted">오늘</div>
            <div className="font-semibold text-text-heading">{formatCost(todayTotal.cost)}</div>
            <div className="text-text-muted">{formatCount(todayTotal.count)}회</div>
          </div>
          <div>
            <div className="text-text-muted">7일</div>
            <div className="font-semibold text-text-heading">{formatCost(last7Total.cost)}</div>
            <div className="text-text-muted">{formatCount(last7Total.count)}회</div>
          </div>
          <div>
            <div className="text-text-muted">30일</div>
            <div className="font-semibold text-text-heading">{formatCost(last30Total.cost)}</div>
            <div className="text-text-muted">{formatCount(last30Total.count)}회</div>
          </div>
        </div>
      )}
      {!usageLoading && isOpenAI && (
        <div className="text-[10px] text-text-muted bg-bg-card/50 rounded p-1.5 text-center">
          💡 서버 측정 불가 — <a href="https://platform.openai.com/usage" target="_blank" rel="noreferrer" className="text-primary hover:underline">OpenAI dashboard</a>에서 확인
        </div>
      )}

      <div className="space-y-1.5">
        {provider.models.map(model => (
          <ModelRow
            key={model.id}
            model={model}
            hasResult={hasResult}
            usage={usage}
          />
        ))}
      </div>
    </div>
  );
}

function ModelRow({
  model,
  hasResult,
  usage,
}: {
  model: {
    id: string;
    displayName: string;
    usage: string;
    ok: boolean;
    ms?: number;
    output?: string;
    error?: string;
  };
  hasResult: boolean;
  usage: ModelUsageResult | null;
}) {
  const service = modelToService(model.id);
  const last7 = usage?.last7?.[service];

  return (
    <div className={`rounded border px-2 py-1.5 text-[11px] ${
      hasResult
        ? model.ok
          ? 'bg-emerald-500/5 border-emerald-500/30'
          : 'bg-red-500/5 border-red-500/30'
        : 'bg-bg-card border-border'
    }`}>
      <div className="flex items-center justify-between gap-2">
        <span className={`font-medium ${
          hasResult
            ? model.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-red-700 dark:text-red-300'
            : 'text-text-heading'
        }`}>
          {hasResult ? (model.ok ? '✅' : '❌') : '○'} {model.displayName}
        </span>
        {typeof model.ms === 'number' && (
          <span className="text-text-muted shrink-0">{model.ms}ms</span>
        )}
      </div>
      <div className="font-mono text-[10px] text-text-muted mt-0.5 break-all">{model.id}</div>
      <div className="text-[10px] text-text-muted mt-0.5 leading-snug">{model.usage}</div>
      {/* service 단위 사용량 — 같은 service의 다른 모델과 합산되므로 service 표기 */}
      {last7 && last7.count > 0 && (
        <div className="text-[10px] text-text-muted/80 mt-1 font-mono">
          📊 7일: {formatCost(last7.cost)} · {formatCount(last7.count)}회
          <span className="text-text-muted/50 ml-1">({service})</span>
        </div>
      )}
      {hasResult && model.output && (
        <div className="text-[10px] text-text-muted mt-1 break-all">→ {model.output.slice(0, 120)}</div>
      )}
      {hasResult && model.error && (
        <div className="text-[10px] text-red-500 mt-1 break-all">⚠ {model.error.slice(0, 180)}</div>
      )}
    </div>
  );
}

// ── Lab Profile Tab ─────────────────────────────
function LabTab({ lab, onUpdate }: { lab: LabProfile | null; onUpdate: (l: LabProfile) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(lab?.name || '');
  const [institution, setInstitution] = useState(lab?.institution || '');
  const [department, setDepartment] = useState(lab?.department || '');
  const [themes, setThemes] = useState<Array<{ name: string; keywords: string; journals: string }>>(
    (lab?.researchThemes || []).map(t => ({
      name: t.name,
      keywords: t.keywords.join(', '),
      journals: (t.journals || []).join(', '),
    }))
  );
  const [instructions, setInstructions] = useState((lab as any)?.instructions || '');
  const [members, setMembers] = useState<Array<{ id: string; name: string; email: string; role: string }>>([]);
  const [newMember, setNewMember] = useState({ name: '', email: '', role: '학생' });
  const [saving, setSaving] = useState(false);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [memberLoaded, setMemberLoaded] = useState(false);

  const loadMembers = useCallback(async () => {
    try {
      const res = await getLabMembers();
      setMembers(Array.isArray(res) ? res : (res as any).data || []);
      setMemberLoaded(true);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { if (lab) loadMembers(); }, [lab, loadMembers]);

  if (!lab) {
    return (
      <div className="bg-bg-card rounded-xl border border-border p-12 text-center">
        <FlaskConical className="w-12 h-12 text-text-muted/40 mx-auto mb-3" />
        <h3 className="text-lg font-semibold text-text-heading mb-2">연구실이 등록되지 않았습니다</h3>
        <p className="text-sm text-text-muted mt-2">관리자에게 연구실 설정을 요청하세요.</p>
      </div>
    );
  }

  const handleSave = async () => {
    const validThemes = themes.filter(t => t.name.trim()).map(t => ({
      name: t.name.trim(),
      keywords: t.keywords.split(',').map(k => k.trim()).filter(Boolean),
      journals: t.journals ? t.journals.split(',').map(j => j.trim()).filter(Boolean) : [],
    }));

    // Optimistic: update UI immediately
    const optimistic = {
      ...lab!,
      name, institution, department,
      researchThemes: validThemes,
      researchFields: validThemes.flatMap(t => t.keywords),
    };
    onUpdate(optimistic as any);
    setEditing(false);

    try {
      const updated = await updateLab({
        name, institution, department,
        researchThemes: validThemes,
        researchFields: validThemes.flatMap(t => t.keywords),
      });
      onUpdate(updated as any);
    } catch {
      onUpdate(lab!); // rollback
    }
  };

  const handleAddMember = async () => {
    if (!newMember.name.trim()) return;
    // Optimistic: append immediately
    const tempId = `temp-${Date.now()}`;
    const optimisticMember = { id: tempId, ...newMember };
    setMembers(prev => [...prev, optimisticMember]);
    setNewMember({ name: '', email: '', role: '학생' });
    try {
      await addLabMember(newMember);
      loadMembers(); // sync real IDs
    } catch {
      setMembers(prev => prev.filter(m => m.id !== tempId)); // rollback
    }
  };

  const handleRemoveMember = async (id: string) => {
    if (!confirm('삭제하시겠습니까?')) return;
    // Optimistic: remove immediately
    const prev = members;
    setMembers(members.filter(m => m.id !== id));
    try {
      await removeLabMember(id);
    } catch (err: any) {
      setMembers(prev); // rollback
      alert(`삭제 실패: ${err.message}`);
    }
  };

  return (
    <div className="space-y-4">
      {/* Lab Info */}
      <section className="bg-bg-card rounded-xl border border-border p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-text-heading text-base">연구실 정보</h3>
          <button onClick={() => setEditing(!editing)} className="text-xs text-primary hover:text-primary-hover">
            {editing ? '취소' : '편집'}
          </button>
        </div>
        {editing ? (
          <div className="space-y-3">
            <SInput label="연구실 이름" value={name} onChange={setName} />
            <SInput label="소속 기관" value={institution} onChange={setInstitution} />
            <SInput label="학과" value={department} onChange={setDepartment} />
            <button onClick={handleSave} disabled={saving} className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium disabled:opacity-50">
              {saving ? '저장 중...' : '저장'}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><span className="text-text-muted">이름:</span> <span className="text-text-heading">{lab.name}</span></div>
            <div><span className="text-text-muted">기관:</span> <span className="text-text-heading">{lab.institution || '-'}</span></div>
            <div><span className="text-text-muted">학과:</span> <span className="text-text-heading">{lab.department || '-'}</span></div>
          </div>
        )}
      </section>

      {/* Research Themes — 독립 편집 */}
      <section className="bg-bg-card rounded-xl border border-border p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-text-heading text-base">연구 테마 (이메일 분류 + 논문 모니터링 연동)</h3>
          {!editing && (
            <button onClick={() => setEditing(true)} className="text-xs text-primary hover:text-primary-hover">
              편집
            </button>
          )}
        </div>
        {themes.length === 0 && !editing && (
          <div className="text-center py-6">
            <p className="text-text-muted text-sm mb-3">연구 테마가 등록되지 않았습니다</p>
            <button onClick={() => { setEditing(true); setThemes([{ name: '', keywords: '', journals: '' }]); }}
              className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium">
              + 연구 테마 추가
            </button>
          </div>
        )}
        {(editing ? themes : (lab.researchThemes || []).map(t => ({
          name: t.name, keywords: t.keywords.join(', '), journals: (t.journals || []).join(', ')
        }))).map((theme, i) => (
          <div key={i} className="bg-bg-input rounded-lg p-3 space-y-2">
            {editing ? (
              <>
                <SInput label={`테마 ${i+1}`} value={theme.name} onChange={v => { const n = [...themes]; n[i].name = v; setThemes(n); }} />
                <SInput label="키워드 (쉼표 구분)" value={theme.keywords} onChange={v => { const n = [...themes]; n[i].keywords = v; setThemes(n); }} placeholder="hydrogel, self-healing, tough hydrogel" />
                <SInput label="관련 저널 (선택)" value={theme.journals} onChange={v => { const n = [...themes]; n[i].journals = v; setThemes(n); }} placeholder="Adv. Mater., Nat. Mater." />
                <button onClick={() => setThemes(themes.filter((_, j) => j !== i))} className="text-xs text-red-400 hover:text-red-300">삭제</button>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-text-heading">{theme.name}</p>
                <p className="text-xs text-text-muted">키워드: {theme.keywords}</p>
                {theme.journals && <p className="text-xs text-text-muted">저널: {theme.journals}</p>}
              </>
            )}
          </div>
        ))}
        {editing && (
          <div className="flex items-center gap-3">
            <button onClick={() => setThemes([...themes, { name: '', keywords: '', journals: '' }])} className="text-xs text-primary">+ 테마 추가</button>
            <button onClick={handleSave} disabled={saving} className="px-4 py-2 bg-primary text-white rounded-lg text-xs font-medium disabled:opacity-50 ml-auto">
              {saving ? '저장 중...' : '저장'}
            </button>
          </div>
        )}
      </section>

      {/* Instructions (claude.md 스타일) */}
      <section className="bg-bg-card rounded-xl border border-border p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-text-heading text-base">AI 지침</h3>
            <p className="text-xs text-text-muted mt-0.5">Brain 응답 시 항상 참조되는 사용자 지침 (claude.md 방식)</p>
          </div>
          <button
            onClick={async () => {
              // Optimistic: show saved immediately
              const prev = lab;
              onUpdate({ ...lab!, instructions } as any);
              setSavingInstructions(true);
              try {
                const updated = await updateLab({ instructions } as any);
                onUpdate(updated as any);
              } catch {
                onUpdate(prev!); // rollback
              } finally { setSavingInstructions(false); }
            }}
            disabled={savingInstructions}
            className="text-xs px-3 py-1.5 bg-primary text-white rounded-lg disabled:opacity-50"
          >
            {savingInstructions ? '저장 중...' : '저장'}
          </button>
        </div>
        <textarea
          value={instructions}
          onChange={e => setInstructions(e.target.value)}
          rows={8}
          placeholder={`예시:\n- 한국어로 답변해줘\n- 논문 요약은 3문장 이내로\n- 학생 이름은 존칭 없이\n- 과제 정보 물어보면 사사 문구도 같이 알려줘\n- 이메일 브리핑은 긴급한 것만 먼저`}
          className="w-full px-4 py-3 bg-bg-input rounded-lg text-text-heading text-sm border border-border focus:border-primary outline-none placeholder:text-text-muted resize-none font-mono"
        />
      </section>

      {/* Members */}
      <section className="bg-bg-card rounded-xl border border-border p-4 md:p-5 space-y-3">
        <h3 className="font-semibold text-text-heading text-base">팀원 ({members.length}명)</h3>
        <div className="space-y-2">
          {members.map(m => (
            <div key={m.id} className="flex items-center justify-between gap-3 bg-bg-input rounded-lg p-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-sm text-text-heading font-medium truncate">{m.name}</span>
                  <span className="text-xs text-text-muted">{m.role}</span>
                </div>
                {m.email && <span className="text-xs text-primary block truncate">{m.email}</span>}
              </div>
              <button onClick={() => handleRemoveMember(m.id)} className="text-xs text-red-400 hover:text-red-300 flex-shrink-0">삭제</button>
            </div>
          ))}
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <input value={newMember.name} onChange={e => setNewMember({...newMember, name: e.target.value})} placeholder="이름" className="flex-1 px-3 py-2 bg-bg-input rounded-lg text-sm text-text-heading border border-border focus:border-primary focus:outline-none" />
          <input value={newMember.email} onChange={e => setNewMember({...newMember, email: e.target.value})} placeholder="이메일" className="flex-1 px-3 py-2 bg-bg-input rounded-lg text-sm text-text-heading border border-border focus:border-primary focus:outline-none" />
          <button onClick={handleAddMember} className="px-4 py-2 bg-primary text-white rounded-lg text-sm">추가</button>
        </div>
      </section>
    </div>
  );
}

// ── Email Classification Tab ─────────────────────
function EmailTab({ connected }: { connected: boolean }) {
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [keywords, setKeywords] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');
  const [groups, setGroups] = useState<Array<{ name: string; domains: string; emoji: string }>>([]);

  useEffect(() => {
    async function load() {
      try {
        const res = await getEmailProfile();
        const p = (res as any).data || res;
        setProfile(p);
        setKeywords((p.keywords || []).join(', '));
        setTimezone(p.timezone || 'America/New_York');
        setGroups((p.groups || []).map((g: any) => ({
          name: g.name, domains: g.domains.join(', '), emoji: g.emoji || '',
        })));
      } catch { /* no profile */ }
      setLoading(false);
    }
    if (connected) load();
    else setLoading(false);
  }, [connected]);

  const handleSave = async () => {
    // Optimistic: show saved state immediately
    setSaving(true);
    try {
      await updateEmailProfile({
        classifyByGroup: groups.length > 0,
        groups: groups.filter(g => g.name.trim()).map(g => ({
          name: g.name.trim(),
          domains: g.domains.split(',').map(d => d.trim()).filter(Boolean),
          emoji: g.emoji,
        })),
        keywords: keywords.split(',').map(k => k.trim()).filter(Boolean),
        timezone,
      } as any);
    } catch (err) {
      console.error('Save failed:', err);
    }
    setSaving(false);
  };

  if (loading) return (
    <div className="flex items-center justify-center py-12">
      <div className="w-8 h-8 rounded-full border-[3px] border-border border-t-primary animate-spin" />
    </div>
  );

  return (
    <div className="space-y-4">
      <section className="bg-bg-card rounded-xl border border-border p-4 md:p-5 space-y-4">
        <div>
          <h3 className="font-semibold text-text-heading text-base">기관별 분류 그룹</h3>
          <p className="text-xs text-text-muted mt-0.5">발신자 이메일 도메인 기반으로 기관별 자동 분류</p>
        </div>
        <div className="space-y-3">
          {groups.map((g, i) => (
            <div key={i} className="grid grid-cols-[3rem_1fr] sm:grid-cols-[3rem_1fr_2fr] gap-2 items-end">
              <div>
                <label className="block text-xs text-text-muted mb-1">이모지</label>
                <input value={g.emoji} onChange={e => { const n = [...groups]; n[i].emoji = e.target.value; setGroups(n); }}
                  className="w-full px-2 py-1.5 bg-bg-input rounded-lg text-sm text-text-heading text-center border border-border focus:border-primary focus:outline-none" />
              </div>
              <SInput label="기관명" value={g.name} onChange={v => { const n = [...groups]; n[i].name = v; setGroups(n); }} />
              <div className="col-span-2 sm:col-span-1">
                <SInput label="도메인 (쉼표 구분)" value={g.domains} onChange={v => { const n = [...groups]; n[i].domains = v; setGroups(n); }} />
              </div>
            </div>
          ))}
        </div>
        <button onClick={() => setGroups([...groups, { name: '', domains: '', emoji: '🏫' }])} className="text-xs text-primary hover:text-primary-hover">+ 기관 추가</button>
      </section>

      <section className="bg-bg-card rounded-xl border border-border p-4 md:p-5 space-y-3">
        <div>
          <h3 className="font-semibold text-text-heading text-base">중요도 상향 키워드</h3>
          <p className="text-xs text-text-muted mt-0.5">이 키워드가 이메일 제목/내용에 포함되면 중요도 1단계 상향</p>
        </div>
        <SInput label="키워드 (쉼표 구분)" value={keywords} onChange={setKeywords} />
      </section>

      <section className="bg-bg-card rounded-xl border border-border p-4 md:p-5 space-y-3">
        <h3 className="font-semibold text-text-heading text-base">시간대</h3>
        <select value={timezone} onChange={e => setTimezone(e.target.value)}
          className="w-full sm:w-auto px-3 py-2 bg-bg-input rounded-lg text-text-heading text-sm border border-border focus:border-primary focus:outline-none">
          <option value="America/New_York">미국 동부 (EDT/EST)</option>
          <option value="America/Los_Angeles">미국 서부 (PDT/PST)</option>
          <option value="Asia/Seoul">한국 (KST)</option>
          <option value="Europe/London">영국 (GMT/BST)</option>
          <option value="UTC">UTC</option>
        </select>
      </section>

      <button onClick={handleSave} disabled={saving}
        className="w-full py-3 bg-primary hover:bg-primary-hover text-white rounded-lg font-medium disabled:opacity-50">
        {saving ? '저장 중...' : '이메일 설정 저장'}
      </button>
    </div>
  );
}

// ── Dictionary Tab ───────────────────────────────
function DictionaryTab() {
  const [entries, setEntries] = useState<Array<{ id: string; wrongForm: string; correctForm: string; category: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [newWrong, setNewWrong] = useState('');
  const [newCorrect, setNewCorrect] = useState('');

  const loadDict = useCallback(async () => {
    try {
      const res = await getLabDictionary();
      setEntries(Array.isArray(res) ? res : (res as any).data || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadDict(); }, [loadDict]);

  const handleAdd = async () => {
    if (!newWrong.trim() || !newCorrect.trim()) return;
    // Optimistic: append immediately
    const tempEntry = { id: `temp-${Date.now()}`, wrongForm: newWrong.trim(), correctForm: newCorrect.trim(), category: '' };
    setEntries(prev => [...prev, tempEntry]);
    const savedWrong = newWrong.trim();
    const savedCorrect = newCorrect.trim();
    setNewWrong('');
    setNewCorrect('');
    try {
      await addDictEntry({ wrongForm: savedWrong, correctForm: savedCorrect });
      loadDict(); // sync real IDs
    } catch {
      setEntries(prev => prev.filter(e => e.id !== tempEntry.id)); // rollback
    }
  };

  return (
    <div className="space-y-4">
      <section className="bg-bg-card rounded-xl border border-border p-4 md:p-5 space-y-3">
        <div>
          <h3 className="font-semibold text-text-heading text-base">기술 용어 사전 ({entries.length}개)</h3>
          <p className="text-xs text-text-muted mt-0.5">미팅 노트 교정, 논문 교정에서 공유되는 도메인 용어 사전</p>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <input value={newWrong} onChange={e => setNewWrong(e.target.value)} placeholder="잘못된 표기"
            className="flex-1 px-3 py-2 bg-bg-input rounded-lg text-sm text-text-heading border border-border focus:border-primary focus:outline-none" />
          <span className="hidden sm:inline text-text-muted self-center">→</span>
          <input value={newCorrect} onChange={e => setNewCorrect(e.target.value)} placeholder="올바른 표기"
            className="flex-1 px-3 py-2 bg-bg-input rounded-lg text-sm text-text-heading border border-border focus:border-primary focus:outline-none" />
          <button onClick={handleAdd} className="px-4 py-2 bg-primary text-white rounded-lg text-sm">추가</button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-6">
            <div className="w-6 h-6 rounded-full border-2 border-border border-t-primary animate-spin" />
          </div>
        ) : entries.length === 0 ? (
          <p className="text-text-muted text-sm text-center py-4">등록된 용어가 없습니다</p>
        ) : (
          <div className="max-h-80 overflow-y-auto space-y-1">
            {entries.map(e => (
              <div key={e.id} className="flex items-center justify-between bg-bg-input rounded px-3 py-2">
                <span className="text-sm">
                  <span className="text-red-400 line-through">{e.wrongForm}</span>
                  <span className="text-text-muted mx-2">→</span>
                  <span className="text-green-400">{e.correctForm}</span>
                </span>
                {e.category && <span className="text-xs text-text-muted">{e.category}</span>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ── Shared Components ────────────────────────────
function StatusItem({ label, status, detail }: { label: string; status: string; detail: string }) {
  const colors: Record<string, string> = {
    healthy: 'bg-green-400', error: 'bg-red-400', disconnected: 'bg-gray-500', info: 'bg-blue-400',
  };
  return (
    <div className="flex items-center gap-3 bg-bg-input rounded-lg p-3">
      <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${colors[status] || 'bg-gray-400'}`} />
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-heading truncate">{label}</p>
        <p className="text-xs text-text-muted truncate">{detail}</p>
      </div>
    </div>
  );
}

function SInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <label className="block text-xs text-text-muted mb-1">{label}</label>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="w-full px-3 py-1.5 bg-bg-input rounded-lg text-text-heading text-sm border border-border focus:border-primary outline-none placeholder:text-text-muted" />
    </div>
  );
}

// ── Error Log Tab ───────────────────────────────
const CATEGORY_LABELS: Record<string, string> = {
  email: '이메일', meeting: '회의', paper: '논문', brain: 'Brain',
  knowledge: '지식그래프', calendar: '캘린더', embedding: '임베딩',
  session: '세션', background: '백그라운드', auth: '인증',
};
const SEVERITY_COLORS: Record<string, string> = {
  error: 'bg-red-500/20 text-red-400 border-red-500/30',
  warn: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
};

function ErrorLogTab({ onCountChange }: { onCountChange: (n: number) => void }) {
  const [errors, setErrors] = useState<ErrorLogEntry[]>([]);
  const [summary, setSummary] = useState<ErrorSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');
  const [showResolved, setShowResolved] = useState(false);

  const load = useCallback(async () => {
    try {
      const [errRes, sumRes] = await Promise.all([
        getErrorLogs({
          category: filter === 'all' ? undefined : filter,
          resolved: showResolved ? undefined : false,
          limit: 100,
        }),
        getErrorSummary(),
      ]);
      setErrors(errRes.errors);
      setTotal(errRes.total);
      setSummary(sumRes.summary);
      onCountChange(sumRes.totalUnresolved);
    } catch { /* ignore */ }
    setLoading(false);
  }, [filter, showResolved, onCountChange]);

  useEffect(() => { load(); }, [load]);

  const handleResolve = async (id: string) => {
    setErrors(prev => prev.filter(e => e.id !== id));
    try {
      await resolveError(id);
      load();
    } catch { /* rollback on next load */ }
  };

  const handleResolveAll = async (category?: string) => {
    try {
      await resolveAllErrors(category);
      load();
    } catch { /* ignore */ }
  };

  const handleCleanup = async () => {
    try {
      const res = await cleanupOldErrors();
      if (res.deletedCount > 0) load();
    } catch { /* ignore */ }
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60000) return '방금';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}분 전`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}시간 전`;
    return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  if (loading) return (
    <div className="flex items-center justify-center py-12">
      <div className="w-8 h-8 rounded-full border-[3px] border-border border-t-primary animate-spin" />
    </div>
  );

  const categories = Array.from(new Set(summary.map(s => s.category)));

  return (
    <div className="space-y-4">
      {/* Summary Cards */}
      {summary.length > 0 && (
        <section className="bg-bg-card rounded-xl border border-border p-5 space-y-3">
          <h3 className="font-semibold text-text-heading text-base">미해결 에러 요약</h3>
          <div className="flex flex-wrap gap-2">
            {summary.map(s => (
              <div key={`${s.category}-${s.severity}`}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border ${SEVERITY_COLORS[s.severity] || 'bg-gray-500/20 text-gray-400'}`}>
                {CATEGORY_LABELS[s.category] || s.category} ({s.severity}): {s.count}건
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Filters + Actions */}
      <section className="bg-bg-card rounded-xl border border-border p-4 md:p-5 space-y-3">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            <select value={filter} onChange={e => setFilter(e.target.value)}
              className="px-3 py-1.5 bg-bg-input rounded-lg text-text-heading text-sm border border-border focus:border-primary focus:outline-none">
              <option value="all">전체 카테고리</option>
              {categories.map(c => (
                <option key={c} value={c}>{CATEGORY_LABELS[c] || c}</option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer">
              <input type="checkbox" checked={showResolved} onChange={e => setShowResolved(e.target.checked)}
                className="rounded border-border" />
              해결된 것도 표시
            </label>
          </div>
          <div className="flex gap-2 flex-wrap">
            {filter !== 'all' && (
              <button onClick={() => handleResolveAll(filter)}
                className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-xs font-medium">
                {CATEGORY_LABELS[filter] || filter} 전체 해결
              </button>
            )}
            <button onClick={() => handleResolveAll()}
              className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-xs font-medium">
              전체 해결
            </button>
            <button onClick={handleCleanup}
              className="px-3 py-1.5 bg-gray-600 hover:bg-gray-700 text-white rounded-lg text-xs font-medium">
              30일+ 정리
            </button>
          </div>
        </div>

        <p className="text-xs text-text-muted">총 {total}건{!showResolved ? ' (미해결)' : ''}</p>
      </section>

      {/* Error List */}
      {errors.length === 0 ? (
        <section className="bg-bg-card rounded-xl border border-border p-12 text-center">
          <AlertTriangle className="w-10 h-10 text-text-muted/30 mx-auto mb-3" />
          <p className="text-text-muted text-sm">에러가 없습니다</p>
        </section>
      ) : (
        <section className="space-y-2">
          {errors.map(err => (
            <div key={err.id} className={`bg-bg-card rounded-xl border p-4 space-y-2 ${err.resolved ? 'border-border opacity-60' : 'border-border'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${SEVERITY_COLORS[err.severity] || ''}`}>
                    {err.severity.toUpperCase()}
                  </span>
                  <span className="px-2 py-0.5 rounded bg-bg-input text-text-muted text-[10px] font-medium">
                    {CATEGORY_LABELS[err.category] || err.category}
                  </span>
                  <span className="text-[10px] text-text-muted">{formatTime(err.createdAt)}</span>
                </div>
                {!err.resolved && (
                  <button onClick={() => handleResolve(err.id)}
                    className="text-[10px] px-2 py-0.5 bg-green-600/20 text-green-400 rounded hover:bg-green-600/30 shrink-0">
                    해결
                  </button>
                )}
              </div>
              <p className="text-sm text-text-heading break-all">{err.message}</p>
              {err.context && Object.keys(err.context).length > 0 && (
                <pre className="text-[10px] text-text-muted bg-bg-input rounded p-2 overflow-x-auto">
                  {JSON.stringify(err.context, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

// ── Cron 진단 대시보드 (OWNER 전용) ─────────────────────
// in-memory CRON_STATUS로 cron 6개 health + 마지막 실행 결과 표시.
// "🚀 모두 실행" button으로 전체 cron 수동 trigger.
function CronDiagnosticsSection() {
  const { toast } = useToast();
  const [data, setData] = useState<CronStatusResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<CronRunAllResult | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await getCronStatus();
      setData(r);
    } catch (e: any) {
      toast(`Cron status 로드 실패: ${e?.message || ''}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const handleRunAll = async () => {
    if (!confirm('모든 cron 6개를 즉시 실행합니다. ~5분 정도 소요됩니다. 계속하시겠습니까?')) return;
    setRunning(true);
    try {
      const r = await runAllCrons();
      setLastRun(r);
      toast(r.ok ? '모든 cron 실행 완료' : '일부 cron 실패 — 결과 확인', r.ok ? 'success' : 'error');
      await fetchStatus();
    } catch (e: any) {
      toast(`실행 실패: ${e?.message || ''}`, 'error');
    } finally {
      setRunning(false);
    }
  };

  const formatRelative = (iso?: string) => {
    if (!iso) return '없음';
    const ms = Date.now() - new Date(iso).getTime();
    const abs = Math.abs(ms);
    const min = Math.floor(abs / 60_000);
    const hr = Math.floor(min / 60);
    const day = Math.floor(hr / 24);
    let label: string;
    if (day > 0) label = `${day}일`;
    else if (hr > 0) label = `${hr}시간`;
    else label = `${min}분`;
    return ms >= 0 ? `${label} 전` : `${label} 후`;
  };

  return (
    <section className="bg-bg-card border border-border rounded-xl p-4 md:p-5 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h3 className="font-semibold text-text-heading text-base flex items-center gap-2">
            🕒 Cron 진단 대시보드
            {data && (
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                data.cronCount > 0 && data.hints.length === 0
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
              }`}>
                {data.cronCount}개 등록 · {data.hints.length}개 경고
              </span>
            )}
          </h3>
          <p className="text-xs text-text-muted mt-1">
            서버 in-memory 추적. 매일 이메일 브리핑/마감 리마인더 등 6개 cron의 마지막 실행 결과·다음 일정·에러를 확인하세요.
            server restart 시 카운터 reset.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={fetchStatus}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-bg hover:bg-bg-card border border-border text-text-heading rounded-lg text-sm font-medium disabled:opacity-50"
          >
            🔄 새로고침
          </button>
          <button
            onClick={handleRunAll}
            disabled={running || loading}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium disabled:opacity-50 whitespace-nowrap"
          >
            {running && <span className="w-3.5 h-3.5 border border-white border-t-transparent rounded-full animate-spin" />}
            {running ? '실행 중… (~5분)' : '🚀 모두 즉시 실행'}
          </button>
        </div>
      </div>

      {loading && !data && (
        <div className="text-sm text-text-muted">로딩 중...</div>
      )}

      {data && data.hints.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 space-y-1">
          <div className="text-xs font-semibold text-amber-700 dark:text-amber-300">⚠️ 경고 / 진단 hint</div>
          {data.hints.map((h, i) => (
            <div key={i} className="text-xs text-amber-700 dark:text-amber-300 font-mono">{h}</div>
          ))}
        </div>
      )}

      {data && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-[11px]">
          {Object.entries(data.envHealth).map(([k, v]) => (
            <div key={k} className={`rounded border px-2 py-1.5 ${
              v === true ? 'bg-emerald-500/5 border-emerald-500/30'
                : v === false ? 'bg-red-500/5 border-red-500/30'
                : 'bg-bg border-border'
            }`}>
              <div className="font-mono text-text-muted text-[10px]">{k}</div>
              <div className={`font-semibold ${
                v === true ? 'text-emerald-700 dark:text-emerald-300'
                  : v === false ? 'text-red-700 dark:text-red-300'
                  : 'text-text-heading'
              }`}>
                {v === true ? '✅ 설정됨' : v === false ? '❌ 미설정' : String(v).slice(0, 30)}
              </div>
            </div>
          ))}
        </div>
      )}

      {data && data.crons.length > 0 && (
        <div className="space-y-2">
          {data.crons.map(c => (
            <div key={c.label} className={`rounded border p-3 ${
              c.lastSuccess === true ? 'bg-emerald-500/5 border-emerald-500/30'
                : c.lastSuccess === false ? 'bg-red-500/5 border-red-500/30'
                : 'bg-bg-card border-border'
            }`}>
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="font-mono text-sm font-semibold text-text-heading">
                  {c.lastSuccess === true ? '✅' : c.lastSuccess === false ? '❌' : '○'} {c.label}
                </span>
                <span className="text-[10px] text-text-muted">{c.schedule}</span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
                <div>
                  <div className="text-text-muted">다음 실행</div>
                  <div className="font-mono text-text-heading">{formatRelative(c.nextRunAt || undefined)}</div>
                </div>
                <div>
                  <div className="text-text-muted">마지막 완료</div>
                  <div className="font-mono text-text-heading">{formatRelative(c.lastCompletedAt)}</div>
                </div>
                <div>
                  <div className="text-text-muted">실행 / 에러</div>
                  <div className="font-mono text-text-heading">{c.runCount} / {c.errorCount}</div>
                </div>
                <div>
                  <div className="text-text-muted">등록 시점</div>
                  <div className="font-mono text-text-heading">{formatRelative(c.scheduledAt)}</div>
                </div>
              </div>
              {c.lastError && (
                <div className="mt-2 text-[11px] text-red-600 dark:text-red-400 font-mono break-all bg-red-500/10 rounded p-2">
                  ⚠ {c.lastError}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {data && data.crons.length === 0 && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-700 dark:text-red-400">
          🚨 등록된 cron이 0개. env.LAB_ID + env.NOTION_API_KEY 둘 다 Railway에 설정되어야 합니다.
        </div>
      )}

      {lastRun && (
        <div className="border-t border-border pt-3 space-y-1">
          <div className="text-xs font-semibold text-text-heading">📊 마지막 일괄 실행 결과</div>
          {lastRun.summary.map(s => (
            <div key={s.label} className={`text-[11px] font-mono flex items-center justify-between gap-2 ${
              s.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
            }`}>
              <span>{s.ok ? '✅' : '❌'} {s.label}</span>
              <span>{(s.ms / 1000).toFixed(1)}s {s.error ? `— ${s.error.slice(0, 80)}` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
