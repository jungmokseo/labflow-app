'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  getKnowledgeGraph,
  getGraphInsights,
  getGraphNodeConnections,
  seedKnowledgeGraph,
  type GraphNode,
  type GraphEdge,
} from '@/lib/api';

// ── 색상 매핑 ──────────────────────────────────────
const TYPE_COLORS: Record<string, string> = {
  person: '#6C63FF',
  project: '#4ade80',
  paper: '#f59e0b',
  term: '#ec4899',
  equipment: '#06b6d4',
  journal: '#8b5cf6',
  institution: '#f97316',
  topic: '#14b8a6',
};

const TYPE_LABELS: Record<string, string> = {
  person: '사람',
  project: '프로젝트',
  paper: '논문',
  term: '전문용어',
  equipment: '장비',
  journal: '학술지',
  institution: '기관',
  topic: '주제',
};

const RELATION_LABELS: Record<string, string> = {
  participates_in: '참여',
  authored: '저술',
  uses_term: '사용',
  published_in: '게재',
  supervises: '지도',
  collaborates_with: '협업',
  cited_by: '인용',
  related_to: '관련',
  discussed_in: '논의',
  mentioned_in: '언급',
};

// ── D3 Force-directed 시뮬레이션 (순수 Canvas) ────────
interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

function useForceSimulation(
  nodes: GraphNode[],
  edges: GraphEdge[],
  width: number,
  height: number,
) {
  const simNodesRef = useRef<SimNode[]>([]);
  const frameRef = useRef<number>(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    // 초기 위치 배치
    simNodesRef.current = nodes.map((n, i) => ({
      ...n,
      x: width / 2 + (Math.random() - 0.5) * width * 0.6,
      y: height / 2 + (Math.random() - 0.5) * height * 0.6,
      vx: 0,
      vy: 0,
      radius: Math.min(8 + n.edgeCount * 2, 24),
    }));

    let iteration = 0;
    const maxIterations = 200;

    function simulate() {
      if (iteration >= maxIterations) return;
      const simNodes = simNodesRef.current;
      const nodeMap = new Map(simNodes.map(n => [n.id, n]));

      // 척력 (repulsion)
      for (let i = 0; i < simNodes.length; i++) {
        for (let j = i + 1; j < simNodes.length; j++) {
          const a = simNodes[i], b = simNodes[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
          const force = 2000 / (dist * dist);
          const fx = (dx / dist) * force, fy = (dy / dist) * force;
          a.vx -= fx; a.vy -= fy;
          b.vx += fx; b.vy += fy;
        }
      }

      // 인력 (attraction via edges)
      for (const e of edges) {
        const a = nodeMap.get(e.from), b = nodeMap.get(e.to);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const force = (dist - 120) * 0.005 * e.weight;
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }

      // 중심 인력
      for (const n of simNodes) {
        n.vx += (width / 2 - n.x) * 0.001;
        n.vy += (height / 2 - n.y) * 0.001;
      }

      // 속도 적용 + 감쇠
      const damping = 0.85;
      for (const n of simNodes) {
        n.vx *= damping; n.vy *= damping;
        n.x += n.vx; n.y += n.vy;
        n.x = Math.max(n.radius, Math.min(width - n.radius, n.x));
        n.y = Math.max(n.radius, Math.min(height - n.radius, n.y));
      }

      iteration++;
      setTick(iteration);
      frameRef.current = requestAnimationFrame(simulate);
    }

    frameRef.current = requestAnimationFrame(simulate);
    return () => cancelAnimationFrame(frameRef.current);
  }, [nodes, edges, width, height]);

  return { simNodes: simNodesRef.current, tick };
}

// ── 메인 페이지 ──────────────────────────────────────
export default function KnowledgeGraphPage() {
  const [graphData, setGraphData] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  const [insights, setInsights] = useState<any>(null);
  const [selectedNode, setSelectedNode] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [filter, setFilter] = useState<string>('');
  const [error, setError] = useState<string>('');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const WIDTH = 900;
  const HEIGHT = 600;

  // 데이터 로드
  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [graphRes, insightRes] = await Promise.all([
        getKnowledgeGraph({ limit: 200 }),
        getGraphInsights(),
      ]);
      setGraphData(graphRes.data);
      setInsights(insightRes.data);
    } catch (err: any) {
      setError(err.message || '데이터 로드 실패');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // 필터 적용
  const filteredNodes = graphData?.nodes.filter(n => !filter || n.entityType === filter) || [];
  const filteredNodeIds = new Set(filteredNodes.map(n => n.id));
  const filteredEdges = graphData?.edges.filter(e => filteredNodeIds.has(e.from) && filteredNodeIds.has(e.to)) || [];

  // Force simulation
  const { simNodes, tick } = useForceSimulation(filteredNodes, filteredEdges, WIDTH, HEIGHT);

  // Canvas 렌더링
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || simNodes.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    ctx.scale(dpr, dpr);

    // 배경
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    const nodeMap = new Map(simNodes.map(n => [n.id, n]));

    // 엣지 그리기
    for (const e of filteredEdges) {
      const from = nodeMap.get(e.from);
      const to = nodeMap.get(e.to);
      if (!from || !to) continue;

      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.strokeStyle = `rgba(255,255,255,${Math.min(0.1 + e.weight * 0.05, 0.4)})`;
      ctx.lineWidth = Math.min(0.5 + e.weight * 0.3, 3);
      ctx.stroke();
    }

    // 노드 그리기
    for (const n of simNodes) {
      const color = TYPE_COLORS[n.entityType] || '#888';

      // 글로우
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius + 4, 0, Math.PI * 2);
      ctx.fillStyle = `${color}20`;
      ctx.fill();

      // 노드
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = `${color}80`;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // 라벨 (큰 노드만)
      if (n.radius >= 10) {
        ctx.font = '11px -apple-system, sans-serif';
        ctx.fillStyle = '#e0e0e0';
        ctx.textAlign = 'center';
        ctx.fillText(
          n.name.length > 12 ? n.name.substring(0, 11) + '…' : n.name,
          n.x,
          n.y + n.radius + 14,
        );
      }
    }
  }, [simNodes, filteredEdges, tick]);

  // 캔버스 클릭 → 노드 선택
  const handleCanvasClick = async (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const clicked = simNodes.find(n => {
      const dx = n.x - x, dy = n.y - y;
      return Math.sqrt(dx * dx + dy * dy) <= n.radius + 4;
    });

    if (clicked) {
      try {
        const res = await getGraphNodeConnections(clicked.id);
        setSelectedNode(res.data);
      } catch { /* ignore */ }
    } else {
      setSelectedNode(null);
    }
  };

  // 시드
  const handleSeed = async () => {
    setSeeding(true);
    try {
      await seedKnowledgeGraph();
      await loadData();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSeeding(false);
    }
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">🕸️ 지식 그래프</h1>
          <p className="text-sm text-text-muted mt-1">
            대화, 미팅, 이메일에서 자동 추출된 엔티티 관계 네트워크
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleSeed}
            disabled={seeding}
            className="px-4 py-2 text-sm bg-bg-input hover:bg-bg-input/80 text-text-main rounded-lg transition-colors disabled:opacity-50"
          >
            {seeding ? '생성 중...' : '🌱 초기 그래프 생성'}
          </button>
          <button
            onClick={loadData}
            className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors"
          >
            새로고침
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* 통계 카드 */}
      {insights?.stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div className="bg-bg-card rounded-lg p-4 border border-bg-input/50">
            <p className="text-xs text-text-muted">총 엔티티</p>
            <p className="text-2xl font-bold text-white">{insights.stats.nodes}</p>
          </div>
          <div className="bg-bg-card rounded-lg p-4 border border-bg-input/50">
            <p className="text-xs text-text-muted">총 관계</p>
            <p className="text-2xl font-bold text-white">{insights.stats.edges}</p>
          </div>
          {insights.stats.typeBreakdown && Object.entries(insights.stats.typeBreakdown).slice(0, 2).map(([type, count]) => (
            <div key={type} className="bg-bg-card rounded-lg p-4 border border-bg-input/50">
              <p className="text-xs text-text-muted">{TYPE_LABELS[type] || type}</p>
              <p className="text-2xl font-bold" style={{ color: TYPE_COLORS[type] || '#fff' }}>{String(count)}</p>
            </div>
          ))}
        </div>
      )}

      {/* 필터 */}
      <div className="flex gap-2 mb-4 flex-wrap">
        <button
          onClick={() => setFilter('')}
          className={`px-3 py-1.5 text-xs rounded-full transition-colors ${!filter ? 'bg-primary text-white' : 'bg-bg-input text-text-muted hover:text-white'}`}
        >
          전체
        </button>
        {Object.entries(TYPE_LABELS).map(([type, label]) => (
          <button
            key={type}
            onClick={() => setFilter(filter === type ? '' : type)}
            className={`px-3 py-1.5 text-xs rounded-full transition-colors ${filter === type ? 'text-white' : 'text-text-muted hover:text-white'}`}
            style={{
              backgroundColor: filter === type ? TYPE_COLORS[type] : undefined,
              borderColor: TYPE_COLORS[type],
              borderWidth: 1,
              borderStyle: 'solid',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex gap-6 flex-col lg:flex-row">
        {/* 그래프 캔버스 */}
        <div className="flex-1 bg-bg-card rounded-lg border border-bg-input/50 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-[600px] text-text-muted">
              <div className="text-center">
                <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto mb-3" />
                <p>지식 그래프 로드 중...</p>
              </div>
            </div>
          ) : filteredNodes.length === 0 ? (
            <div className="flex items-center justify-center h-[600px] text-text-muted">
              <div className="text-center">
                <p className="text-4xl mb-3">🕸️</p>
                <p className="text-lg font-medium text-white mb-1">지식 그래프가 비어있습니다</p>
                <p className="text-sm mb-4">대화, 미팅, 이메일을 사용하면 자동으로 관계가 추출됩니다.</p>
                <button
                  onClick={handleSeed}
                  disabled={seeding}
                  className="px-4 py-2 text-sm bg-primary hover:bg-primary-hover text-white rounded-lg transition-colors"
                >
                  🌱 기존 데이터에서 초기 그래프 생성
                </button>
              </div>
            </div>
          ) : (
            <canvas
              ref={canvasRef}
              style={{ width: WIDTH, height: HEIGHT, cursor: 'pointer' }}
              onClick={handleCanvasClick}
            />
          )}
        </div>

        {/* 사이드 패널 */}
        <div className="w-full lg:w-80 space-y-4">
          {/* 선택된 노드 상세 */}
          {selectedNode && (
            <div className="bg-bg-card rounded-lg p-4 border border-bg-input/50">
              <div className="flex items-center gap-2 mb-3">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: TYPE_COLORS[selectedNode.node.entityType] }}
                />
                <h3 className="font-medium text-white">{selectedNode.node.name}</h3>
              </div>
              <p className="text-xs text-text-muted mb-3">
                {TYPE_LABELS[selectedNode.node.entityType] || selectedNode.node.entityType}
              </p>

              {selectedNode.outgoing?.length > 0 && (
                <div className="mb-3">
                  <p className="text-xs font-medium text-text-muted mb-1">→ 연결 대상</p>
                  {selectedNode.outgoing.slice(0, 8).map((e: any, i: number) => (
                    <div key={i} className="flex items-center gap-2 text-xs py-1">
                      <span className="text-text-muted">{RELATION_LABELS[e.relation] || e.relation}</span>
                      <span className="text-white">{e.target.name}</span>
                      {e.weight > 1 && <span className="text-primary text-[10px]">×{e.weight}</span>}
                    </div>
                  ))}
                </div>
              )}

              {selectedNode.incoming?.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-text-muted mb-1">← 연결 소스</p>
                  {selectedNode.incoming.slice(0, 8).map((e: any, i: number) => (
                    <div key={i} className="flex items-center gap-2 text-xs py-1">
                      <span className="text-white">{e.source.name}</span>
                      <span className="text-text-muted">{RELATION_LABELS[e.relation] || e.relation}</span>
                      {e.weight > 1 && <span className="text-primary text-[10px]">×{e.weight}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* AI 인사이트 */}
          {insights?.insights?.length > 0 && (
            <div className="bg-bg-card rounded-lg p-4 border border-bg-input/50">
              <h3 className="font-medium text-white mb-3">💡 AI 인사이트</h3>
              <div className="space-y-3">
                {insights.insights.slice(0, 5).map((insight: any, i: number) => (
                  <div key={i} className="text-sm">
                    <p className="text-white font-medium text-xs">{insight.title}</p>
                    <p className="text-text-muted text-xs mt-0.5">{insight.description}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 범례 */}
          <div className="bg-bg-card rounded-lg p-4 border border-bg-input/50">
            <h3 className="font-medium text-white mb-3 text-sm">범례</h3>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(TYPE_LABELS).map(([type, label]) => (
                <div key={type} className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: TYPE_COLORS[type] }} />
                  <span className="text-xs text-text-muted">{label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 허브 엔티티 */}
          {insights?.topEntities?.length > 0 && (
            <div className="bg-bg-card rounded-lg p-4 border border-bg-input/50">
              <h3 className="font-medium text-white mb-3 text-sm">🏆 핵심 엔티티</h3>
              {insights.topEntities.map((e: any, i: number) => (
                <div key={i} className="flex items-center justify-between py-1">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: TYPE_COLORS[e.type] }} />
                    <span className="text-xs text-white">{e.name}</span>
                  </div>
                  <span className="text-xs text-text-muted">{e.connections}개 연결</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
