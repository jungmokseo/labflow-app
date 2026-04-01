'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { brainChat, brainUpload, getBrainChannels, getChannelMessages, searchBrainMemory, type BrainMessage, type UploadResult } from '@/lib/api';

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

function isToday(dateStr: string): boolean {
  return new Date(dateStr).toDateString() === new Date().toDateString();
}

function isThisWeek(dateStr: string): boolean {
  const diff = Date.now() - new Date(dateStr).getTime();
  return diff < 7 * 24 * 60 * 60 * 1000;
}

export default function BrainPage() {
  const [sessions, setSessions] = useState<any[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<BrainMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'chat' | 'search'>('chat');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any>(null);
  const [uploadedFile, setUploadedFile] = useState<UploadResult | null>(null);
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const dragCounter = useRef(0);

  useEffect(() => { loadChannels(); }, []);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const loadChannels = useCallback(async () => {
    try {
      const res = await getBrainChannels();
      const data = Array.isArray(res.data) ? res.data : [];
      setSessions(data);
      // 첫 로드 시 가장 최근 세션 자동 선택
      if (data.length > 0 && !activeChannelId) {
        loadMessages(data[0].id);
      }
    } catch {}
  }, []);

  async function loadMessages(channelId: string) {
    try {
      const res = await getChannelMessages(channelId);
      setMessages(res.data || res || []);
      setActiveChannelId(channelId);
    } catch (err) {
      console.error('Failed to load messages', err);
    }
  }

  function handleSelectSession(ch: any) {
    loadMessages(ch.id);
  }

  function handleNewSession() {
    setActiveChannelId(null);
    setMessages([]);
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const result = await brainUpload(file);
      setUploadedFile(result);
      setMessages(prev => [...prev, {
        id: `file-${Date.now()}`,
        role: 'assistant',
        content: result.message,
        createdAt: new Date().toISOString(),
      }]);
    } catch (err: any) {
      setMessages(prev => [...prev, {
        id: `err-${Date.now()}`,
        role: 'assistant',
        content: `파일 처리 실패: ${err.message}`,
        createdAt: new Date().toISOString(),
      }]);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleSend() {
    if (!input.trim() || loading) return;
    const msg = input;
    const currentFileId = uploadedFile?.fileId;
    const isNewSession = !activeChannelId;
    setInput('');
    setUploadedFile(null);
    setMessages(prev => [...prev, { id: `temp-${Date.now()}`, role: 'user', content: msg, createdAt: new Date().toISOString() }]);
    setLoading(true);

    try {
      const result = await brainChat(msg, activeChannelId || undefined, currentFileId, isNewSession ? true : undefined);
      setMessages(prev => [...prev, {
        id: `resp-${Date.now()}`,
        role: 'assistant',
        content: result.response,
        createdAt: new Date().toISOString(),
      }]);
      if (result.channelId && result.channelId !== activeChannelId) {
        setActiveChannelId(result.channelId);
        loadChannels();
        try {
          const res = await getChannelMessages(result.channelId);
          const serverMsgs = res.data || res || [];
          if (Array.isArray(serverMsgs) && serverMsgs.length > 0) {
            setMessages(serverMsgs);
          }
        } catch {}
      }
    } catch (err: any) {
      setMessages(prev => [...prev, {
        id: `err-${Date.now()}`,
        role: 'assistant',
        content: `오류: ${err.message}`,
        createdAt: new Date().toISOString(),
      }]);
    } finally {
      setLoading(false);
    }
  }

  async function handleSearch() {
    if (!searchQuery.trim()) return;
    try {
      const res = await searchBrainMemory(searchQuery);
      setSearchResults(res.data || res);
    } catch (err: any) {
      setSearchResults({ error: err.message });
    }
  }

  function handleDragOver(e: React.DragEvent) { e.preventDefault(); e.stopPropagation(); }
  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault(); e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes('Files')) setIsDragging(true);
  }
  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault(); e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragging(false);
  }
  async function handleDrop(e: React.DragEvent) {
    e.preventDefault(); e.stopPropagation();
    dragCounter.current = 0;
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const result = await brainUpload(file);
      setUploadedFile(result);
      setMessages(prev => [...prev, { id: `file-${Date.now()}`, role: 'assistant', content: result.message, createdAt: new Date().toISOString() }]);
    } catch (err: any) {
      setMessages(prev => [...prev, { id: `err-${Date.now()}`, role: 'assistant', content: `파일 처리 실패: ${err.message}`, createdAt: new Date().toISOString() }]);
    } finally { setUploading(false); }
  }

  // 세션을 날짜별 그룹
  const todaySessions = sessions.filter((c: any) => isToday(c.lastMessageAt || c.createdAt));
  const weekSessions = sessions.filter((c: any) => !isToday(c.lastMessageAt || c.createdAt) && isThisWeek(c.lastMessageAt || c.createdAt));
  const olderSessions = sessions.filter((c: any) => !isThisWeek(c.lastMessageAt || c.createdAt));

  return (
    <div className="flex h-[calc(100vh-2rem)] gap-4">
      {/* ── 사이드바 ── */}
      <div className="w-60 bg-bg-card rounded-xl flex flex-col overflow-hidden">
        <div className="p-4 pb-2">
          <h2 className="text-lg font-bold text-white">🧠 Brain</h2>
          <div className="flex gap-1 mt-3">
            <button onClick={() => setTab('chat')} className={`flex-1 px-2 py-1 rounded text-xs ${tab === 'chat' ? 'bg-primary text-white' : 'bg-bg-input text-text-muted'}`}>채팅</button>
            <button onClick={() => setTab('search')} className={`flex-1 px-2 py-1 rounded text-xs ${tab === 'search' ? 'bg-primary text-white' : 'bg-bg-input text-text-muted'}`}>검색</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1">
          {/* 새 대화 버튼 */}
          <div className="pt-3 pb-2">
            <button
              onClick={handleNewSession}
              className="w-full px-3 py-2 bg-primary/20 text-primary rounded-lg text-sm hover:bg-primary/30 font-medium"
            >
              + 새 대화
            </button>
          </div>

          {/* 현재 활성 (activeChannelId 없으면 새 대화 중) */}
          {!activeChannelId && (
            <div className="px-3 py-2 rounded-lg text-sm bg-primary/10 text-primary flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              <span className="text-xs font-medium">새 대화</span>
            </div>
          )}

          {/* 대화 히스토리 (날짜별) */}
          {todaySessions.length > 0 && (
            <>
              <p className="text-[10px] text-text-muted uppercase tracking-wider px-2 pt-3 pb-1">오늘</p>
              {todaySessions.map((ch: any) => (
                <SessionButton key={ch.id} ch={ch} isActive={activeChannelId === ch.id} onClick={() => handleSelectSession(ch)} />
              ))}
            </>
          )}
          {weekSessions.length > 0 && (
            <>
              <p className="text-[10px] text-text-muted uppercase tracking-wider px-2 pt-3 pb-1">이번 주</p>
              {weekSessions.map((ch: any) => (
                <SessionButton key={ch.id} ch={ch} isActive={activeChannelId === ch.id} onClick={() => handleSelectSession(ch)} />
              ))}
            </>
          )}
          {olderSessions.length > 0 && (
            <>
              <p className="text-[10px] text-text-muted uppercase tracking-wider px-2 pt-3 pb-1">이전</p>
              {olderSessions.slice(0, 15).map((ch: any) => (
                <SessionButton key={ch.id} ch={ch} isActive={activeChannelId === ch.id} onClick={() => handleSelectSession(ch)} />
              ))}
            </>
          )}
        </div>
      </div>

      {/* ── 메인 영역 ── */}
      <div
        className="flex-1 bg-bg-card rounded-xl flex flex-col relative"
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag overlay */}
        {isDragging && (
          <div className="absolute inset-0 z-50 bg-bg-card/90 border-2 border-dashed border-primary rounded-xl flex items-center justify-center">
            <div className="text-center">
              <p className="text-4xl mb-3">📎</p>
              <p className="text-white font-medium text-lg">파일을 여기에 놓으세요</p>
              <p className="text-text-muted text-sm mt-1">PDF, 이미지, 엑셀, 워드 등</p>
            </div>
          </div>
        )}
        {tab === 'chat' ? (
          <>
            {/* 헤더 */}
            <div className="p-4 border-b border-bg-input/50">
              <div className="flex items-center gap-2">
                <span className="text-lg">🧠</span>
                <div>
                  <h3 className="text-white font-medium text-sm">Brain</h3>
                  <p className="text-[11px] text-text-muted">
                    이메일, 일정, 메모, 연구실 정보 — 무엇이든 물어보세요
                  </p>
                </div>
              </div>
            </div>

            {/* 메시지 영역 */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.length === 0 && (
                <div className="text-center text-text-muted py-12">
                  <p className="text-4xl mb-4">🧠</p>
                  <p className="text-lg font-medium">연구실 AI 비서</p>
                  <p className="text-sm mt-2">무엇이든 물어보세요. 이메일, 일정, 논문, 메모 — 자연어로 요청하면 됩니다.</p>
                  <div className="mt-6 grid grid-cols-2 gap-3 max-w-md mx-auto">
                    {['이메일 브리핑 해줘', '오늘 일정 뭐야?', '이거 메모해줘: 내일 장비 예약', '학생 명단 보여줘'].map(q => (
                      <button key={q} onClick={() => setInput(q)} className="px-3 py-2 bg-bg-input rounded-lg text-xs text-text-muted hover:text-white hover:bg-bg-input/80 transition-colors">
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {messages.map(msg => (
                <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] px-4 py-3 rounded-2xl text-sm whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-primary text-white rounded-br-md'
                      : 'bg-bg-input text-white rounded-bl-md'
                  }`}>
                    {msg.content}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="bg-bg-input px-4 py-3 rounded-2xl rounded-bl-md text-sm text-text-muted">
                    생각 중...
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* 입력 영역 */}
            <div className="border-t border-bg-input/50">
              {/* 업로드된 파일 표시 */}
              {uploadedFile && (
                <div className="px-4 pt-3 flex items-center gap-2">
                  <span className="flex items-center gap-1 px-2.5 py-1 bg-blue-500/10 text-blue-400 rounded-lg text-xs">
                    📎 {uploadedFile.filename}
                    <button onClick={() => setUploadedFile(null)} className="ml-1 text-blue-400/50 hover:text-blue-400">✕</button>
                  </span>
                </div>
              )}
              <div className="px-4 pb-4 pt-3 flex gap-2">
                <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden"
                  accept=".pdf,.xlsx,.xls,.doc,.docx,.png,.jpg,.jpeg,.txt,.csv,.md" />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="px-3 py-3 bg-bg-input text-text-muted rounded-xl hover:text-white hover:bg-bg-input/80 transition-colors disabled:opacity-50"
                  title="파일 업로드"
                >
                  {uploading ? '⏳' : '📎'}
                </button>
                <input
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
                  placeholder="메시지를 입력하세요..."
                  className="flex-1 bg-bg-input text-white px-4 py-3 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <button
                  onClick={handleSend}
                  disabled={loading || !input.trim()}
                  className="px-6 py-3 bg-primary text-white rounded-xl text-sm font-medium disabled:opacity-50 hover:bg-primary/90"
                >
                  전송
                </button>
              </div>
            </div>
          </>
        ) : (
          /* 검색 탭 */
          <div className="p-6">
            <h3 className="text-white font-medium text-lg mb-4">🔍 Lab Memory 검색</h3>
            <div className="flex gap-2 mb-6">
              <input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                placeholder="검색어를 입력하세요 (과제, 논문, 구성원, 메모...)"
                className="flex-1 bg-bg-input text-white px-4 py-3 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <button onClick={handleSearch} className="px-6 py-3 bg-primary text-white rounded-xl text-sm font-medium">검색</button>
            </div>
            {searchResults && (
              <div className="space-y-4">
                {searchResults.error && <p className="text-red-400">{searchResults.error}</p>}
                {['projects', 'publications', 'members', 'memos'].map(key => {
                  const items = searchResults[key];
                  if (!items?.length) return null;
                  const labels: Record<string, string> = { projects: '📋 과제', publications: '📄 논문', members: '👤 구성원', memos: '💡 메모' };
                  return (
                    <div key={key}>
                      <h4 className="text-primary font-medium mb-2">{labels[key]} ({items.length})</h4>
                      {items.map((item: any) => (
                        <div key={item.id} className="bg-bg-input p-3 rounded-lg mb-2">
                          <p className="text-white text-sm font-medium">{item.name || item.title || item.content?.slice(0, 100)}</p>
                          <p className="text-text-muted text-xs">{item.funder || item.journal || item.role || item.tags?.join(', ') || ''}</p>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionButton({ ch, isActive, onClick }: { ch: any; isActive: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
        isActive ? 'bg-primary/10 text-primary' : 'text-text-muted hover:bg-bg-input hover:text-white'
      }`}
    >
      {isActive && <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />}
      <span className="flex-1 text-left truncate text-xs">
        {ch.name || `대화 #${ch.id.slice(-4)}`}
      </span>
      <span className="text-[10px] text-text-muted flex-shrink-0">
        {timeAgo(ch.lastMessageAt || ch.createdAt)}
      </span>
    </button>
  );
}
