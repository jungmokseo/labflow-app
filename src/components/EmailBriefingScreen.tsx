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
  Modal,
  TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../constants/theme';
import {
  checkEmailStatus,
  getEmailAuthUrl,
  getEmailBriefing,
  getEmailBriefingHistory,
  initEmailProfile,
  EmailBriefingItem,
  EmailBriefingMeta,
  EmailBriefingHistoryEntry,
  translateEmail,
  createEmailDraft,
  extractEmailActions,
  createCalendarEvent,
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

  // 브리핑 히스토리
  const [history, setHistory] = useState<EmailBriefingHistoryEntry[]>([]);
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);

  // 이메일 상세 모달
  const [selectedEmail, setSelectedEmail] = useState<EmailBriefingItem | null>(null);
  const [translatedText, setTranslatedText] = useState<string | null>(null);
  const [isTranslating, setIsTranslating] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractedActions, setExtractedActions] = useState<any | null>(null);
  const [draftBody, setDraftBody] = useState('');
  const [isDrafting, setIsDrafting] = useState(false);
  const [showDraftInput, setShowDraftInput] = useState(false);

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
        try { await initEmailProfile(); } catch { /* ignore */ }
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
      // 히스토리 로드
      try {
        const historyRes = await getEmailBriefingHistory(30, 20);
        setHistory(historyRes.data);
      } catch { /* 히스토리 실패는 무시 */ }
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

  // ── 이메일 상세 모달 열기 ─────────────────────────────
  const openEmailDetail = (email: EmailBriefingItem) => {
    setSelectedEmail(email);
    setTranslatedText(null);
    setExtractedActions(null);
    setShowDraftInput(false);
    setDraftBody('');
  };

  const closeEmailDetail = () => {
    setSelectedEmail(null);
    setTranslatedText(null);
    setExtractedActions(null);
    setShowDraftInput(false);
    setDraftBody('');
  };

  // ── 번역 ─────────────────────────────────────────────
  const handleTranslate = async () => {
    if (!selectedEmail) return;
    setIsTranslating(true);
    try {
      const result = await translateEmail(
        `${selectedEmail.subject}\n\n${selectedEmail.summary}`,
        'ko',
      );
      setTranslatedText(result.translated);
    } catch (err: any) {
      Alert.alert('번역 실패', err.message);
    } finally {
      setIsTranslating(false);
    }
  };

  // ── 할일/일정 추출 ───────────────────────────────────
  const handleExtractActions = async () => {
    if (!selectedEmail) return;
    setIsExtracting(true);
    try {
      const result = await extractEmailActions({
        subject: selectedEmail.subject,
        body: selectedEmail.summary,
        sender: selectedEmail.sender,
      });
      setExtractedActions(result);
      if (result.captures?.length > 0) {
        Alert.alert('Capture 저장 완료', `${result.captures.length}건이 Capture에 추가되었습니다`);
      }
    } catch (err: any) {
      Alert.alert('추출 실패', err.message);
    } finally {
      setIsExtracting(false);
    }
  };

  // ── 일정 등록 ────────────────────────────────────────
  const handleCreateEvent = async (event: any) => {
    try {
      const result = await createCalendarEvent({
        title: event.title,
        date: event.date,
        time: event.time,
        description: event.description,
      });
      Alert.alert('일정 등록 완료', result.message);
    } catch (err: any) {
      Alert.alert('일정 등록 실패', err.message);
    }
  };

  // ── 답장 초안 ────────────────────────────────────────
  const handleDraft = async () => {
    if (!selectedEmail || !draftBody.trim()) return;
    setIsDrafting(true);
    try {
      const result = await createEmailDraft({
        to: selectedEmail.sender,
        subject: `Re: ${selectedEmail.subject}`,
        body: draftBody,
        threadId: selectedEmail.threadId,
      });
      Alert.alert('임시보관함 저장', result.message);
      setShowDraftInput(false);
      setDraftBody('');
    } catch (err: any) {
      Alert.alert('초안 생성 실패', err.message);
    } finally {
      setIsDrafting(false);
    }
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
    <>
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
                      <TouchableOpacity
                        key={email.messageId}
                        style={styles.emailItem}
                        onPress={() => openEmailDetail(email)}
                        activeOpacity={0.7}
                      >
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
                      </TouchableOpacity>
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

          {/* 이전 브리핑 히스토리 (토글) */}
          {history.length > 0 && (
            <View style={styles.historySection}>
              <Text style={styles.historySectionTitle}>이전 브리핑</Text>
              {history.map((entry) => (
                <View key={entry.id} style={styles.historyCard}>
                  <TouchableOpacity
                    style={styles.historyHeader}
                    onPress={() => setExpandedHistoryId(
                      expandedHistoryId === entry.id ? null : entry.id
                    )}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name={expandedHistoryId === entry.id ? 'chevron-down' : 'chevron-forward'}
                      size={16}
                      color={colors.textMuted}
                    />
                    <View style={{ flex: 1, marginLeft: spacing.sm }}>
                      <Text style={styles.historyTitle}>{entry.title}</Text>
                      <Text style={styles.historyDate}>
                        {new Date(entry.time).toLocaleString('ko-KR', {
                          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                        })}
                      </Text>
                    </View>
                    <View style={styles.historyBadges}>
                      {entry.meta?.categories?.urgent ? (
                        <Text style={[styles.historyBadge, { color: '#EF4444' }]}>⚠️{entry.meta.categories.urgent}</Text>
                      ) : null}
                      {entry.meta?.categories?.['action-needed'] ? (
                        <Text style={[styles.historyBadge, { color: '#F59E0B' }]}>📝{entry.meta.categories['action-needed']}</Text>
                      ) : null}
                      <Text style={styles.historyCount}>{entry.meta?.total || entry.briefings?.length || 0}건</Text>
                    </View>
                  </TouchableOpacity>
                  {expandedHistoryId === entry.id && entry.briefings?.length > 0 && (
                    <View style={styles.historyBody}>
                      {entry.briefings.map((email, i) => (
                        <TouchableOpacity
                          key={email.messageId || i}
                          style={styles.historyEmailItem}
                          onPress={() => openEmailDetail(email)}
                          activeOpacity={0.7}
                        >
                          <Text style={styles.historyEmailCategory}>
                            {CATEGORY_META[email.category]?.icon || '📧'}
                          </Text>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.historyEmailSender} numberOfLines={1}>
                              {email.groupEmoji ? `${email.groupEmoji} ` : ''}{email.senderName || email.sender}
                            </Text>
                            <Text style={styles.historyEmailSubject} numberOfLines={1}>{email.subject}</Text>
                            <Text style={styles.historyEmailSummary} numberOfLines={1}>{email.summary}</Text>
                          </View>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                </View>
              ))}
            </View>
          )}
        </View>
      )}
    </ScrollView>

    {/* ── 이메일 상세 모달 ────────────────────────────── */}
    <Modal
      visible={!!selectedEmail}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={closeEmailDetail}
    >
      <View style={styles.modalContainer}>
        {/* 모달 헤더 */}
        <View style={styles.modalHeader}>
          <TouchableOpacity onPress={closeEmailDetail} style={styles.modalCloseBtn}>
            <Ionicons name="close" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.modalTitle} numberOfLines={1}>이메일 상세</Text>
          <View style={{ width: 36 }} />
        </View>

        <ScrollView style={styles.modalBody} contentContainerStyle={{ paddingBottom: 40 }}>
          {selectedEmail && (
            <>
              {/* 이메일 정보 */}
              <Text style={styles.detailSubject}>{selectedEmail.subject}</Text>
              <View style={styles.detailMeta}>
                <Text style={styles.detailSender}>
                  {selectedEmail.senderName || selectedEmail.sender}
                </Text>
                <Text style={styles.detailDate}>{formatDate(selectedEmail.date)}</Text>
              </View>
              <Text style={styles.detailSummary}>{selectedEmail.summary}</Text>

              {/* 액션 버튼들 */}
              <View style={styles.actionButtons}>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: '#3B82F620' }]}
                  onPress={handleTranslate}
                  disabled={isTranslating}
                >
                  {isTranslating ? (
                    <ActivityIndicator size="small" color="#3B82F6" />
                  ) : (
                    <Ionicons name="language" size={18} color="#3B82F6" />
                  )}
                  <Text style={[styles.actionBtnText, { color: '#3B82F6' }]}>번역</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: '#F59E0B20' }]}
                  onPress={handleExtractActions}
                  disabled={isExtracting}
                >
                  {isExtracting ? (
                    <ActivityIndicator size="small" color="#F59E0B" />
                  ) : (
                    <Ionicons name="flash" size={18} color="#F59E0B" />
                  )}
                  <Text style={[styles.actionBtnText, { color: '#F59E0B' }]}>할일 추출</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: '#10B98120' }]}
                  onPress={() => setShowDraftInput(!showDraftInput)}
                >
                  <Ionicons name="create" size={18} color="#10B981" />
                  <Text style={[styles.actionBtnText, { color: '#10B981' }]}>답장</Text>
                </TouchableOpacity>
              </View>

              {/* 번역 결과 */}
              {translatedText && (
                <View style={styles.resultCard}>
                  <Text style={styles.resultLabel}>번역 결과</Text>
                  <Text style={styles.resultText}>{translatedText}</Text>
                </View>
              )}

              {/* 추출된 할일/일정 */}
              {extractedActions && (
                <View style={styles.resultCard}>
                  <Text style={styles.resultLabel}>추출된 항목</Text>
                  {extractedActions.tasks?.length > 0 && (
                    <View style={{ marginBottom: spacing.md }}>
                      <Text style={styles.resultSubLabel}>할일</Text>
                      {extractedActions.tasks.map((t: any, i: number) => (
                        <Text key={i} style={styles.resultText}>
                          {t.priority === 'high' ? '🔴' : t.priority === 'medium' ? '🟡' : '🟢'}{' '}
                          {t.title}
                          {t.dueDate ? ` (${t.dueDate})` : ''}
                        </Text>
                      ))}
                    </View>
                  )}
                  {extractedActions.events?.length > 0 && (
                    <View>
                      <Text style={styles.resultSubLabel}>일정</Text>
                      {extractedActions.events.map((e: any, i: number) => (
                        <View key={i} style={styles.eventRow}>
                          <Text style={styles.resultText}>
                            📅 {e.title} — {e.date} {e.time || ''}
                          </Text>
                          <TouchableOpacity
                            style={styles.eventAddBtn}
                            onPress={() => handleCreateEvent(e)}
                          >
                            <Text style={styles.eventAddBtnText}>캘린더 추가</Text>
                          </TouchableOpacity>
                        </View>
                      ))}
                    </View>
                  )}
                  {(!extractedActions.tasks?.length && !extractedActions.events?.length) && (
                    <Text style={styles.resultText}>추출된 항목이 없습니다</Text>
                  )}
                </View>
              )}

              {/* 답장 초안 입력 */}
              {showDraftInput && (
                <View style={styles.resultCard}>
                  <Text style={styles.resultLabel}>답장 초안</Text>
                  <Text style={styles.draftTo}>To: {selectedEmail.sender}</Text>
                  <TextInput
                    style={styles.draftInput}
                    multiline
                    placeholder="답장 내용을 입력하세요..."
                    placeholderTextColor={colors.textMuted}
                    value={draftBody}
                    onChangeText={setDraftBody}
                    textAlignVertical="top"
                  />
                  <TouchableOpacity
                    style={[styles.draftSendBtn, !draftBody.trim() && { opacity: 0.5 }]}
                    onPress={handleDraft}
                    disabled={isDrafting || !draftBody.trim()}
                  >
                    {isDrafting ? (
                      <ActivityIndicator size="small" color="white" />
                    ) : (
                      <Text style={styles.draftSendBtnText}>임시보관함에 저장</Text>
                    )}
                  </TouchableOpacity>
                </View>
              )}
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
    </>
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

  // ── 모달 ────────────────────────────────────────
  modalContainer: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.bgInput,
  },
  modalCloseBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalTitle: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.text,
  },
  modalBody: {
    flex: 1,
    padding: spacing.lg,
  },
  detailSubject: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.sm,
  },
  detailMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  detailSender: {
    fontSize: fontSize.sm,
    color: colors.primaryLight,
    fontWeight: '600',
  },
  detailDate: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
  detailSummary: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    lineHeight: 24,
    marginBottom: spacing.xl,
  },

  // ── 액션 버튼 ──────────────────────────────────
  actionButtons: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.md,
  },
  actionBtnText: {
    fontSize: fontSize.sm,
    fontWeight: '600',
  },

  // ── 결과 카드 ──────────────────────────────────
  resultCard: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.bgInput,
  },
  resultLabel: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.primaryLight,
    marginBottom: spacing.sm,
  },
  resultSubLabel: {
    fontSize: fontSize.xs,
    fontWeight: '600',
    color: colors.textMuted,
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  resultText: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    lineHeight: 22,
    marginBottom: 4,
  },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  eventAddBtn: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: borderRadius.sm,
    marginLeft: spacing.sm,
  },
  eventAddBtnText: {
    fontSize: fontSize.xs,
    color: 'white',
    fontWeight: '600',
  },

  // ── 답장 초안 ──────────────────────────────────
  draftTo: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  draftInput: {
    backgroundColor: colors.bgInput,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    fontSize: fontSize.sm,
    color: colors.text,
    minHeight: 120,
    marginBottom: spacing.md,
  },
  draftSendBtn: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.md,
    alignItems: 'center',
  },
  draftSendBtnText: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: 'white',
  },

  // ── 브리핑 히스토리 ────────────────────────────
  historySection: {
    marginTop: spacing.xl,
    borderTopWidth: 1,
    borderTopColor: colors.bgInput,
    paddingTop: spacing.lg,
  },
  historySectionTitle: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.md,
  },
  historyCard: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.bgInput,
    overflow: 'hidden',
  },
  historyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
  },
  historyTitle: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.text,
  },
  historyDate: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: 1,
  },
  historyBadges: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  historyBadge: {
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  historyCount: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
  historyBody: {
    borderTopWidth: 1,
    borderTopColor: colors.bgInput,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  historyEmailItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: spacing.xs,
    gap: spacing.sm,
  },
  historyEmailCategory: {
    fontSize: 14,
    marginTop: 2,
  },
  historyEmailSender: {
    fontSize: fontSize.xs,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  historyEmailSubject: {
    fontSize: fontSize.xs,
    color: colors.text,
  },
  historyEmailSummary: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
});
