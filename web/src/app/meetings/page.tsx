'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { getMeetings, uploadMeetingAudio, deleteMeeting, Meeting } from '@/lib/api';

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

type RecordingState = 'idle' | 'recording' | 'stopped' | 'processing';

export default function MeetingsPage() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Recording state
  const [recordingState, setRecordingState] = useState<RecordingState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioTitle, setAudioTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

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

  // Load meetings
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

  // ── Submit ──
  const handleSubmit = async () => {
    const fileToUpload = attachedFile || (audioBlob ? new File([audioBlob], 'recording.webm', { type: 'audio/webm' }) : null);
    if (!fileToUpload) return;

    setRecordingState('processing');
    setError(null);
    try {
      const res = await uploadMeetingAudio(fileToUpload, {
        title: audioTitle.trim() || undefined,
        duration: elapsed > 0 ? elapsed : undefined,
      });
      setMeetings((prev) => [res.data, ...prev]);
      resetRecording();
    } catch (err: any) {
      console.error('Upload failed:', err);
      setError(err.message || '업로드에 실패했습니다. 다시 시도해 주세요.');
      setRecordingState('stopped');
    }
  };

  // ── Delete ──
  const handleDelete = async (id: string) => {
    try {
      await deleteMeeting(id);
      setMeetings((prev) => prev.filter((m) => m.id !== id));
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
            <span className="text-5xl block mb-4">🎵</span>
            <p className="text-xl text-white font-semibold">오디오 파일을 여기에 놓으세요</p>
            <p className="text-sm text-text-muted mt-2">webm, mp3, m4a, wav</p>
          </div>
        </div>
      )}

      <div className="p-6 max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h2 className="text-2xl font-bold text-white">🎙️ 회의 노트</h2>
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
                🎙️
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
                  📎 파일 첨부
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
                <p className="text-xs text-text-muted">
                  📎 {attachedFile.name} ({(attachedFile.size / (1024 * 1024)).toFixed(1)} MB)
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
                  🎙️ 회의록 생성
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

          {/* Processing state */}
          {recordingState === 'processing' && (
            <div className="flex flex-col items-center gap-4 py-4">
              <div className="animate-spin w-10 h-10 border-3 border-primary border-t-transparent rounded-full" />
              <div className="text-center">
                <p className="text-white font-medium">회의록 생성 중...</p>
                <p className="text-sm text-text-muted mt-1">
                  음성 인식(STT) 및 요약을 진행하고 있습니다
                </p>
                <p className="text-xs text-text-muted mt-1">약 30~60초 소요됩니다</p>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mt-4 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-lg">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}
        </div>

        {/* Meeting list */}
        {meetings.length === 0 ? (
          <div className="text-center py-16 text-text-muted">
            <span className="text-5xl block mb-4">🎙️</span>
            <p className="text-lg mb-2">아직 회의 기록이 없습니다</p>
            <p className="text-sm">녹음하거나 오디오 파일을 업로드해 보세요.</p>
            <p className="text-xs mt-4 text-text-muted">
              Gemini STT로 음성을 텍스트로, Claude Sonnet으로 요약 및 액션아이템을 자동 생성합니다.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wider">
              회의 기록 ({meetings.length})
            </h3>
            {meetings.map((m) => {
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
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                        {m.actionItems.length > 0 && (
                          <span className="text-xs text-yellow-400">
                            📋 {m.actionItems.length} 액션아이템
                          </span>
                        )}
                        {m.summary && <span className="text-xs text-green-400">✅ 요약 완료</span>}
                      </div>
                    </div>
                    <span className="text-text-muted text-sm">{expanded ? '▲' : '▼'}</span>
                  </div>

                  {expanded && (
                    <div className="px-4 pb-4 space-y-4 border-t border-bg-input/50 pt-4">
                      {m.summary && (
                        <div>
                          <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
                            요약
                          </h4>
                          <p className="text-sm text-white bg-bg/50 rounded-lg p-3">{m.summary}</p>
                        </div>
                      )}

                      {m.agenda.length > 0 && (
                        <div>
                          <h4 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
                            안건
                          </h4>
                          <ul className="space-y-1">
                            {m.agenda.map((a, i) => (
                              <li key={i} className="text-sm text-text-main flex items-start gap-2">
                                <span className="text-text-muted">•</span> {a}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {m.actionItems.length > 0 && (
                        <div>
                          <h4 className="text-xs font-semibold text-yellow-400 uppercase tracking-wider mb-2">
                            📋 액션 아이템
                          </h4>
                          <ul className="space-y-1">
                            {m.actionItems.map((a, i) => (
                              <li key={i} className="text-sm text-white flex items-start gap-2">
                                <span className="text-yellow-400">☐</span> {a}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {m.nextSteps.length > 0 && (
                        <div>
                          <h4 className="text-xs font-semibold text-blue-400 uppercase tracking-wider mb-2">
                            → 다음 단계
                          </h4>
                          <ul className="space-y-1">
                            {m.nextSteps.map((s, i) => (
                              <li key={i} className="text-sm text-text-main flex items-start gap-2">
                                <span className="text-blue-400">→</span> {s}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <div className="pt-2 border-t border-bg-input/30">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(m.id);
                          }}
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
    </div>
  );
}
