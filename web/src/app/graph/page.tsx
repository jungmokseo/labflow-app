'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import { getKnowledgeGraph, type GraphData, type GraphNode, type GraphEdge } from '@/lib/api';

// SSR 비활성화 — force-graph는 canvas 기반이라 서버에서 렌더링 불가
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

const TYPE_COLORS: Record<string, string> = {
  person: '#7c9bf7',
  project: '#f5c542',
  paper: '#5ee8a0',
  term: '#b08cf7',
  equipment: '#f77171',
  journal: '#4dd6e6',
  institution: '#fb923c',
  topic: '#f472b6',
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

interface ForceNode {
  id: string;
  name: string;
  type: string;
  edgeCount: number;
  val: number; // node size
  color: string;
  // d3 adds x, y at runtime
  x?: number;
  y?: number;
}

interface ForceLink {
  source: string;
  target: string;
  relation: string;
  weight: number;
  color: string;
}

function buildForceData(graph: GraphData, filter: string | null) {
  const nodeIds = new Set(graph.nodes.map(n => n.id));

  // Filter nodes
  let visibleNodes = filter
    ? graph.nodes.filter(n => n.entityType === filter)
    : graph.nodes;

  const visibleIds = new Set(visibleNodes.map(n => n.id));

  // Include connected nodes when filtering
  if (filter) {
    const connectedEdges = graph.edges.filter(e => visibleIds.has(e.from) || visibleIds.has(e.to));
    for (const e of connectedEdges) {
      visibleIds.add(e.from);
      visibleIds.add(e.to);
    }
    visibleNodes = graph.nodes.filter(n => visibleIds.has(n.id));
  }

  const nodes: ForceNode[] = visibleNodes.map(n => ({
    id: n.id,
    name: n.name,
    type: n.entityType,
    edgeCount: n.edgeCount,
    val: Math.max(2, Math.min(n.edgeCount + 1, 8)),
    color: TYPE_COLORS[n.entityType] || '#6b7280',
  }));

  const links: ForceLink[] = graph.edges
    .filter(e => visibleIds.has(e.from) && visibleIds.has(e.to))
    .map(e => ({
      source: e.from,
      target: e.to,
      relation: e.relation,
      weight: e.weight,
      color: e.weight >= 3 ? 'rgba(124,155,247,0.6)' : 'rgba(148,163,184,0.2)',
    }));

  return { nodes, links };
}

export default function GraphPage() {
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);

  // Responsive sizing
  useEffect(() => {
    function updateSize() {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    }
    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, []);

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

  const forceData = useMemo(() => {
    if (!graphData) return { nodes: [], links: [] };
    return buildForceData(graphData, filter);
  }, [graphData, filter]);

  const stats = useMemo(() => {
    if (!graphData) return null;
    const typeCounts: Record<string, number> = {};
    for (const n of graphData.nodes) {
      typeCounts[n.entityType] = (typeCounts[n.entityType] || 0) + 1;
    }
    return { totalNodes: graphData.meta.totalNodes, totalEdges: graphData.meta.totalEdges, typeCounts };
  }, [graphData]);

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
          direction: isFrom ? 'out' as const : 'in' as const,
          targetName: targetNode?.name || '(unknown)',
          targetType: targetNode?.entityType || '',
        };
      });
  }, [selectedNode, graphData]);

  // Highlight connected nodes/links on hover
  const connectedNodeIds = useMemo(() => {
    if (!hoveredNode || !graphData) return new Set<string>();
    const ids = new Set<string>([hoveredNode]);
    for (const e of graphData.edges) {
      if (e.from === hoveredNode) ids.add(e.to);
      if (e.to === hoveredNode) ids.add(e.from);
    }
    return ids;
  }, [hoveredNode, graphData]);

  const handleNodeClick = useCallback((node: any) => {
    if (!graphData) return;
    const gNode = graphData.nodes.find(n => n.id === node.id);
    setSelectedNode(gNode || null);
    // Zoom to node
    if (fgRef.current) {
      fgRef.current.centerAt(node.x, node.y, 500);
      fgRef.current.zoom(3, 500);
    }
  }, [graphData]);

  // Custom node rendering — Obsidian style circles with glow
  const paintNode = useCallback((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const isHovered = hoveredNode === node.id;
    const isConnected = connectedNodeIds.has(node.id);
    const dimmed = hoveredNode && !isConnected;
    const radius = Math.sqrt(node.val) * 4;
    const fontSize = Math.max(11 / globalScale, 2);

    // Glow effect for hovered/connected
    if (isHovered || isConnected) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius + 4, 0, 2 * Math.PI);
      ctx.fillStyle = `${node.color}30`;
      ctx.fill();
    }

    // Node circle
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = dimmed ? `${node.color}40` : node.color;
    ctx.fill();

    // Border
    ctx.strokeStyle = dimmed ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.3)';
    ctx.lineWidth = isHovered ? 2 / globalScale : 0.5 / globalScale;
    ctx.stroke();

    // Label (show when zoomed in enough or when hovered/connected)
    if (globalScale > 1.2 || isHovered || isConnected) {
      const label = node.name.length > 16 ? node.name.slice(0, 14) + '..' : node.name;
      ctx.font = `${isHovered ? 'bold ' : ''}${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = dimmed ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.9)';
      ctx.fillText(label, node.x, node.y + radius + 3);
    }
  }, [hoveredNode, connectedNodeIds]);

  // Custom link rendering
  const paintLink = useCallback((link: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const sourceId = typeof link.source === 'string' ? link.source : link.source.id;
    const targetId = typeof link.target === 'string' ? link.target : link.target.id;
    const isConnected = hoveredNode && (connectedNodeIds.has(sourceId) && connectedNodeIds.has(targetId));
    const dimmed = hoveredNode && !isConnected;

    const sx = link.source.x ?? 0;
    const sy = link.source.y ?? 0;
    const tx = link.target.x ?? 0;
    const ty = link.target.y ?? 0;

    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(tx, ty);
    ctx.strokeStyle = dimmed ? 'rgba(148,163,184,0.05)' : link.color;
    ctx.lineWidth = isConnected ? Math.min(link.weight, 4) / globalScale : Math.min(link.weight, 3) * 0.5 / globalScale;
    ctx.stroke();
  }, [hoveredNode, connectedNodeIds]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center h-[80vh]">
        <div className="text-text-muted animate-pulse">Knowledge Graph loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center h-[80vh]">
        <div className="text-red-500">{error}</div>
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ width: '100%', height: 'calc(100dvh - 3rem)', position: 'relative', background: '#0f1117', borderRadius: '16px', overflow: 'hidden' }}>
      {/* Force Graph */}
      <ForceGraph2D
        ref={fgRef}
        graphData={forceData}
        width={dimensions.width}
        height={dimensions.height}
        backgroundColor="#0f1117"
        nodeCanvasObject={paintNode}
        nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
          const r = Math.sqrt(node.val) * 4 + 4;
          ctx.beginPath();
          ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
        }}
        linkCanvasObject={paintLink}
        onNodeClick={handleNodeClick}
        onNodeHover={(node: any) => setHoveredNode(node?.id || null)}
        onBackgroundClick={() => { setSelectedNode(null); setHoveredNode(null); }}
        cooldownTicks={100}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.3}
        linkDirectionalParticles={(link: any) => link.weight >= 3 ? 2 : 0}
        linkDirectionalParticleWidth={2}
        linkDirectionalParticleColor={() => 'rgba(124,155,247,0.8)'}
        enableZoomInteraction={true}
        enablePanInteraction={true}
      />

      {/* Stats Panel — top left */}
      <div style={{ position: 'absolute', top: 16, left: 16, zIndex: 10 }}>
        <div className="bg-[#1a1d2e]/90 backdrop-blur border border-white/10 rounded-xl p-4 shadow-lg space-y-3 max-w-[260px]">
          <h2 className="text-sm font-bold text-white/90">Knowledge Graph</h2>
          {stats && (
            <div className="text-xs text-white/50 space-y-1">
              <div>Nodes: <span className="font-medium text-white/80">{stats.totalNodes}</span> / Edges: <span className="font-medium text-white/80">{stats.totalEdges}</span></div>
            </div>
          )}

          <div className="flex flex-wrap gap-1.5">
            <button
              onClick={() => setFilter(null)}
              className={`px-2 py-1 rounded-full text-[10px] font-medium transition-colors ${
                !filter ? 'bg-white/20 text-white' : 'bg-white/5 text-white/40 hover:text-white/70'
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
                className="px-2 py-1 rounded-full text-[10px] font-medium transition-colors flex items-center gap-1"
                style={{
                  backgroundColor: filter === type ? TYPE_COLORS[type] : 'rgba(255,255,255,0.05)',
                  color: filter === type ? '#fff' : `${TYPE_COLORS[type]}cc`,
                  border: `1px solid ${TYPE_COLORS[type]}40`,
                }}
              >
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: TYPE_COLORS[type] }} />
                {TYPE_LABELS[type] || type} ({count})
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Selected Node Detail — top right */}
      {selectedNode && (
        <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 10 }}>
          <div className="bg-[#1a1d2e]/90 backdrop-blur border border-white/10 rounded-xl p-4 shadow-lg max-w-[300px] space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full" style={{ backgroundColor: TYPE_COLORS[selectedNode.entityType] }} />
                <span className="text-xs font-medium text-white/50">{TYPE_LABELS[selectedNode.entityType] || selectedNode.entityType}</span>
              </div>
              <button onClick={() => setSelectedNode(null)} className="text-white/30 hover:text-white/70 text-xs">X</button>
            </div>
            <h3 className="text-sm font-bold text-white/90">{selectedNode.name}</h3>

            {selectedNodeEdges.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[10px] text-white/40 uppercase tracking-wider">Connections ({selectedNodeEdges.length})</p>
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {selectedNodeEdges.map((e, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-xs text-white/50">
                      <span className={e.direction === 'out' ? 'text-blue-400' : 'text-green-400'}>
                        {e.direction === 'out' ? '\u2192' : '\u2190'}
                      </span>
                      <span className="text-white/80 font-medium truncate">{e.targetName}</span>
                      <span className="text-[10px] px-1.5 py-0.5 bg-white/10 rounded">
                        {e.relation.replace(/_/g, ' ')}
                      </span>
                      {e.weight > 1 && <span className="text-[10px] text-blue-400">w:{e.weight}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Hover tooltip */}
      {hoveredNode && !selectedNode && graphData && (() => {
        const n = graphData.nodes.find(nd => nd.id === hoveredNode);
        if (!n) return null;
        return (
          <div style={{ position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 10 }}>
            <div className="bg-[#1a1d2e]/90 backdrop-blur border border-white/10 rounded-lg px-4 py-2 flex items-center gap-3">
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: TYPE_COLORS[n.entityType] }} />
              <span className="text-sm text-white/90 font-medium">{n.name}</span>
              <span className="text-xs text-white/40">{TYPE_LABELS[n.entityType]}</span>
              <span className="text-xs text-white/30">{n.edgeCount} connections</span>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
