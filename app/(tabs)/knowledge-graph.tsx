import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  StyleSheet,
  Dimensions,
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

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface KnowledgeNode {
  id: string;
  label: string;
  type: string;
  properties: Record<string, any>;
  createdAt: string;
}

interface KnowledgeEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relation: string;
  weight: number;
}

interface GraphInsight {
  type: string;
  description: string;
  score: number;
  relatedNodes: string[];
}

const NODE_COLORS: Record<string, string> = {
  CONCEPT: '#6366F1',
  PAPER: '#3B82F6',
  PERSON: '#F59E0B',
  METHOD: '#10B981',
  MATERIAL: '#EF4444',
  TOPIC: '#8B5CF6',
  DEFAULT: '#64748B',
};

export default function KnowledgeGraphScreen() {
  const [nodes, setNodes] = useState<KnowledgeNode[]>([]);
  const [edges, setEdges] = useState<KnowledgeEdge[]>([]);
  const [insights, setInsights] = useState<GraphInsight[]>([]);
  const [loading, setLoading] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [selectedNode, setSelectedNode] = useState<KnowledgeNode | null>(null);
  const [tab, setTab] = useState<'graph' | 'insights'>('graph');

  const fetchGraph = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/graph`, { headers: HEADERS });
      const data = await res.json();
      setNodes(data.data?.nodes ?? []);
      setEdges(data.data?.edges ?? []);
    } catch (err) {
      console.error('Graph fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchInsights = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/graph/insights`, { headers: HEADERS });
      const data = await res.json();
      setInsights(data.data ?? []);
    } catch (err) {
      console.error('Insights fetch error:', err);
    }
  }, []);

  useEffect(() => {
    fetchGraph();
    fetchInsights();
  }, [fetchGraph, fetchInsights]);

  const seedGraph = async () => {
    setSeeding(true);
    try {
      await fetch(`${API_BASE}/api/graph/seed`, {
        method: 'POST',
        headers: HEADERS,
      });
      Alert.alert('ìë£', 'ì§ì ê·¸ëí ìë ë°ì´í°ê° ìì±ëììµëë¤.');
      fetchGraph();
      fetchInsights();
    } catch (err: any) {
      Alert.alert('ì¤ë¥', err.message);
    } finally {
      setSeeding(false);
    }
  };

  const getNodeColor = (type: string) =>
    NODE_COLORS[type.toUpperCase()] ?? NODE_COLORS.DEFAULT;

  const getConnections = (nodeId: string) =>
    edges.filter((e) => e.sourceId === nodeId || e.targetId === nodeId);

  const renderNodeBubble = (node: KnowledgeNode, index: number) => {
    const connections = getConnections(node.id);
    const size = Math.max(50, Math.min(90, 50 + connections.length * 8));
    const col = index % 4;
    const row = Math.floor(index / 4);
    const isSelected = selectedNode?.id === node.id;

    return (
      <TouchableOpacity
        key={node.id}
        style={[
          styles.nodeBubble,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: getNodeColor(node.type),
            borderWidth: isSelected ? 3 : 0,
            borderColor: colors.white,
            left: col * (SCREEN_WIDTH - 60) / 4 + 10,
            top: row * 100 + 10,
          },
        ]}
        onPress={() => setSelectedNode(isSelected ? null : node)}
      >
        <Text style={styles.nodeLabel} numberOfLines={2}>
          {node.label}
        </Text>
        <Text style={styles.nodeCount}>{connections.length}</Text>
      </TouchableOpacity>
    );
  };

  const renderInsight = (insight: GraphInsight, index: number) => (
    <View key={index} style={styles.insightCard}>
      <View style={styles.insightHeader}>
        <Ionicons name="sparkles" size={16} color={colors.warning} />
        <Text style={styles.insightType}>{insight.type}</Text>
        <View style={styles.scoreBadge}>
          <Text style={styles.scoreText}>{(insight.score * 100).toFixed(0)}%</Text>
        </View>
      </View>
      <Text style={styles.insightDesc}>{insight.description}</Text>
    </View>
  );

  const typeCounts = nodes.reduce<Record<string, number>>((acc, n) => {
    const t = n.type.toUpperCase();
    acc[t] = (acc[t] || 0) + 1;
    return acc;
  }, {});

  return (
    <View style={styles.container}>
      {/* Stats Bar */}
      <View style={styles.statsBar}>
        <View style={styles.stat}>
          <Text style={styles.statNum}>{nodes.length}</Text>
          <Text style={styles.statLabel}>ë¸ë</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statNum}>{edges.length}</Text>
          <Text style={styles.statLabel}>ì°ê²°</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statNum}>{Object.keys(typeCounts).length}</Text>
          <Text style={styles.statLabel}>ì í</Text>
        </View>
        <TouchableOpacity
          style={styles.seedBtn}
          onPress={seedGraph}
          disabled={seeding}
        >
          {seeding ? (
            <ActivityIndicator size="small" color={colors.white} />
          ) : (
            <Ionicons name="sparkles-outline" size={16} color={colors.white} />
          )}
          <Text style={styles.seedText}>ìë</Text>
        </TouchableOpacity>
      </View>

      {/* Tab Switcher */}
      <View style={styles.tabs}>
        <TouchableOpacity
          style={[styles.tabBtn, tab === 'graph' && styles.tabActive]}
          onPress={() => setTab('graph')}
        >
          <Text style={[styles.tabText, tab === 'graph' && styles.tabTextActive]}>
            ê·¸ëí ë·°
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabBtn, tab === 'insights' && styles.tabActive]}
          onPress={() => setTab('insights')}
        >
          <Text style={[styles.tabText, tab === 'insights' && styles.tabTextActive]}>
            ì¸ì¬ì´í¸ ({insights.length})
          </Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 60 }} color={colors.primary} size="large" />
      ) : tab === 'graph' ? (
        <ScrollView contentContainerStyle={styles.graphContainer}>
          {/* Type Legend */}
          <View style={styles.legend}>
            {Object.entries(typeCounts).map(([type, count]) => (
              <View key={type} style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: getNodeColor(type) }]} />
                <Text style={styles.legendText}>
                  {type} ({count})
                </Text>
              </View>
            ))}
          </View>

          {/* Node Bubbles */}
          <View style={[styles.graphArea, { height: Math.ceil(nodes.length / 4) * 100 + 40 }]}>
            {nodes.map(renderNodeBubble)}
          </View>

          {/* Selected Node Detail */}
          {selectedNode && (
            <View style={styles.detailCard}>
              <View style={styles.detailHeader}>
                <View
                  style={[
                    styles.detailDot,
                    { backgroundColor: getNodeColor(selectedNode.type) },
                  ]}
                />
                <Text style={styles.detailTitle}>{selectedNode.label}</Text>
              </View>
              <Text style={styles.detailType}>ì í: {selectedNode.type}</Text>
              <Text style={styles.detailConn}>
                ì°ê²°: {getConnections(selectedNode.id).length}ê°
              </Text>
              {getConnections(selectedNode.id).slice(0, 5).map((edge) => {
                const targetId =
                  edge.sourceId === selectedNode.id ? edge.targetId : edge.sourceId;
                const targetNode = nodes.find((n) => n.id === targetId);
                return (
                  <View key={edge.id} style={styles.connRow}>
                    <Ionicons name="arrow-forward" size={12} color={colors.textMuted} />
                    <Text style={styles.connText}>
                      {edge.relation} â {targetNode?.label ?? targetId}
                    </Text>
                  </View>
                );
              })}
            </View>
          )}

          {nodes.length === 0 && (
            <View style={styles.empty}>
              <Ionicons name="git-network-outline" size={48} color={colors.textMuted} />
              <Text style={styles.emptyText}>ì§ì ê·¸ëíê° ë¹ì´ììµëë¤</Text>
              <Text style={styles.emptySubtext}>
                'ìë' ë²í¼ì ëë¬ ìº¡ì² ë°ì´í°ë¡ë¶í° ì§ì ê·¸ëíë¥¼ ìì±íì¸ì
              </Text>
            </View>
          )}
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.insightsList}>
          {insights.length > 0 ? (
            insights.map(renderInsight)
          ) : (
            <View style={styles.empty}>
              <Ionicons name="analytics-outline" size={48} color={colors.textMuted} />
              <Text style={styles.emptyText}>ì¸ì¬ì´í¸ê° ììµëë¤</Text>
              <Text style={styles.emptySubtext}>
                ë¸ëê° ì¶©ë¶í ìì´ë© AIê° í¨í´ì ë°ê²¬í©ëë¤
              </Text>
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  statsBar: {
    flexDirection: 'row',
    padding: spacing.md,
    gap: spacing.md,
    alignItems: 'center',
  },
  stat: { alignItems: 'center' },
  statNum: { fontSize: fontSize.xl, fontWeight: '800', color: colors.text },
  statLabel: { fontSize: fontSize.xs, color: colors.textMuted },
  seedBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 'auto',
    backgroundColor: colors.primary,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.md,
  },
  seedText: { color: colors.white, fontWeight: '600', fontSize: fontSize.sm },
  tabs: { flexDirection: 'row', paddingHorizontal: spacing.md, gap: spacing.sm },
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
  graphContainer: { padding: spacing.md, paddingBottom: 100 },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontSize: fontSize.xs, color: colors.textSecondary },
  graphArea: { position: 'relative', width: '100%' },
  nodeBubble: {
    position: 'absolute',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 4,
  },
  nodeLabel: {
    fontSize: 10,
    color: colors.white,
    fontWeight: '700',
    textAlign: 'center',
  },
  nodeCount: { fontSize: 9, color: 'rgba(255,255,255,0.7)' },
  detailCard: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  detailHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  detailDot: { width: 14, height: 14, borderRadius: 7 },
  detailTitle: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text },
  detailType: { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 4 },
  detailConn: { fontSize: fontSize.sm, color: colors.primary, marginTop: 2 },
  connRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
    paddingLeft: spacing.sm,
  },
  connText: { fontSize: fontSize.sm, color: colors.textSecondary },
  insightsList: { padding: spacing.md, paddingBottom: 100 },
  insightCard: {
    backgroundColor: colors.bgCard,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  insightHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  insightType: { fontSize: fontSize.md, fontWeight: '700', color: colors.text, flex: 1 },
  scoreBadge: {
    backgroundColor: colors.bgInput,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  scoreText: { fontSize: fontSize.xs, color: colors.warning, fontWeight: '700' },
  insightDesc: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginTop: spacing.sm,
    lineHeight: 20,
  },
  empty: { alignItems: 'center', paddingTop: 60 },
  emptyText: { fontSize: fontSize.lg, color: colors.textSecondary, marginTop: spacing.md },
  emptySubtext: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 4, textAlign: 'center', paddingHorizontal: 40 },
});
