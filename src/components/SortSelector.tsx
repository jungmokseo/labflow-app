import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { SortMode } from '../hooks/useCapture';
import { colors, spacing, fontSize, borderRadius } from '../constants/theme';

interface Props {
  sortMode: SortMode;
  onSortChange: (mode: SortMode) => void;
}

const SORT_OPTIONS: { key: SortMode; label: string; icon: string }[] = [
  { key: 'oldest', label: '등록순', icon: 'time-outline' },
  { key: 'dueDate', label: '마감일순', icon: 'calendar-outline' },
];

export default function SortSelector({ sortMode, onSortChange }: Props) {
  return (
    <View style={styles.container}>
      {SORT_OPTIONS.map((opt, idx) => {
        const isActive = opt.key === sortMode;
        return (
          <TouchableOpacity
            key={opt.key}
            style={[
              styles.segment,
              idx === 0 && styles.segmentLeft,
              idx === SORT_OPTIONS.length - 1 && styles.segmentRight,
              isActive && styles.segmentActive,
            ]}
            onPress={() => onSortChange(opt.key)}
            activeOpacity={0.7}
          >
            <Ionicons
              name={opt.icon as any}
              size={13}
              color={isActive ? colors.primaryLight : colors.textMuted}
            />
            <Text style={[styles.segmentText, isActive && styles.segmentTextActive]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.bgInput,
    overflow: 'hidden',
  },
  segment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  segmentLeft: {
    borderRightWidth: 1,
    borderRightColor: colors.bgInput,
  },
  segmentRight: {},
  segmentActive: {
    backgroundColor: colors.primary + '20',
  },
  segmentText: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    fontWeight: '500',
  },
  segmentTextActive: {
    color: colors.primaryLight,
    fontWeight: '700',
  },
});
