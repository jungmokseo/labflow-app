import { useState } from 'react';
import { useToast } from '@/components/Toast';
import { updateManuscript, type Manuscript, type ManuscriptUpdatePayload } from '@/lib/api';
import { Loader2, Pencil, X } from 'lucide-react';

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-text-muted uppercase tracking-wider mb-1">{label}</label>
      {children}
    </div>
  );
}

interface EditModalProps {
  m: Manuscript;
  onClose: () => void;
  onSaved: () => void;
}

/** 편집 modal — 모든 필드 in-place 수정 (DB + 노션 동시 갱신) */
export function EditModal({ m, onClose, onSaved }: EditModalProps) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  // 폼 state — 빈 문자열은 null로 변환해서 저장
  const [form, setForm] = useState({
    title: m.title || '',
    stage: m.stage,
    whoseTurn: (m.whoseTurn || '') as '' | 'PI' | '학생' | '저널',
    firstAuthors: m.firstAuthors || '',
    piRole: (m.piRole || '') as '' | '교신' | '공저',
    currentJournal: m.currentJournal || '',
    impactFactor: m.impactFactor !== null ? String(m.impactFactor) : '',
    attempts: m.attempts !== null ? String(m.attempts) : '',
    rejectHistory: m.rejectHistory || '',
    manuscriptNum: m.manuscriptNum || '',
    submittedAt: m.submittedAt ? m.submittedAt.slice(0, 10) : '',
    revisionDueAt: m.revisionDueAt ? m.revisionDueAt.slice(0, 10) : '',
    publishedAt: m.publishedAt ? m.publishedAt.slice(0, 10) : '',
    doi: m.doi || '',
    memo: m.memo || '',
  });

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload: ManuscriptUpdatePayload = {
        title: form.title.trim(),
        stage: form.stage,
        whoseTurn: form.whoseTurn || null,
        firstAuthors: form.firstAuthors.trim() || null,
        piRole: form.piRole || null,
        currentJournal: form.currentJournal.trim() || null,
        impactFactor: form.impactFactor ? Number(form.impactFactor) : null,
        attempts: form.attempts ? Number(form.attempts) : null,
        rejectHistory: form.rejectHistory.trim() || null,
        manuscriptNum: form.manuscriptNum.trim() || null,
        submittedAt: form.submittedAt || null,
        revisionDueAt: form.revisionDueAt || null,
        publishedAt: form.publishedAt || null,
        doi: form.doi.trim() || null,
        memo: form.memo.trim() || null,
      };
      const r = await updateManuscript(m.id, payload);
      toast(r.notionUpdated ? '저장 완료 · 노션 갱신' : '저장 완료 (노션 갱신 실패 — 다음 sync에서 재시도)', 'success');
      onSaved();
      onClose();
    } catch (e: any) {
      toast(`저장 실패: ${e.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-3 md:p-4"
      onClick={onClose}
    >
      <div
        className="bg-bg-card rounded-2xl shadow-xl border border-border w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-bg-card">
          <h3 className="text-base md:text-lg font-bold text-text-heading flex items-center gap-2">
            <Pencil className="w-4 h-4" /> 논문 편집
          </h3>
          <button onClick={onClose} className="p-1 hover:bg-bg-hover rounded-lg">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <FormField label="제목">
            <input
              value={form.title}
              onChange={e => setForm({ ...form, title: e.target.value })}
              className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </FormField>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="단계">
              <select
                value={form.stage}
                onChange={e => setForm({ ...form, stage: e.target.value as Manuscript['stage'] })}
                className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="작성">작성 (준비중)</option>
                <option value="심사 중">심사 중 (제출됨)</option>
                <option value="대응 중">대응 중 (리비전)</option>
                <option value="억셉">억셉</option>
                <option value="게재 완료">게재 완료</option>
              </select>
            </FormField>
            <FormField label="차례">
              <select
                value={form.whoseTurn}
                onChange={e => setForm({ ...form, whoseTurn: e.target.value as any })}
                className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">없음</option>
                <option value="PI">PI</option>
                <option value="학생">학생</option>
                <option value="저널">저널</option>
              </select>
            </FormField>
          </div>

          <FormField label="1저자 학생 (콤마 구분 — 여러명 가능)">
            <input
              value={form.firstAuthors}
              onChange={e => setForm({ ...form, firstAuthors: e.target.value })}
              placeholder="예: 김수아, 윤민"
              className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </FormField>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="PI 역할">
              <select
                value={form.piRole}
                onChange={e => setForm({ ...form, piRole: e.target.value as any })}
                className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="">미지정</option>
                <option value="교신">교신</option>
                <option value="공저">공저</option>
              </select>
            </FormField>
            <FormField label="현재/타겟 저널">
              <input
                value={form.currentJournal}
                onChange={e => setForm({ ...form, currentJournal: e.target.value })}
                placeholder="예: Advanced Materials"
                className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </FormField>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <FormField label="Impact Factor">
              <input
                type="number"
                step="0.1"
                value={form.impactFactor}
                onChange={e => setForm({ ...form, impactFactor: e.target.value })}
                className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </FormField>
            <FormField label="시도 횟수">
              <input
                type="number"
                min="1"
                value={form.attempts}
                onChange={e => setForm({ ...form, attempts: e.target.value })}
                className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </FormField>
            <FormField label="Manuscript ID">
              <input
                value={form.manuscriptNum}
                onChange={e => setForm({ ...form, manuscriptNum: e.target.value })}
                placeholder="nn-2026-..."
                className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm font-mono text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </FormField>
          </div>

          <FormField label="리젝 이력">
            <input
              value={form.rejectHistory}
              onChange={e => setForm({ ...form, rejectHistory: e.target.value })}
              placeholder="예: Nano Today (2026-04 reject)"
              className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </FormField>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <FormField label="제출일">
              <input
                type="date"
                value={form.submittedAt}
                onChange={e => setForm({ ...form, submittedAt: e.target.value })}
                className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </FormField>
            <FormField label="리비전 마감">
              <input
                type="date"
                value={form.revisionDueAt}
                onChange={e => setForm({ ...form, revisionDueAt: e.target.value })}
                className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </FormField>
            <FormField label="게재일">
              <input
                type="date"
                value={form.publishedAt}
                onChange={e => setForm({ ...form, publishedAt: e.target.value })}
                className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </FormField>
          </div>

          <FormField label="DOI">
            <input
              value={form.doi}
              onChange={e => setForm({ ...form, doi: e.target.value })}
              placeholder="https://doi.org/10..."
              className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </FormField>

          <FormField label="메모">
            <textarea
              value={form.memo}
              onChange={e => setForm({ ...form, memo: e.target.value })}
              rows={3}
              className="w-full px-3 py-2 bg-bg-input border border-border rounded-lg text-sm text-text-heading focus:outline-none focus:ring-2 focus:ring-primary resize-none"
            />
          </FormField>
        </div>
        <div className="flex gap-2 p-4 border-t border-border sticky bottom-0 bg-bg-card">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 rounded-lg border border-border text-sm hover:bg-bg-hover"
          >
            취소
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
