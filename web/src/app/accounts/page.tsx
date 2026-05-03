'use client';

/**
 * Lab 계정 정보 페이지 — labflow-member LabAccount read-only.
 *
 * PI 본인이 학생 공용 계정(서비스 ID/PW)을 한 곳에서 lookup.
 * 학생은 Slack BLISS-bot의 search_faq를 통해 별도 조회.
 *
 * 보안: 비밀번호는 default masking. "보기" 클릭 시 1회 fetch + 자동 다시 마스킹.
 */

import { useMemo, useState } from 'react';
import {
  getLabAccounts,
  getLabAccountPassword,
  type LabAccountItem,
} from '@/lib/api';
import { useApiData } from '@/lib/use-api';
import { useToast } from '@/components/Toast';
import { Eye, EyeOff, Copy, ExternalLink, KeyRound, Loader2, Search, Lock } from 'lucide-react';

export default function AccountsPage() {
  const { data, error, isLoading } = useApiData<{ items: LabAccountItem[] }>(
    'lab-accounts',
    () => getLabAccounts(),
  );
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const items = data?.items ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(a =>
      a.service.toLowerCase().includes(q) ||
      (a.username || '').toLowerCase().includes(q) ||
      (a.url || '').toLowerCase().includes(q) ||
      (a.notes || '').toLowerCase().includes(q),
    );
  }, [items, query]);

  async function reveal(item: LabAccountItem) {
    if (revealed[item.id]) {
      // 이미 노출 — 토글하면 다시 마스킹
      setRevealed(prev => { const n = { ...prev }; delete n[item.id]; return n; });
      return;
    }
    setBusy(prev => ({ ...prev, [item.id]: true }));
    try {
      const r = await getLabAccountPassword(item.id);
      setRevealed(prev => ({ ...prev, [item.id]: r.password }));
    } catch (err: any) {
      toast(`비밀번호 조회 실패: ${err?.message ?? '오류'}`, 'error');
    } finally {
      setBusy(prev => ({ ...prev, [item.id]: false }));
    }
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label} 복사됨`, 'success');
    } catch {
      toast('복사 실패', 'error');
    }
  }

  return (
    <div className="min-h-full pb-20 md:pb-12">
      <div className="px-4 md:px-8 pt-4 md:pt-8 pb-3">
        <div className="flex items-center gap-2 md:gap-3 mb-1">
          <KeyRound className="w-5 h-5 md:w-6 md:h-6 text-primary" />
          <h1 className="text-lg md:text-2xl font-bold text-text-heading">계정 정보</h1>
        </div>
        <p className="text-xs md:text-sm text-text-muted">
          학생 공용 계정 lookup. 비밀번호는 클릭해야 노출 — 자리 비울 때 다시 마스킹하세요.
        </p>
      </div>

      <div className="px-4 md:px-8 pt-1 pb-3">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="서비스, 사용자명, URL 검색..."
            className="w-full bg-bg-input border border-border rounded-lg pl-9 pr-3 py-2 text-sm text-text-heading focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      <div className="px-4 md:px-8 space-y-2">
        {isLoading && (
          <div className="flex items-center justify-center py-12 text-text-muted">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            불러오는 중...
          </div>
        )}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
            불러오지 못했습니다
          </div>
        )}
        {!isLoading && filtered.length === 0 && (
          <div className="text-center py-12 text-text-muted text-sm">
            {query ? '검색 결과가 없습니다.' : '등록된 계정 정보가 없습니다.'}
          </div>
        )}

        {filtered.map(a => {
          const shown = revealed[a.id];
          const isBusy = !!busy[a.id];
          return (
            <article key={a.id} className="bg-bg-card border border-border rounded-lg p-3 md:p-4">
              <div className="flex items-start gap-2 flex-wrap mb-2">
                <h3 className="text-base font-semibold text-text-heading break-words flex-1 min-w-0">
                  {a.service}
                </h3>
                {a.url && (
                  <a
                    href={a.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary/80"
                  >
                    <ExternalLink className="w-3 h-3" />
                    열기
                  </a>
                )}
              </div>

              <div className="space-y-1.5 text-sm">
                {a.username && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-muted w-12 flex-shrink-0">ID</span>
                    <code className="flex-1 bg-bg-input rounded px-2 py-1 text-xs break-all">{a.username}</code>
                    <button
                      onClick={() => copy(a.username!, 'ID')}
                      className="p-1.5 text-text-muted hover:text-text-heading rounded hover:bg-bg-hover"
                      title="복사"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                {a.hasPassword && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-muted w-12 flex-shrink-0">PW</span>
                    <code className="flex-1 bg-bg-input rounded px-2 py-1 text-xs break-all">
                      {shown ? shown : '••••••••'}
                    </code>
                    <button
                      onClick={() => reveal(a)}
                      disabled={isBusy}
                      className="p-1.5 text-text-muted hover:text-text-heading rounded hover:bg-bg-hover disabled:opacity-50"
                      title={shown ? '숨기기' : '보기'}
                    >
                      {isBusy ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : shown ? (
                        <EyeOff className="w-3.5 h-3.5" />
                      ) : (
                        <Eye className="w-3.5 h-3.5" />
                      )}
                    </button>
                    {shown && (
                      <button
                        onClick={() => copy(shown, 'PW')}
                        className="p-1.5 text-text-muted hover:text-text-heading rounded hover:bg-bg-hover"
                        title="복사"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                )}

                {!a.hasPassword && (
                  <div className="flex items-center gap-2 text-xs text-text-muted">
                    <Lock className="w-3 h-3" />
                    비밀번호 미등록
                  </div>
                )}

                {a.notes && (
                  <p className="mt-2 text-xs text-text-muted bg-bg-input rounded px-2 py-1.5 border border-border whitespace-pre-wrap break-words">
                    {a.notes}
                  </p>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
