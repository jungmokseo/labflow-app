import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CaptureItem, CaptureCategory } from '../types';
import { CATEGORY_META } from '../hooks/useCapture';
import { colors, spacing, fontSize, borderRadius } from '../constants/theme';

interface Props {
  item: CaptureItem;
  onPress?: () => void;
  onDelete?: (id: string) => void;
  onReclassify?: (id: string, category: CaptureCategory) => void;
  onToggleComplete?: (id: string) => void;
}

const ALL_CATEGORIES: CaptureCategory[] = ['idea', 'task', 'memo'];

// Due date까지 남은 일수 계산
function getDueDateInfo(dateStr?: string): { label: string; color: string; urgent: boolean } | null {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dateStr);
  due.setHours(0, 0, 0, 0);
  const diff = Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  if (diff < 0) return { label: `${Math.abs(diff)}일 지남`, color: '#EF4444', urgent: true };
  if (diff === 0) return { label: '오늘', color: '#EF4444', urgent: true };
  if (diff === 1) return { label: '내일', color: '#F59E0B', urgent: true };
  if (diff <= 3) return { label: `${diff}일 남음`, color: '#F59E0B', urgent: false };
  if (diff <= 7) return { label: `${diff}일 남음`, color: '#3B82F6', urgent: false };
  return { label: dateStr, color: '#64748B', urgent: false };
}

export default function CaptureCard({ item, onPress, onDelete, onReclassify, onToggleComplete }: Props) {
  const [showActions, setShowActions] = useState(false);
  const meta = CATEGORY_META[item.category];
  const isTask = item.category === 'task';
  const isCompleted = !!item.completed;
  const dueDateInfo = getDueDateInfo(item.actionDate);

  const time = item.timestamp instanceof Date
    ? item.timestamp.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    : new Date(item.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  const date = item.timestamp instanceof Date
    ? item.timestamp.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })
    : new Date(item.timestamp).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });

  const handleLongPress = () => setShowActions(!showActions);

  const handleDelete = () => {
    Alert.alert('삭제', '이 캡처를 삭제하시겠습니까?', [
      { text: '취소', style: 'cancel' },
      { text: '삭제', style: 'destructive', onPress: () => onDelete?.(item.id) },
    ]);
  };

  const handleReclassify = (newCategory: CaptureCategory) => {
    if (newCategory !== item.category) {
      onReclassify?.(item.id, newCategory);
    }
    setShowActions(false);
  };

  const handleToggleComplete = () => {
    onToggleComplete?.(item.id);
  };

  return (
    <TouchableOpacity
      style={[styles.card, isCompleted && styles.cardCompleted]}
      onPress={onPress}
      onLongPress={handleLongPress}
      activeOpacity={0.7}
    >
      {/* 카테고리 배지 + 메타 */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          {/* 할일이면 체크박스 표시 */}
          {isTask && (
            <TouchableOpacity
              style={[styles.checkbox, isCompleted && styles.checkboxChecked]}
              onPress={handleToggleComplete}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              {isCompleted && (
                <Ionicons name="checkmark" size={14} color="white" />
              )}
            </TouchableOpacity>
          )}
          <View style={[styles.categoryBadge, { backgroundColor: meta.color + '20' }]}>
            <Ionicons name={meta.icon as any} size={13} color={meta.color} />
            <Text style={[styles.categoryLabel, { color: meta.color }]}>{meta.label}</Text>
          </View>
          {/* 우선순위 */}
          {item.priority === 'high' && !isCompleted && (
            <Ionicons name="alert-circle" size={14} color="#EF4444" />
          )}
        </View>
        <Text style={styles.time}>{date} {time}</Text>
      </View>

      {/* Due Date 바 (있으면 표시) */}
      {dueDateInfo && !isCompleted && (
        <View style={[styles.dueDateBar, { backgroundColor: dueDateInfo.color + '15' }]}>
          <Ionicons name="calendar-outline" size={13} color={dueDateInfo.color} />
          <Text style={[styles.dueDateText, { color: dueDateInfo.color }]}>
            {dueDateInfo.label}
          </Text>
          {dueDateInfo.urgent && (
            <Ionicons name="warning-outline" size={13} color={dueDateInfo.color} />
          )}
        </View>
      )}

      {/* 내용 */}
      <Text style={[styles.content, isCompleted && styles.contentCompleted]} numberOfLines={3}>
        {item.content}
      </Text>

      {/* 태그 */}
      {item.tags.length > 0 && (
        <View style={styles.tagsRow}>
          {item.tags.map((tag, idx) => (
            <View key={idx} style={[styles.tag, isCompleted && styles.tagCompleted]}>
              <Text style={[styles.tagText, isCompleted && styles.tagTextCompleted]}>#{tag}</Text>
            </View>
          ))}
        </View>
      )}

      {/* 완료 표시 */}
      {isCompleted && (
        <View style={styles.completedBanner}>
          <Ionicons name="checkmark-circle" size={14} color="#10B981" />
          <Text style={styles.completedText}>완료됨</Text>
        </View>
      )}

      {/* 액션 바 (롱프레스 시 표시) */}
      {showActions && (
        <View style={styles.actionsBar}>
          <View style={styles.reclassifyRow}>
            <Text style={styles.reclassifyLabel}>분류 변경:</Text>
            {ALL_CATEGORIES.map(cat => {
              const catMeta = CATEGORY_META[cat];
              const isActive = cat === item.category;
              return (
                <TouchableOpacity
                  key={cat}
                  style={[
                    styles.reclassifyChip,
                    isActive && { backgroundColor: catMeta.color + '30', borderColor: catMeta.color },
                  ]}
                  onPress={() => handleReclassify(cat)}
                >
                  <Ionicons name={catMeta.icon as any} size={12} color={isActive ? catMeta.color : colors.textSecondary} />
                  <Text style={[styles.reclassifyText, isActive && { color: catMeta.color }]}>
                    {catMeta.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <TouchableOpacity style={styles.deleteBtn} onPress={handleDelete}>
            <Ionicons name="trash-outline" size={16} color="#EF4444" />
            <Text style={styles.deleteText}>삭제</Text>
          </TouchableOpacity>
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    marginHorizontal: spacing.lg,
    marginVertical: spacing.xs,
    borderWidth: 1,
    borderColor: colors.bgInput,
  },
  cardCompleted: {
    opacity: 0.6,
    borderColor: '#10B98130',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  // 체크박스
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#3B82F6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: '#10B981',
    borderColor: '#10B981',
  },
  categoryBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: borderRadius.full,
    gap: 4,
  },
  categoryLabel: { fontSize: fontSize.xs, fontWeight: '700' },
  time: { fontSize: fontSize.xs, color: colors.textMuted },
  // Due Date 바
  dueDateBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: borderRadius.md,
    marginBottom: spacing.sm,
  },
  dueDateText: {
    fontSize: fontSize.xs,
    fontWeight: '700',
  },
  // 내용
  content: {
    fontSize: fontSize.md,
    color: colors.text,
    lineHeight: 22,
    marginBottom: spacing.sm,
  },
  contentCompleted: {
    textDecorationLine: 'line-through',
    color: colors.textMuted,
  },
  // 태그
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  tag: {
    backgroundColor: 'rgba(99, 102, 241, 0.15)',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
  tagCompleted: { backgroundColor: 'rgba(99, 102, 241, 0.08)' },
  tagText: { color: colors.primaryLight, fontSize: fontSize.xs, fontWeight: '500' },
  tagTextCompleted: { color: colors.textMuted },
  // 완료 배너
  completedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: '#10B98120',
  },
  completedText: {
    fontSize: fontSize.xs,
    color: '#10B981',
    fontWeight: '600',
  },
  // 액션 바
  actionsBar: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.bgInput,
  },
  reclassifyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  reclassifyLabel: { fontSize: fontSize.xs, color: colors.textMuted, marginRight: spacing.xs },
  reclassifyChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
    backgroundColor: colors.bgInput,
    borderWidth: 1,
    borderColor: 'transparent',
    gap: 3,
  },
  reclassifyText: { fontSize: fontSize.xs, color: colors.textSecondary, fontWeight: '600' },
  deleteBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-end' },
  deleteText: { fontSize: fontSize.xs, color: '#EF4444', fontWeight: '600' },
});
