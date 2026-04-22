'use client';
/**
 * 오프라인 / 동기화 대기 뱃지.
 * - 오프라인 중이거나 큐에 대기 중인 요청이 있을 때만 표시.
 * - 온라인 상태에서 큐가 남아있으면 "지금 동기화" 버튼 노출.
 */
import { useEffect, useState } from 'react';
import {
  subscribeOfflineQueue,
  flushOfflineQueue,
  type QueuedRequest,
} from '@/lib/offline-queue';
import { getAuthHeadersForReplay } from '@/lib/api';

export function OfflineStatusBadge() {
  const [online, setOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [queue, setQueue] = useState<QueuedRequest[]>([]);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    const updateOnline = () => {
      const now = navigator.onLine;
      setOnline(now);
      if (now) {
        flushOfflineQueue(getAuthHeadersForReplay).catch(() => {});
      }
    };
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    const unsub = subscribeOfflineQueue(setQueue);
    return () => {
      window.removeEventListener('online', updateOnline);
      window.removeEventListener('offline', updateOnline);
      unsub();
    };
  }, []);

  const show = !online || queue.length > 0;
  if (!show) return null;

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await flushOfflineQueue(getAuthHeadersForReplay);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] px-3 py-2 rounded-full shadow-lg border text-xs flex items-center gap-2"
      style={{
        backgroundColor: !online ? '#fef3c7' : '#dbeafe',
        borderColor: !online ? '#f59e0b' : '#3b82f6',
        color: !online ? '#92400e' : '#1e40af',
      }}
      role="status"
      aria-live="polite"
    >
      <span
        className="inline-block w-2 h-2 rounded-full"
        style={{ backgroundColor: !online ? '#f59e0b' : '#3b82f6' }}
      />
      {!online ? (
        <span>오프라인{queue.length > 0 ? ` · ${queue.length}건 대기` : ''}</span>
      ) : (
        <>
          <span>{queue.length}건 동기화 대기</span>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="underline underline-offset-2 disabled:opacity-50"
          >
            {syncing ? '동기화 중…' : '지금 동기화'}
          </button>
        </>
      )}
    </div>
  );
}
