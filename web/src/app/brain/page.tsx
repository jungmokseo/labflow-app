'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { brainChat, brainUpload, getBrainChannels, getChannelMessages, searchBrainMemory, type BrainChannel, type BrainMessage, type BrainTool, type UploadResult } from '@/lib/api';

const TOOLS: Array<{ key: BrainTool; icon: string; label: string; persistent: boolean }> = [
  { key: 'general', icon: '🧠', label: '자유 대화', persistent: false },
  { key: 'email', icon: '📧', label: '이메일', persistent: true },
  { key: 'papers', icon: '📚', label: '논문', persistent: true },
  { key: 'meeting', icon: '🎙️', label: '미팅', persistent: true },
  { key: 'calendar', icon: '📅', label: '캘린더', persistent: true },
];

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
  const [toolSessions, setToolSessions] = useState<any[]>([]);
  const [freeSessions, setFreeSessions] = useState<any[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<BrainMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [activeTool, setActiveTool] = useState<BrainTool>('general');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any>(null);
  const [tab, setTab] = useState<'chat' | 'search'>('chat');
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
      const data = res.data || res;
      if (Array.isArray(data)) {
        setToolSessions(data.filter((c: any) => c.tool && c.tool !== 'general'));
        setFreeSessions(data.filter((c: any) => !c.tool || c.tool === 'general'));
      } else {
        setToolSessions((data as any).toolSessions || []);
        setFreeSessions((data as any).freeSessions || []);
      }
    } catch {}
  }, []);

  async function loadMessages(channelId: string) {
    try {
      const res = await getChannelMessages(channelId);
      setMessages(res.data || []);
      setActiveChannelId(channelId);
    } catch {}
  }

  function handleSelectTool(tool: BrainTool) {
    setActiveTool(tool);
    if (tool !== 'general') {
      // 영구 세션: 기존 세션 있으면 로드
      const existing = toolSessions.find((c: any) => c.tool === tool);
      if (existing) {
        loadMessages(existing.id);
      } else {
        // 새 세션은 첫 메시지 보낼 때 서버에서 생성
        setActiveChannelId(null);
        setMessages([]);
      }
    } else {
      // 자유 대화: 새 세션
      setActiveChannelId(null);
      setMessages([]);
    }
  }

  function handleSelectFreeSession(ch: any) {
    setActiveTool('general');
    loadMessages(ch.id);
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const result = await brainUpload(file);
      setUploadedFile(result);
      // 파일 처리 결과를 메시지로 표시
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
    setInput('');
    setMessages(prev => [...prev, { id: `temp-${Date.now()}`, role: 'user', content: msg, createdAt: new Date().toISOString() }]);
    setLoading(true);

    try {
      const result = await brainChat(msg, activeChannelId || undefined, activeTool, currentFileId);
      setMessages(prev => [...prev, {
        id: `resp-${Date.now()}`,
        role: 'assistant',
        content: result.response,
        createdAt: new Date().toISOString(),
      }]);
      if (result.channelId && result.channelId !== activeChannelId) {
        setActiveChannelId(result.channelId);
        loadChannels(); // 사이드바 새로고침
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

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragging(false);

    const file = e.dataTransfer.files?.[0];
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
    }
  }

  // 자유 대화 세션을 날짜별 그룹
  const todaySessions = freeSessions.filter((c: any) => isToday(c.lastMessageAt || c.createdAt));
  const weekSessions = freeSessions.filter((c: any) => !isToday(c.lastMessageAt || c.createdAt) && isThisWeek(c.lastMessageAt || c.createdAt));
  const olderSessions = freeSessions.filter((c: any) => !isThisWeek(c.lastMessageAt || c.createdAt));

  const activeToolInfo = TOOLS.find(t => t.key === activeTool);

  return (
    <div className="flex h-[calc(100vh-2rem)] gap-4">
      {/* ── 사이드바 ── */}
      <div className="w-60 bg-bg-card rounded-xl flex flex-col overflow-hidden">
        <div className="p-4 pb-2">
          <h2 className="text-lg font-bold text-white">🧠 미니브레인</h2>
          <div className="flex gap-1 mt-3">
            <button onClick={() => setTab('chat')} className={`flex-1 px-2 py-1 rounded text-xs ${tab === 'chat' ? 'bg-primary text-white' : 'bg-bg-input text-text-muted'}`}>채팅</button>
            <button onClick={() => setTab('search')} className={`flex-1 px-2 py-1 rounded text-xs ${tab === 'search' ? 'bg-primary text-white' : 'bg-bg-input text-text-muted'}`}>검색</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1">
          {/* 영구 세션 도구 */}
          <p className="text-[10px] text-text-muted uppercase tracking-wider px-2 pt-3 pb-1">도구 세션</p>
          {TOOLS.filter(t => t.persistent).map(t => {
            const session = toolSessions.find((c: any) => c.tool === t.key);
            const isActive = activeTool === t.key && activeChannelId === session?.id;
            return (
              <button
                key={t.key}
                onClick={() => handleSelectTool(t.key)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive ? 'bg-primary/10 text-primary' : 'text-text-muted hover:bg-bg-input hover:text-white'
                }`}
              >
                <span>{t.icon}</span>
                <span className="flex-1 text-left truncate">{t.label}</span>
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />
                {session?.messageCount ? (
                  <span className="text-[10px] text-text-muted">{session.messageCount}</span>
                ) : null}
              </button>
            );
          })}

          {/* 새 대화 버튼 */}
          <div className="pt-3">
            <button
              onClick={() => handleSelectTool('general')}
              className="w-full px-3 py-2 bg-primary/20 text-primary rounded-lg text-sm hover:bg-primary/30"
            >
              + 새 자유 대화
            </button>
          </div>

          {/* 자유 대화 세션 목록 */}
          {todaySessions.length > 0 && (
            <>
              <p className="text-[10px] text-text-muted uppercase tracking-wider px-2 pt-3 pb-1">오늘</p>
              {todaySessions.map((ch: any) => (
                <SessionButton key={ch.id} ch={ch} isActive={activeChannelId === ch.id} onClick={() => handleSelectFreeSession(ch)} />
              ))}
            </>
          )}
          {weekSessions.length > 0 && (
            <>
              <p className="text-[10px] text-text-muted uppercase tracking-wider px-2 pt-3 pb-1">이번 주</p>
              {weekSessions.map((ch: any) => (
                <SessionButton key={ch.id} ch={ch} isActive={activeChannelId === ch.id} onClick={() => handleSelectFreeSession(ch)} />
              ))}
            </>
          )}
          {olderSessions.length > 0 && (
            <>
              <p className="text-[10px] text-text-muted uppercase tracking-wider px-2 pt-3 pb-1">이전</p>
              {olderSessions.slice(0, 10).map((ch: any) => (
                <SessionButton key={ch.id} ch={ch} isActive={activeChannelId === ch.id} onClick={() => handleSelectFreeSession(ch)} />
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
                {activeToolInfo && (
                  <span className="text-lg">{activeToolInfo.icon}</span>
                )}
                <div>
                  <h3 className="text-white font-medium text-sm">
                    {activeToolInfo?.persistent
                      ? `${activeToolInfo.label} 세션`
                      : activeChannelId ? '자유 대화' : '새 대화'}
                  </h3>
                  <p className="text-[11px] text-text-muted">
                    {activeToolInfo?.persistent
                      ? '대화가 쌓일수록 이 분야에서 AI가 더 정확해집니다'
                      : '연구실 정보를 물어보세요. 메모/구성원/과제 질문은 자동 처리됩니다'}
                  </p>
                </div>
              </div>
            </div>

            {/* 메시지 영역 */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.length === 0 && (
                <div className="text-center text-text-muted py-12">
                  <p className="text-4xl mb-4">{activeToolInfo?.icon || '🧠'}</p>
                  <p className="text-lg font-medium">
                    {activeToolInfo?.persistent
                      ? `${activeToolInfo.label} 비서`
                      : 'Lab Memory 미니브레인'}
                  </p>
                  <p className="text-sm mt-2">
                    {activeTool === 'email' && '이메일 브리핑, 중요 메일 확인, 분류 관련 질문을 하세요'}
                    {activeTool === 'papers' && '최신 논문, 연구 동향, 관련 논문 검색을 질문하세요'}
                    {activeTool === 'meeting' && '미팅 기록 조회, 액션 아이템 추적, 후속 미팅 관련 질문을 하세요'}
                    {activeTool === 'calendar' && '오늘/이번주 일정, 대기 중 일정, 스케줄 관련 질문을 하세요'}
                    {activeTool === 'general' && '무엇이든 물어보세요. 메모, 구성원, 과제 질문은 자동 처리됩니다'}
                  </p>
                  {activeTool === 'general' && (
                    <div className="mt-6 grid grid-cols-2 gap-3 max-w-md mx-auto">
                      {['NRF 과제 사사 문구 알려줘', '학생 명단 보여줘', '이거 메모해줘: 내일 장비 예약', 'PDMS 관련 정보 있어?'].map(q => (
                        <button key={q} onClick={() => setInput(q)} className="px-3 py-2 bg-bg-input rounded-lg text-xs text-text-muted hover:text-white hover:bg-bg-input/80 transition-colors">
                          {q}
                        </button>
                      ))}
                    </div>
                  )}
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
              {/* 도구 선택 바 */}
              <div className="px-4 pt-3 pb-1 flex gap-1 overflow-x-auto">
                {TOOLS.map(t => (
                  <button
                    key={t.key}
                    onClick={() => handleSelectTool(t.key)}
                    className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs whitespace-nowrap transition-colors ${
                      activeTool === t.key
                        ? 'bg-primary text-white'
                        : 'bg-bg-input/50 text-text-muted hover:text-white hover:bg-bg-input'
                    }`}
                  >
                    <span>{t.icon}</span>
                    <span>{t.label}</span>
                    {t.persistent && <span className="w-1.5 h-1.5 rounded-full bg-green-400 ml-0.5" />}
                  </button>
                ))}
              </div>
              {/* 업로드된 파일 표시 */}
              {uploadedFile && (
                <div className="px-4 pt-2 flex items-center gap-2">
                  <span className="flex items-center gap-1 px-2.5 py-1 bg-blue-500/10 text-blue-400 rounded-lg text-xs">
                    📎 {uploadedFile.filename}
                    <button onClick={() => setUploadedFile(null)} className="ml-1 text-blue-400/50 hover:text-blue-400">✕</button>
                  </span>
                </div>
              )}
              {/* 입력 */}
              <div className="px-4 pb-4 pt-2 flex gap-2">
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
                  placeholder={activeTool === 'general'
                    ? '메시지를 입력하세요...'
                    : `${activeToolInfo?.icon} ${activeToolInfo?.label} — 질문하세요...`}
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
      <span className="flex-1 text-left truncate text-xs">
        {ch.name || `대화 #${ch.id.slice(-4)}`}
      </span>
      <span className="text-[10px] text-text-muted flex-shrink-0">
        {timeAgo(ch.lastMessageAt || ch.createdAt)}
      </span>
    </button>
  );
}
