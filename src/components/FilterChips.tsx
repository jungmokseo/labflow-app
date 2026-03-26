import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CaptureCategory } from '../types';
import { colors, spacing, fontSize, borderRadius } from '../constants/theme';

interface FilterOption {
  key: CaptureCategory | 'all';
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  count: number;
}

interface Props {
  filter: CaptureCategory | 'all';
  onFilterChange: (filter: CaptureCategory | 'all') => void;
  counts: { all: number; idea: number; task: number; memo: number };
}

export default function FilterChips({ filter, onFilterChange, counts }: Props) {
  const options: FilterOption[] = [
    { key: 'all', label: '전체', icon: 'layers-outline', count: counts.all },
    { key: 'idea', label: '아이디어', icon: 'bulb-outline', count: counts.idea },
    { key: 'task', label: '할일', icon: 'checkmark-circle-outline', count: counts.task },
    { key: 'memo', label: '메모', icon: 'document-text-outline', count: counts.memo },
  ];

  return (
    <View style={styles.container}>
      {options.map((opt) => {
        const isActive = filter === opt.key;
        return (
          <TouchableOpacity
            key={opt.key}
            style={[styles.chip, isActive && styles.chipActive]}
            onPress={() => onFilterChange(opt.key)}
            activeOpacity={0.7}
          >
            <Ionicons
              name={isActive ? (opt.icon.replace('-outline', '') as any) : opt.icon}
              size={14}
              color={isActive ? colors.primaryLight : colors.textSecondary}
            />
            <Text style={[styles.chipLabel, isActive && styles.chipLabelActive]}>
              {opt.label}
            </Text>
            {opt.count > 0 && (
              <View style={[styles.countBadge, isActive && styles.countBadgeActive]}>
                <Text style={[styles.countText, isActive && styles.countTextActive]}>
                  {opt.count}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  chip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    backgroundColor: colors.bgCard,
    borderWidth: 1,
    borderColor: colors.bgInput,
    gap: 5,
  },
  chipActive: {
    backgroundColor: colors.primary + '20',
    borderColor: colors.primary,
  },
  chipLabel: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    fontWeight: '500',
  },
  chipLabelActive: {
    color: colors.primaryLight,
    fontWeight: '700',
  },
  countBadge: {
    backgroundColor: colors.bgInput,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  countBadgeActive: {
    backgroundColor: colors.primary + '40',
  },
  countText: {
    fontSize: 10,
    color: colors.textMuted,
    fontWeight: '700',
  },
  countTextActive: {
    color: colors.primaryLight,
  },
});
