'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  brainChat, brainUpload, getBrainChannels, getChannelMessages, deleteBrainChannel, searchBrainMemory,
  type BrainMessage, type UploadResult,
} from '@/lib/api';
import { useApiData } from '@/lib/use-api';
import { useConversationsStore } from '@/store/conversations';
import { stripEmoji } from '@/lib/strip-emoji';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Brain, Paperclip, Loader2, Search, X, Copy, Mic, MicOff, Send, Plus, Trash2,
  MessageSquare, Clock, ChevronDown, ChevronUp,
} from 'lucide-react';

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

function formatRecordingTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const MAX_RECORDING_SECONDS = 180; // 3 minutes

export default function BrainPage() {
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [localNewMessages, setLocalNewMessages] = useState<BrainMessage[]>([]);
  const [input, setInput] = useState('');
  const [localLoading, setLocalLoading] = useState(false);
  const [tab, setTab] = useState<'chat' | 'search'>('chat');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any>(null);
  const [uploadedFile, setUploadedFile] = useState<UploadResult | null>(null);
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Voice recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const dragCounter = useRef(0);

  // Conversations store
  const { conversations, setMessages: storeMessages, addMessage: storeAddMessage, setStreaming } = useConversationsStore();

  // SWR for channels list
  const { data: channelsData, mutate: refreshChannels } = useApiData(
    'brain-channels',
    async () => { const res = await getBrainChannels(); return Array.isArray(res.data) ? res.data : []; },
    { revalidateOnFocus: false, dedupingInterval: 60000 }
  );
  const sessions = channelsData || [];

  // Derive messages from store or local state
  const activeMessages = activeChannelId ? (conversations[activeChannelId]?.messages || []) : localNewMessages;
  const isChannelStreaming = activeChannelId ? (conversations[activeChannelId]?.isStreaming || false) : false;
  const loading = localLoading || isChannelStreaming;

  // Auto-load first channel messages
  useEffect(() => {
    if (sessions.length > 0 && !activeChannelId) {
      loadMessages(sessions[0].id);
    }
  }, [sessions]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [activeMessages]);

  // Auto-stop recording at max time
  useEffect(() => {
    if (isRecording && recordingTime >= MAX_RECORDING_SECONDS) {
      stopRecording();
    }
  }, [isRecording, recordingTime]);

  async function loadMessages(channelId: string) {
    // Check store first
    if (conversations[channelId]?.messages?.length) {
      setActiveChannelId(channelId);
      return;
    }
    try {
      const res = await getChannelMessages(channelId);
      const msgs = res.data || res || [];
      storeMessages(channelId, msgs);
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
    setLocalNewMessages([]);
  }

  async function handleDeleteSession(channelId: string) {
    if (!confirm('이 대화를 삭제하시겠습니까?')) return;
    try {
      await deleteBrainChannel(channelId);
      refreshChannels((prev: any) => prev ? (prev as any[]).filter((s: any) => s.id !== channelId) : prev, { revalidate: false });
      if (activeChannelId === channelId) {
        setActiveChannelId(null);
        setLocalNewMessages([]);
      }
    } catch {
      alert('삭제 실패');
    }
  }

  function addMessageToActive(msg: BrainMessage) {
    if (activeChannelId) {
      storeAddMessage(activeChannelId, msg);
    } else {
      setLocalNewMessages(prev => [...prev, msg]);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const result = await brainUpload(file);
      setUploadedFile(result);
      addMessageToActive({
        id: `file-${Date.now()}`,
        role: 'assistant',
        content: result.message,
        createdAt: new Date().toISOString(),
      });
    } catch (err: any) {
      addMessageToActive({
        id: `err-${Date.now()}`,
        role: 'assistant',
        content: `파일 처리 실패: ${err.message}`,
        createdAt: new Date().toISOString(),
      });
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
    const channelIdAtSend = activeChannelId;
    setInput('');
    setUploadedFile(null);

    const userMsg: BrainMessage = { id: `temp-${Date.now()}`, role: 'user', content: msg, createdAt: new Date().toISOString() };

    if (channelIdAtSend) {
      storeAddMessage(channelIdAtSend, userMsg);
      setStreaming(channelIdAtSend, true);
    } else {
      setLocalNewMessages(prev => [...prev, userMsg]);
      setLocalLoading(true);
    }

    try {
      const result = await brainChat(msg, channelIdAtSend || undefined, currentFileId, isNewSession ? true : undefined);
      const assistantMsg: BrainMessage = {
        id: `resp-${Date.now()}`,
        role: 'assistant',
        content: result.response,
        createdAt: new Date().toISOString(),
      };

      if (result.channelId && result.channelId !== channelIdAtSend) {
        // New channel created -- move local messages to store
        const newMsgs = isNewSession ? [...localNewMessages, userMsg, assistantMsg] : [userMsg, assistantMsg];
        storeMessages(result.channelId, newMsgs);
        setActiveChannelId(result.channelId);
        setLocalNewMessages([]);
        refreshChannels();
        // Sync with server messages
        try {
          const res = await getChannelMessages(result.channelId);
          const serverMsgs = res.data || res || [];
          if (Array.isArray(serverMsgs) && serverMsgs.length > 0) {
            storeMessages(result.channelId, serverMsgs);
          }
        } catch {}
      } else if (channelIdAtSend) {
        storeAddMessage(channelIdAtSend, assistantMsg);
      } else {
        setLocalNewMessages(prev => [...prev, assistantMsg]);
      }
    } catch (err: any) {
      const errMsg: BrainMessage = {
        id: `err-${Date.now()}`,
        role: 'assistant',
        content: `오류: ${err.message}`,
        createdAt: new Date().toISOString(),
      };
      if (channelIdAtSend) {
        storeAddMessage(channelIdAtSend, errMsg);
      } else {
        setLocalNewMessages(prev => [...prev, errMsg]);
      }
    } finally {
      if (channelIdAtSend) {
        setStreaming(channelIdAtSend, false);
      } else {
        setLocalLoading(false);
      }
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

  // Voice recording
  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
      });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        if (blob.size === 0) return;

        // Transcribe via API
        const formData = new FormData();
        formData.append('audio', blob, 'recording.webm');

        try {
          const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'https://labflow-app-production.up.railway.app';
          const headers: Record<string, string> = {};
          if (typeof window !== 'undefined') {
            const { createClient } = await import('@/lib/supabase');
            const supabase = createClient();
            const { data: { session } } = await supabase.auth.getSession();
            if (session?.access_token) {
              headers['Authorization'] = `Bearer ${session.access_token}`;
            }
          }
          const res = await fetch(`${API_BASE}/api/brain/transcribe`, {
            method: 'POST',
            headers,
            body: formData,
          });
          if (res.ok) {
            const data = await res.json();
            if (data.text) {
              setInput(prev => prev ? `${prev} ${data.text}` : data.text);
            }
          }
        } catch (err) {
          console.error('Transcription failed:', err);
        }
      };

      mediaRecorder.start(1000);
      startTimeRef.current = Date.now();
      setRecordingTime(0);
      setIsRecording(true);

      timerRef.current = setInterval(() => {
        setRecordingTime(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 500);
    } catch (err) {
      console.error('Microphone access error:', err);
    }
  }

  function stopRecording() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsRecording(false);
    setRecordingTime(0);
  }

  function handleCopyMessage(id: string, content: string) {
    navigator.clipboard.writeText(content);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  // Drag and drop
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
      addMessageToActive({ id: `file-${Date.now()}`, role: 'assistant', content: result.message, createdAt: new Date().toISOString() });
    } catch (err: any) {
      addMessageToActive({ id: `err-${Date.now()}`, role: 'assistant', content: `파일 처리 실패: ${err.message}`, createdAt: new Date().toISOString() });
    } finally { setUploading(false); }
  }

  // Group sessions by date
  const todaySessions = sessions.filter((c: any) => isToday(c.lastMessageAt || c.createdAt));
  const weekSessions = sessions.filter((c: any) => !isToday(c.lastMessageAt || c.createdAt) && isThisWeek(c.lastMessageAt || c.createdAt));
  const olderSessions = sessions.filter((c: any) => !isThisWeek(c.lastMessageAt || c.createdAt));

  const searchLabelIcons: Record<string, React.ReactNode> = {
    projects: <ClipboardList className="w-3.5 h-3.5 inline mr-1" />,
    publications: <BookOpen className="w-3.5 h-3.5 inline mr-1" />,
    members: <User className="w-3.5 h-3.5 inline mr-1" />,
    memos: <MessageSquare className="w-3.5 h-3.5 inline mr-1" />,
  };

  return (
    <div className="flex h-screen md:h-[calc(100vh-2rem)] md:gap-4 p-0 md:p-4">
      {/* Sidebar (hidden on mobile) */}
      <div className="hidden md:flex w-60 bg-bg-card rounded-xl flex-col overflow-hidden">
        <div className="p-4 pb-2">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Brain className="w-5 h-5 text-primary" /> Brain
          </h2>
          <div className="flex gap-1 mt-3">
            <button onClick={() => setTab('chat')} className={`flex-1 px-2 py-1 rounded text-xs ${tab === 'chat' ? 'bg-primary text-white' : 'bg-bg-input text-text-muted'}`}>채팅</button>
            <button onClick={() => setTab('search')} className={`flex-1 px-2 py-1 rounded text-xs ${tab === 'search' ? 'bg-primary text-white' : 'bg-bg-input text-text-muted'}`}>검색</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1">
          <div className="pt-3 pb-2">
            <button
              onClick={handleNewSession}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-primary/20 text-primary rounded-lg text-sm hover:bg-primary/30 font-medium"
            >
              <Plus className="w-4 h-4" /> 새 대화
            </button>
          </div>

          {!activeChannelId && (
            <div className="px-3 py-2 rounded-lg text-sm bg-primary/10 text-primary flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              <span className="text-xs font-medium">새 대화</span>
            </div>
          )}

          {todaySessions.length > 0 && (
            <>
              <p className="text-[10px] text-text-muted uppercase tracking-wider px-2 pt-3 pb-1">오늘</p>
              {todaySessions.map((ch: any) => (
                <SessionButton key={ch.id} ch={ch} isActive={activeChannelId === ch.id} onClick={() => handleSelectSession(ch)} onDelete={() => handleDeleteSession(ch.id)} isStreaming={conversations[ch.id]?.isStreaming} />
              ))}
            </>
          )}
          {weekSessions.length > 0 && (
            <>
              <p className="text-[10px] text-text-muted uppercase tracking-wider px-2 pt-3 pb-1">이번 주</p>
              {weekSessions.map((ch: any) => (
                <SessionButton key={ch.id} ch={ch} isActive={activeChannelId === ch.id} onClick={() => handleSelectSession(ch)} onDelete={() => handleDeleteSession(ch.id)} isStreaming={conversations[ch.id]?.isStreaming} />
              ))}
            </>
          )}
          {olderSessions.length > 0 && (
            <>
              <p className="text-[10px] text-text-muted uppercase tracking-wider px-2 pt-3 pb-1">이전</p>
              {olderSessions.slice(0, 15).map((ch: any) => (
                <SessionButton key={ch.id} ch={ch} isActive={activeChannelId === ch.id} onClick={() => handleSelectSession(ch)} onDelete={() => handleDeleteSession(ch.id)} isStreaming={conversations[ch.id]?.isStreaming} />
              ))}
            </>
          )}
        </div>
      </div>

      {/* Main area */}
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
              <Paperclip className="w-10 h-10 text-primary mx-auto mb-3" />
              <p className="text-white font-medium text-lg">파일을 여기에 놓으세요</p>
              <p className="text-text-muted text-sm mt-1">PDF, 이미지, 엑셀, 워드 등</p>
            </div>
          </div>
        )}
        {tab === 'chat' ? (
          <>
            {/* Header */}
            <div className="p-4 border-b border-bg-input/50">
              <div className="flex items-center gap-2">
                <Brain className="w-5 h-5 text-primary" />
                <div>
                  <h3 className="text-white font-medium text-sm">Brain</h3>
                  <p className="text-[11px] text-text-muted">
                    이메일, 일정, 메모, 연구실 정보 -- 무엇이든 물어보세요
                  </p>
                </div>
              </div>
            </div>

            {/* Messages area — Claude-style */}
            <div className="flex-1 overflow-y-auto p-4">
              <div className="max-w-3xl mx-auto space-y-6">
                {activeMessages.length === 0 && (
                  <div className="text-center text-text-muted py-12">
                    <Brain className="w-12 h-12 text-primary/40 mx-auto mb-4" />
                    <p className="text-lg font-medium">연구실 AI 비서</p>
                    <p className="text-sm mt-2">무엇이든 물어보세요. 이메일, 일정, 논문, 메모 -- 자연어로 요청하면 됩니다.</p>
                    <div className="mt-6 grid grid-cols-2 gap-3 max-w-md mx-auto">
                      {['이메일 브리핑 해줘', '오늘 일정 뭐야?', '이거 메모해줘: 내일 장비 예약', '학생 명단 보여줘'].map(q => (
                        <button key={q} onClick={() => setInput(q)} className="px-3 py-2 bg-bg-input rounded-lg text-xs text-text-muted hover:text-white hover:bg-bg-input/80 transition-colors">
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {activeMessages.map(msg => (
                  <div key={msg.id}>
                    {msg.role === 'user' ? (
                      /* User message: right-aligned blue bubble */
                      <div className="flex justify-end">
                        <div className="bg-blue-600 text-white rounded-2xl rounded-br-sm max-w-[70%] px-4 py-3 text-sm whitespace-pre-wrap">
                          {msg.content}
                        </div>
                      </div>
                    ) : (
                      /* AI message: left-aligned, no bubble, full width, with markdown */
                      <div className="group relative">
                        <div className="prose prose-invert prose-sm max-w-none text-white/90 leading-relaxed">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {stripEmoji(msg.content)}
                          </ReactMarkdown>
                        </div>
                        {/* Hover action: copy */}
                        <div className="absolute -top-2 right-0 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => handleCopyMessage(msg.id, msg.content)}
                            className="p-1.5 rounded-lg bg-bg-input/80 text-text-muted hover:text-white transition-colors"
                            title="복사"
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                          {copiedId === msg.id && (
                            <span className="absolute -top-6 right-0 text-[10px] text-green-400 bg-bg-card px-2 py-0.5 rounded">복사됨</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {loading && (
                  <div className="flex justify-start">
                    <div className="text-sm text-text-muted flex items-center gap-1.5">
                      <span>생각 중</span>
                      <span className="flex gap-0.5">
                        <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                      </span>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>

            {/* Input area */}
            <div className="border-t border-bg-input/50">
              {uploadedFile && (
                <div className="px-4 pt-3 flex items-center gap-2">
                  <span className="flex items-center gap-1 px-2.5 py-1 bg-blue-500/10 text-blue-400 rounded-lg text-xs">
                    <Paperclip className="w-3 h-3" /> {uploadedFile.filename}
                    <button onClick={() => setUploadedFile(null)} className="ml-1 text-blue-400/50 hover:text-blue-400">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                </div>
              )}
              <div className="px-4 pb-4 pt-3 flex gap-2 max-w-3xl mx-auto w-full">
                <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden"
                  accept=".pdf,.xlsx,.xls,.doc,.docx,.png,.jpg,.jpeg,.txt,.csv,.md" />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="px-3 py-3 bg-bg-input text-text-muted rounded-xl hover:text-white hover:bg-bg-input/80 transition-colors disabled:opacity-50"
                  title="파일 업로드"
                >
                  {uploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Paperclip className="w-5 h-5" />}
                </button>
                <input
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
                  placeholder="메시지를 입력하세요..."
                  className="flex-1 bg-bg-input text-white px-4 py-3 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
                {/* Voice input button */}
                <button
                  onClick={isRecording ? stopRecording : startRecording}
                  className={`px-3 py-3 rounded-xl transition-colors ${
                    isRecording
                      ? 'bg-red-500 text-white animate-pulse'
                      : 'bg-bg-input text-text-muted hover:text-white hover:bg-bg-input/80'
                  }`}
                  title={isRecording ? `녹음 중지 (${formatRecordingTime(recordingTime)})` : '음성 입력'}
                >
                  {isRecording ? (
                    <div className="flex items-center gap-1.5">
                      <MicOff className="w-5 h-5" />
                      <span className="text-xs font-mono">{formatRecordingTime(recordingTime)}</span>
                    </div>
                  ) : (
                    <Mic className="w-5 h-5" />
                  )}
                </button>
                <button
                  onClick={handleSend}
                  disabled={loading || !input.trim()}
                  className="px-5 py-3 bg-primary text-white rounded-xl text-sm font-medium disabled:opacity-50 hover:bg-primary/90"
                >
                  <Send className="w-5 h-5" />
                </button>
              </div>
            </div>
          </>
        ) : (
          /* Search tab */
          <div className="p-6">
            <h3 className="text-white font-medium text-lg mb-4 flex items-center gap-2">
              <Search className="w-5 h-5 text-primary" /> Lab Memory 검색
            </h3>
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
                  const labels: Record<string, string> = { projects: '과제', publications: '논문', members: '구성원', memos: '메모' };
                  return (
                    <div key={key}>
                      <h4 className="text-primary font-medium mb-2 flex items-center gap-1.5">
                        {searchLabelIcons[key]} {labels[key]} ({items.length})
                      </h4>
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

// Need to import these for the search labels
import { ClipboardList, BookOpen, User } from 'lucide-react';

function SessionButton({ ch, isActive, onClick, onDelete, isStreaming }: { ch: any; isActive: boolean; onClick: () => void; onDelete: () => void; isStreaming?: boolean }) {
  return (
    <div className={`group w-full flex items-center gap-1 px-3 py-2 rounded-lg text-sm transition-colors ${
      isActive ? 'bg-primary/10 text-primary' : 'text-text-muted hover:bg-bg-input hover:text-white'
    }`}>
      <button onClick={onClick} className="flex-1 flex items-center gap-2 min-w-0">
        {isStreaming ? <Loader2 className="w-3 h-3 animate-spin text-primary flex-shrink-0" /> : isActive ? <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0" /> : null}
        <span className="flex-1 text-left truncate text-xs">
          {ch.name || `대화 #${ch.id.slice(-4)}`}
        </span>
        <span className="text-[10px] text-text-muted flex-shrink-0">
          {timeAgo(ch.lastMessageAt || ch.createdAt)}
        </span>
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-red-400 flex-shrink-0 p-0.5 transition-opacity"
        title="삭제"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
