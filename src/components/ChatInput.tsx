import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Text,
  Animated,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../constants/theme';
import { RecordingState, formatDuration } from '../hooks/useVoiceRecorder';

interface Props {
  onSend: (text: string) => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onCancelRecording: () => void;
  placeholder?: string;
  isLoading?: boolean;
  recordingState: RecordingState;
  recordingDuration: number;
  recordingError?: string | null;
}

export default function ChatInput({
  onSend,
  onStartRecording,
  onStopRecording,
  onCancelRecording,
  placeholder = '메시지를 입력하세요...',
  isLoading,
  recordingState,
  recordingDuration,
  recordingError,
}: Props) {
  const [text, setText] = useState('');
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // 녹음 중 맥동 애니메이션
  useEffect(() => {
    if (recordingState === 'recording') {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.3,
            duration: 600,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }),
        ]),
      );
      pulse.start();
      return () => pulse.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [recordingState]);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;
    onSend(trimmed);
    setText('');
  };

  const handleMicPress = () => {
    if (recordingState === 'idle') {
      onStartRecording();
    } else if (recordingState === 'recording') {
      onStopRecording();
    }
  };

  const isRecording = recordingState === 'recording';
  const isProcessingVoice = recordingState === 'processing';
  const showTextInput = recordingState === 'idle' && !isProcessingVoice;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <View style={styles.container}>
        {/* 녹음 중 UI */}
        {isRecording && (
          <View style={styles.recordingBar}>
            <View style={styles.recordingLeft}>
              <Animated.View
                style={[
                  styles.recordDot,
                  { transform: [{ scale: pulseAnim }] },
                ]}
              />
              <Text style={styles.recordingTime}>
                {formatDuration(recordingDuration)}
              </Text>
              <Text style={styles.recordingLabel}>녹음 중...</Text>
            </View>
            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={onCancelRecording}
            >
              <Ionicons name="close" size={18} color={colors.error} />
            </TouchableOpacity>
          </View>
        )}

        {/* AI 처리 중 UI */}
        {isProcessingVoice && (
          <View style={styles.processingBar}>
            <Ionicons name="sparkles" size={16} color={colors.primary} />
            <Text style={styles.processingText}>
              AI가 음성을 분석하고 있습니다...
            </Text>
          </View>
        )}

        {/* 에러 메시지 */}
        {recordingError && (
          <View style={styles.errorBar}>
            <Ionicons name="warning" size={14} color={colors.error} />
            <Text style={styles.errorText}>{recordingError}</Text>
          </View>
        )}

        {/* 입력 행 */}
        <View style={styles.inputRow}>
          {/* 마이크 버튼 */}
          <TouchableOpacity
            style={[
              styles.micBtn,
              isRecording && styles.micBtnRecording,
              isProcessingVoice && styles.micBtnProcessing,
            ]}
            onPress={handleMicPress}
            disabled={isLoading || isProcessingVoice}
          >
            <Ionicons
              name={isRecording ? 'stop' : 'mic'}
              size={22}
              color={
                isRecording
                  ? colors.white
                  : isProcessingVoice
                    ? colors.textMuted
                    : colors.primary
              }
            />
          </TouchableOpacity>

          {/* 텍스트 입력 */}
          {showTextInput && (
            <>
              <TextInput
                style={styles.input}
                value={text}
                onChangeText={setText}
                placeholder={placeholder}
                placeholderTextColor={colors.textMuted}
                multiline
                maxLength={2000}
                onSubmitEditing={handleSend}
                returnKeyType="send"
                blurOnSubmit={false}
                editable={!isLoading}
              />
              {/* 전송 버튼 */}
              <TouchableOpacity
                style={[
                  styles.sendBtn,
                  text.trim() ? styles.sendBtnActive : null,
                ]}
                onPress={handleSend}
                disabled={!text.trim() || isLoading}
              >
                {isLoading ? (
                  <Ionicons
                    name="ellipsis-horizontal"
                    size={20}
                    color={colors.white}
                  />
                ) : (
                  <Ionicons
                    name="arrow-up"
                    size={20}
                    color={text.trim() ? colors.white : colors.textMuted}
                  />
                )}
              </TouchableOpacity>
            </>
          )}

          {/* 녹음 중일 때: 전송(중지) 버튼 */}
          {isRecording && (
            <View style={styles.recordingInputArea}>
              <Text style={styles.recordingHint}>
                탭하여 캡처 완료
              </Text>
              <TouchableOpacity
                style={[styles.sendBtn, styles.sendBtnActive]}
                onPress={onStopRecording}
              >
                <Ionicons name="checkmark" size={22} color={colors.white} />
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.bg,
    borderTopWidth: 0.5,
    borderTopColor: colors.bgInput,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: Platform.OS === 'ios' ? spacing.xl : spacing.sm,
  },
  // ── 녹음 중 바 ──────────────────────────
  recordingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginBottom: spacing.xs,
    backgroundColor: '#EF444415',
    borderRadius: borderRadius.md,
  },
  recordingLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  recordDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.error,
  },
  recordingTime: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.error,
    fontVariant: ['tabular-nums'],
  },
  recordingLabel: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
  },
  cancelBtn: {
    padding: spacing.xs,
  },
  // ── AI 처리 중 바 ───────────────────────
  processingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginBottom: spacing.xs,
    backgroundColor: `${colors.primary}15`,
    borderRadius: borderRadius.md,
  },
  processingText: {
    fontSize: fontSize.sm,
    color: colors.primaryLight,
    fontWeight: '500',
  },
  // ── 에러 바 ──────────────────────────────
  errorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginBottom: spacing.xs,
  },
  errorText: {
    fontSize: fontSize.xs,
    color: colors.error,
  },
  // ── 입력 행 ──────────────────────────────
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: colors.bgInput,
    borderRadius: borderRadius.xl,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    gap: spacing.xs,
  },
  micBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: `${colors.primary}20`,
  },
  micBtnRecording: {
    backgroundColor: colors.error,
  },
  micBtnProcessing: {
    backgroundColor: colors.bgHover,
    opacity: 0.5,
  },
  input: {
    flex: 1,
    fontSize: fontSize.md,
    color: colors.text,
    maxHeight: 100,
    paddingVertical: spacing.sm,
    lineHeight: 20,
  },
  sendBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.bgHover,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 2,
  },
  sendBtnActive: {
    backgroundColor: colors.primary,
  },
  // ── 녹음 중 입력 영역 ───────────────────
  recordingInputArea: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: spacing.sm,
  },
  recordingHint: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    flex: 1,
  },
});
