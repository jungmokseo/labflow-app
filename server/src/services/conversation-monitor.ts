/**
 * Conversation Monitor Service
 *
 * LangChain realtime-phone-agents의 Opik 모니터링에서 차용.
 * Supabase에 턴별 latency, tool call 결과, 에러를 추적.
 * 대화 품질 분석 및 디버깅을 위한 구조화된 로그.
 */

import { PrismaClient } from '@prisma/client';

// Supabase 직접 연결 (pgvector 확장 포함)
// Prisma가 아닌 raw SQL로 vector 작업 처리
import { env } from '../config/env.js';

export interface ConversationTurn {
  sessionId: string;
  personaId: string;
  userId?: string;
  turnIndex: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  audioLengthMs?: number;
  latencyMs?: number;
  toolCalls?: ToolCallLog[];
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolCallLog {
  toolName: string;
  input: Record<string, unknown>;
  output?: unknown;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface SessionSummary {
  sessionId: string;
  personaId: string;
  userId?: string;
  startedAt: Date;
  endedAt?: Date;
  totalTurns: number;
  avgLatencyMs: number;
  totalToolCalls: number;
  errorCount: number;
  language: string;
}

class ConversationMonitor {
  private turns: Map<string, ConversationTurn[]> = new Map();
  private sessionStarts: Map<string, Date> = new Map();

  /**
   * 새 대화 세션 시작
   */
  startSession(sessionId: string, personaId: string, userId?: string): void {
    this.turns.set(sessionId, []);
    this.sessionStarts.set(sessionId, new Date());
    console.log(`[Monitor] Session started: ${sessionId} (persona: ${personaId})`);
  }

  /**
   * 대화 턴 기록
   */
  logTurn(turn: ConversationTurn): void {
    const sessionTurns = this.turns.get(turn.sessionId) || [];
    sessionTurns.push({ ...turn, turnIndex: sessionTurns.length });
    this.turns.set(turn.sessionId, sessionTurns);

    // 에러 발생 시 경고
    if (turn.error) {
      console.warn(`[Monitor] Error in session ${turn.sessionId}, turn ${turn.turnIndex}: ${turn.error}`);
    }

    // 높은 레이턴시 경고 (2초 이상)
    if (turn.latencyMs && turn.latencyMs > 2000) {
      console.warn(`[Monitor] High latency in session ${turn.sessionId}: ${turn.latencyMs}ms`);
    }
  }

  /**
   * Tool call 기록 (RAG 검색 등)
   */
  logToolCall(sessionId: string, toolCall: ToolCallLog): void {
    const sessionTurns = this.turns.get(sessionId);
    if (!sessionTurns || sessionTurns.length === 0) return;

    const lastTurn = sessionTurns[sessionTurns.length - 1];
    if (!lastTurn.toolCalls) lastTurn.toolCalls = [];
    lastTurn.toolCalls.push(toolCall);
  }

  /**
   * 세션 요약 생성
   */
  getSessionSummary(sessionId: string, personaId: string, userId?: string): SessionSummary {
    const sessionTurns = this.turns.get(sessionId) || [];
    const startedAt = this.sessionStarts.get(sessionId) || new Date();

    const latencies = sessionTurns
      .filter(t => t.latencyMs !== undefined)
      .map(t => t.latencyMs!);

    const totalToolCalls = sessionTurns.reduce(
      (sum, t) => sum + (t.toolCalls?.length || 0), 0
    );

    const errorCount = sessionTurns.filter(t => t.error).length;

    return {
      sessionId,
      personaId,
      userId,
      startedAt,
      endedAt: new Date(),
      totalTurns: sessionTurns.length,
      avgLatencyMs: latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : 0,
      totalToolCalls,
      errorCount,
      language: this.detectLanguage(sessionTurns),
    };
  }

  /**
   * 세션 종료 및 Supabase에 저장을 위한 데이터 반환
   */
  endSession(sessionId: string, personaId: string, userId?: string): {
    summary: SessionSummary;
    turns: ConversationTurn[];
  } {
    const summary = this.getSessionSummary(sessionId, personaId, userId);
    const turns = this.turns.get(sessionId) || [];

    // 메모리 정리
    this.turns.delete(sessionId);
    this.sessionStarts.delete(sessionId);

    console.log(`[Monitor] Session ended: ${sessionId} — ${summary.totalTurns} turns, avg ${summary.avgLatencyMs}ms`);

    return { summary, turns };
  }

  /**
   * 대화 언어 감지 (간이)
   */
  private detectLanguage(turns: ConversationTurn[]): string {
    const userTurns = turns.filter(t => t.role === 'user');
    if (userTurns.length === 0) return 'unknown';

    const allText = userTurns.map(t => t.content).join(' ');
    const koreanChars = (allText.match(/[\uAC00-\uD7AF]/g) || []).length;
    const totalChars = allText.length;

    return koreanChars / totalChars > 0.3 ? 'ko' : 'en';
  }
}

// 싱글톤 인스턴스
export const conversationMonitor = new ConversationMonitor();
