import React from 'react';
import { View, FlatList, StyleSheet, Text, ActivityIndicator, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useCapture } from '../hooks/useCapture';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';
import * as api from '../services/api-client';
import CaptureCard from './CaptureCard';
import FilterChips from './FilterChips';
import SortSelector from './SortSelector';
import ChatInput from './ChatInput';
import { colors, spacing, fontSize, borderRadius } from '../constants/theme';

export default function CaptureScreen() {
  const {
    items, isProcessing, isLoaded, filter, setFilter,
    sortMode, setSortMode,
    addCapture, removeCapture, reclassify, toggleComplete, clearCompleted,
    counts, taskCounts, isOnline,
    addCaptureFromVoice,
  } = useCapture();

  const voice = useVoiceRecorder();

  // ── 음성 녹음 완료 → API 전송 → 캡처 추가 ──────────
  const handleStopRecording = async () => {
    const result = await voice.stopRecording();
    if (!result) return;

    try {
      if (isOnline) {
        // 서버로 오디오 전송 → Gemini 전사+분류+저장
        const capture = await api.createVoiceCapture(result.uri, result.mimeType);
        addCaptureFromVoice(capture);
      } else {
        Alert.alert(
          '오프라인',
          '음성 캡처는 서버 연결이 필요합니다. 인터넷 연결을 확인해주세요.',
        );
      }
    } catch (error: any) {
      console.error('음성 캡처 실패:', error);
      Alert.alert('음성 캡처 실패', error.message || '다시 시도해주세요.');
    } finally {
      // state를 idle로 복원 (useVoiceRecorder의 processing은 여기서 해제)
      voice.cancelRecording(); // processing 상태 리셋
    }
  };

  const handleClearCompleted = () => {
    if (taskCounts.completed === 0) return;
    Alert.alert(
      '완료 항목 삭제',
      `완료된 ${taskCounts.completed}개 항목을 삭제하시겠습니까?`,
      [
        { text: '취소', style: 'cancel' },
        { text: '삭제', style: 'destructive', onPress: clearCompleted },
      ]
    );
  };

  return (
    <View style={styles.container}>
      {/* 연결 상태 표시 */}
      {isLoaded && !isOnline && (
        <View style={styles.offlineBanner}>
          <Ionicons name="cloud-offline-outline" size={14} color={colors.warning} />
          <Text style={styles.offlineText}>오프라인 — 텍스트 캡처만 가능</Text>
        </View>
      )}

      {/* 필터 칩 + 정렬 선택 */}
      <View style={styles.toolbar}>
        <FilterChips filter={filter} onFilterChange={setFilter} counts={counts} />
        <View style={styles.sortRow}>
          <SortSelector sortMode={sortMode} onSortChange={setSortMode} />
          <View style={styles.sortRowRight}>
            {filter === 'task' && taskCounts.total > 0 && (
              <Text style={styles.taskProgress}>
                {taskCounts.completed}/{taskCounts.total} 완료
              </Text>
            )}
            {taskCounts.completed > 0 && (
              <TouchableOpacity style={styles.clearBtn} onPress={handleClearCompleted}>
                <Ionicons name="trash-outline" size={13} color="#EF4444" />
                <Text style={styles.clearBtnText}>완료 삭제</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>

      {/* 캡처 목록 */}
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <CaptureCard
            item={item}
            onDelete={removeCapture}
            onReclassify={reclassify}
            onToggleComplete={toggleComplete}
          />
        )}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          isProcessing ? (
            <View style={styles.processingBar}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={styles.processingText}>AI가 분류하고 있습니다...</Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          isLoaded ? (
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyEmoji}>🧠</Text>
              <Text style={styles.emptyTitle}>빠른 캡처</Text>
              <Text style={styles.emptySubtitle}>
                아무거나 입력하거나 말하세요{'\n'}
                AI가 자동으로 분류합니다{'\n\n'}
                🎤 음성 — 운전/운동 중 핸즈프리{'\n'}
                ⌨️ 텍스트 — 빠른 메모{'\n\n'}
                💡 아이디어 — 나중에 발전시킬 것{'\n'}
                ✅ 할일 — 체크박스로 완료 표시{'\n'}
                📝 메모 — 기억할 정보{'\n\n'}
                💬 롱프레스로 분류 수정/삭제
              </Text>
            </View>
          ) : null
        }
      />

      {/* 통합 입력창 (텍스트 + 음성) */}
      <ChatInput
        onSend={addCapture}
        onStartRecording={voice.startRecording}
        onStopRecording={handleStopRecording}
        onCancelRecording={voice.cancelRecording}
        placeholder="입력 또는 🎤 음성 캡처"
        isLoading={isProcessing}
        recordingState={voice.state}
        recordingDuration={voice.duration}
        recordingError={voice.error}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
    backgroundColor: `${colors.warning}15`,
  },
  offlineText: {
    fontSize: fontSize.xs,
    color: colors.warning,
    fontWeight: '500',
  },
  toolbar: {
    gap: 4,
  },
  sortRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },
  sortRowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  taskProgress: {
    fontSize: fontSize.xs,
    color: '#10B981',
    fontWeight: '700',
  },
  clearBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
    backgroundColor: '#EF444415',
  },
  clearBtnText: {
    fontSize: fontSize.xs,
    color: '#EF4444',
    fontWeight: '600',
  },
  list: {
    flexGrow: 1,
    paddingVertical: spacing.xs,
  },
  processingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  processingText: {
    color: colors.primaryLight,
    fontSize: fontSize.sm,
    fontWeight: '500',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xxl,
    paddingTop: 60,
  },
  emptyEmoji: {
    fontSize: 56,
    marginBottom: spacing.lg,
  },
  emptyTitle: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.text,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  emptySubtitle: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 24,
  },
});
