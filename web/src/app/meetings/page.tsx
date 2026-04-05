'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { getMeetings, uploadMeetingAudio, deleteMeeting, Meeting } from '@/lib/api';
import { useApiData } from '@/lib/use-api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SkeletonCard, SkeletonLine } from '@/components/Skeleton';
import {
  Mic, Paperclip, ClipboardList, FileText, CheckCircle, Music,
  ChevronUp, ChevronDown, Copy, X,
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

  // Load meetings via SWR
  const { data: meetingsData, isLoading: loading, mutate: refreshMeetings } = useApiData(
    'meetings',
    async () => { const res = await getMeetings(20); return res; }
  );
  const meetings = meetingsData?.data || [];

  // Cleanup audio URL on unmount
  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
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

      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 500);
    } catch (err: any) {
      console.error('Microphone access error:', err);
      setError('마이크 접근 권한이 필요합니다. 브라우저 설정을 확인해 주세요.');
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
    setRecordingState('stopped');
  };

  const resetRecording = () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
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
    try {
      await deleteMeeting(id);
      refreshMeetings((prev: any) => prev ? { ...prev, data: (prev.data || []).filter((m: Meeting) => m.id !== id) } : prev, { revalidate: false });
    } catch (err) {
      console.error('Failed to delete meeting:', err);
    }
  };

  if (loading) {
    return (
      <div className="p-6 max-w-4xl mx-auto space-y-6">
        <div className="space-y-2">
          <SkeletonLine width="w-40" />
          <SkeletonLine width="w-64" />
        </div>
        <div className="space-y-3">
          {[1, 2, 3].map(i => <SkeletonCard key={i} />)}
        </div>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm pointer-events-none">
          <div className="border-2 border-dashed border-primary rounded-2xl p-12 text-center">
            <Music className="w-12 h-12 text-primary mx-auto mb-4" />
            <p className="text-xl text-white font-semibold">오디오 파일을 여기에 놓으세요</p>
            <p className="text-sm text-text-muted mt-2">webm, mp3, m4a, wav</p>
          </div>
        </div>
      )}

      <div className="p-6 max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h2 className="text-2xl font-bold text-white flex items-center gap-2"><Mic className="w-6 h-6 text-primary" /> 회의 노트</h2>
          <p className="text-text-muted mt-1">녹음 또는 오디오 업로드로 자동 트랜스크립션 및 요약</p>
        </div>

        {/* Recording / Upload Card */}
        <div className="bg-bg-card rounded-xl border border-bg-input/50 p-6">
          {/* Idle state — big mic button */}
          {recordingState === 'idle' && (
            <div className="flex flex-col items-center gap-4">
              <button
                onClick={startRecording}
                className="w-24 h-24 rounded-full bg-primary hover:bg-primary-hover transition-all duration-200 flex items-center justify-center text-5xl shadow-lg shadow-primary/20 hover:shadow-primary/40 hover:scale-105 active:scale-95"
                title="녹음 시작"
              >
                <Mic className="w-10 h-10 text-white" />
              </button>
              <p className="text-sm text-text-muted">탭하여 녹음 시작</p>

              <div className="flex items-center gap-3 mt-2">
                <div className="h-px flex-1 bg-bg-input/50" />
                <span className="text-xs text-text-muted">또는</span>
                <div className="h-px flex-1 bg-bg-input/50" />
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center gap-2 px-4 py-2.5 bg-bg-input/50 hover:bg-bg-input text-text-muted hover:text-white rounded-lg text-sm transition-colors border border-bg-input/50 hover:border-primary/30"
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
                <span className="text-3xl font-mono text-white font-semibold tracking-wider">
                  {formatTime(elapsed)}
                </span>
              </div>
              <p className="text-sm text-red-400">녹음 중...</p>
              <button
                onClick={stopRecording}
                className="w-16 h-16 rounded-full bg-red-500 hover:bg-red-600 transition-all duration-200 flex items-center justify-center shadow-lg shadow-red-500/30 hover:scale-105 active:scale-95"
                title="녹음 중지"
              >
                <svg className="w-6 h-6 text-white" fill="currentColor" viewBox="0 0 24 24">
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
                  <svg className="w-5 h-5 text-white ml-0.5" fill="currentColor" viewBox="0 0 24 24">
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
                className="w-full bg-bg-input/50 border border-bg-input rounded-lg px-4 py-3 text-sm text-white placeholder-text-muted focus:outline-none focus:border-primary"
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
                  className="px-4 py-3 bg-bg-input/50 text-text-muted hover:text-white rounded-lg text-sm transition-colors"
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
                <button onClick={resetRecording} className="text-xs text-text-muted hover:text-white whitespace-nowrap px-3 py-1.5 rounded-lg bg-bg-input/50">
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
                job.status === 'error' ? 'bg-red-500/5 border-red-500/20' : job.status === 'done' ? 'bg-green-500/5 border-green-500/20' : 'bg-bg-card border-bg-input/50'
              }`}>
                {job.status === 'uploading' && <div className="animate-spin w-4 h-4 border-2 border-primary border-t-transparent rounded-full flex-shrink-0" />}
                {job.status === 'done' && <span className="text-green-400 flex-shrink-0">✓</span>}
                {job.status === 'error' && <X className="w-4 h-4 text-red-400 flex-shrink-0" />}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{job.title}</p>
                  <p className="text-xs text-text-muted">
                    {job.status === 'uploading' && '회의록 생성 중...'}
                    {job.status === 'done' && '완료!'}
                    {job.status === 'error' && (job.error || '생성 실패')}
                  </p>
                </div>
                {job.status === 'error' && (
                  <button onClick={() => setProcessingQueue(prev => prev.filter(j => j.id !== job.id))} className="text-xs text-text-muted hover:text-white px-2 py-1">닫기</button>
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
            <p className="text-sm">녹음하거나 오디오 파일을 업로드해 보세요.</p>
            <p className="text-xs mt-4 text-text-muted">
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
                    <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wider mb-3">
                      {y}년 {parseInt(mo)}월 ({monthMeetings.length}건)
                    </h3>
                    <div className="space-y-3">
            {monthMeetings.map((m) => {
              const expanded = expandedId === m.id;
              return (
                <div
                  key={m.id}
                  className="bg-bg-card rounded-xl border border-bg-input/50 overflow-hidden hover:border-primary/30 transition-colors"
                >
                  <div
                    className="p-4 flex items-center justify-between cursor-pointer"
                    onClick={() => setExpandedId(expanded ? null : m.id)}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-white">{m.title}</p>
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
                          <span className="text-xs text-yellow-400 flex items-center gap-1">
                            <ClipboardList className="w-3 h-3" /> {m.actionItems.length} 액션아이템
                          </span>
                        )}
                        {m.summary && <span className="text-xs text-green-400 flex items-center gap-1"><CheckCircle className="w-3 h-3" /> 요약 완료</span>}
                      </div>
                    </div>
                    {expanded ? <ChevronUp className="w-4 h-4 text-text-muted" /> : <ChevronDown className="w-4 h-4 text-text-muted" />}
                  </div>

                  {expanded && (
                    <div className="px-4 pb-4 border-t border-bg-input/50 pt-4">
                      {/* Notion 스타일 회의록 렌더링 */}
                      {m.summary && (
                        <div className="notion-note">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.summary}</ReactMarkdown>
                        </div>
                      )}

                      {/* 공유/액션 버튼 */}
                      <div className="pt-4 mt-4 border-t border-bg-input/30 flex items-center gap-3">
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
                              const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'https://labflow-app-production.up.railway.app';
                              const res = await fetch(`${API_BASE}/api/meetings/${m.id}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
                              const data = await res.json();
                              if (data.success && data.docUrl) {
                                window.open(data.docUrl, '_blank');
                              } else {
                                alert(data.error || 'Google Docs 내보내기 실패');
                              }
                            } catch {
                              alert('Google Docs 내보내기에 실패했습니다');
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
                            handleDelete(m.id);
                          }}
                          className="text-xs text-red-400 hover:text-red-300"
                        >
                          삭제
                        </button>
                      </div>
                    </div>
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
