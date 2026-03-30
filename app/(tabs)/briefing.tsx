/**
 * Briefing Screen — 모닝 브리핑
 *
 * 매일 아침 확인할 항목을 우선순위별로 표시.
 * 긴급 → 확인 필요 → 참고 순서.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../../src/constants/theme';

const API_BASE = __DEV__
  ? 'http://localhost:3001'
  : 'https://labflow-app-production.up.railway.app';

interface BriefingItem {
  type: 'email' | 'paper' | 'capture' | 'meeting';
  id: string;
  priority: 'urgent' | 'important' | 'info';
  title: string;
  summary: string;
}

interface BriefingData {
  date: string;
  urgent: BriefingItem[];
  important: BriefingItem[];
  info: BriefingItem[];
  stats: {
    totalEmails: number;
    newPapers: number;
    pendingCaptures: number;
    upcomingMeetings: number;
  };
}

const ICON_MAP: Record<string, keyof typeof Ionicons.glyphMap> = {
  email: 'mail-outline',
  paper: 'document-text-outline',
  capture: 'flash-outline',
  meeting: 'calendar-outline',
};

const PRIORITY_COLORS = {
  urgent: colors.error,
  important: colors.warning,
  info: colors.textMuted,
};

const PRIORITY_LABELS = {
  urgent: '긴급',
  important: '확인 필요',
  info: '참고',
};

export default function BriefingScreen() {
  const [briefing, setBriefing] = useState<BriefingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBriefing = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch(`${API_BASE}/api/briefing`, {
        headers: {
          'Content-Type': 'application/json',
          'X-Dev-User-Id': 'dev-user-seo',
        },
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setBriefing(data);
    } catch (err: any) {
      setError(err.message || '브리핑을 불러올 수 없습니다');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchBriefing();
  }, [fetchBriefing]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchBriefing();
  }, [fetchBriefing]);

  const sendFeedback = async (item: BriefingItem, action: 'clicked' | 'skipped') => {
    try {
      await fetch(`${API_BASE}/api/briefing/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Dev-User-Id': 'dev-user-seo',
        },
        body: JSON.stringify({
          briefingDate: briefing?.date || new Date().toISOString().split('T')[0],
          itemType: item.type,
          itemId: item.id,
          action,
        }),
      });
    } catch {
      // 피드백 실패는 무시
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>브리핑 준비 중...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Ionicons name="cloud-offline-outline" size={48} color={colors.textMuted} />
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={fetchBriefing}>
          <Text style={styles.retryText}>다시 시도</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isEmpty = briefing &&
    briefing.urgent.length === 0 &&
    briefing.important.length === 0 &&
    briefing.info.length === 0;

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
    >
      {/* 날짜 헤더 */}
      <View style={styles.header}>
        <Text style={styles.dateText}>
          {new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' })}
        </Text>
        <Text style={styles.greeting}>오늘의 브리핑</Text>
      </View>

      {/* 통계 카드 */}
      {briefing && (
        <View style={styles.statsRow}>
          <StatCard icon="mail-outline" label="이메일" count={briefing.stats.totalEmails} color={colors.email} />
          <StatCard icon="document-text-outline" label="논문" count={briefing.stats.newPapers} color={colors.primary} />
          <StatCard icon="flash-outline" label="태스크" count={briefing.stats.pendingCaptures} color={colors.idea} />
          <StatCard icon="calendar-outline" label="미팅" count={briefing.stats.upcomingMeetings} color={colors.meeting} />
        </View>
      )}

      {/* 빈 상태 */}
      {isEmpty && (
        <View style={styles.emptyState}>
          <Ionicons name="checkmark-circle-outline" size={64} color={colors.success} />
          <Text style={styles.emptyTitle}>오늘은 여유로운 하루!</Text>
          <Text style={styles.emptySubtitle}>확인할 사항이 없습니다</Text>
        </View>
      )}

      {/* 긴급 */}
      {briefing && briefing.urgent.length > 0 && (
        <BriefingSection
          title={`${PRIORITY_LABELS.urgent} (${briefing.urgent.length})`}
          items={briefing.urgent}
          color={PRIORITY_COLORS.urgent}
          onPress={(item) => sendFeedback(item, 'clicked')}
        />
      )}

      {/* 확인 필요 */}
      {briefing && briefing.important.length > 0 && (
        <BriefingSection
          title={`${PRIORITY_LABELS.important} (${briefing.important.length})`}
          items={briefing.important}
          color={PRIORITY_COLORS.important}
          onPress={(item) => sendFeedback(item, 'clicked')}
        />
      )}

      {/* 참고 */}
      {briefing && briefing.info.length > 0 && (
        <BriefingSection
          title={`${PRIORITY_LABELS.info} (${briefing.info.length})`}
          items={briefing.info}
          color={PRIORITY_COLORS.info}
          onPress={(item) => sendFeedback(item, 'clicked')}
        />
      )}

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

// ── 통계 카드 컴포넌트 ──────────────────────────
function StatCard({ icon, label, count, color }: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  count: number;
  color: string;
}) {
  return (
    <View style={styles.statCard}>
      <Ionicons name={icon} size={20} color={color} />
      <Text style={[styles.statCount, { color }]}>{count}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ── 브리핑 섹션 컴포넌트 ──────────────────────────
function BriefingSection({ title, items, color, onPress }: {
  title: string;
  items: BriefingItem[];
  color: string;
  onPress: (item: BriefingItem) => void;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View style={[styles.priorityDot, { backgroundColor: color }]} />
        <Text style={styles.sectionTitle}>{title}</Text>
      </View>
      {items.map((item) => (
        <TouchableOpacity
          key={item.id}
          style={styles.itemCard}
          onPress={() => onPress(item)}
          activeOpacity={0.7}
        >
          <Ionicons
            name={ICON_MAP[item.type] || 'ellipse-outline'}
            size={20}
            color={color}
            style={{ marginRight: spacing.sm }}
          />
          <View style={{ flex: 1 }}>
            <Text style={styles.itemTitle} numberOfLines={1}>{item.title}</Text>
            <Text style={styles.itemSummary} numberOfLines={1}>{item.summary}</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ── Styles ──────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  loadingText: { color: colors.textSecondary, marginTop: spacing.md, fontSize: fontSize.md },
  errorText: { color: colors.textSecondary, marginTop: spacing.md, fontSize: fontSize.md, textAlign: 'center' },
  retryBtn: { marginTop: spacing.lg, paddingHorizontal: spacing.xl, paddingVertical: spacing.sm, backgroundColor: colors.primary, borderRadius: borderRadius.sm },
  retryText: { color: colors.white, fontSize: fontSize.md, fontWeight: '600' },

  header: { paddingHorizontal: spacing.xl, paddingTop: spacing.xl, paddingBottom: spacing.md },
  dateText: { color: colors.textSecondary, fontSize: fontSize.sm },
  greeting: { color: colors.text, fontSize: fontSize.xxl, fontWeight: '700', marginTop: spacing.xs },

  statsRow: { flexDirection: 'row', paddingHorizontal: spacing.lg, marginBottom: spacing.lg },
  statCard: { flex: 1, backgroundColor: colors.bgCard, borderRadius: borderRadius.md, padding: spacing.md, alignItems: 'center', marginHorizontal: spacing.xs },
  statCount: { fontSize: fontSize.xl, fontWeight: '700', marginTop: spacing.xs },
  statLabel: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 2 },

  emptyState: { alignItems: 'center', paddingVertical: spacing.xxl * 2 },
  emptyTitle: { color: colors.text, fontSize: fontSize.lg, fontWeight: '600', marginTop: spacing.lg },
  emptySubtitle: { color: colors.textSecondary, fontSize: fontSize.md, marginTop: spacing.xs },

  section: { paddingHorizontal: spacing.xl, marginBottom: spacing.lg },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  priorityDot: { width: 8, height: 8, borderRadius: 4, marginRight: spacing.sm },
  sectionTitle: { color: colors.text, fontSize: fontSize.md, fontWeight: '600' },

  itemCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.md,
    padding: spacing.lg,
    marginBottom: spacing.sm,
  },
  itemTitle: { color: colors.text, fontSize: fontSize.md, fontWeight: '500' },
  itemSummary: { color: colors.textSecondary, fontSize: fontSize.sm, marginTop: 2 },
});
