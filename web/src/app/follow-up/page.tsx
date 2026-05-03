'use client';

/**
 * BLISS-bot 미답변 질문 팔로업 페이지
 *
 * 학생이 BLISS-bot에 질문 → Gemini가 답 못함 → labflow-member에 UnansweredQuestion 저장.
 * 이 페이지에서 PI가 답변 작성 → FAQ에 추가 + (옵션) 학생 Slack DM 알림.
 *
 * 모바일 호환: 카드 레이아웃, 터치 친화적 버튼, 반응형 padding.
 */

import { useMemo, useState } from 'react';
import {
  answerFollowUp,
  deleteFollowUp,
  getFollowUpList,
  skipFollowUp,
  type FollowUpItem,
  type FollowUpListResponse,
} from '@/lib/api';
import { useApiData } from '@/lib/use-api';
import { useToast } from '@/components/Toast';
import {
  CheckCircle,
  Clock,
  HelpCircle,
  Inbox,
  Loader2,
  MessageSquare,
  Send,
  Sparkles,
  Trash2,
  User,
  X,
} from 'lucide-react';

type TabKey = 'pending' | 'answered';

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const min = Math.max(0, Math.floor(diff / 60000));
  if (min < 1) return '방금 전';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}일 전`;
  return new Date(dateStr).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

function previewText(text: string, max = 160): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

interface AnswerFormState {
  answer: string;
  category: string;
  addToFaq: boolean;
  notifyStudent: boolean;
}

const EMPTY_FORM: AnswerFormState = {
  answer: '',
  category: '',
  addToFaq: true,
  notifyStudent: false,
};

export default function FollowUpPage() {
  const [tab, setTab] = useState<TabKey>('pending');
  const { data, error, isLoading, mutate } = useApiData<FollowUpListResponse>(
    `follow-up:${tab}`,
    () => getFollowUpList({ status: tab, limit: 100 }),
  );
  const refresh = () => { mutate(); };
  const { toast } = useToast();
  const [openId, setOpenId] = useState<string | null>(null);
  const [forms, setForms] = useState<Record<string, AnswerFormState>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const items = data?.items ?? [];
  const counts = data?.counts ?? { pending: 0, answered: 0 };

  const sorted = useMemo(() => {
    const list = [...items];
    list.sort((a, b) => {
      const ta = new Date(a.createdAt).getTime();
      const tb = new Date(b.createdAt).getTime();
      return tb - ta; // 최신 우선
    });
    return list;
  }, [items]);

  function getForm(id: string, item: FollowUpItem): AnswerFormState {
    if (forms[id]) return forms[id];
    return {
      answer: item.answer ?? '',
      category: item.category ?? '',
      addToFaq: true,
      notifyStudent: !!(item.slackUserId || item.slackChannelId),
    };
  }

  function setForm(id: string, patch: Partial<AnswerFormState>) {
    setForms(prev => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY_FORM), ...patch } }));
  }

  async function onAnswer(item: FollowUpItem) {
    const form = getForm(item.id, item);
    if (!form.answer.trim()) {
      toast('답변 내용을 입력해주세요', 'error');
      return;
    }
    setBusy(prev => ({ ...prev, [item.id]: true }));
    try {
      const res = await answerFollowUp(item.id, {
        answer: form.answer.trim(),
        category: form.category.trim() || undefined,
        addToFaq: form.addToFaq,
        notifyStudent: form.notifyStudent,
      });
      let msg = '답변 등록 완료';
      if (res.faqAdded) msg += ' · FAQ 추가됨';
      if (form.notifyStudent) {
        if (res.notify?.ok) msg += ' · 학생에게 Slack DM 전송';
        else if (res.notify) msg += ` · DM 실패 (${res.notify.reason ?? '알 수 없음'})`;
      }
      toast(msg, 'success');
      setOpenId(null);
      setForms(prev => { const next = { ...prev }; delete next[item.id]; return next; });
      refresh();
    } catch (err: any) {
      toast(`답변 등록 실패: ${err?.message ?? '오류'}`, 'error');
    } finally {
      setBusy(prev => ({ ...prev, [item.id]: false }));
    }
  }

  async function onSkip(item: FollowUpItem) {
    if (!confirm(`"${previewText(item.question, 60)}" 질문을 답변 없이 종료할까요?`)) return;
    setBusy(prev => ({ ...prev, [item.id]: true }));
    try {
      await skipFollowUp(item.id);
      toast('답변 없이 종료', 'success');
      refresh();
    } catch (err: any) {
      toast(`종료 실패: ${err?.message ?? '오류'}`, 'error');
    } finally {
      setBusy(prev => ({ ...prev, [item.id]: false }));
    }
  }

  async function onDelete(item: FollowUpItem) {
    if (!confirm('이 질문 기록을 영구 삭제할까요?')) return;
    setBusy(prev => ({ ...prev, [item.id]: true }));
    try {
      await deleteFollowUp(item.id);
      toast('삭제됨', 'success');
      refresh();
    } catch (err: any) {
      toast(`삭제 실패: ${err?.message ?? '오류'}`, 'error');
    } finally {
      setBusy(prev => ({ ...prev, [item.id]: false }));
    }
  }

  return (
    <div className="min-h-full pb-20 md:pb-12">
      {/* 헤더 */}
      <div className="px-4 md:px-8 pt-4 md:pt-8 pb-4 sticky top-0 md:relative bg-bg-app/95 backdrop-blur z-10 border-b border-border md:border-b-0">
        <div className="flex items-center gap-2 md:gap-3 mb-1">
          <HelpCircle className="w-5 h-5 md:w-6 md:h-6 text-primary" />
          <h1 className="text-lg md:text-2xl font-bold text-text-heading">FAQ 답변 대기</h1>
        </div>
        <p className="text-xs md:text-sm text-text-muted">
          BLISS-bot이 답하지 못한 질문에 답변하면 자동으로 FAQ에 추가됩니다.
        </p>
      </div>

      {/* 탭 */}
      <div className="px-4 md:px-8 pt-3 pb-2 flex gap-2 overflow-x-auto">
        <button
          onClick={() => setTab('pending')}
          className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 whitespace-nowrap ${
            tab === 'pending'
              ? 'bg-primary text-white'
              : 'bg-bg-card text-text-muted hover:text-text-heading hover:bg-bg-hover border border-border'
          }`}
        >
          <Inbox className="w-4 h-4" />
          답변 대기
          <span className={`ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
            tab === 'pending' ? 'bg-white/20 text-white' : 'bg-primary-light text-primary'
          }`}>
            {counts.pending}
          </span>
        </button>
        <button
          onClick={() => setTab('answered')}
          className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 whitespace-nowrap ${
            tab === 'answered'
              ? 'bg-primary text-white'
              : 'bg-bg-card text-text-muted hover:text-text-heading hover:bg-bg-hover border border-border'
          }`}
        >
          <CheckCircle className="w-4 h-4" />
          답변 완료
          <span className={`ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
            tab === 'answered' ? 'bg-white/20 text-white' : 'bg-bg-input text-text-muted'
          }`}>
            {counts.answered}
          </span>
        </button>
      </div>

      {/* 본문 */}
      <div className="px-4 md:px-8 pt-2 space-y-3">
        {isLoading && (
          <div className="flex items-center justify-center py-16 text-text-muted">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            불러오는 중...
          </div>
        )}

        {error && !isLoading && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
            데이터를 불러오지 못했습니다: {String(error)}
          </div>
        )}

        {!isLoading && !error && sorted.length === 0 && (
          <div className="text-center py-16">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-bg-card border border-border mb-3">
              <Sparkles className="w-6 h-6 text-text-muted" />
            </div>
            <p className="text-text-muted text-sm">
              {tab === 'pending' ? '답변 대기 중인 질문이 없습니다.' : '답변 완료된 질문이 없습니다.'}
            </p>
          </div>
        )}

        {sorted.map(item => {
          const isOpen = openId === item.id;
          const form = getForm(item.id, item);
          const isBusy = !!busy[item.id];
          return (
            <article
              key={item.id}
              className="bg-bg-card border border-border rounded-lg overflow-hidden shadow-sm"
            >
              {/* 카드 헤더 */}
              <div className="p-4 md:p-5">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex-1 min-w-0">
                    <h3 className="text-base md:text-lg font-semibold text-text-heading break-words">
                      {item.question}
                    </h3>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                      <span className="inline-flex items-center gap-1">
                        <User className="w-3.5 h-3.5" />
                        {item.askedBy}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5" />
                        {timeAgo(item.createdAt)}
                      </span>
                      {item.slackChannelId && (
                        <span className="inline-flex items-center gap-1 text-text-muted/80">
                          <MessageSquare className="w-3.5 h-3.5" />
                          Slack
                        </span>
                      )}
                      {item.category && (
                        <span className="px-1.5 py-0.5 rounded bg-primary-light text-primary text-[10px] font-medium">
                          {item.category}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {item.reason && (
                  <p className="text-xs text-text-muted bg-bg-input rounded px-2 py-1.5 mb-2 border border-border">
                    <span className="font-medium">AI 메모: </span>
                    {item.reason}
                  </p>
                )}

                {/* 답변 표시 (answered 탭) */}
                {tab === 'answered' && item.answer && (
                  <div className="mt-2 bg-primary-light/50 rounded p-3 border border-primary/20">
                    <p className="text-xs text-primary font-medium mb-1">
                      답변 {item.resolvedBy ? `· ${item.resolvedBy}` : ''} {item.answeredAt ? `· ${timeAgo(item.answeredAt)}` : ''}
                    </p>
                    <p className="text-sm text-text-heading whitespace-pre-wrap break-words">{item.answer}</p>
                    {item.faqId && (
                      <p className="text-[10px] text-primary/80 mt-1.5">FAQ에 등록됨</p>
                    )}
                    {item.resolvedVia === 'skipped' && (
                      <p className="text-[10px] text-text-muted mt-1.5">답변 없이 종료</p>
                    )}
                  </div>
                )}

                {/* 답변 입력 (pending 탭) */}
                {tab === 'pending' && !isOpen && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    <button
                      onClick={() => setOpenId(item.id)}
                      disabled={isBusy}
                      className="px-3 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5"
                    >
                      <Send className="w-3.5 h-3.5" />
                      답변하기
                    </button>
                    <button
                      onClick={() => onSkip(item)}
                      disabled={isBusy}
                      className="px-3 py-2 bg-bg-input text-text-muted rounded-lg text-sm hover:bg-bg-hover hover:text-text-heading disabled:opacity-50"
                    >
                      답변 없이 종료
                    </button>
                  </div>
                )}

                {tab === 'pending' && isOpen && (
                  <div className="mt-3 space-y-3 border-t border-border pt-3">
                    <div>
                      <label className="block text-xs font-medium text-text-muted mb-1">답변</label>
                      <textarea
                        value={form.answer}
                        onChange={e => setForm(item.id, { answer: e.target.value })}
                        rows={5}
                        placeholder="학생이 이해하기 쉽게 답변을 작성하세요..."
                        className="w-full bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-heading focus:outline-none focus:ring-1 focus:ring-primary resize-y"
                        autoFocus
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-text-muted mb-1">카테고리 (선택)</label>
                        <input
                          type="text"
                          value={form.category}
                          onChange={e => setForm(item.id, { category: e.target.value })}
                          placeholder="예: 출장, 영수증, 장비"
                          className="w-full bg-bg-input border border-border rounded-lg px-3 py-2 text-sm text-text-heading focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                      </div>
                      <div className="flex items-end gap-3">
                        <label className="inline-flex items-center gap-2 text-sm text-text-muted cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={form.addToFaq}
                            onChange={e => setForm(item.id, { addToFaq: e.target.checked })}
                            className="w-4 h-4 rounded accent-primary"
                          />
                          FAQ 추가
                        </label>
                        {(item.slackUserId || item.slackChannelId) && (
                          <label className="inline-flex items-center gap-2 text-sm text-text-muted cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={form.notifyStudent}
                              onChange={e => setForm(item.id, { notifyStudent: e.target.checked })}
                              className="w-4 h-4 rounded accent-primary"
                            />
                            학생에게 DM
                          </label>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        onClick={() => onAnswer(item)}
                        disabled={isBusy || !form.answer.trim()}
                        className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5"
                      >
                        {isBusy ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Send className="w-4 h-4" />
                        )}
                        등록
                      </button>
                      <button
                        onClick={() => { setOpenId(null); }}
                        disabled={isBusy}
                        className="px-3 py-2 text-text-muted hover:text-text-heading text-sm disabled:opacity-50 inline-flex items-center gap-1"
                      >
                        <X className="w-3.5 h-3.5" />
                        취소
                      </button>
                    </div>
                  </div>
                )}

                {/* answered 탭 액션 */}
                {tab === 'answered' && (
                  <div className="flex gap-2 mt-3">
                    <button
                      onClick={() => onDelete(item)}
                      disabled={isBusy}
                      className="px-3 py-1.5 bg-bg-input text-text-muted rounded-lg text-xs hover:bg-red-50 hover:text-red-600 disabled:opacity-50 inline-flex items-center gap-1"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      삭제
                    </button>
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
