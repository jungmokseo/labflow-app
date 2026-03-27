import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ScrollView,
  ActivityIndicator,
  Alert,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, borderRadius } from '../../src/constants/theme';

const API_BASE = __DEV__
  ? 'http://localhost:3001'
  : 'https://labflow-api.onrender.com';

const HEADERS = {
  'Content-Type': 'application/json',
  'X-Dev-User-Id': 'dev-user-001',
};

interface PaperAlert {
  id: string;
  keywords: string[];
  journals: string[];
  frequency: string;
  active: boolean;
  lastRun: string | null;
  createdAt: string;
}

interface PaperResult {
  id: string;
  title: string;
  authors: string;
  journal: string;
  publishedAt: string;
  abstract: string;
  relevanceScore: number;
  url: string | null;
}

export default function PaperAlertsScreen() {
  const [alerts, setAlerts] = useState<PaperAlert[]>([]);
  const [results, setResults] = useState<PaperResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<'alerts' | 'results'>('alerts');

  // New alert form
  const [keywords, setKeywords] = useState('');
  const [journals, setJournals] = useState('');
  const [showForm, setShowForm] = useState(false);

  const fetchAlerts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/papers/alerts`, { headers: HEADERS });
      const data = await res.json();
      setAlerts(data.data ?? []);
    } catch (err) {
      console.error('Failed to fetch alerts:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchResults = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/papers/alerts/results`, { headers: HEADERS });
      const data = await res.json();
      setResults(data.data ?? []);
    } catch (err) {
      console.error('Failed to fetch results:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

  useEffect(() => {
    if (tab === 'results') fetchResults();
  }, [tab, fetchResults]);

  const createAlert = async () => {
    if (!keywords.trim()) return;
    try {
      const res = await fetch(`${API_BASE}/api/papers/alerts`, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({
          keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean),
          journals: journals.split(',').map((j) => j.trim()).filter(Boolean),
          frequency: 'weekly',
        }),
      });
      if (res.ok) {
        setKeywords('');
        setJournals('');
        setShowForm(false);
        fetchAlerts();
      }
    } catch (err: any) {
      Alert.alert('ì¤ë¥', err.message);
    }
  };

  const runAlerts = async () => {
    setRunning(true);
    try {
      await fetch(`${API_BASE}/api/papers/alerts/run`, {
        method: 'POST',
        headers: HEADERS,
      });
      Alert.alert('ì¤í ìë£', 'ë¼ë¬¸ ìë¦¼ì´ ì¤íëììµëë¤.');
      fetchResults();
      setTab('results');
    } catch (err: any) {
      Alert.alert('ì¤ë¥', err.message);
    } finally {
      setRunning(false);
    }
  };

  const renderAlert = ({ item }: { item: PaperAlert }) => (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Ionicons
          name={item.active ? 'notifications' : 'notifications-off'}
          size={18}
          color={item.active ? colors.success : colors.textMuted}
        />
        <Text style={styles.cardTitle}>
          {item.keywords.join(', ')}
        </Text>
      </View>
      {item.journals.length > 0 && (
        <Text style={styles.cardSub}>
          ð {item.journals.join(', ')}
        </Text>
      )}
      <View style={styles.cardMeta}>
        <Text style={styles.metaText}>ì£¼ê¸°: {item.frequency}</Text>
        <Text style={styles.metaText}>
          ë§ì§ë§ ì¤í: {item.lastRun ? new Date(item.lastRun).toLocaleDateString('ko-KR') : 'ìì'}
        </Text>
      </View>
    </View>
  );

  const renderResult = ({ item }: { item: PaperResult }) => (
    <View style={styles.card}>
      <Text style={styles.resultTitle}>{item.title}</Text>
      <Text style={styles.resultAuthors} numberOfLines={1}>
        {item.authors}
      </Text>
      <Text style={styles.resultJournal}>
        {item.journal} Â· {new Date(item.publishedAt).toLocaleDateString('ko-KR')}
      </Text>
      <Text style={styles.resultAbstract} numberOfLines={3}>
        {item.abstract}
      </Text>
      <View style={styles.scoreBar}>
        <View style={[styles.scoreFill, { width: `${(item.relevanceScore * 100)}%` }]} />
      </View>
      <Text style={styles.scoreText}>ê´ë ¨ë: {(item.relevanceScore * 100).toFixed(0)}%</Text>
    </View>
  );

  return (
    <View style={styles.container}>
      {/* Tab Switcher */}
      <View style={styles.tabs}>
        <TouchableOpacity
          style={[styles.tabBtn, tab === 'alerts' && styles.tabActive]}
          onPress={() => setTab('alerts')}
        >
          <Text style={[styles.tabText, tab === 'alerts' && styles.tabTextActive]}>
            ìë¦¼ ì¤ì 
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabBtn, tab === 'results' && styles.tabActive]}
          onPress={() => setTab('results')}
        >
          <Text style={[styles.tabText, tab === 'results' && styles.tabTextActive]}>
            ê²ì ê²°ê³¼ ({results.length})
          </Text>
        </TouchableOpacity>
      </View>

      {tab === 'alerts' ? (
        <>
          {/* Action Buttons */}
          <View style={styles.actions}>
            <TouchableOpacity style={styles.actionBtn} onPress={() => setShowForm(!showForm)}>
              <Ionicons name="add-circle-outline" size={18} color={colors.primary} />
              <Text style={styles.actionText}>ì ìë¦¼</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, styles.runBtn]}
              onPress={runAlerts}
              disabled={running}
            >
              {running ? (
                <ActivityIndicator size="small" color={colors.white} />
              ) : (
                <Ionicons name="play" size={16} color={colors.white} />
              )}
              <Text style={[styles.actionText, { color: colors.white }]}>ì¤í</Text>
            </TouchableOpacity>
          </View>

          {/* New Alert Form */}
          {showForm && (
            <View style={styles.formCard}>
              <Text style={styles.formLabel}>í¤ìë (ì¼í êµ¬ë¶)</Text>
              <TextInput
                style={styles.formInput}
                value={keywords}
                onChangeText={setKeywords}
                placeholder="ì: flexible sensor, hydrogel, wearable"
                placeholderTextColor={colors.textMuted}
              />
              <Text style={styles.formLabel}>ì ë (ì í, ì¼í êµ¬ë¶)</Text>
              <TextInput
                style={styles.formInput}
                value={journals}
                onChangeText={setJournals}
                placeholder="ì: Nature, Science, Advanced Materials"
                placeholderTextColor={colors.textMuted}
              />
              <TouchableOpacity style={styles.submitBtn} onPress={createAlert}>
                <Text style={styles.submitText}>ìë¦¼ ìì±</Text>
              </TouchableOpacity>
            </View>
          )}

          {loading ? (
            <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
          ) : (
            <FlatList
              data={alerts}
              keyExtractor={(item) => item.id}
              renderItem={renderAlert}
              contentContainerStyle={styles.list}
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Ionicons name="document-text-outline" size={48} color={colors.textMuted} />
                  <Text style={styles.emptyText}>ë¼ë¬¸ ìë¦¼ì´ ììµëë¤</Text>
                  <Text style={styles.emptySubtext}>ìì 'ì ìë¦¼' ë²í¼ì¼ë¡ í¤ìëë¥¼ ë±ë¡íì¸ì</Text>
                </View>
              }
            />
          )}
        </>
      ) : (
        <>
          {loading ? (
            <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
          ) : (
            <FlatList
              data={results}
              keyExtractor={(item) => item.id}
              renderItem={renderResult}
              contentContainerStyle={styles.list}
              ListEmptyComponent={
                <View style={styles.empty}>
                  <Ionicons name="search-outline" size={48} color={colors.textMuted} />
                  <Text style={styles.emptyText}>ê²ì ê²°ê³¼ê° ììµëë¤</Text>
                  <Text style={styles.emptySubtext}>ìë¦¼ì ì¤ííë©´ ê²°ê³¼ê° ì¬ê¸°ì íìë©ëë¤</Text>
                </View>
              }
            />
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  tabs: {
    flexDirection: 'row',
    padding: spacing.md,
    gap: spacing.sm,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.md,
    backgroundColor: colors.bgCard,
    alignItems: 'center',
  },
  tabActive: { backgroundColor: colors.primary },
  tabText: { fontSize: fontSize.sm, fontWeight: '600', color: colors.textSecondary },
  tabTextActive: { color: colors.white },
  actions: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.md,
  },
  runBtn: { backgroundColor: colors.primary },
  actionText: { fontSize: fontSize.sm, fontWeight: '600', color: colors.primary },
  formCard: {
    margin: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  formLabel: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginBottom: 4,
    marginTop: spacing.sm,
  },
  formInput: {
    backgroundColor: colors.bgInput,
    borderRadius: borderRadius.sm,
    padding: spacing.md,
    fontSize: fontSize.md,
    color: colors.text,
  },
  submitBtn: {
    marginTop: spacing.lg,
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.md,
    alignItems: 'center',
  },
  submitText: { color: colors.white, fontWeight: '700', fontSize: fontSize.md },
  list: { padding: spacing.md, paddingBottom: 100 },
  card: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cardTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.text, flex: 1 },
  cardSub: { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 4 },
  cardMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  metaText: { fontSize: fontSize.xs, color: colors.textMuted },
  resultTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.text },
  resultAuthors: { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 2 },
  resultJournal: { fontSize: fontSize.xs, color: colors.primary, marginTop: 2 },
  resultAbstract: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginTop: spacing.sm,
    lineHeight: 20,
  },
  scoreBar: {
    height: 4,
    backgroundColor: colors.bgInput,
    borderRadius: 2,
    marginTop: spacing.sm,
  },
  scoreFill: { height: 4, backgroundColor: colors.success, borderRadius: 2 },
  scoreText: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  empty: { alignItems: 'center', paddingTop: 60 },
  emptyText: { fontSize: fontSize.lg, color: colors.textSecondary, marginTop: spacing.md },
  emptySubtext: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 4 },
});
