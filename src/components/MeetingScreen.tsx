import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import { colors, spacing, fontSize, borderRadius } from '../constants/theme';
import {
  createMeeting,
  listMeetings,
  deleteMeeting,
  MeetingItem,
} from '../services/api-client';

export default function MeetingScreen() {
  // ── 녹음 상태 ──────────────────────────────────────
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── 회의 목록 ──────────────────────────────────────
  const [meetings, setMeetings] = useState<MeetingItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedMeeting, setExpandedMeeting] = useState<string | null>(null);
  const [expandedTranscription, setExpandedTranscription] = useState<string | null>(null);

  // ── 초기 로드 ──────────────────────────────────────
  useEffect(() => {
    loadMeetings();
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const loadMeetings = useCallback(async () => {
    try {
      const result = await listMeetings({ limit: 20 });
      setMeetings(result.items);
    } catch (err: any) {
      console.warn('Meeting list load failed:', err.message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadMeetings();
    setRefreshing(false);
  }, [loadMeetings]);

  // ── 녹음 시작 ──────────────────────────────────────
  const startRecording = async () => {
    try {
      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('권한 필요', '마이크 권한을 허용해주세요.');
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );

      recordingRef.current = recording;
      setIsRecording(true);
      setRecordingDuration(0);

      timerRef.current = setInterval(() => {
        setRecordingDuration((prev) => prev + 1);
      }, 1000);
    } catch (error: any) {
      console.error('Recording start failed:', error);
      Alert.alert('녹음 실패', '녹음을 시작할 수 없습니다.');
    }
  };

  // ── 녹음 중지 + 서버 전송 ──────────────────────────
  const stopRecording = async () => {
    if (!recordingRef.current) return;

    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    setIsRecording(false);
    setIsProcessing(true);

    try {
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;

      if (!uri) {
        throw new Error('녹음 파일을 찾을 수 없습니다');
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
      });

      // 서버로 전송 → 2단계 파이프라인 (Gemini STT → Sonnet 요약)
      const meeting = await createMeeting(uri, 'audio/m4a', recordingDuration);

      setMeetings((prev) => [meeting, ...prev]);
      setExpandedMeeting(meeting.id);

      Alert.alert(
        '회의 저장 완료',
        `"${meeting.title}" 회의가 저장되었습니다.\n액션 아이템 ${meeting.actionItems.length}개가 추출되었습니다.`,
      );
    } catch (error: any) {
      console.error('Meeting processing failed:', error);
      Alert.alert(
        '처리 실패',
        error.message || '회의 음성 처리 중 오류가 발생했습니다.',
      );
    } finally {
      setIsProcessing(false);
      setRecordingDuration(0);
    }
  };

  const handleRecord = () => {
    if (isProcessing) return;
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  // ── 회의 삭제 ──────────────────────────────────────
  const handleDelete = (meeting: MeetingItem) => {
    Alert.alert(
      '회의 삭제',
      `"${meeting.title}" 회의를 삭제하시겠습니까?`,
      [
        { text: '취소', style: 'cancel' },
        {
          text: '삭제',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteMeeting(meeting.id);
              setMeetings((prev) => prev.filter((m) => m.id !== meeting.id));
            } catch {
              Alert.alert('삭제 실패', '회의를 삭제하지 못했습니다.');
            }
          },
        },
      ],
    );
  };

  // ── 시간 포맷 ──────────────────────────────────────
  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffHr = Math.floor(diffMs / 3600000);
    if (diffHr < 1) return '방금 전';
    if (diffHr < 24) return `${diffHr}시간 전`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}일 전`;
    return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
  };

  // ── discussions 파싱 ──────────────────────────────
  const parseDiscussions = (meeting: MeetingItem): Array<{ topic: string; content: string }> => {
    if (!meeting.discussions) return [];
    if (Array.isArray(meeting.discussions)) return meeting.discussions;
    try {
      return JSON.parse(meeting.discussions as any);
    } catch {
      return [];
    }
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.primary}
          colors={[colors.primary]}
        />
      }
    >
      {/* ── 녹음 카드 ──────────────────────────────── */}
      <View style={styles.recordCard}>
        <TouchableOpacity
          style={[
            styles.recordBtn,
            isRecording && styles.recordBtnActive,
            isProcessing && styles.recordBtnProcessing,
          ]}
          onPress={handleRecord}
          disabled={isProcessing}
          activeOpacity={0.7}
        >
          {isProcessing ? (
            <ActivityIndicator size={36} color={colors.primary} />
          ) : (
            <Ionicons
              name={isRecording ? 'stop' : 'mic'}
              size={40}
              color={isRecording ? '#EF4444' : 'white'}
            />
          )}
        </TouchableOpacity>

        <Text style={styles.recordLabel}>
          {isProcessing
            ? 'AI가 분석 중입니다...'
            : isRecording
            ? '녹음 중... 탭하여 중지'
            : '탭하여 회의 녹음 시작'}
        </Text>

        {isRecording && (
          <View style={styles.recordingIndicator}>
            <View style={styles.recordingDot} />
            <Text style={styles.recordingTime}>{formatTime(recordingDuration)}</Text>
          </View>
        )}

        {isProcessing && (
          <Text style={styles.processingSubtext}>
            Gemini STT 전사 → Sonnet 교정/요약 (30초~1분)
          </Text>
        )}
      </View>

      {/* ── 최근 회의 ──────────────────────────────── */}
      <View style={styles.recentHeader}>
        <Text style={styles.recentTitle}>최근 회의</Text>
        <Text style={styles.recentCount}>{meetings.length}건</Text>
      </View>

      {isLoading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : meetings.length === 0 ? (
        <View style={styles.emptyCard}>
          <Ionicons name="document-text-outline" size={32} color={colors.textMuted} />
          <Text style={styles.emptyText}>아직 녹음된 회의가 없습니다</Text>
          <Text style={styles.emptySubtext}>위의 녹음 버튼으로 첫 회의를 시작하세요</Text>
        </View>
      ) : (
        meetings.map((meeting) => {
          const discussions = parseDiscussions(meeting);
          const isExpanded = expandedMeeting === meeting.id;
          const isTransExpanded = expandedTranscription === meeting.id;

          return (
            <TouchableOpacity
              key={meeting.id}
              style={styles.meetingCard}
              onPress={() =>
                setExpandedMeeting(isExpanded ? null : meeting.id)
              }
              activeOpacity={0.7}
            >
              {/* 회의 헤더 */}
              <View style={styles.meetingHeader}>
                <View style={styles.meetingTitleRow}>
                  <Text style={styles.meetingEmoji}>🎙️</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.meetingTitle} numberOfLines={1}>
                      {meeting.title}
                    </Text>
                    <Text style={styles.meetingMeta}>
                      {formatDate(meeting.createdAt)}
                      {meeting.duration ? ` · ${formatTime(meeting.duration)}` : ''}
                      {meeting.actionItems.length > 0
                        ? ` · 액션 ${meeting.actionItems.length}개`
                        : ''}
                    </Text>
                  </View>
                  <Ionicons
                    name={isExpanded ? 'chevron-up' : 'chevron-down'}
                    size={16}
                    color={colors.textMuted}
                  />
                </View>
              </View>

              {/* 확장된 상세 — 새 구조 */}
              {isExpanded && (
                <View style={styles.meetingDetail}>
                  {/* 📋 안건 */}
                  {meeting.agenda && meeting.agenda.length > 0 && (
                    <View style={styles.detailSection}>
                      <Text style={styles.detailLabel}>📋 안건</Text>
                      {meeting.agenda.map((item, idx) => (
                        <Text key={idx} style={styles.agendaItem}>
                          {idx + 1}. {item}
                        </Text>
                      ))}
                    </View>
                  )}

                  {/* 📝 논의 내용 */}
                  {discussions.length > 0 && (
                    <View style={styles.detailSection}>
                      <Text style={styles.detailLabel}>📝 논의 내용</Text>
                      {discussions.map((disc, idx) => (
                        <View key={idx} style={styles.discussionItem}>
                          <Text style={styles.discussionTopic}>▸ {disc.topic}</Text>
                          <Text style={styles.discussionContent}>{disc.content}</Text>
                        </View>
                      ))}
                    </View>
                  )}

                  {/* 기존 summary fallback (discussions가 없을 때) */}
                  {discussions.length === 0 && meeting.summary && (
                    <View style={styles.detailSection}>
                      <Text style={styles.detailLabel}>📝 요약</Text>
                      <Text style={styles.detailText}>{meeting.summary}</Text>
                    </View>
                  )}

                  {/* ✅ 액션 아이템 */}
                  {meeting.actionItems.length > 0 && (
                    <View style={styles.detailSection}>
                      <Text style={styles.detailLabel}>✅ 액션 아이템</Text>
                      {meeting.actionItems.map((item, idx) => (
                        <View key={idx} style={styles.actionItem}>
                          <View style={styles.actionCheckbox} />
                          <Text style={styles.actionText}>{item}</Text>
                        </View>
                      ))}
                    </View>
                  )}

                  {/* 📌 다음 할 일 */}
                  {meeting.nextSteps && meeting.nextSteps.length > 0 && (
                    <View style={styles.detailSection}>
                      <Text style={styles.detailLabel}>📌 다음 할 일</Text>
                      {meeting.nextSteps.map((item, idx) => (
                        <View key={idx} style={styles.nextStepItem}>
                          <Text style={styles.nextStepBullet}>•</Text>
                          <Text style={styles.nextStepText}>{item}</Text>
                        </View>
                      ))}
                    </View>
                  )}

                  {/* 전사 (접기/펼치기) */}
                  {meeting.transcription && (
                    <View style={styles.detailSection}>
                      <TouchableOpacity
                        onPress={() =>
                          setExpandedTranscription(
                            isTransExpanded ? null : meeting.id,
                          )
                        }
                      >
                        <View style={styles.transcriptionToggle}>
                          <Text style={styles.detailLabel}>🔤 전사 내용</Text>
                          <Ionicons
                            name={isTransExpanded ? 'chevron-up' : 'chevron-down'}
                            size={12}
                            color={colors.textMuted}
                          />
                        </View>
                      </TouchableOpacity>
                      {isTransExpanded && (
                        <Text style={styles.transcriptionText}>
                          {meeting.transcription}
                        </Text>
                      )}
                    </View>
                  )}

                  {/* 삭제 버튼 */}
                  <TouchableOpacity
                    style={styles.deleteBtn}
                    onPress={() => handleDelete(meeting)}
                  >
                    <Ionicons name="trash-outline" size={14} color={colors.error} />
                    <Text style={styles.deleteBtnText}>삭제</Text>
                  </TouchableOpacity>
                </View>
              )}
            </TouchableOpacity>
          );
        })
      )}
    </ScrollView>
  );
}

// ── 스타일 ──────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: spacing.lg,
    gap: spacing.lg,
  },

  // ── 녹음 카드 ────────────────────────────────
  recordCard: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.xl,
    padding: spacing.xxl,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.bgInput,
  },
  recordBtn: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
  recordBtnActive: {
    backgroundColor: '#1E293B',
    borderWidth: 3,
    borderColor: '#EF4444',
    shadowColor: '#EF4444',
  },
  recordBtnProcessing: {
    backgroundColor: colors.bgInput,
    shadowOpacity: 0,
    elevation: 0,
  },
  recordLabel: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  recordingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#EF4444',
  },
  recordingTime: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: '#EF4444',
    fontVariant: ['tabular-nums'],
  },
  processingSubtext: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },

  // ── 최근 회의 ────────────────────────────────
  recentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  recentTitle: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.text,
  },
  recentCount: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
  },
  loadingContainer: {
    paddingVertical: spacing.xxl,
    alignItems: 'center',
  },
  emptyCard: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.xl,
    padding: spacing.xxl,
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.bgInput,
  },
  emptyText: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  emptySubtext: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
  },

  // ── 회의 카드 ────────────────────────────────
  meetingCard: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.bgInput,
  },
  meetingHeader: {},
  meetingTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  meetingEmoji: {
    fontSize: 20,
  },
  meetingTitle: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.text,
  },
  meetingMeta: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: 2,
  },

  // ── 회의 상세 ────────────────────────────────
  meetingDetail: {
    marginTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.bgInput,
    paddingTop: spacing.md,
  },
  detailSection: {
    marginBottom: spacing.md,
  },
  detailLabel: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.primaryLight,
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
  },
  detailText: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    lineHeight: 20,
  },

  // ── 안건 ──────────────────────────────────────
  agendaItem: {
    fontSize: fontSize.sm,
    color: colors.text,
    lineHeight: 22,
    paddingLeft: spacing.xs,
  },

  // ── 논의 내용 ────────────────────────────────
  discussionItem: {
    marginBottom: spacing.sm,
  },
  discussionTopic: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 2,
  },
  discussionContent: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    lineHeight: 20,
    paddingLeft: spacing.md,
  },

  // ── 액션 아이템 ──────────────────────────────
  actionItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: 3,
  },
  actionCheckbox: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.primaryLight,
    marginTop: 2,
  },
  actionText: {
    fontSize: fontSize.sm,
    color: colors.text,
    flex: 1,
    lineHeight: 20,
  },

  // ── 다음 할 일 ──────────────────────────────
  nextStepItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: 2,
  },
  nextStepBullet: {
    fontSize: fontSize.sm,
    color: colors.primaryLight,
    fontWeight: '700',
    marginTop: 1,
  },
  nextStepText: {
    fontSize: fontSize.sm,
    color: colors.text,
    flex: 1,
    lineHeight: 20,
  },

  // ── 전사 내용 ────────────────────────────────
  transcriptionToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  transcriptionText: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    lineHeight: 18,
    fontStyle: 'italic',
    marginTop: spacing.xs,
  },

  // ── 삭제 버튼 ────────────────────────────────
  deleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-end',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  deleteBtnText: {
    fontSize: fontSize.xs,
    color: colors.error,
  },
});
