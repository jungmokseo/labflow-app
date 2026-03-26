/**
 * 음성 녹음 Hook
 *
 * expo-av를 사용한 오디오 녹음 → API 전송 → 캡처 생성
 * 운전/운동 중 핸즈프리 캡처 UX 지원
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { Audio } from 'expo-av';
import { Platform, Alert } from 'react-native';

export type RecordingState = 'idle' | 'requesting' | 'recording' | 'processing';

interface UseVoiceRecorderReturn {
  /** 현재 녹음 상태 */
  state: RecordingState;
  /** 녹음 시간 (초) */
  duration: number;
  /** 녹음 시작 */
  startRecording: () => Promise<void>;
  /** 녹음 중지 → URI 반환 */
  stopRecording: () => Promise<{ uri: string; mimeType: string } | null>;
  /** 녹음 취소 (저장 안 함) */
  cancelRecording: () => Promise<void>;
  /** 에러 메시지 */
  error: string | null;
}

export function useVoiceRecorder(): UseVoiceRecorderReturn {
  const [state, setState] = useState<RecordingState>('idle');
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 타이머 정리
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);
    setState('requesting');

    try {
      // 권한 요청
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) {
        setError('마이크 권한이 필요합니다');
        setState('idle');
        Alert.alert(
          '마이크 권한 필요',
          '음성 캡처를 위해 마이크 권한을 허용해주세요.\n설정 > 앱 > LabFlow > 마이크',
        );
        return;
      }

      // 오디오 모드 설정
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      // 녹음 시작
      const recording = new Audio.Recording();
      await recording.prepareToRecordAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );
      await recording.startAsync();

      recordingRef.current = recording;
      setState('recording');
      setDuration(0);

      // 녹음 시간 카운터
      timerRef.current = setInterval(() => {
        setDuration(prev => prev + 1);
      }, 1000);

      // 최대 60초 녹음 제한
      setTimeout(async () => {
        if (recordingRef.current) {
          // 60초 넘으면 자동 중지 (UI에서 처리)
        }
      }, 60000);
    } catch (err: any) {
      console.error('녹음 시작 실패:', err);
      setError('녹음을 시작할 수 없습니다');
      setState('idle');
    }
  }, []);

  const stopRecording = useCallback(async () => {
    if (!recordingRef.current) return null;

    // 타이머 정리
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    try {
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;

      // 오디오 모드 복원
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
      });

      if (!uri) {
        setError('녹음 파일을 찾을 수 없습니다');
        setState('idle');
        return null;
      }

      // iOS: .m4a (AAC), Android: .m4a (기본 HIGH_QUALITY)
      const mimeType = Platform.OS === 'ios' ? 'audio/m4a' : 'audio/m4a';

      setState('processing');
      return { uri, mimeType };
    } catch (err: any) {
      console.error('녹음 중지 실패:', err);
      setError('녹음을 중지할 수 없습니다');
      setState('idle');
      recordingRef.current = null;
      return null;
    }
  }, []);

  const cancelRecording = useCallback(async () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (recordingRef.current) {
      try {
        await recordingRef.current.stopAndUnloadAsync();
      } catch {
        // 이미 중지되었을 수 있음
      }
      recordingRef.current = null;
    }

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
    });

    setState('idle');
    setDuration(0);
    setError(null);
  }, []);

  return {
    state,
    duration,
    startRecording,
    stopRecording,
    cancelRecording,
    error,
  };
}

/** 초를 M:SS 형식으로 변환 */
export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
