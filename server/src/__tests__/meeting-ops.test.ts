import { describe, it, expect } from 'vitest';
import {
  buildMeetingOpsPacket,
  buildTaskCandidate,
  parseActionDueDate,
} from '../services/meeting-ops.js';

describe('meeting operations packet', () => {
  const baseDate = new Date('2026-05-19T10:00:00');

  it('parses explicit and Korean due dates', () => {
    expect(parseActionDueDate('IRB 자료를 2026-05-22까지 정리', baseDate).dueDate).toBe('2026-05-22');
    expect(parseActionDueDate('시제품 사진은 6월 3일까지 업로드', baseDate).dueDate).toBe('2026-06-03');
  });

  it('parses relative Korean due dates from the meeting date', () => {
    expect(parseActionDueDate('내일까지 Slack에 공유', baseDate).dueDate).toBe('2026-05-20');
    expect(parseActionDueDate('다음 주까지 병원 미팅 아젠다 준비', baseDate).dueDate).toBe('2026-05-26');
  });

  it('parses Korean weekday deadlines and rolls month/day dates into next year when needed', () => {
    expect(parseActionDueDate('이번 주 금요일까지 실험 사진 공유', baseDate).dueDate).toBe('2026-05-22');
    expect(parseActionDueDate('다음 주 금요일까지 IRB 초안 작성', baseDate).dueDate).toBe('2026-05-29');
    expect(parseActionDueDate('1월 5일까지 연차 계획 정리', new Date('2026-12-20T10:00:00')).dueDate).toBe('2027-01-05');
    expect(parseActionDueDate('1/5까지 샘플 수량 확인', new Date('2026-12-20T10:00:00')).dueDate).toBe('2027-01-05');
  });

  it('extracts owner, due date, and priority from an action item', () => {
    const task = buildTaskCandidate('김태영: 내일까지 IRB 클라우드 업로드 확인', 'action_item', 0, baseDate);
    expect(task).not.toBeNull();
    expect(task?.ownerName).toBe('김태영');
    expect(task?.title).toBe('내일까지 IRB 클라우드 업로드 확인');
    expect(task?.dueDate).toBe('2026-05-20');
    expect(task?.priority).toBe('HIGH');
    expect(task?.reviewReason).toContain('owner_inferred');
  });

  it('extracts natural Korean owner expressions from meeting speech', () => {
    const subjectTask = buildTaskCandidate('김수아 학생이 이번 주 금요일까지 샘플 사진 업로드', 'action_item', 1, baseDate);
    expect(subjectTask?.ownerName).toBe('김수아');
    expect(subjectTask?.title).toBe('이번 주 금요일까지 샘플 사진 업로드');
    expect(subjectTask?.dueDate).toBe('2026-05-22');
    expect(subjectTask?.reviewReason).toContain('owner_inferred');

    const looseTask = buildTaskCandidate('담당자 김민경 6월 3일까지 장비 예약 확인', 'action_item', 2, baseDate);
    expect(looseTask?.ownerName).toBe('김민경');
    expect(looseTask?.dueDate).toBe('2026-06-03');
  });

  it('builds decisions, task candidates, and integration events for operations', () => {
    const packet = buildMeetingOpsPacket({
      title: 'LM Team Weekly',
      createdAt: baseDate,
      team: 'LM Team',
      participants: ['A', 'B'],
      agenda: ['PDA-LM 진행상황'],
      decisions: ['PDA-LM spray ink는 2차 샘플까지 진행하기로 확정'],
      discussions: [
        {
          topic: 'PDA-LM',
          bullets: ['2차 샘플 조건은 기존 농도에서 점도를 낮추는 방향으로 결정'],
        },
      ],
      actionItems: [
        '담당: 김수아, 2026-05-22까지 점도 데이터 정리',
        '다음 주까지 샘플 사진 업로드',
      ],
      nextSteps: ['다음 회의에서 전기적 안정성 결과 확인'],
    });

    expect(packet.decisions).toContain('PDA-LM spray ink는 2차 샘플까지 진행하기로 확정');
    expect(packet.taskCandidates).toHaveLength(3);
    expect(packet.taskCandidates[2].source).toBe('next_step');
    expect(packet.taskCandidates[0].ownerName).toBe('김수아');
    expect(packet.taskCandidates[0].title).toBe('2026-05-22까지 점도 데이터 정리');
    expect(packet.taskCandidates[0].dueDate).toBe('2026-05-22');
    expect(packet.integrationEvents.find(e => e.target === 'tasks')?.status).toBe('queued');
    expect(packet.integrationEvents.find(e => e.target === 'knowledge')?.count).toBeGreaterThan(0);
    expect(packet.readiness.score).toBeGreaterThanOrEqual(70);
  });
});
