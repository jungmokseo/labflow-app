'use client';

import { useEffect, useState } from 'react';
import { getMeetings, createMeeting, deleteMeeting, Meeting } from '@/lib/api';

export default function MeetingsPage() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newAgenda, setNewAgenda] = useState('');
  const [creating, setCreating] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await getMeetings(20);
        setMeetings(res.data);
      } catch (err) {
        console.error('Failed to load meetings:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const handleCreate = async () => {
    if (!newTitle.trim() || creating) return;
    setCreating(true);
    try {
      const agenda = newAgenda.split('\n').filter(a => a.trim());
      const res = await createMeeting({ title: newTitle.trim(), agenda });
      setMeetings(prev => [res.data, ...prev]);
      setNewTitle('');
      setNewAgenda('');
      setShowCreate(false);
    } catch (err) {
      console.error('Failed to create meeting:', err);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteMeeting(id);
      setMeetings(prev => prev.filter(m => m.id !== id));
    } catch (err) {
      console.error('Failed to delete meeting:', err);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">🎙️ 회의 노트</h2>
          <p className="text-text-muted mt-1">녹음 업로드로 자동 트랜스크립션 및 요약</p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium transition-colors"
        >
          + 새 회의
        </button>
      </div>

      {/* 새 회의 생성 */}
      {showCreate && (
        <div className="bg-bg-card rounded-xl border border-primary/30 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-white">새 회의 만들기</h3>
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="회의 제목"
            className="w-full bg-bg-input/50 border border-bg-input rounded-lg px-4 py-3 text-sm text-white placeholder-text-muted focus:outline-none focus:border-primary"
          />
          <textarea
            value={newAgenda}
            onChange={(e) => setNewAgenda(e.target.value)}
            placeholder="안건 (줄바꿈으로 구분)"
            rows={3}
            className="w-full bg-bg-input/50 border border-bg-input rounded-lg px-4 py-3 text-sm text-white placeholder-text-muted focus:outline-none focus:border-primary resize-none"
          />
          <div className="flex gap-3">
            <button
              onClick={handleCreate}
              disabled={creating || !newTitle.trim()}
              className="px-4 py-2 bg-primary hover:bg-primary-hover disabled:opacity-50 text-white rounded-lg text-sm transition-colors"
            >
              {creating ? '생성 중...' : '생성'}
            </button>
            <button
              onClick={() => setShowCreate(false)}
              className="px-4 py-2 bg-bg-input/50 text-text-muted hover:text-white rounded-lg text-sm transition-colors"
            >
              취소
            </button>
          </div>
        </div>
      )}

      {/* 회의 목록 */}
      {meetings.length === 0 ? (
        <div className="text-center py-16 text-text-muted">
          <span className="text-5xl block mb-4">🎙️</span>
          <p className="text-lg mb-2">아직 회의 기록이 없습니다</p>
          <p className="text-sm">새 회의를 만들고 녹음을 업로드해 보세요.</p>
          <p className="text-xs mt-4 text-text-muted">
            Gemini STT로 음성을 텍스트로, Claude Sonnet으로 요약·액션아이템을 자동 생성합니다.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {meetings.map((m) => {
            const expanded = expandedId === m.id;
            return (
              <div key={m.id} className="bg-bg-card rounded-xl border border-bg-input/50 overflow-hidden hover:border-primary/30 transition-colors">
                <div
                  className="p-4 flex items-center justify-between cursor-pointer"
                  onClick={() => setExpandedId(expanded ? null : m.id)}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white">{m.title}</p>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-xs text-text-muted">
                        {new Date(m.createdAt).toLocaleDateString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric' })}
                      </span>
                      {m.actionItems.length > 0 && (
                        <span className="text-xs text-yellow-400">📋 {m.actionItems.length} 액션아이템</span>
                      )}
                      {m.summary && (
                        <span className="text-xs text-green-400">✅ 요약 완료</span>
                      )}
                    </div>
                  </div>
                  <span className="text-text-muted text-sm">{expanded ? '▲' : '▼'}</span>
                </div>

                {expanded && (
                  <div className="px-4 pb-4 space-y-4 border-t border-bg-input/50 pt-4">
                    {/* 요약 */}
                    {m.summary && (
                      <div>
                        <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">요약</h4>
                        <p className="text-sm text-white bg-bg/50 rounded-lg p-3">{m.summary}</p>
                      </div>
                    )}

                    {/* 안건 */}
                    {m.agenda.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">안건</h4>
                        <ul className="space-y-1">
                          {m.agenda.map((a, i) => (
                            <li key={i} className="text-sm text-text-main flex items-start gap-2">
                              <span className="text-text-muted">•</span> {a}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* 액션 아이템 */}
                    {m.actionItems.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold text-yellow-400 uppercase tracking-wider mb-2">📋 액션 아이템</h4>
                        <ul className="space-y-1">
                          {m.actionItems.map((a, i) => (
                            <li key={i} className="text-sm text-white flex items-start gap-2">
                              <span className="text-yellow-400">☐</span> {a}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* 다음 단계 */}
                    {m.nextSteps.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold text-blue-400 uppercase tracking-wider mb-2">→ 다음 단계</h4>
                        <ul className="space-y-1">
                          {m.nextSteps.map((s, i) => (
                            <li key={i} className="text-sm text-text-main flex items-start gap-2">
                              <span className="text-blue-400">→</span> {s}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* 삭제 */}
                    <div className="pt-2 border-t border-bg-input/30">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(m.id); }}
                        className="text-xs text-red-400 hover:text-red-300"
                      >
                        이 회의 삭제
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
