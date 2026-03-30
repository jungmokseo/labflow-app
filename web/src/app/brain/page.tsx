'use client';

import { useState, useRef, useEffect } from 'react';
import { brainChat, getBrainChannels, getChannelMessages, searchBrainMemory, type BrainChannel, type BrainMessage } from '@/lib/api';

export default function BrainPage() {
  const [channels, setChannels] = useState<BrainChannel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<BrainMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any>(null);
  const [tab, setTab] = useState<'chat' | 'search'>('chat');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadChannels();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function loadChannels() {
    try {
      const res = await getBrainChannels();
      setChannels(res.data || []);
    } catch {}
  }

  async function loadMessages(channelId: string) {
    try {
      const res = await getChannelMessages(channelId);
      setMessages(res.data || []);
      setActiveChannelId(channelId);
    } catch {}
  }

  async function handleSend() {
    if (!input.trim() || loading) return;
    const msg = input;
    setInput('');
    setMessages(prev => [...prev, { id: `temp-${Date.now()}`, role: 'user', content: msg, createdAt: new Date().toISOString() }]);
    setLoading(true);

    try {
      const result = await brainChat(msg, activeChannelId || undefined);
      setMessages(prev => [...prev, {
        id: `resp-${Date.now()}`,
        role: 'assistant',
        content: result.response,
        createdAt: new Date().toISOString(),
      }]);
      if (!activeChannelId && result.channelId) {
        setActiveChannelId(result.channelId);
        loadChannels();
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

  return (
    <div className="flex h-[calc(100vh-2rem)] gap-4">
      {/* 채널 목록 */}
      <div className="w-56 bg-bg-card rounded-xl p-4 flex flex-col">
        <h2 className="text-lg font-bold text-white mb-4">🧠 미니브레인</h2>
        <div className="flex gap-1 mb-4">
          <button onClick={() => setTab('chat')} className={`flex-1 px-2 py-1 rounded text-xs ${tab === 'chat' ? 'bg-primary text-white' : 'bg-bg-input text-text-muted'}`}>채팅</button>
          <button onClick={() => setTab('search')} className={`flex-1 px-2 py-1 rounded text-xs ${tab === 'search' ? 'bg-primary text-white' : 'bg-bg-input text-text-muted'}`}>검색</button>
        </div>
        <button
          onClick={() => { setActiveChannelId(null); setMessages([]); }}
          className="w-full px-3 py-2 bg-primary/20 text-primary rounded-lg text-sm mb-3 hover:bg-primary/30"
        >
          + 새 대화
        </button>
        <div className="flex-1 overflow-y-auto space-y-1">
          {channels.map(ch => (
            <button
              key={ch.id}
              onClick={() => loadMessages(ch.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm truncate ${
                activeChannelId === ch.id ? 'bg-primary/10 text-primary' : 'text-text-muted hover:bg-bg-input'
              }`}
            >
              {ch.name || `대화 #${ch.id.slice(-4)}`}
            </button>
          ))}
        </div>
      </div>

      {/* 메인 영역 */}
      <div className="flex-1 bg-bg-card rounded-xl flex flex-col">
        {tab === 'chat' ? (
          <>
            <div className="p-4 border-b border-bg-input/50">
              <h3 className="text-white font-medium">
                {activeChannelId ? '대화 진행 중' : '새 대화 시작'}
              </h3>
              <p className="text-xs text-text-muted mt-1">
                연구실 정보를 물어보세요. DB에 있는 정보만 정확히 답변합니다.
              </p>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.length === 0 && (
                <div className="text-center text-text-muted py-12">
                  <p className="text-4xl mb-4">🧠</p>
                  <p className="text-lg font-medium">Lab Memory 미니브레인</p>
                  <p className="text-sm mt-2">3층 기억 구조로 연구실 정보를 관리합니다</p>
                  <div className="mt-6 grid grid-cols-2 gap-3 max-w-md mx-auto">
                    {['NRF 과제 사사 문구 알려줘', '학생 명단 보여줘', '지난 미팅 요약해줘', 'PDMS 관련 논문 있어?'].map(q => (
                      <button key={q} onClick={() => { setInput(q); }} className="px-3 py-2 bg-bg-input rounded-lg text-xs text-text-muted hover:text-white hover:bg-bg-input/80 transition-colors">
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
            <div className="p-4 border-t border-bg-input/50">
              <div className="flex gap-2">
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
              <button onClick={handleSearch} className="px-6 py-3 bg-primary text-white rounded-xl text-sm font-medium">
                검색
              </button>
            </div>
            {searchResults && (
              <div className="space-y-4">
                {searchResults.error && <p className="text-red-400">{searchResults.error}</p>}
                {searchResults.projects?.length > 0 && (
                  <div>
                    <h4 className="text-primary font-medium mb-2">📋 과제 ({searchResults.projects.length})</h4>
                    {searchResults.projects.map((p: any) => (
                      <div key={p.id} className="bg-bg-input p-3 rounded-lg mb-2">
                        <p className="text-white text-sm font-medium">{p.name}</p>
                        <p className="text-text-muted text-xs">{p.funder} · {p.number}</p>
                      </div>
                    ))}
                  </div>
                )}
                {searchResults.publications?.length > 0 && (
                  <div>
                    <h4 className="text-primary font-medium mb-2">📄 논문 ({searchResults.publications.length})</h4>
                    {searchResults.publications.map((p: any) => (
                      <div key={p.id} className="bg-bg-input p-3 rounded-lg mb-2">
                        <p className="text-white text-sm">{p.title}</p>
                        <p className="text-text-muted text-xs">{p.journal} ({p.year})</p>
                      </div>
                    ))}
                  </div>
                )}
                {searchResults.members?.length > 0 && (
                  <div>
                    <h4 className="text-primary font-medium mb-2">👤 구성원 ({searchResults.members.length})</h4>
                    {searchResults.members.map((m: any) => (
                      <div key={m.id} className="bg-bg-input p-3 rounded-lg mb-2">
                        <p className="text-white text-sm">{m.name} ({m.role})</p>
                        <p className="text-text-muted text-xs">{m.email}</p>
                      </div>
                    ))}
                  </div>
                )}
                {searchResults.memos?.length > 0 && (
                  <div>
                    <h4 className="text-primary font-medium mb-2">💡 메모 ({searchResults.memos.length})</h4>
                    {searchResults.memos.map((m: any) => (
                      <div key={m.id} className="bg-bg-input p-3 rounded-lg mb-2">
                        <p className="text-white text-sm">{m.content.slice(0, 200)}</p>
                        <p className="text-text-muted text-xs">{m.tags?.join(', ')}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
