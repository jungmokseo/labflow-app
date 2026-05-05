'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import { Network, X as XIcon } from 'lucide-react';
import { getKnowledgeGraph, type GraphData, type GraphNode } from '@/lib/api';

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

// 표준 헤더 — vacations/page.tsx 패턴 준수
function GraphHeader() {
  return (
    <div className="px-4 md:px-8 pt-4 md:pt-8 pb-3 md:pb-4 flex-shrink-0">
      <div className="flex items-center gap-3 mb-1">
        <span className="w-1 h-9 md:h-11 bg-primary rounded-full flex-shrink-0" />
        <div className="min-w-0">
          <h1 className="text-2xl md:text-3xl font-bold text-text-heading tracking-tight flex items-center gap-2 leading-tight">
            <Network className="w-6 h-6 text-primary flex-shrink-0" /> 지식 그래프
          </h1>
          <p className="text-sm md:text-base text-text-muted mt-1">
            연구실의 인물·과제·논문·주제를 한눈에. 노드를 탭하면 연결 관계를 볼 수 있습니다.
          </p>
        </div>
      </div>
    </div>
  );
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

  // Responsive sizing — graph 컨테이너 크기 추적
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
  }, [loading, error]);

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
      <div className="flex flex-col h-[calc(100dvh-3.5rem)] md:h-[calc(100dvh-1.5rem)]">
        <GraphHeader />
        <div className="flex-1 flex items-center justify-center px-4 md:px-8">
          <div className="text-text-muted animate-pulse">Knowledge Graph loading...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col h-[calc(100dvh-3.5rem)] md:h-[calc(100dvh-1.5rem)]">
        <GraphHeader />
        <div className="flex-1 flex items-center justify-center px-4 md:px-8">
          <div className="bg-bg-card border border-border rounded-lg p-3 md:p-4 text-sm text-red-500">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100dvh-3.5rem)] md:h-[calc(100dvh-1.5rem)] overflow-hidden">
      <GraphHeader />

      {/* Graph 컨테이너 — 헤더 아래 가용 영역을 모두 사용 */}
      <div
        ref={containerRef}
        className="relative flex-1 min-h-0 mx-4 md:mx-8 mb-4 md:mb-8 rounded-2xl overflow-hidden bg-[#0f1117] border border-border"
      >
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

        {/* Stats Panel — top left (모바일은 더 작게) */}
        <div className="absolute top-3 left-3 md:top-4 md:left-4 z-10 max-w-[220px] md:max-w-[260px]">
          <div className="bg-[#1a1d2e]/90 backdrop-blur border border-white/10 rounded-xl p-3 md:p-4 shadow-lg space-y-2.5 md:space-y-3">
            <div className="flex items-center gap-2">
              <Network className="w-4 h-4 text-white/70" />
              <h2 className="text-sm font-bold text-white/90">Knowledge Graph</h2>
            </div>
            {stats && (
              <div className="text-xs text-white/50 leading-relaxed">
                Nodes: <span className="font-medium text-white/80">{stats.totalNodes}</span>
                <span className="text-white/30 mx-1">/</span>
                Edges: <span className="font-medium text-white/80">{stats.totalEdges}</span>
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

        {/* Selected Node Detail — 데스크탑: top-right 패널, 모바일: bottom sheet */}
        {selectedNode && (
          <div className="absolute z-20 left-3 right-3 bottom-3 md:left-auto md:right-4 md:top-4 md:bottom-auto md:w-[320px]">
            <div className="bg-[#1a1d2e]/95 backdrop-blur border border-white/10 rounded-xl p-3 md:p-4 shadow-lg space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: TYPE_COLORS[selectedNode.entityType] }} />
                  <span className="text-xs font-medium text-white/50 truncate">
                    {TYPE_LABELS[selectedNode.entityType] || selectedNode.entityType}
                  </span>
                </div>
                <button
                  onClick={() => setSelectedNode(null)}
                  className="text-white/40 hover:text-white/80 p-1 -m-1 rounded flex-shrink-0"
                  aria-label="닫기"
                >
                  <XIcon className="w-4 h-4" />
                </button>
              </div>
              <h3 className="text-base font-bold text-white/90 leading-snug">{selectedNode.name}</h3>

              {selectedNodeEdges.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[10px] text-white/40 uppercase tracking-wider">
                    Connections ({selectedNodeEdges.length})
                  </p>
                  <div className="max-h-48 md:max-h-60 overflow-y-auto space-y-1 pr-1">
                    {selectedNodeEdges.map((e, i) => (
                      <div key={i} className="flex items-center gap-1.5 text-xs text-white/50">
                        <span className={`flex-shrink-0 ${e.direction === 'out' ? 'text-blue-400' : 'text-green-400'}`}>
                          {e.direction === 'out' ? '→' : '←'}
                        </span>
                        <span className="text-white/80 font-medium truncate flex-1 min-w-0">{e.targetName}</span>
                        <span className="text-[10px] px-1.5 py-0.5 bg-white/10 rounded flex-shrink-0">
                          {e.relation.replace(/_/g, ' ')}
                        </span>
                        {e.weight > 1 && <span className="text-[10px] text-blue-400 flex-shrink-0">w:{e.weight}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Hover tooltip — 데스크탑 전용 (모바일은 hover 의미 없음) */}
        {hoveredNode && !selectedNode && graphData && (() => {
          const n = graphData.nodes.find(nd => nd.id === hoveredNode);
          if (!n) return null;
          return (
            <div className="hidden md:block absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
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
    </div>
  );
}
