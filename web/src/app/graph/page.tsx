'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  ReactFlow,
  Node,
  Edge,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  Panel,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { getKnowledgeGraph, type GraphData, type GraphNode, type GraphEdge } from '@/lib/api';

// Entity type → color mapping
const TYPE_COLORS: Record<string, string> = {
  person: '#3b82f6',      // blue
  project: '#f59e0b',     // amber
  paper: '#10b981',       // emerald
  term: '#8b5cf6',        // violet
  equipment: '#ef4444',   // red
  journal: '#06b6d4',     // cyan
  institution: '#f97316', // orange
  topic: '#ec4899',       // pink
};

const TYPE_LABELS: Record<string, string> = {
  person: '인물',
  project: '과제',
  paper: '논문',
  term: '용어',
  equipment: '장비',
  journal: '학술지',
  institution: '기관',
  topic: '주제',
};

function buildFlowData(graph: GraphData, filter: string | null): { nodes: Node[]; edges: Edge[] } {
  const filteredNodes = filter
    ? graph.nodes.filter(n => n.entityType === filter)
    : graph.nodes;

  const nodeIds = new Set(filteredNodes.map(n => n.id));

  // If filtering, also include connected nodes
  const connectedEdges = graph.edges.filter(e =>
    nodeIds.has(e.from) || nodeIds.has(e.to)
  );
  for (const e of connectedEdges) {
    nodeIds.add(e.from);
    nodeIds.add(e.to);
  }

  const allNodes = graph.nodes.filter(n => nodeIds.has(n.id));

  // Force-directed layout approximation
  const cols = Math.ceil(Math.sqrt(allNodes.length));
  const spacing = 220;

  const nodes: Node[] = allNodes.map((n, i) => ({
    id: n.id,
    position: {
      x: (i % cols) * spacing + (Math.random() - 0.5) * 60,
      y: Math.floor(i / cols) * spacing + (Math.random() - 0.5) * 60,
    },
    data: {
      label: n.name.length > 20 ? n.name.slice(0, 18) + '...' : n.name,
      fullName: n.name,
      type: n.entityType,
      edgeCount: n.edgeCount,
    },
    style: {
      background: TYPE_COLORS[n.entityType] || '#6b7280',
      color: '#fff',
      border: '2px solid ' + (TYPE_COLORS[n.entityType] || '#6b7280'),
      borderRadius: '12px',
      padding: '8px 14px',
      fontSize: '12px',
      fontWeight: 500,
      minWidth: '80px',
      textAlign: 'center' as const,
      boxShadow: `0 2px 8px ${TYPE_COLORS[n.entityType] || '#6b7280'}40`,
    },
  }));

  const edges: Edge[] = connectedEdges
    .filter(e => nodeIds.has(e.from) && nodeIds.has(e.to))
    .map(e => ({
      id: e.id,
      source: e.from,
      target: e.to,
      label: e.relation.replace(/_/g, ' '),
      animated: e.weight >= 3,
      style: {
        strokeWidth: Math.min(e.weight, 5),
        stroke: e.weight >= 3 ? '#3b82f6' : '#94a3b8',
      },
      labelStyle: {
        fontSize: '10px',
        fill: '#64748b',
      },
    }));

  return { nodes, edges };
}

export default function GraphPage() {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const fetchGraph = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getKnowledgeGraph({ limit: 500 });
      setGraphData(res.data);
    } catch (err: any) {
      setError(err.message || 'Failed to load graph');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchGraph(); }, [fetchGraph]);

  useEffect(() => {
    if (!graphData) return;
    const { nodes: flowNodes, edges: flowEdges } = buildFlowData(graphData, filter);
    setNodes(flowNodes);
    setEdges(flowEdges);
  }, [graphData, filter, setNodes, setEdges]);

  const onNodeClick = useCallback((_: any, node: Node) => {
    if (!graphData) return;
    const gNode = graphData.nodes.find(n => n.id === node.id);
    setSelectedNode(gNode || null);
  }, [graphData]);

  const stats = useMemo(() => {
    if (!graphData) return null;
    const typeCounts: Record<string, number> = {};
    for (const n of graphData.nodes) {
      typeCounts[n.entityType] = (typeCounts[n.entityType] || 0) + 1;
    }
    return {
      totalNodes: graphData.meta.totalNodes,
      totalEdges: graphData.meta.totalEdges,
      typeCounts,
    };
  }, [graphData]);

  // Edges for selected node
  const selectedNodeEdges = useMemo(() => {
    if (!selectedNode || !graphData) return [];
    return graphData.edges
      .filter(e => e.from === selectedNode.id || e.to === selectedNode.id)
      .map(e => {
        const isFrom = e.from === selectedNode.id;
        const targetId = isFrom ? e.to : e.from;
        const targetNode = graphData.nodes.find(n => n.id === targetId);
        return {
          ...e,
          direction: isFrom ? 'out' : 'in',
          targetName: targetNode?.name || '(unknown)',
          targetType: targetNode?.entityType || '',
        };
      });
  }, [selectedNode, graphData]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-text-muted animate-pulse">Knowledge Graph loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-red-500">{error}</div>
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: 'calc(100dvh - 3rem)' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        fitView
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        style={{ background: 'var(--color-bg, #f8fafc)' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--color-text-muted, #94a3b8)" />
          <Controls />
          <MiniMap
            nodeColor={(n) => TYPE_COLORS[n.data?.type as string] || '#6b7280'}
            maskColor="rgba(0,0,0,0.1)"
            style={{ borderRadius: '8px' }}
          />

          {/* Stats Panel */}
          <Panel position="top-left">
            <div className="bg-bg-card border border-border rounded-xl p-4 shadow-lg space-y-3 max-w-[260px]">
              <h2 className="text-sm font-bold text-text-heading">Knowledge Graph</h2>
              {stats && (
                <div className="text-xs text-text-muted space-y-1">
                  <div>Nodes: <span className="font-medium text-text-heading">{stats.totalNodes}</span> / Edges: <span className="font-medium text-text-heading">{stats.totalEdges}</span></div>
                </div>
              )}

              {/* Type filter chips */}
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => setFilter(null)}
                  className={`px-2 py-1 rounded-full text-[10px] font-medium transition-colors ${
                    !filter ? 'bg-text-heading text-bg-card' : 'bg-bg-hover text-text-muted hover:text-text-heading'
                  }`}
                >
                  All
                </button>
                {stats && Object.entries(stats.typeCounts)
                  .sort((a, b) => b[1] - a[1])
                  .map(([type, count]) => (
                  <button
                    key={type}
                    onClick={() => setFilter(filter === type ? null : type)}
                    className={`px-2 py-1 rounded-full text-[10px] font-medium transition-colors flex items-center gap-1 ${
                      filter === type ? 'text-white' : 'text-text-muted hover:text-text-heading'
                    }`}
                    style={{
                      backgroundColor: filter === type ? TYPE_COLORS[type] : undefined,
                      border: `1px solid ${TYPE_COLORS[type]}40`,
                    }}
                  >
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: TYPE_COLORS[type] }} />
                    {TYPE_LABELS[type] || type} ({count})
                  </button>
                ))}
              </div>
            </div>
          </Panel>

          {/* Selected Node Detail */}
          {selectedNode && (
            <Panel position="top-right">
              <div className="bg-bg-card border border-border rounded-xl p-4 shadow-lg max-w-[300px] space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 rounded-full" style={{ backgroundColor: TYPE_COLORS[selectedNode.entityType] }} />
                    <span className="text-xs font-medium text-text-muted">{TYPE_LABELS[selectedNode.entityType] || selectedNode.entityType}</span>
                  </div>
                  <button onClick={() => setSelectedNode(null)} className="text-text-muted hover:text-text-heading text-xs">X</button>
                </div>
                <h3 className="text-sm font-bold text-text-heading">{selectedNode.name}</h3>

                {selectedNodeEdges.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] text-text-muted uppercase tracking-wider">Connections ({selectedNodeEdges.length})</p>
                    <div className="max-h-48 overflow-y-auto space-y-1">
                      {selectedNodeEdges.map((e, i) => (
                        <div key={i} className="flex items-center gap-1.5 text-xs text-text-muted">
                          <span className={e.direction === 'out' ? 'text-blue-400' : 'text-green-400'}>
                            {e.direction === 'out' ? '\u2192' : '\u2190'}
                          </span>
                          <span className="text-text-heading font-medium truncate">{e.targetName}</span>
                          <span className="text-[10px] px-1.5 py-0.5 bg-bg-hover rounded">
                            {e.relation.replace(/_/g, ' ')}
                          </span>
                          {e.weight > 1 && <span className="text-[10px] text-primary">w:{e.weight}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Panel>
          )}
        </ReactFlow>
    </div>
  );
}
