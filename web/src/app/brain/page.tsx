'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  brainChat, brainChatStream, brainUpload, getBrainChannels, getChannelMessages, deleteBrainChannel,
  pollForAssistantMessage,
  type BrainMessage, type UploadResult,
} from '@/lib/api';
import { useApiData } from '@/lib/use-api';
import { useWakeLock } from '@/lib/use-wake-lock';
import { savePendingBrainJob, getPendingBrainJob, clearPendingBrainJob, isPendingJobStale } from '@/lib/pending-brain-job';
import { useConversationsStore } from '@/store/conversations';
import { useBrainSessionsStore } from '@/store/brain-sessions';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import {
  Brain, Paperclip, Loader2, X, Copy, Mic, MicOff, Send, Plus,
  MessageSquare, BarChart3, AlertTriangle, Calendar, CheckSquare,
  Mail, BookOpen, Users, FileText, Clock, Zap, Info,
  ArrowDown, Square, ArrowRight, Quote, Hash,
  Building2, User, ShoppingCart, Megaphone,
} from 'lucide-react';

// Heading → Lucide icon mapping for structured AI responses
const HEADING_ICONS: Array<{ pattern: RegExp; icon: React.ReactNode }> = [
  { pattern: /요약|주요 사항/i, icon: <BarChart3 className="w-4 h-4 text-primary inline" /> },
  { pattern: /즉시 대응|긴급|대응 필요/i, icon: <AlertTriangle className="w-4 h-4 text-red-500 inline" /> },
  { pattern: /주요 일정|일정|캘린더|오늘 일정|이번 주/i, icon: <Calendar className="w-4 h-4 text-blue-500 inline" /> },
  { pattern: /권장 액션|할 일|액션|조치/i, icon: <CheckSquare className="w-4 h-4 text-green-500 inline" /> },
  { pattern: /이메일|메일|브리핑/i, icon: <Mail className="w-4 h-4 text-primary inline" /> },
  { pattern: /논문|연구|동향/i, icon: <BookOpen className="w-4 h-4 text-green-500 inline" /> },
  { pattern: /구성원|학생|팀/i, icon: <Users className="w-4 h-4 text-blue-500 inline" /> },
  { pattern: /진행 상황|업데이트|현황/i, icon: <Clock className="w-4 h-4 text-yellow-500 inline" /> },
  { pattern: /완료|완료된/i, icon: <Zap className="w-4 h-4 text-green-500 inline" /> },
  { pattern: /정보성|참고/i, icon: <Info className="w-4 h-4 text-text-muted inline" /> },
  { pattern: /연세대|학교|대학/i, icon: <BookOpen className="w-4 h-4 text-blue-500 inline" /> },
  { pattern: /링크솔루텍|회사|사업/i, icon: <Brain className="w-4 h-4 text-primary inline" /> },
  { pattern: /개인/i, icon: <Users className="w-4 h-4 text-text-muted inline" /> },
  { pattern: /광고|프로모션/i, icon: <Info className="w-4 h-4 text-text-muted inline" /> },
];

function getHeadingIcon(text: string): React.ReactNode | null {
  for (const { pattern, icon } of HEADING_ICONS) {
    if (pattern.test(text)) return icon;
  }
  return <FileText className="w-4 h-4 text-text-muted inline" />;
}

// 이모지 제거 (Lucide 아이콘으로 대체하므로 이모지는 strip)
// eslint-disable-next-line no-misleading-character-class
const EMOJI_RE = new RegExp(
  '[\\u{1F300}-\\u{1F9FF}]|[\\u{2600}-\\u{26FF}]|[\\u{2700}-\\u{27BF}]|[\\u{1F000}-\\u{1F2FF}]|[\\u{1F600}-\\u{1F64F}]|[\\u{1F680}-\\u{1F6FF}]|[\\u{1FA00}-\\u{1FAFF}]|[\\u{2300}-\\u{23FF}]|[\\u{200D}]|[\\u{FE0F}]',
  'gu',
);
function cleanEmoji(text: string): string {
  return text.replace(EMOJI_RE, '').replace(/\s{2,}/g, ' ');
}

// 대괄호 라벨 → Lucide 아이콘 매핑 (불릿 항목용)
const LABEL_ICONS: Record<string, React.ReactNode> = {
  '[긴급]': <AlertTriangle className="w-3.5 h-3.5 text-red-500 inline mr-1" />,
  '[대응]': <CheckSquare className="w-3.5 h-3.5 text-orange-500 inline mr-1" />,
  '[일정]': <Calendar className="w-3.5 h-3.5 text-blue-500 inline mr-1" />,
  '[정보]': <Info className="w-3.5 h-3.5 text-text-muted inline mr-1" />,
  '[광고]': <Info className="w-3.5 h-3.5 text-text-muted inline mr-1" />,
};
const LABEL_RE = /\[(긴급|대응|일정|정보|광고)\]/g;

// 텍스트에서 라벨과 이모지를 처리하는 유틸리티
function processInlineContent(child: any): any {
  if (typeof child !== 'string') return child;
  let text = cleanEmoji(child);
  // [라벨] → Lucide 아이콘 교체
  const parts: (string | React.ReactNode)[] = [];
  let lastIdx = 0;
  let match;
  const re = new RegExp(LABEL_RE.source, 'g');
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIdx) parts.push(text.slice(lastIdx, match.index));
    const label = match[0] as keyof typeof LABEL_ICONS;
    parts.push(LABEL_ICONS[label] || match[0]);
    lastIdx = re.lastIndex;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts.length > 1 ? parts : text;
}

// React 노드에서 재귀적으로 텍스트 추출 (React element → string 변환 시 [object Object] 방지)
function extractText(node: any): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node?.props?.children !== undefined) return extractText(node.props.children);
  return '';
}

// Custom markdown components — 모든 요소에 Lucide 아이콘 + 가독성 스타일링
const markdownComponents = {
  // ── Headings: Lucide 아이콘 자동 삽입 ──
  h1: ({ children, ...props }: any) => {
    const text = cleanEmoji(extractText(children));
    const icon = getHeadingIcon(text);
    return <h1 {...props} className="flex items-center gap-2">{icon} {text}</h1>;
  },
  h2: ({ children, ...props }: any) => {
    const text = cleanEmoji(extractText(children));
    const icon = getHeadingIcon(text);
    return <h2 {...props} className="flex items-center gap-2">{icon} {text}</h2>;
  },
  h3: ({ children, ...props }: any) => {
    const text = cleanEmoji(extractText(children));
    const icon = getHeadingIcon(text);
    return <h3 {...props} className="flex items-center gap-1.5">{icon} {text}</h3>;
  },

  // ── List items: [라벨] → Lucide 아이콘 교체 ──
  li: ({ children, ...props }: any) => {
    const processed = Array.isArray(children)
      ? children.map((c: any, i: number) => <span key={i}>{processInlineContent(c)}</span>)
      : processInlineContent(children);
    return <li {...props}>{processed}</li>;
  },

  // ── Paragraphs: 이모지 정리 + → 화살표 강조 ──
  p: ({ children, ...props }: any) => {
    const processed = Array.isArray(children)
      ? children.map((c: any, i: number) => {
          if (typeof c === 'string') {
            // → 화살표를 시각적으로 강조
            if (c.includes('→')) {
              const arrowParts = c.split('→');
              return arrowParts.map((part: string, j: number) => (
                <span key={`${i}-${j}`}>
                  {j > 0 && <ArrowRight className="w-3.5 h-3.5 text-primary inline mx-1" />}
                  {cleanEmoji(part)}
                </span>
              ));
            }
            return cleanEmoji(c);
          }
          return c;
        })
      : typeof children === 'string' ? cleanEmoji(children) : children;
    return <p {...props}>{processed}</p>;
  },

  // ── Blockquote: 좌측 강조 바 + Quote 아이콘 ──
  blockquote: ({ children, ...props }: any) => (
    <blockquote {...props} className="border-l-3 border-primary pl-4 my-3 text-text-muted italic">
      <Quote className="w-4 h-4 text-primary inline mr-1 -mt-0.5" />
      {children}
    </blockquote>
  ),

  // ── Table: 깔끔한 줄무늬 ──
  table: ({ children, ...props }: any) => (
    <div className="overflow-x-auto my-3">
      <table {...props} className="w-full text-sm border-collapse">
        {children}
      </table>
    </div>
  ),

  // ── HR: 명확한 섹션 구분 ──
  hr: () => <hr className="border-t border-border my-5" />,
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

function formatRecordingTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const MAX_RECORDING_SECONDS = 180; // 3 minutes

export default function BrainPage() {
  // Use shared store for activeChannelId (synced with Sidebar)
  const { activeChannelId, setActive: setActiveChannelId } = useConversationsStore();
  const { setSessions } = useBrainSessionsStore();
  const [localNewMessages, setLocalNewMessages] = useState<BrainMessage[]>([]);
  const [input, setInput] = useState('');
  const [localLoading, setLocalLoading] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<Array<{
    id: string; name: string; size: number;
    status: 'uploading' | 'ready' | 'error';
    result?: UploadResult; error?: string;
  }>>([]);
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [thinkingSteps, setThinkingSteps] = useState<string[]>([]);
  const [streamingContent, setStreamingContent] = useState<string>('');
  const [isTokenStreaming, setIsTokenStreaming] = useState(false);
  const [showMobileSessions, setShowMobileSessions] = useState(false);

  // Voice recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const dragCounter = useRef(0);
  const [showScrollDown, setShowScrollDown] = useState(false);
  // 사용자가 명시적으로 "새 대화"를 선택했을 때 sessions SWR 재검증으로 인한 자동 로드 방지
  const userChoseNewSessionRef = useRef(false);
  // 세션 전환 시 맨 아래로 즉시 스크롤 요청 플래그
  const shouldScrollToBottomRef = useRef(false);

  // Wake Lock — 작업 중 모바일 화면 꺼짐 방지
  const wakeLock = useWakeLock();
  // Recovery polling 표시
  const [recovering, setRecovering] = useState(false);

  // Auto-save input to localStorage
  useEffect(() => {
    const saved = localStorage.getItem('brain-draft');
    if (saved) setInput(saved);
  }, []);

  // Pending job 복구 — 페이지 진입 시 (새로고침/재방문 후) 끊긴 작업이 있으면 polling으로 결과 가져오기
  useEffect(() => {
    const pending = getPendingBrainJob();
    if (!pending) return;
    if (isPendingJobStale(pending)) {
      clearPendingBrainJob();
      return;
    }

    // 채널 ID가 없으면 (새 세션이었던 경우) 가장 최근 채널 사용
    let cancelled = false;
    (async () => {
      let pollChannelId = pending.channelId;
      if (!pollChannelId) {
        try {
          const res = await getBrainChannels();
          const list = (res as any).data || [];
          if (Array.isArray(list) && list.length > 0) pollChannelId = list[0].id;
        } catch { /* ignore */ }
      }
      if (!pollChannelId || cancelled) return;

      setRecovering(true);
      setThinkingSteps(['이전 작업의 결과를 확인하고 있습니다...']);

      const recovered = await pollForAssistantMessage(
        pollChannelId,
        pending.sentAt,
        (n) => !cancelled && setThinkingSteps([`백그라운드 결과를 가져오고 있습니다... (${n}회 시도)`]),
        2 * 60 * 1000, // 복구 시 2분만 시도
      );

      if (cancelled) return;

      setRecovering(false);
      setThinkingSteps([]);
      clearPendingBrainJob();

      if (recovered) {
        // 활성 채널을 복구된 채널로 설정 → 메시지가 자동으로 표시됨
        setActiveChannelId(pollChannelId);
        try {
          const messagesRes = await getChannelMessages(pollChannelId);
          const messages = (messagesRes as any).data || [];
          if (Array.isArray(messages)) {
            storeMessages(pollChannelId, messages);
          }
        } catch { /* ignore */ }
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (input) localStorage.setItem('brain-draft', input);
    else localStorage.removeItem('brain-draft');
  }, [input]);

  // Conversations store
  const { conversations, setMessages: storeMessages, addMessage: storeAddMessage, setStreaming } = useConversationsStore();

  // SWR for channels list — sync to shared store for Sidebar
  const { data: channelsData, mutate: refreshChannels } = useApiData(
    'brain-channels',
    async () => { const res = await getBrainChannels(); return Array.isArray(res.data) ? res.data : []; },
    { revalidateOnFocus: false, dedupingInterval: 60000 }
  );
  const sessions = channelsData || [];
  useEffect(() => { if (channelsData) setSessions(channelsData); }, [channelsData]);

  // Derive messages from store or local state
  const activeMessages = activeChannelId ? (conversations[activeChannelId]?.messages || []) : localNewMessages;
  const isChannelStreaming = activeChannelId ? (conversations[activeChannelId]?.isStreaming || false) : false;
  const loading = localLoading || isChannelStreaming;

  // Auto-load first channel messages — 최초 진입 시 가장 최근 세션 자동 로드
  // userChoseNewSessionRef가 true이면 (사용자가 "새 대화" 클릭) SWR 재검증으로 인한 재로드 방지
  useEffect(() => {
    if (sessions.length > 0 && !activeChannelId && !userChoseNewSessionRef.current) {
      loadMessages(sessions[0].id);
    }
  }, [sessions]);

  // Load messages when activeChannelId changes (e.g. from Sidebar click)
  useEffect(() => {
    if (activeChannelId && !conversations[activeChannelId]?.messages?.length) {
      loadMessages(activeChannelId);
    }
  }, [activeChannelId]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    // 세션 전환 직후: 맨 아래로 즉시 스크롤
    if (shouldScrollToBottomRef.current && activeMessages.length > 0) {
      shouldScrollToBottomRef.current = false;
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' });
        setShowScrollDown(false);
      }, 0);
      return;
    }

    // 스크롤 다운 버튼 표시 여부 업데이트
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    setShowScrollDown(distanceFromBottom > 300);

    // 사용자가 하단 근처에 있을 때만 자동 스크롤 (스트리밍 중)
    if (distanceFromBottom < 150) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [activeMessages, streamingContent]);

  // Show/hide scroll-to-bottom button
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      setShowScrollDown(distanceFromBottom > 300);
    };
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  // Auto-stop recording at max time
  useEffect(() => {
    if (isRecording && recordingTime >= MAX_RECORDING_SECONDS) {
      stopRecording();
    }
  }, [isRecording, recordingTime]);

  async function loadMessages(channelId: string) {
    // 세션 명시적 선택 시 "새 대화 선택" 플래그 해제
    userChoseNewSessionRef.current = false;
    // Check store first
    if (conversations[channelId]?.messages?.length) {
      setActiveChannelId(channelId);
      shouldScrollToBottomRef.current = true;
      return;
    }
    try {
      const res = await getChannelMessages(channelId);
      const msgs = res.data || res || [];
      storeMessages(channelId, msgs);
      setActiveChannelId(channelId);
      shouldScrollToBottomRef.current = true;
    } catch (err) {
      console.error('Failed to load messages', err);
    }
  }

  function handleNewSession() {
    userChoseNewSessionRef.current = true;
    setActiveChannelId(null);
    setLocalNewMessages([]);
  }

  async function handleDeleteSession(channelId: string) {
    if (!confirm('이 대화를 삭제하시겠습니까?')) return;
    try {
      await deleteBrainChannel(channelId);
      refreshChannels((prev: any) => prev ? (prev as any[]).filter((s: any) => s.id !== channelId) : prev, { revalidate: false });
      useBrainSessionsStore.getState().removeSession(channelId);
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

  function addFiles(files: File[]) {
    if (files.length === 0) return;
    // 각 파일에 대해 칩 추가 + 백그라운드 업로드
    for (const file of files) {
      const fileId = `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      setAttachedFiles(prev => [...prev, { id: fileId, name: file.name, size: file.size, status: 'uploading' }]);
      // 백그라운드 업로드
      brainUpload(file).then(result => {
        setAttachedFiles(prev => prev.map(f => f.id === fileId ? { ...f, status: 'ready' as const, result } : f));
      }).catch(err => {
        setAttachedFiles(prev => prev.map(f => f.id === fileId ? { ...f, status: 'error' as const, error: err.message } : f));
      });
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function removeAttachedFile(id: string) {
    setAttachedFiles(prev => prev.filter(f => f.id !== id));
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    addFiles(Array.from(e.target.files || []));
  }

  async function handleSend() {
    if (!input.trim() || loading) return;
    const msg = input;
    const readyFiles = attachedFiles.filter(f => f.status === 'ready' && f.result);
    const currentFileIds = readyFiles.map(f => f.result!.fileId);
    const fileNames = readyFiles.map(f => f.name);
    const isNewSession = !activeChannelId;
    const channelIdAtSend = activeChannelId;
    setInput('');
    setAttachedFiles([]);
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    const attachmentNote = fileNames.length > 0 ? `\n\n📎 ${fileNames.join(', ')}` : '';
    const sentAtIso = new Date().toISOString();
    const userMsg: BrainMessage = { id: `temp-${Date.now()}`, role: 'user', content: msg + attachmentNote, createdAt: sentAtIso };

    if (channelIdAtSend) {
      storeAddMessage(channelIdAtSend, userMsg);
      setStreaming(channelIdAtSend, true);
    } else {
      setLocalNewMessages(prev => [...prev, userMsg]);
      setLocalLoading(true);
    }

    // Wake Lock 활성화 — 모바일 화면 꺼짐 방지
    wakeLock.acquire().catch(() => {});

    // Pending job 추적 — SSE 끊김 시 복구용
    savePendingBrainJob({
      channelId: channelIdAtSend,
      userMessage: msg,
      sentAt: sentAtIso,
      fileIds: currentFileIds.length > 0 ? currentFileIds : undefined,
    });

    try {
      setThinkingSteps([]);
      setStreamingContent('');
      setIsTokenStreaming(false);
      let result;
      try {
        result = await brainChatStream(
          msg,
          (step) => setThinkingSteps([step]),
          (token) => {
            setIsTokenStreaming(true);
            setStreamingContent(prev => prev + token);
          },
          channelIdAtSend || undefined,
          currentFileIds[0],
          isNewSession ? true : undefined,
          currentFileIds.length > 1 ? currentFileIds : undefined,
        );
      } catch (streamErr: any) {
        // SSE 끊김 (모바일 화면 sleep 등) → polling으로 복구 시도
        // 서버는 try/catch 안에서 끝까지 처리하고 메시지를 DB에 저장하므로,
        // 채널 메시지를 polling하면 결과를 가져올 수 있다.
        const isNetworkErr = /Load failed|Failed to fetch|NetworkError|aborted|시간이 초과|서버 연결/i.test(streamErr.message || '');
        if (!isNetworkErr) throw streamErr;

        setRecovering(true);
        setThinkingSteps(['연결이 끊겼습니다. 백그라운드 결과를 확인하고 있습니다...']);

        // 새 세션이면 채널 ID를 모름 → 가장 최근 채널 찾기
        let pollChannelId = channelIdAtSend;
        if (!pollChannelId) {
          try {
            const channels = await getBrainChannels();
            const list = (channels as any).data || [];
            if (Array.isArray(list) && list.length > 0) {
              // 가장 최근 채널 — 방금 만든 것일 가능성 높음
              pollChannelId = list[0].id;
            }
          } catch { /* ignore */ }
        }

        if (!pollChannelId) {
          throw new Error('연결이 끊겼고 채널을 찾을 수 없습니다. 잠시 후 새로고침해주세요.');
        }

        const recovered = await pollForAssistantMessage(
          pollChannelId,
          sentAtIso,
          (n) => setThinkingSteps([`백그라운드에서 결과를 가져오고 있습니다... (${n}회 시도)`]),
        );

        setRecovering(false);

        if (!recovered) {
          throw new Error('백그라운드 작업 결과를 가져오지 못했습니다. 잠시 후 새로고침해주세요.');
        }

        result = {
          response: recovered.content,
          channelId: pollChannelId,
          intent: 'recovered',
          isNewSession,
          multiHop: false,
          dbResult: false,
          autoCaptured: null,
        };
      }
      setThinkingSteps([]);
      setStreamingContent('');
      setIsTokenStreaming(false);
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
      setThinkingSteps([]);
      setStreamingContent('');
      setIsTokenStreaming(false);
      setRecovering(false);
      const rawMsg = err.message || 'Unknown error';
      console.error('[Brain] Chat error:', rawMsg, err);
      const errorDetail = rawMsg.includes('401') || rawMsg.includes('403')
        ? '인증이 만료되었습니다. 페이지를 새로고침 후 다시 로그인해주세요.'
        : rawMsg.includes('AbortError') || rawMsg.includes('시간이 초과')
        ? '응답 시간이 초과되었습니다. 잠시 후 다시 시도해주세요.'
        : rawMsg.includes('Load failed') || rawMsg.includes('Failed to fetch') || rawMsg.includes('NetworkError')
        ? `서버에 연결할 수 없습니다. (${rawMsg})`
        : rawMsg;
      const errMsg: BrainMessage = {
        id: `err-${Date.now()}`,
        role: 'assistant',
        content: errorDetail,
        createdAt: new Date().toISOString(),
      };
      if (channelIdAtSend) {
        storeAddMessage(channelIdAtSend, errMsg);
      } else {
        setLocalNewMessages(prev => [...prev, errMsg]);
      }
    } finally {
      // Wake Lock 해제
      wakeLock.release().catch(() => {});
      // Pending job 클리어 (성공/실패 모두)
      clearPendingBrainJob();
      if (channelIdAtSend) {
        setStreaming(channelIdAtSend, false);
      } else {
        setLocalLoading(false);
      }
    }
  }

  // 내장 마이크 우선 선택 헬퍼 (iPhone Continuity Microphone 자동 연결 방지)
  async function getLocalAudioStream(): Promise<MediaStream> {
    const permStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default');
      const builtIn = audioInputs.find(d =>
        /built.?in|internal|MacBook|laptop|내장|기본/i.test(d.label) &&
        !/iPhone|iPad|AirPod|Bluetooth|bluetooth/i.test(d.label)
      );
      if (builtIn) {
        permStream.getTracks().forEach(t => t.stop());
        return navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: builtIn.deviceId } } });
      }
    } catch { /* 장치 열거 실패 시 기본 스트림 사용 */ }
    return permStream;
  }

  // Voice recording
  async function startRecording() {
    try {
      const stream = await getLocalAudioStream();
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
          const API_BASE = typeof window !== 'undefined' ? '' : (process.env.NEXT_PUBLIC_API_URL || 'https://labflow-app-production.up.railway.app');
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

  function handleStopGenerating() {
    abortControllerRef.current?.abort();
  }

  function scrollToBottom() {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }

  function handleTextareaChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    // Auto-resize
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }

  function handleTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
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
  function handleDrop(e: React.DragEvent) {
    e.preventDefault(); e.stopPropagation();
    dragCounter.current = 0;
    setIsDragging(false);
    addFiles(Array.from(e.dataTransfer.files || []));
  }

  return (
    <div className="flex h-screen md:h-[calc(100vh-2rem)] p-0 md:p-4">
      {/* Main area — full width (sidebar is in the main nav now) */}
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
              <p className="text-text-heading font-medium text-lg">파일을 여기에 놓으세요</p>
              <p className="text-text-muted text-sm mt-1">PDF, 이미지, 엑셀, 워드 등</p>
            </div>
          </div>
        )}
        {/* Chat view */}
          <>
            {/* Header */}
            <div className="p-4 border-b border-border">
              <div className="flex items-center gap-2">
                {/* Mobile session toggle */}
                <button
                  onClick={() => setShowMobileSessions(true)}
                  className="md:hidden p-1.5 rounded-lg bg-bg-input text-text-muted hover:text-text-heading transition-colors"
                >
                  <MessageSquare className="w-4 h-4" />
                </button>
                <Brain className="w-5 h-5 text-primary" />
                <div className="flex-1 min-w-0">
                  <h3 className="text-text-heading font-medium text-sm">Brain</h3>
                  <p className="text-[11px] text-text-muted truncate">
                    이메일, 일정, 메모, 연구실 정보 -- 무엇이든 물어보세요
                  </p>
                </div>
                <button
                  onClick={handleNewSession}
                  className="md:hidden p-1.5 rounded-lg bg-primary-light text-primary hover:bg-primary/30 transition-colors"
                  title="새 대화"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Mobile sessions drawer */}
            {showMobileSessions && (
              <>
                <div className="fixed inset-0 bg-[var(--color-overlay)] z-40 md:hidden" onClick={() => setShowMobileSessions(false)} />
                <div className="fixed inset-y-0 left-0 w-72 bg-bg-card z-50 md:hidden animate-in slide-in-from-left duration-200 shadow-2xl flex flex-col">
                  <div className="p-4 border-b border-border flex items-center justify-between">
                    <h3 className="text-text-heading font-medium">대화 목록</h3>
                    <button onClick={() => setShowMobileSessions(false)} className="p-1 text-text-muted hover:text-text-heading"><X className="w-5 h-5" /></button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-3 space-y-1">
                    <button
                      onClick={() => { handleNewSession(); setShowMobileSessions(false); }}
                      className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-primary-light text-primary rounded-lg text-sm hover:bg-primary/30 font-medium mb-2"
                    >
                      <Plus className="w-4 h-4" /> 새 대화
                    </button>
                    {sessions.map((ch: any) => (
                      <button
                        key={ch.id}
                        onClick={() => { loadMessages(ch.id); setShowMobileSessions(false); }}
                        className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors ${
                          activeChannelId === ch.id ? 'bg-primary-light text-primary' : 'text-text-muted hover:bg-bg-hover'
                        }`}
                      >
                        <div className="truncate">{ch.name || `대화 #${ch.id.slice(-4)}`}</div>
                        <div className="text-xs text-text-muted mt-0.5">{timeAgo(ch.lastMessageAt || ch.createdAt)}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* Messages area — Claude-style */}
            <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-4 relative">
              <div className="max-w-4xl mx-auto space-y-6">
                {activeMessages.length === 0 && (
                  <div className="text-text-muted py-6 max-w-lg mx-auto w-full">
                    <div className="text-center mb-6">
                      <Brain className="w-10 h-10 text-primary/40 mx-auto mb-3" />
                      <p className="text-base font-semibold text-text-heading">연구실 AI 비서</p>
                      <p className="text-xs mt-1 text-text-muted">자연어로 지시하면 이메일·일정·연구실 정보를 처리합니다</p>
                    </div>

                    {/* 기능 카테고리 힌트 */}
                    <div className="space-y-2">
                      {[
                        {
                          icon: '📧',
                          label: '이메일 & 일정',
                          examples: ['지난 12시간 이메일 브리핑 해줘', '오늘 일정 알려줘', '김철수 교수 메일 초안 작성해줘'],
                        },
                        {
                          icon: '🔬',
                          label: '연구실 정보 조회',
                          examples: ['진행 중인 과제 알려줘', '이번 주 회의 요약해줘', '최근 논문 동향 알려줘'],
                        },
                        {
                          icon: '📝',
                          label: '빠른 메모 & 할일',
                          examples: ['내일 9시 장비 예약 메모해줘', '아이디어: 새 센서 방향 저장', '이번 주 제출 마감 태스크 추가'],
                        },
                        {
                          icon: '⚙️',
                          label: '설정 변경 — "기억해줘"',
                          examples: ['내 이름 언급 이메일 중요도 높여줘. 기억해줘', '브리핑에서 광고 섹션 빼줘. 기억해줘', '앞으로 답변 짧게 해줘. 기억해줘'],
                        },
                      ].map(cat => (
                        <div key={cat.label} className="bg-bg-input rounded-xl p-3">
                          <p className="text-xs font-semibold text-text-heading mb-2">{cat.icon} {cat.label}</p>
                          <div className="flex flex-wrap gap-1.5">
                            {cat.examples.map(q => (
                              <button
                                key={q}
                                onClick={() => setInput(q)}
                                className="px-2.5 py-1.5 bg-bg-card rounded-lg text-xs text-text-muted hover:text-primary hover:bg-primary/5 border border-border/50 hover:border-primary/30 transition-all"
                              >
                                {q}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>

                    <p className="text-center text-[11px] text-text-muted mt-4 opacity-70">
                      예시를 클릭하거나 직접 입력하세요
                    </p>

                    {/* 지난 대화 목록 */}
                    {sessions.length > 0 && (
                      <div className="mt-6 text-left">
                        <h4 className="text-xs font-medium text-text-muted mb-2 px-1">지난 대화</h4>
                        <div className="space-y-0.5">
                          {sessions.slice(0, 8).map((ch: any) => (
                            <button
                              key={ch.id}
                              onClick={() => loadMessages(ch.id)}
                              className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors ${
                                activeChannelId === ch.id ? 'bg-primary-light text-primary' : 'text-text-muted hover:bg-bg-hover hover:text-text-heading'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate flex-1">{ch.name || `대화 #${ch.id.slice(-4)}`}</span>
                                <span className="text-[10px] text-text-muted flex-shrink-0">{timeAgo(ch.lastMessageAt || ch.createdAt)}</span>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {activeMessages.map(msg => (
                  <div key={msg.id} className="animate-msg-in group/msg">
                    {msg.role === 'user' ? (
                      /* User message: right-aligned blue bubble */
                      <div className="flex flex-col items-end">
                        <div className="bg-primary text-white rounded-2xl rounded-br-sm max-w-[70%] px-4 py-3 text-sm whitespace-pre-wrap">
                          {msg.content}
                        </div>
                        <span className="text-[10px] text-text-muted mt-1 opacity-0 group-hover/msg:opacity-100 transition-opacity">
                          {new Date(msg.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                    ) : (
                      /* AI message: left-aligned, no bubble, full width, with markdown */
                      <div className="group relative">
                        <div className="brain-prose max-w-none">
                          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
                            {msg.content}
                          </ReactMarkdown>
                        </div>
                        {/* Hover action: copy + timestamp */}
                        <div className="flex items-center gap-1.5 mt-1 opacity-0 group-hover:opacity-100 transition-all duration-200">
                          <button
                            onClick={() => handleCopyMessage(msg.id, msg.content)}
                            className="p-1.5 rounded-lg bg-bg-input/80 text-text-muted hover:text-text-heading hover:bg-bg-hover transition-colors"
                            title="복사"
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                          {copiedId === msg.id && (
                            <span className="text-xs text-green-400">복사됨</span>
                          )}
                          <span className="text-[10px] text-text-muted ml-1">
                            {new Date(msg.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {/* Thinking steps — 현재 단계만 한 줄로 표시 (Gemini 스타일) */}
                {(loading || recovering) && thinkingSteps.length > 0 && (
                  <div className="flex justify-start animate-msg-in">
                    <div className="flex items-center gap-1.5 text-sm text-text-muted transition-all duration-300">
                      <span className="flex gap-0.5 w-3.5 justify-center">
                        <span className="w-1 h-1 bg-primary/70 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-1 h-1 bg-primary/70 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-1 h-1 bg-primary/70 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                      </span>
                      <span key={thinkingSteps[thinkingSteps.length - 1]}>{thinkingSteps[thinkingSteps.length - 1]}</span>
                    </div>
                  </div>
                )}
                {/* Default spinner when loading with no steps yet */}
                {loading && thinkingSteps.length === 0 && !streamingContent && (
                  <div className="flex justify-start animate-msg-in">
                    <div className="text-sm text-text-muted">
                      <div className="flex items-center gap-1.5">
                        <span>생각 중</span>
                        <span className="flex gap-0.5">
                          <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                          <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                          <span className="w-1.5 h-1.5 bg-text-muted rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                        </span>
                      </div>
                    </div>
                  </div>
                )}
                {/* Token streaming: show response as it arrives */}
                {loading && streamingContent && (
                  <div className="group relative animate-msg-in">
                    <div className="brain-prose max-w-none">
                      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
                        {streamingContent}
                      </ReactMarkdown>
                      <span className="inline-block w-0.5 h-4 bg-primary animate-pulse ml-0.5 align-text-bottom" />
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Scroll to bottom button */}
              {showScrollDown && (
                <button
                  onClick={scrollToBottom}
                  className="absolute bottom-4 left-1/2 -translate-x-1/2 p-2 rounded-full bg-bg-card border border-border shadow-lg text-text-muted hover:text-text-heading hover:bg-bg-hover transition-all"
                  title="아래로 스크롤"
                >
                  <ArrowDown className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Stop generating button */}
            {loading && (
              <div className="flex justify-center py-2">
                <button
                  onClick={handleStopGenerating}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-full border border-border bg-bg-card text-text-muted hover:text-text-heading hover:bg-bg-hover transition-colors text-sm"
                >
                  <Square className="w-3 h-3" /> 생성 중단
                </button>
              </div>
            )}

            {/* Input area */}
            <div className="border-t border-border">
              {/* 첨부 파일 칩 — Claude Desktop 스타일 */}
              {attachedFiles.length > 0 && (
                <div className="px-4 pt-3 max-w-4xl mx-auto w-full">
                  <div className="flex flex-wrap gap-2">
                    {attachedFiles.map(f => (
                      <div key={f.id} className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs border transition-all ${
                        f.status === 'uploading' ? 'bg-bg-hover border-border/50 animate-pulse' :
                        f.status === 'error' ? 'bg-red-500/10 border-red-500/30' :
                        'bg-bg-hover border-border/30'
                      }`}>
                        {f.status === 'uploading' ? (
                          <Loader2 className="w-3.5 h-3.5 text-text-muted animate-spin flex-shrink-0" />
                        ) : f.status === 'error' ? (
                          <FileText className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
                        ) : (
                          <FileText className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
                        )}
                        <span className={`max-w-[180px] truncate ${f.status === 'error' ? 'text-red-400' : 'text-text-heading'}`}>
                          {f.name}
                        </span>
                        <span className="text-text-muted">{(f.size / 1024 / 1024).toFixed(1)}MB</span>
                        <button onClick={() => removeAttachedFile(f.id)} className="text-text-muted hover:text-text-heading ml-0.5">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="px-4 pb-4 pt-3 max-w-4xl mx-auto w-full">
                <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" multiple
                  accept=".pdf,.xlsx,.xls,.doc,.docx,.png,.jpg,.jpeg,.txt,.csv,.md" />
                {/* 텍스트 입력 영역 (Claude 스타일) */}
                <div className="bg-bg-input rounded-2xl border border-border/30 focus-within:ring-2 focus-within:ring-primary/50 transition-all">
                  <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={handleTextareaChange}
                    onKeyDown={handleTextareaKeyDown}
                    placeholder="메시지를 입력하세요..."
                    rows={2}
                    className="w-full bg-transparent text-text-heading px-4 pt-3 pb-2 text-sm focus:outline-none resize-none min-h-[72px] max-h-[200px]"
                  />
                  {/* 하단 도구 바 */}
                  <div className="flex items-center justify-between px-3 pb-2">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploading}
                        className="p-2 text-text-muted rounded-lg hover:text-text-heading hover:bg-bg-hover/50 transition-colors disabled:opacity-50"
                        title="파일 업로드"
                      >
                        {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
                      </button>
                      <button
                        onClick={isRecording ? stopRecording : startRecording}
                        className={`p-2 rounded-lg transition-colors ${
                          isRecording
                            ? 'bg-red-500 text-white animate-pulse'
                            : 'text-text-muted hover:text-text-heading hover:bg-bg-hover/50'
                        }`}
                        title={isRecording ? `녹음 중지 (${formatRecordingTime(recordingTime)})` : '음성 입력'}
                      >
                        {isRecording ? (
                          <div className="flex items-center gap-1">
                            <MicOff className="w-4 h-4" />
                            <span className="text-xs font-mono">{formatRecordingTime(recordingTime)}</span>
                          </div>
                        ) : (
                          <Mic className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-muted/50">Shift+Enter 줄바꿈</span>
                      <button
                        onClick={handleSend}
                        disabled={loading || !input.trim() || attachedFiles.some(f => f.status === 'uploading')}
                        className="p-2 bg-primary text-white rounded-lg disabled:opacity-30 hover:bg-primary/90 transition-colors"
                      >
                        <Send className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </>
      </div>
    </div>
  );
}

