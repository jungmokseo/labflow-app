'use client';

import { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  getWikiArticles, getWikiArticle, getWikiStatus, updateWikiArticle,
  deleteWikiArticle, triggerWikiIngest, triggerWikiSynthesis,
  type WikiArticle, type WikiStatus,
} from '@/lib/api';
import {
  BookOpen, RefreshCw, Pencil, Trash2, Save, X, ChevronRight,
  Tag, Clock, Hash, Loader2, Sparkles, Zap, Filter,
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

  function showToast(msg: string, type: 'ok' | 'err' = 'ok') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  const loadArticles = useCallback(async () => {
    setLoading(true);
    try {
      const [articlesRes, statusRes] = await Promise.all([
        getWikiArticles({ category: categoryFilter || undefined, limit: 200 }),
        getWikiStatus(),
      ]);
      setArticles(articlesRes.articles ?? []);
      setStatus(statusRes as WikiStatus);
    } catch {
      showToast('아티클 로드 실패', 'err');
    } finally {
      setLoading(false);
    }
  }, [categoryFilter]);

  useEffect(() => { loadArticles(); }, [loadArticles]);

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
    try {
      const res = await triggerWikiIngest() as { enqueued: number; processed: number; updated: string[] };
      showToast(`Ingest 완료 — ${res.processed}건 처리, ${res.updated.length}개 업데이트`);
      await loadArticles();
    } catch {
      showToast('Ingest 실패', 'err');
    } finally {
      setIngestLoading(false);
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
    <div className="flex flex-col h-full overflow-hidden">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-2 rounded-lg text-sm font-medium shadow-lg transition-all ${
          toast.type === 'ok' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
        }`}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex items-center gap-3 flex-shrink-0">
        <BookOpen className="w-5 h-5 text-primary" />
        <div>
          <h1 className="text-lg font-bold text-text-heading">지식 위키</h1>
          {status && (
            <p className="text-xs text-text-muted">
              {status.totalArticles}개 아티클 &middot; 처리 대기 {status.pendingQueueItems}건
              {status.lastIngestAt && ` &middot; 마지막 갱신 ${timeAgo(status.lastIngestAt)}`}
            </p>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={handleIngest}
            disabled={ingestLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {ingestLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            Ingest
          </button>
          <button
            onClick={handleSynthesis}
            disabled={synthLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-bg-input border border-border text-text-heading rounded-lg hover:bg-bg-hover disabled:opacity-50 transition-colors"
          >
            {synthLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            딥 리뷰
          </button>
          <button onClick={loadArticles} className="p-1.5 text-text-muted hover:text-text-heading hover:bg-bg-hover rounded-lg transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Left panel — article list */}
        <div className="w-72 flex-shrink-0 border-r border-border flex flex-col min-h-0">
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
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          {!selectedId ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
              <BookOpen className="w-12 h-12 text-text-muted mb-3" />
              <p className="text-text-muted text-sm">왼쪽에서 아티클을 선택하세요</p>
              {status && status.totalArticles === 0 && (
                <div className="mt-4 p-4 bg-bg-input rounded-xl border border-border text-sm text-text-muted max-w-xs">
                  아직 생성된 위키가 없습니다.<br />
                  <span className="text-primary font-medium cursor-pointer" onClick={handleIngest}>Ingest 버튼</span>을 눌러 시작하세요.
                </div>
              )}
            </div>
          ) : detailLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : detail ? (
            <>
              {/* Article toolbar */}
              <div className="px-6 py-3 border-b border-border flex items-center gap-3 flex-shrink-0">
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
                    className="w-full h-full px-6 py-4 bg-transparent text-text-heading text-sm font-mono resize-none focus:outline-none leading-relaxed"
                    placeholder="마크다운 내용을 입력하세요..."
                  />
                ) : (
                  <div className="px-6 py-4 prose prose-sm max-w-none dark:prose-invert">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: ({ href, children }) => (
                          <a href={href} className="text-primary hover:underline">{children}</a>
                        ),
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
                      {detail.content}
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
    </div>
  );
}
