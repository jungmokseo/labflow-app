'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { getMeetings, uploadMeetingAudio, deleteMeeting, updateMeeting, exportMeetingToGDocs, Meeting } from '@/lib/api';
import { useApiData } from '@/lib/use-api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
// Skeleton imports removed — using inline spinner
import {
  Mic, Paperclip, ClipboardList, FileText, CheckCircle, Music,
  ChevronUp, ChevronDown, Copy, X, Plus, Pencil, Trash2, Save,
} from 'lucide-react';

const ACCEPTED_AUDIO_TYPES = ['audio/webm', 'audio/mp3', 'audio/mpeg', 'audio/m4a', 'audio/mp4', 'audio/wav', 'audio/x-m4a'];
const ACCEPTED_EXTENSIONS = ['.webm', '.mp3', '.m4a', '.wav'];

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function isAcceptedAudioFile(file: File): boolean {
  if (ACCEPTED_AUDIO_TYPES.includes(file.type)) return true;
  const ext = '.' + file.name.split('.').pop()?.toLowerCase();
  return ACCEPTED_EXTENSIONS.includes(ext);
}

type RecordingState = 'idle' | 'recording' | 'stopped';

export default function MeetingsPage() {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Recording state
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioTitle, setAudioTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Background processing queue
  const [processingQueue, setProcessingQueue] = useState<Array<{ id: string; title: string; status: 'uploading' | 'done' | 'error'; error?: string }>>([]);

  // File attach / drag-drop state
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const silentAudioRef = useRef<{ ctx: AudioContext; osc: OscillatorNode } | null>(null);

  // Load meetings via SWR
  const { data: meetingsData, isLoading: loading, mutate: refreshMeetings } = useApiData(
    'meetings',
    async () => { const res = await getMeetings(20); return res; }
  );
  const meetings = meetingsData?.data || [];

  // Cleanup on unmount: audio URL, Wake Lock, silent audio
  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
      if (silentAudioRef.current) {
        silentAudioRef.current.osc.stop();
        silentAudioRef.current.ctx.close().catch(() => {});
        silentAudioRef.current = null;
      }
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [audioUrl]);

  // ── Recording ──
  const startRecording = async () => {
    setError(null);
    setAttachedFile(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm',
        audioBitsPerSecond: 32000, // 32kbps — speech quality, 10min ≈ 2.3MB
      });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        setAudioBlob(blob);
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        setAudioUrl(URL.createObjectURL(blob));
        stream.getTracks().forEach((t) => t.stop());
      };

      mediaRecorder.start(1000);
      startTimeRef.current = Date.now();
      setElapsed(0);
      setRecordingState('recording');
      setAudioBlob(null);
      setAudioUrl(null);

      // 백그라운드 녹음 유지: Wake Lock + 무음 오디오 재생
      // 모바일에서 화면 꺼지거나 앱 전환 시 브라우저가 탭을 suspend하는 것을 방지
      try {
        if ('wakeLock' in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request('screen');
        }
      } catch { /* Wake Lock 미지원 또는 권한 거부 — 무시 */ }
      // 무음 오디오 재생으로 브라우저 탭 활성 상태 유지
      try {
        const audioCtx = new AudioContext();
        const oscillator = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        gain.gain.value = 0; // 완전 무음
        oscillator.connect(gain);
        gain.connect(audioCtx.destination);
        oscillator.start();
        silentAudioRef.current = { ctx: audioCtx, osc: oscillator };
      } catch { /* AudioContext 실패 — 무시 */ }

      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 500);
    } catch (err: any) {
      console.error('Microphone access error:', err);
      setError('마이크 접근 권한이 필요합니다. 브라우저 설정을 확인해 주세요.');
    }
  };

  const releaseWakeLock = () => {
    if (wakeLockRef.current) {
      wakeLockRef.current.release().catch(() => {});
      wakeLockRef.current = null;
    }
    if (silentAudioRef.current) {
      silentAudioRef.current.osc.stop();
      silentAudioRef.current.ctx.close().catch(() => {});
      silentAudioRef.current = null;
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    releaseWakeLock();
    setRecordingState('stopped');
  };

  const resetRecording = () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    releaseWakeLock();
    setRecordingState('idle');
    setAudioBlob(null);
    setAudioUrl(null);
    setAudioTitle('');
    setElapsed(0);
    setAttachedFile(null);
    setError(null);
  };

  // ── File handling ──
  const handleFileSelect = (file: File) => {
    if (!isAcceptedAudioFile(file)) {
      setError('지원하는 형식: webm, mp3, m4a, wav');
      return;
    }
    setError(null);
    setAttachedFile(file);
    setAudioBlob(null);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(URL.createObjectURL(file));
    setRecordingState('stopped');
    // Pre-fill title from filename
    const name = file.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ');
    setAudioTitle(name);
  };

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
    e.target.value = '';
  };

  // ── Drag & Drop ──
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileSelect(file);
  }, []);

  // ── Submit (non-blocking: 즉시 idle로 복귀, 백그라운드 업로드) ──
  const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

  const handleSubmit = async () => {
    const fileToUpload = attachedFile || (audioBlob ? new File([audioBlob], 'recording.webm', { type: 'audio/webm' }) : null);
    if (!fileToUpload) return;

    if (fileToUpload.size > MAX_FILE_SIZE) {
      setError(`오디오 파일이 너무 큽니다 (${(fileToUpload.size / (1024 * 1024)).toFixed(1)}MB / 최대 50MB)`);
      return;
    }

    const jobId = `job-${Date.now()}`;
    const jobTitle = audioTitle.trim() || `녹음 ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`;
    const jobFile = fileToUpload;
    const jobDuration = elapsed > 0 ? elapsed : undefined;

    // 즉시 idle로 복귀 → 새 녹음 가능
    setProcessingQueue(prev => [...prev, { id: jobId, title: jobTitle, status: 'uploading' }]);
    resetRecording();

    // 백그라운드 업로드
    try {
      const res = await uploadMeetingAudio(jobFile, {
        title: jobTitle || undefined,
        duration: jobDuration,
      });
      refreshMeetings((prev: any) => prev ? { ...prev, data: [res.data, ...(prev.data || [])] } : prev, { revalidate: false });
      setProcessingQueue(prev => prev.map(j => j.id === jobId ? { ...j, status: 'done' } : j));
      // 3초 후 완료 표시 제거
      setTimeout(() => setProcessingQueue(prev => prev.filter(j => j.id !== jobId)), 3000);
    } catch (err: any) {
      console.error('Upload failed:', err);
      setProcessingQueue(prev => prev.map(j => j.id === jobId ? { ...j, status: 'error', error: err.message } : j));
    }
  };

  // ── Delete ──
  const handleDelete = async (id: string) => {
    if (!confirm('이 회의 기록을 삭제하시겠습니까?')) return;
    try {
      await deleteMeeting(id);
      refreshMeetings((prev: any) => prev ? { ...prev, data: (prev.data || []).filter((m: Meeting) => m.id !== id) } : prev, { revalidate: false });
    } catch (err) {
      console.error('Failed to delete meeting:', err);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-10 h-10 rounded-full border-[3px] border-border border-t-primary animate-spin" />
      </div>
    );
  }

  const hasAudio = audioUrl !== null;

  return (
    <div
      className="relative min-h-full"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {dragOver && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-overlay)] backdrop-blur-sm pointer-events-none">
          <div className="border-2 border-dashed border-primary rounded-2xl p-12 text-center">
            <Music className="w-12 h-12 text-primary mx-auto mb-4" />
            <p className="text-xl text-text-heading font-semibold">오디오 파일을 여기에 놓으세요</p>
            <p className="text-sm text-text-muted mt-2">webm, mp3, m4a, wav</p>
          </div>
        </div>
      )}

      <div className="p-6 max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h2 className="text-3xl font-bold text-text-heading flex items-center gap-2"><Mic className="w-6 h-6 text-primary" /> 회의 노트</h2>
          <p className="text-text-muted text-base mt-1">녹음 또는 오디오 업로드로 자동 트랜스크립션 및 요약</p>
        </div>

        {/* Recording / Upload Card */}
        <div className="bg-bg-card rounded-xl border border-border p-6">
          {/* Idle state — big mic button */}
          {recordingState === 'idle' && (
            <div className="flex flex-col items-center gap-4">
              <button
                onClick={startRecording}
                className="w-24 h-24 rounded-full bg-bg-hover hover:bg-border transition-all duration-200 flex items-center justify-center text-5xl shadow-lg shadow-black/5 hover:scale-105 active:scale-95"
                title="녹음 시작"
              >
                <Mic className="w-10 h-10 text-text-muted" />
              </button>
              <p className="text-base text-text-muted">탭하여 녹음 시작</p>

              <div className="flex items-center gap-3 mt-2">
                <div className="h-px flex-1 bg-bg-input/50" />
                <span className="text-xs text-text-muted">또는</span>
                <div className="h-px flex-1 bg-bg-input/50" />
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-2 px-4 py-2.5 bg-bg-input/50 hover:bg-bg-hover text-text-muted hover:text-text-heading rounded-lg text-sm transition-colors border border-border hover:border-primary/30"
                >
                  <Paperclip className="w-4 h-4" /> 파일 첨부
                </button>
                <span className="text-xs text-text-muted">
                  드래그 앤 드롭도 가능 (webm, mp3, m4a, wav)
                </span>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".webm,.mp3,.m4a,.wav,audio/*"
                onChange={onFileInputChange}
                className="hidden"
              />
            </div>
          )}

          {/* Recording state — timer + pulsing indicator + stop */}
          {recordingState === 'recording' && (
            <div className="flex flex-col items-center gap-5">
              <div className="flex items-center gap-3">
                <span className="relative flex h-4 w-4">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
                  <span className="relative inline-flex rounded-full h-4 w-4 bg-red-500" />
                </span>
                <span className="text-3xl font-mono text-text-heading font-semibold tracking-wider">
                  {formatTime(elapsed)}
                </span>
              </div>
              <p className="text-sm text-red-400">녹음 중...</p>
              <button
                onClick={stopRecording}
                className="w-16 h-16 rounded-full bg-red-500 hover:bg-red-600 transition-all duration-200 flex items-center justify-center shadow-lg shadow-red-500/30 hover:scale-105 active:scale-95"
                title="녹음 중지"
              >
                <svg className="w-6 h-6 text-text-heading" fill="currentColor" viewBox="0 0 24 24">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
            </div>
          )}

          {/* Stopped state — playback + title + submit */}
          {recordingState === 'stopped' && hasAudio && (
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                {/* Play button */}
                <button
                  onClick={() => {
                    if (audioRef.current) {
                      if (audioRef.current.paused) audioRef.current.play();
                      else audioRef.current.pause();
                    }
                  }}
                  className="w-12 h-12 rounded-full bg-primary hover:bg-primary-hover transition-colors flex items-center justify-center flex-shrink-0"
                  title="재생"
                >
                  <svg className="w-5 h-5 text-text-heading ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </button>
                <div className="flex-1 min-w-0">
                  <audio ref={audioRef} src={audioUrl!} className="w-full" controls />
                </div>
                {elapsed > 0 && (
                  <span className="text-xs text-text-muted flex-shrink-0">{formatTime(elapsed)}</span>
                )}
              </div>

              {attachedFile && (
                <p className="text-xs text-text-muted flex items-center gap-1">
                  <Paperclip className="w-3 h-3" /> {attachedFile.name} ({(attachedFile.size / (1024 * 1024)).toFixed(1)} MB)
                </p>
              )}

              {/* Title input */}
              <input
                type="text"
                value={audioTitle}
                onChange={(e) => setAudioTitle(e.target.value)}
                placeholder="회의 제목 (선택, 비워두면 자동 생성)"
                className="w-full bg-bg-input/50 border border-border rounded-lg px-4 py-3 text-sm text-text-heading placeholder-text-muted focus:outline-none focus:border-primary"
              />

              {/* Action buttons */}
              <div className="flex gap-3">
                <button
                  onClick={handleSubmit}
                  className="flex-1 px-4 py-3 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-semibold transition-colors"
                >
                  <Mic className="w-4 h-4 inline mr-1" /> 회의록 생성
                </button>
                <button
                  onClick={resetRecording}
                  className="px-4 py-3 bg-bg-input/50 text-text-muted hover:text-text-heading rounded-lg text-sm transition-colors"
                >
                  취소
                </button>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mt-4 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center justify-between gap-3">
              <p className="text-sm text-red-400">{error}</p>
              {recordingState === 'stopped' && (
                <button onClick={resetRecording} className="text-xs text-text-muted hover:text-text-heading whitespace-nowrap px-3 py-1.5 rounded-lg bg-bg-input/50">
                  새 녹음
                </button>
              )}
            </div>
          )}
        </div>

        {/* Background processing queue */}
        {processingQueue.length > 0 && (
          <div className="space-y-2">
            {processingQueue.map(job => (
              <div key={job.id} className={`flex items-center gap-3 px-4 py-3 rounded-xl border ${
                job.status === 'error' ? 'bg-red-500/5 border-red-500/20' : job.status === 'done' ? 'bg-green-500/5 border-green-500/20' : 'bg-bg-card border-border'
              }`}>
                {job.status === 'uploading' && <div className="animate-spin w-4 h-4 border-2 border-primary border-t-transparent rounded-full flex-shrink-0" />}
                {job.status === 'done' && <span className="text-green-400 flex-shrink-0">✓</span>}
                {job.status === 'error' && <X className="w-4 h-4 text-red-400 flex-shrink-0" />}
                <div className="flex-1 min-w-0">
                  <p className="text-base text-text-heading truncate">{job.title}</p>
                  <p className="text-sm text-text-muted">
                    {job.status === 'uploading' && '회의록 생성 중...'}
                    {job.status === 'done' && '완료!'}
                    {job.status === 'error' && (job.error || '생성 실패')}
                  </p>
                </div>
                {job.status === 'error' && (
                  <button onClick={() => setProcessingQueue(prev => prev.filter(j => j.id !== job.id))} className="text-xs text-text-muted hover:text-text-heading px-2 py-1">닫기</button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Meeting list */}
        {meetings.length === 0 ? (
          <div className="text-center py-16 text-text-muted">
            <Mic className="w-12 h-12 text-text-muted/40 mx-auto mb-4" />
            <p className="text-lg mb-2">아직 회의 기록이 없습니다</p>
            <p className="text-base">녹음하거나 오디오 파일을 업로드해 보세요.</p>
            <p className="text-sm mt-4 text-text-muted">
              음성을 자동으로 텍스트로 변환하고, 요약 및 액션아이템을 생성합니다.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* 월별 그룹핑 */}
            {(() => {
              const monthGroups = new Map<string, Meeting[]>();
              for (const m of meetings) {
                const d = new Date(m.createdAt);
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                if (!monthGroups.has(key)) monthGroups.set(key, []);
                monthGroups.get(key)!.push(m);
              }
              return Array.from(monthGroups.entries()).map(([monthKey, monthMeetings]) => {
                const [y, mo] = monthKey.split('-');
                return (
                  <div key={monthKey}>
                    <h3 className="text-base font-semibold text-text-muted uppercase tracking-wider mb-3">
                      {y}년 {parseInt(mo)}월 ({monthMeetings.length}건)
                    </h3>
                    <div className="space-y-3">
            {monthMeetings.map((m) => {
              const expanded = expandedId === m.id;
              return (
                <div
                  key={m.id}
                  className="bg-bg-card rounded-xl border border-border overflow-hidden hover:border-primary/30 transition-colors"
                >
                  <div
                    className="p-4 flex items-center justify-between cursor-pointer"
                    onClick={() => setExpandedId(expanded ? null : m.id)}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-medium text-text-heading">{m.title}</p>
                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-xs text-text-muted">
                          {new Date(m.createdAt).toLocaleDateString('ko-KR', {
                            month: 'short',
                            day: 'numeric',
                            weekday: 'short',
                          })}
                          {' '}
                          {new Date(m.createdAt).toLocaleTimeString('ko-KR', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                        {m.actionItems.length > 0 && (
                          <span className="text-xs text-amber-600 flex items-center gap-1">
                            <ClipboardList className="w-3 h-3" /> {m.actionItems.length} 액션아이템
                          </span>
                        )}
                        {m.summary && <span className="text-xs text-green-400 flex items-center gap-1"><CheckCircle className="w-3 h-3" /> 요약 완료</span>}
                      </div>
                    </div>
                    {expanded ? <ChevronUp className="w-4 h-4 text-text-muted" /> : <ChevronDown className="w-4 h-4 text-text-muted" />}
                  </div>

                  {expanded && (
                    <MeetingExpanded
                      meeting={m}
                      onDelete={() => handleDelete(m.id)}
                      onRefresh={() => refreshMeetings()}
                    />
                  )}
                </div>
              );
            })}
                    </div>
                  </div>
                );
              });
            })()}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 액션 아이템 체크리스트 컴포넌트 ──
const DONE_PREFIX = '[완료] ';

function ActionItemChecklist({ meetingId, items, onUpdate }: {
  meetingId: string;
  items: string[];
  onUpdate: (items: string[]) => void;
}) {
  const [localItems, setLocalItems] = useState(items);
  const [newItemText, setNewItemText] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const newInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setLocalItems(items); }, [items]);

  const persist = async (updated: string[]) => {
    setLocalItems(updated);
    try {
      await updateMeeting(meetingId, { actionItems: updated });
      onUpdate(updated);
    } catch {
      setLocalItems(items);
    }
  };

  const toggleItem = (index: number) => {
    const updated = [...localItems];
    const item = updated[index];
    updated[index] = item.startsWith(DONE_PREFIX) ? item.slice(DONE_PREFIX.length) : DONE_PREFIX + item;
    persist(updated);
  };

  const addItem = () => {
    const text = newItemText.trim();
    if (!text) return;
    persist([...localItems, text]);
    setNewItemText('');
    setTimeout(() => newInputRef.current?.focus(), 0);
  };

  const startEdit = (index: number) => {
    const item = localItems[index];
    const label = item.startsWith(DONE_PREFIX) ? item.slice(DONE_PREFIX.length) : item;
    setEditingIndex(index);
    setEditText(label);
    setTimeout(() => editInputRef.current?.focus(), 0);
  };

  const saveEdit = () => {
    if (editingIndex === null) return;
    const text = editText.trim();
    if (!text) { setEditingIndex(null); return; }
    const updated = [...localItems];
    const wasDone = updated[editingIndex].startsWith(DONE_PREFIX);
    updated[editingIndex] = wasDone ? DONE_PREFIX + text : text;
    setEditingIndex(null);
    persist(updated);
  };

  const deleteItem = (index: number) => {
    persist(localItems.filter((_, i) => i !== index));
  };

  return (
    <div className="mt-4 pt-4 border-t border-border/30">
      <h4 className="text-sm font-semibold text-text-heading mb-2 flex items-center gap-1.5">
        <ClipboardList className="w-4 h-4 text-amber-600" /> 액션 아이템
      </h4>
      <div className="space-y-1.5">
        {localItems.map((item, i) => {
          const done = item.startsWith(DONE_PREFIX);
          const label = done ? item.slice(DONE_PREFIX.length) : item;

          if (editingIndex === i) {
            return (
              <div key={i} className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                <input
                  ref={editInputRef}
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) saveEdit(); if (e.key === 'Escape') setEditingIndex(null); }}
                  className="flex-1 text-sm bg-surface-card border border-primary rounded px-2 py-1 text-text-body outline-none"
                />
                <button onClick={saveEdit} className="text-xs text-green-400 hover:text-green-300 px-1">저장</button>
                <button onClick={() => setEditingIndex(null)} className="text-xs text-text-muted hover:text-text-body px-1">취소</button>
              </div>
            );
          }

          return (
            <div key={i} className="flex items-start gap-2 group" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => toggleItem(i)}
                className="flex items-start gap-2 flex-1 text-left"
              >
                <span className={`mt-0.5 w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
                  done ? 'bg-green-500/20 border-green-500 text-green-400' : 'border-border group-hover:border-primary'
                }`}>
                  {done && (
                    <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3"><path d="M8 16A8 8 0 1 0 8 0a8 8 0 0 0 0 16zm3.78-9.72a.75.75 0 0 0-1.06-1.06L6.75 9.19 5.28 7.72a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l4.5-4.5z" /></svg>
                  )}
                </span>
                <span className={`text-sm transition-all ${done ? 'line-through text-text-muted' : 'text-text-body'}`}>
                  {label}
                </span>
              </button>
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                <button onClick={() => startEdit(i)} className="p-1 text-text-muted hover:text-primary" title="수정">
                  <Pencil className="w-3 h-3" />
                </button>
                <button onClick={() => deleteItem(i)} className="p-1 text-text-muted hover:text-red-400" title="삭제">
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {/* 새 액션 아이템 추가 */}
      <div className="flex items-center gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
        <input
          ref={newInputRef}
          value={newItemText}
          onChange={(e) => setNewItemText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) addItem(); }}
          placeholder="새 액션 아이템 추가..."
          className="flex-1 text-sm bg-transparent border-b border-border/50 focus:border-primary px-1 py-1 text-text-body placeholder:text-text-muted/50 outline-none transition-colors"
        />
        <button
          onClick={addItem}
          disabled={!newItemText.trim()}
          className="p-1 text-text-muted hover:text-primary disabled:opacity-30 transition-colors"
          title="추가"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ── 회의록 확장 뷰 (수정 가능) ──
function MeetingExpanded({ meeting: m, onDelete, onRefresh }: {
  meeting: Meeting;
  onDelete: () => void;
  onRefresh: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editSummary, setEditSummary] = useState(m.summary || '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      // summary에서 수정된 용어를 원본과 비교하여 corrections 추출
      const corrections: Array<{ wrong: string; correct: string }> = [];
      if (m.summary && editSummary !== m.summary) {
        // 간단한 diff: 원본에서 "안티데라인"이 수정본에서 "안티드라잉"으로 바뀐 경우 등
        const oldWords = new Set(m.summary.match(/[가-힣A-Za-z]{2,}/g) || []);
        const newWords = new Set(editSummary.match(/[가-힣A-Za-z]{2,}/g) || []);
        // 신규 추가된 단어 중 기존에 없던 것은 교정일 가능성
        // 서버 측 learnCorrectionPatterns가 백그라운드에서 더 정교하게 처리
      }

      // summary 첫 줄의 # 제목에서 title 자동 동기화
      const titleMatch = editSummary.match(/^#\s+(.+)/m);
      const newTitle = titleMatch ? titleMatch[1].trim() : undefined;
      await updateMeeting(m.id, {
        summary: editSummary,
        corrections,
        ...(newTitle && newTitle !== m.title ? { title: newTitle } : {}),
      });
      setEditing(false);
      onRefresh();
    } catch (err) {
      console.error('Failed to save meeting:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="px-4 pb-4 border-t border-border pt-4">
      {/* 수정 모드 토글 */}
      <div className="flex items-center gap-2 mb-3">
        {!editing ? (
          <button
            onClick={() => { setEditing(true); setEditSummary(m.summary || ''); }}
            className="text-xs text-text-muted hover:text-primary flex items-center gap-1 transition-colors"
          >
            <Pencil className="w-3 h-3" /> 수정
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="text-xs text-primary hover:text-primary/80 flex items-center gap-1 font-semibold"
            >
              <Save className="w-3 h-3" /> {saving ? '저장 중...' : '저장'}
            </button>
            <button
              onClick={() => { setEditing(false); setEditSummary(m.summary || ''); }}
              className="text-xs text-text-muted hover:text-text-heading"
            >
              취소
            </button>
            <span className="text-xs text-text-muted ml-2">
              수정하면 오탈자 교정 사전에 자동 학습됩니다
            </span>
          </div>
        )}
      </div>

      {/* 요약 렌더링 또는 편집 */}
      {editing ? (
        <textarea
          value={editSummary}
          onChange={(e) => setEditSummary(e.target.value)}
          className="w-full min-h-[400px] bg-bg-input/50 border border-border rounded-lg px-4 py-3 text-sm text-text-heading font-mono leading-relaxed focus:outline-none focus:border-primary resize-y"
          placeholder="마크다운으로 회의록을 수정하세요..."
        />
      ) : (
        m.summary && (
          <div className="notion-note">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {m.summary.replace(/##\s*액션\s*아이템[\s\S]*?(?=\n##\s|\n---|\n$|$)/, '').trim()}
            </ReactMarkdown>
          </div>
        )
      )}

      {/* 액션 아이템 체크리스트 */}
      {m.actionItems.length > 0 && (
        <ActionItemChecklist
          meetingId={m.id}
          items={m.actionItems}
          onUpdate={() => onRefresh()}
        />
      )}

      {/* 공유/액션 버튼 */}
      <div className="pt-4 mt-4 border-t border-border/30 flex items-center gap-3">
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (m.summary) {
              navigator.clipboard.writeText(m.summary);
              alert('마크다운이 클립보드에 복사되었습니다');
            }
          }}
          className="text-xs text-primary hover:text-primary/80 flex items-center gap-1"
        >
          <Copy className="w-3 h-3" /> 마크다운 복사
        </button>
        <button
          onClick={async (e) => {
            e.stopPropagation();
            try {
              const data = await exportMeetingToGDocs(m.id);
              if (data.success && data.docUrl) {
                window.open(data.docUrl, '_blank');
              } else {
                alert(data.error || 'Google Docs 내보내기 실패');
              }
            } catch (err: any) {
              alert(`Google Docs 내보내기 실패: ${err.message || err}`);
            }
          }}
          className="text-xs text-primary hover:text-primary/80 flex items-center gap-1"
        >
          <FileText className="w-3 h-3" /> Google Docs 내보내기
        </button>
        <div className="flex-1" />
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="text-xs text-red-400 hover:text-red-300"
        >
          삭제
        </button>
      </div>
    </div>
  );
}
