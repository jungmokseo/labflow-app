import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Linking,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../constants/theme';
import {
  checkEmailStatus,
  getEmailAuthUrl,
  getEmailBriefing,
  EmailBriefingItem,
  EmailBriefingMeta,
} from '../services/api-client';

// ── 카테고리 메타데이터 ──────────────────────────────
const CATEGORY_META: Record<string, { icon: string; label: string; color: string }> = {
  urgent:          { icon: '🔴', label: '긴급 / 즉시 대응', color: '#EF4444' },
  'action-needed': { icon: '🟡', label: '대응 필요',        color: '#F59E0B' },
  schedule:        { icon: '📅', label: '일정 관련',        color: '#3B82F6' },
  info:            { icon: '📋', label: '정보성 / 공지',    color: '#10B981' },
  ads:             { icon: '📢', label: '광고 / 뉴스레터',  color: '#6B7280' },
};

const CATEGORY_ORDER = ['urgent', 'action-needed', 'schedule', 'info', 'ads'];

export default function EmailBriefingScreen() {
  const [isConnected, setIsConnected] = useState(false);
  const [isCheckingStatus, setIsCheckingStatus] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isLoadingBriefing, setIsLoadingBriefing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 브리핑 데이터
  const [emails, setEmails] = useState<EmailBriefingItem[]>([]);
  const [meta, setMeta] = useState<EmailBriefingMeta | null>(null);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

  // ── 초기 상태 체크 ──────────────────────────────────
  useEffect(() => {
    checkConnection();
  }, []);

  const checkConnection = useCallback(async () => {
    setIsCheckingStatus(true);
    setError(null);
    try {
      const status = await checkEmailStatus();
      setIsConnected(status.connected);
      if (status.connected) {
        await loadBriefing();
      }
    } catch (err: any) {
      console.warn('Email status check failed:', err.message);
      setIsConnected(false);
    } finally {
      setIsCheckingStatus(false);
    }
  }, []);

  // ── 브리핑 로드 ──────────────────────────────────────
  const loadBriefing = useCallback(async () => {
    setIsLoadingBriefing(true);
    setError(null);
    try {
      const result = await getEmailBriefing({ maxResults: 20 });
      setEmails(result.items);
      setMeta(result.meta);
      // 긴급 카테고리가 있으면 자동 펼치기
      if (result.meta.categories.urgent > 0) {
        setExpandedCategory('urgent');
      } else if (result.meta.categories['action-needed'] > 0) {
        setExpandedCategory('action-needed');
      }
    } catch (err: any) {
      if (err.message?.includes('연동되지') || err.message?.includes('401')) {
        setIsConnected(false);
      } else {
        setError(err.message || '이메일 브리핑을 불러오지 못했습니다');
      }
    } finally {
      setIsLoadingBriefing(false);
    }
  }, []);

  // ── Pull-to-Refresh ──────────────────────────────────
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    if (isConnected) {
      await loadBriefing();
    } else {
      await checkConnection();
    }
    setRefreshing(false);
  }, [isConnected, loadBriefing, checkConnection]);

  // ── Gmail OAuth 연결 ─────────────────────────────────
  const handleConnect = async () => {
    setIsConnecting(true);
    setError(null);
    try {
      const authUrl = await getEmailAuthUrl();
      if (authUrl) {
        await Linking.openURL(authUrl);
        // OAuth 완료 후 유저가 돌아오면 연결 상태 재확인
        // Expo deep link 또는 수동 새로고침으로 처리
        Alert.alert(
          'Gmail 인증',
          'Google 로그인 후 앱으로 돌아와 아래로 당겨서 새로고침해주세요.',
          [{ text: '확인' }],
        );
      }
    } catch (err: any) {
      setError('Gmail 연결 URL을 가져오지 못했습니다');
    } finally {
      setIsConnecting(false);
    }
  };

  // ── Gmail 연결 해제 ──────────────────────────────────
  const handleDisconnect = () => {
    Alert.alert(
      'Gmail 연결 해제',
      '이메일 브리핑을 더 이상 받을 수 없습니다.\n정말 해제하시겠습니까?',
      [
        { text: '취소', style: 'cancel' },
        {
          text: '해제',
          style: 'destructive',
          onPress: () => {
            setIsConnected(false);
            setEmails([]);
            setMeta(null);
          },
        },
      ],
    );
  };

  // ── 카테고리별 이메일 그룹핑 ──────────────────────────
  const groupedEmails = CATEGORY_ORDER.map((catKey) => ({
    key: catKey,
    ...CATEGORY_META[catKey],
    count: meta?.categories[catKey as keyof EmailBriefingMeta['categories']] ?? 0,
    items: emails.filter((e) => e.category === catKey),
  }));

  // ── 시간 포맷 ──────────────────────────────────────
  const formatDate = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      const now = new Date();
      const diffMs = now.getTime() - d.getTime();
      const diffMin = Math.floor(diffMs / 60000);
      if (diffMin < 60) return `${diffMin}분 전`;
      const diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) return `${diffHr}시간 전`;
      const diffDay = Math.floor(diffHr / 24);
      if (diffDay < 7) return `${diffDay}일 전`;
      return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  };

  // ── 로딩 스피너 (초기 상태 체크) ──────────────────────
  if (isCheckingStatus) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>이메일 상태 확인 중...</Text>
      </View>
    );
  }

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
      {!isConnected ? (
        // ── 미연결 상태 ──────────────────────────────
        <View style={styles.connectCard}>
          <Text style={styles.connectEmoji}>✉️</Text>
          <Text style={styles.connectTitle}>이메일 브리핑</Text>
          <Text style={styles.connectDesc}>
            Gmail 계정을 연결하면{'\n'}
            AI가 매일 이메일을 분류하고 요약합니다
          </Text>

          <View style={styles.featureList}>
            <FeatureItem icon="flash" text="5단계 자동 분류 (긴급/대응필요/일정/정보/광고)" />
            <FeatureItem icon="alert-circle" text="긴급 메일 우선 하이라이트" />
            <FeatureItem icon="calendar" text="일정 관련 메일 자동 감지" />
            <FeatureItem icon="document-text" text="AI 한줄 요약으로 빠른 확인" />
          </View>

          <TouchableOpacity
            style={styles.connectBtn}
            onPress={handleConnect}
            disabled={isConnecting}
          >
            {isConnecting ? (
              <ActivityIndicator color="white" size="small" />
            ) : (
              <>
                <Ionicons name="logo-google" size={20} color="white" />
                <Text style={styles.connectBtnText}>Gmail 연결하기</Text>
              </>
            )}
          </TouchableOpacity>

          <Text style={styles.connectNote}>
            연세대 / 링크솔루텍 / 개인 계정 통합 지원
          </Text>

          {error && (
            <Text style={styles.errorText}>{error}</Text>
          )}
        </View>
      ) : (
        // ── 연결된 상태 — 브리핑 대시보드 ────────────────
        <View>
          {/* 헤더 */}
          <View style={styles.briefingHeader}>
            <View>
              <Text style={styles.briefingTitle}>오늘의 이메일 브리핑</Text>
              <Text style={styles.briefingSubtitle}>
                {meta ? `총 ${meta.total}건 분석 완료` : '로딩 중...'}
              </Text>
            </View>
            <View style={styles.headerActions}>
              <TouchableOpacity
                style={styles.refreshBtn}
                onPress={loadBriefing}
                disabled={isLoadingBriefing}
              >
                {isLoadingBriefing ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <Ionicons name="refresh" size={20} color={colors.primaryLight} />
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.settingsBtn}
                onPress={handleDisconnect}
              >
                <Ionicons name="settings-outline" size={20} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
          </View>

          {/* 에러 */}
          {error && (
            <View style={styles.errorCard}>
              <Ionicons name="warning" size={16} color={colors.error} />
              <Text style={styles.errorCardText}>{error}</Text>
            </View>
          )}

          {/* 카테고리별 카드 */}
          {groupedEmails.map((group) => (
            <TouchableOpacity
              key={group.key}
              style={styles.categoryCard}
              onPress={() =>
                setExpandedCategory(expandedCategory === group.key ? null : group.key)
              }
              activeOpacity={0.7}
            >
              {/* 카테고리 헤더 */}
              <View style={styles.categoryHeader}>
                <Text style={styles.categoryIcon}>{group.icon}</Text>
                <Text style={styles.categoryLabel}>{group.label}</Text>
                <View style={[styles.countBadge, { backgroundColor: group.color + '20' }]}>
                  <Text style={[styles.countText, { color: group.color }]}>
                    {group.count}
                  </Text>
                </View>
                <Ionicons
                  name={expandedCategory === group.key ? 'chevron-up' : 'chevron-down'}
                  size={16}
                  color={colors.textMuted}
                  style={{ marginLeft: 4 }}
                />
              </View>

              {/* 확장된 이메일 목록 */}
              {expandedCategory === group.key && (
                <View style={styles.emailList}>
                  {group.items.length === 0 ? (
                    <Text style={styles.emptyCategory}>새 메일 없음</Text>
                  ) : (
                    group.items.map((email) => (
                      <View key={email.messageId} style={styles.emailItem}>
                        <View style={styles.emailTop}>
                          <Text style={styles.emailSender} numberOfLines={1}>
                            {email.senderName || email.sender}
                          </Text>
                          <Text style={styles.emailDate}>
                            {formatDate(email.date)}
                          </Text>
                        </View>
                        <Text style={styles.emailSubject} numberOfLines={1}>
                          {email.subject}
                        </Text>
                        <Text style={styles.emailSummary} numberOfLines={2}>
                          {email.summary}
                        </Text>
                      </View>
                    ))
                  )}
                </View>
              )}
            </TouchableOpacity>
          ))}

          {/* 로딩 오버레이 */}
          {isLoadingBriefing && emails.length === 0 && (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={styles.loadingText}>
                AI가 이메일을 분석하고 있습니다...
              </Text>
              <Text style={styles.loadingSubtext}>
                처음 로딩 시 30초 정도 걸릴 수 있습니다
              </Text>
            </View>
          )}
        </View>
      )}
    </ScrollView>
  );
}

// ── 하위 컴포넌트 ──────────────────────────────────────
function FeatureItem({ icon, text }: { icon: string; text: string }) {
  return (
    <View style={styles.featureItem}>
      <Ionicons name={icon as any} size={18} color={colors.primaryLight} />
      <Text style={styles.featureText}>{text}</Text>
    </View>
  );
}

// ── 스타일 ──────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    padding: spacing.lg,
  },
  loadingText: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    marginTop: spacing.md,
  },
  loadingSubtext: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },

  // ── 미연결 상태 ────────────────────────────────
  connectCard: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.xl,
    padding: spacing.xxl,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.bgInput,
  },
  connectEmoji: {
    fontSize: 56,
    marginBottom: spacing.lg,
  },
  connectTitle: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.sm,
  },
  connectDesc: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: spacing.xl,
  },
  featureList: {
    width: '100%',
    gap: spacing.md,
    marginBottom: spacing.xl,
  },
  featureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  featureText: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    flex: 1,
  },
  connectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.lg,
    marginBottom: spacing.md,
  },
  connectBtnText: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: 'white',
  },
  connectNote: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
  errorText: {
    fontSize: fontSize.xs,
    color: colors.error,
    marginTop: spacing.md,
    textAlign: 'center',
  },

  // ── 브리핑 대시보드 ────────────────────────────
  briefingHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: spacing.lg,
  },
  briefingTitle: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.text,
  },
  briefingSubtitle: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: 2,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  refreshBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.bgCard,
    alignItems: 'center',
    justifyContent: 'center',
  },
  settingsBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.bgCard,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── 에러 카드 ──────────────────────────────────
  errorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: '#EF444410',
    borderRadius: borderRadius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: '#EF444430',
  },
  errorCardText: {
    fontSize: fontSize.sm,
    color: colors.error,
    flex: 1,
  },

  // ── 카테고리 카드 ──────────────────────────────
  categoryCard: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.bgInput,
  },
  categoryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  categoryIcon: {
    fontSize: 18,
  },
  categoryLabel: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.text,
    flex: 1,
  },
  countBadge: {
    minWidth: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  countText: {
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  emptyCategory: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: spacing.md,
    textAlign: 'center',
  },

  // ── 이메일 리스트 ──────────────────────────────
  emailList: {
    marginTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.bgInput,
    paddingTop: spacing.md,
  },
  emailItem: {
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgInput + '60',
  },
  emailTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  emailSender: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.text,
    flex: 1,
    marginRight: spacing.sm,
  },
  emailDate: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
  emailSubject: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginBottom: 2,
  },
  emailSummary: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    lineHeight: 16,
  },

  // ── 로딩 오버레이 ──────────────────────────────
  loadingOverlay: {
    alignItems: 'center',
    paddingVertical: spacing.xxl,
  },
});
