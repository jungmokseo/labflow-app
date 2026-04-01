'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  getEmailStatus, getEmailAuthUrl, getEmailProfile, checkHealth,
  getLabProfile, updateLab, getLabMembers, addLabMember, removeLabMember,
  getLabDictionary, addDictEntry, getLabCompleteness,
  updateEmailProfile, LabProfile,
} from '@/lib/api';

type Tab = 'status' | 'lab' | 'email' | 'dictionary';

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('status');
  const [health, setHealth] = useState<boolean | null>(null);
  const [emailConnected, setEmailConnected] = useState(false);
  const [lab, setLab] = useState<LabProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [h, emailRes, labRes] = await Promise.allSettled([
          checkHealth(),
          getEmailStatus(),
          getLabProfile(),
        ]);
        if (h.status === 'fulfilled') setHealth(h.value);
        if (emailRes.status === 'fulfilled') setEmailConnected(emailRes.value.connected);
        if (labRes.status === 'fulfilled') setLab(labRes.value as any);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  const TABS: { key: Tab; label: string; icon: string }[] = [
    { key: 'status', label: '시스템 상태', icon: '📊' },
    { key: 'lab', label: '연구실 프로필', icon: '🔬' },
    { key: 'email', label: '이메일 분류', icon: '📧' },
    { key: 'dictionary', label: '용어 사전', icon: '📖' },
  ];

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-white">⚙️ 설정</h2>
        <p className="text-text-muted mt-1">ResearchFlow 시스템 설정 및 프로필 관리</p>
      </div>

      {/* Tab Navigation */}
      <div className="flex gap-1 bg-bg-card rounded-lg p-1 border border-bg-input/50">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors
              ${tab === t.key ? 'bg-primary text-white' : 'text-text-muted hover:text-white hover:bg-bg-input/50'}`}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === 'status' && <StatusTab health={health} emailConnected={emailConnected} lab={lab} />}
      {tab === 'lab' && <LabTab lab={lab} onUpdate={setLab} />}
      {tab === 'email' && <EmailTab connected={emailConnected} />}
      {tab === 'dictionary' && <DictionaryTab />}
    </div>
  );
}

// ── Status Tab ──────────────────────────────────
function StatusTab({ health, emailConnected, lab }: { health: boolean | null; emailConnected: boolean; lab: LabProfile | null }) {
  const handleConnectGmail = async () => {
    try {
      const res = await getEmailAuthUrl();
      window.open(res.url, '_blank');
    } catch (err) {
      console.error('Failed to get auth URL:', err);
    }
  };

  return (
    <div className="space-y-4">
      <section className="bg-bg-card rounded-xl border border-bg-input/50 p-5 space-y-4">
        <h3 className="font-semibold text-white text-sm">시스템 상태</h3>
        <div className="grid grid-cols-2 gap-4">
          <StatusItem label="API 서버" status={health === true ? 'healthy' : 'error'} detail="Railway" />
          <StatusItem label="Gmail" status={emailConnected ? 'healthy' : 'disconnected'} detail={emailConnected ? '연동됨' : '미연동'} />
          <StatusItem label="연구실" status={lab ? 'healthy' : 'disconnected'} detail={lab ? lab.name : '미설정'} />
          <StatusItem label="AI 모델" status="info" detail="Gemini Flash + Claude Sonnet" />
        </div>
        {!emailConnected && (
          <button onClick={handleConnectGmail} className="px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium">
            Gmail 연동하기
          </button>
        )}
        {!lab && (
          <a href="/onboarding" className="inline-block px-4 py-2 bg-primary hover:bg-primary-hover text-white rounded-lg text-sm font-medium">
            온보딩 시작
          </a>
        )}
      </section>
    </div>
  );
}

// ── Lab Profile Tab ─────────────────────────────
function LabTab({ lab, onUpdate }: { lab: LabProfile | null; onUpdate: (l: LabProfile) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(lab?.name || '');
  const [institution, setInstitution] = useState(lab?.institution || '');
  const [department, setDepartment] = useState(lab?.department || '');
  const [themes, setThemes] = useState<Array<{ name: string; keywords: string; journals: string }>>(
    (lab?.researchThemes || []).map(t => ({
      name: t.name,
      keywords: t.keywords.join(', '),
      journals: (t.journals || []).join(', '),
    }))
  );
  const [instructions, setInstructions] = useState((lab as any)?.instructions || '');
  const [members, setMembers] = useState<Array<{ id: string; name: string; email: string; role: string }>>([]);
  const [newMember, setNewMember] = useState({ name: '', email: '', role: '학생' });
  const [saving, setSaving] = useState(false);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [memberLoaded, setMemberLoaded] = useState(false);

  const loadMembers = useCallback(async () => {
    try {
      const res = await getLabMembers();
      setMembers(Array.isArray(res) ? res : (res as any).data || []);
      setMemberLoaded(true);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { if (lab) loadMembers(); }, [lab, loadMembers]);

  if (!lab) {
    return (
      <div className="bg-bg-card rounded-xl border border-bg-input/50 p-12 text-center">
        <span className="text-5xl block mb-3">🔬</span>
        <h3 className="text-lg font-semibold text-white mb-2">연구실이 등록되지 않았습니다</h3>
        <a href="/onboarding" className="inline-block px-6 py-3 bg-primary text-white rounded-lg font-medium mt-4">온보딩 시작</a>
      </div>
    );
  }

  const handleSave = async () => {
    setSaving(true);
    try {
      const validThemes = themes.filter(t => t.name.trim()).map(t => ({
        name: t.name.trim(),
        keywords: t.keywords.split(',').map(k => k.trim()).filter(Boolean),
        journals: t.journals ? t.journals.split(',').map(j => j.trim()).filter(Boolean) : [],
      }));

      const updated = await updateLab({
        name, institution, department,
        researchThemes: validThemes,
        researchFields: validThemes.flatMap(t => t.keywords),
      });
      onUpdate(updated as any);
      setEditing(false);
    } catch (err) {
      console.error('Save failed:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleAddMember = async () => {
    if (!newMember.name.trim()) return;
    try {
      await addLabMember(newMember);
      setNewMember({ name: '', email: '', role: '학생' });
      loadMembers();
    } catch (err) {
      console.error('Add member failed:', err);
    }
  };

  const handleRemoveMember = async (id: string) => {
    try {
      await removeLabMember(id);
      loadMembers();
    } catch (err) {
      console.error('Remove member failed:', err);
    }
  };

  return (
    <div className="space-y-4">
      {/* Lab Info */}
      <section className="bg-bg-card rounded-xl border border-bg-input/50 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-white text-sm">연구실 정보</h3>
          <button onClick={() => setEditing(!editing)} className="text-xs text-primary hover:text-primary-hover">
            {editing ? '취소' : '편집'}
          </button>
        </div>
        {editing ? (
          <div className="space-y-3">
            <SInput label="연구실 이름" value={name} onChange={setName} />
            <SInput label="소속 기관" value={institution} onChange={setInstitution} />
            <SInput label="학과" value={department} onChange={setDepartment} />
            <button onClick={handleSave} disabled={saving} className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium disabled:opacity-50">
              {saving ? '저장 중...' : '저장'}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><span className="text-text-muted">이름:</span> <span className="text-white">{lab.name}</span></div>
            <div><span className="text-text-muted">기관:</span> <span className="text-white">{lab.institution || '-'}</span></div>
            <div><span className="text-text-muted">학과:</span> <span className="text-white">{lab.department || '-'}</span></div>
            <div><span className="text-text-muted">온보딩:</span> <span className={lab.onboardingDone ? 'text-green-400' : 'text-yellow-400'}>{lab.onboardingDone ? '완료' : '미완료'}</span></div>
          </div>
        )}
      </section>

      {/* Research Themes — 독립 편집 */}
      <section className="bg-bg-card rounded-xl border border-bg-input/50 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-white text-sm">연구 테마 (이메일 분류 + 논문 모니터링 연동)</h3>
          {!editing && (
            <button onClick={() => setEditing(true)} className="text-xs text-primary hover:text-primary-hover">
              편집
            </button>
          )}
        </div>
        {themes.length === 0 && !editing && (
          <div className="text-center py-6">
            <p className="text-text-muted text-sm mb-3">연구 테마가 등록되지 않았습니다</p>
            <button onClick={() => { setEditing(true); setThemes([{ name: '', keywords: '', journals: '' }]); }}
              className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium">
              + 연구 테마 추가
            </button>
          </div>
        )}
        {(editing ? themes : (lab.researchThemes || []).map(t => ({
          name: t.name, keywords: t.keywords.join(', '), journals: (t.journals || []).join(', ')
        }))).map((theme, i) => (
          <div key={i} className="bg-bg/50 rounded-lg p-3 space-y-2">
            {editing ? (
              <>
                <SInput label={`테마 ${i+1}`} value={theme.name} onChange={v => { const n = [...themes]; n[i].name = v; setThemes(n); }} />
                <SInput label="키워드 (쉼표 구분)" value={theme.keywords} onChange={v => { const n = [...themes]; n[i].keywords = v; setThemes(n); }} placeholder="hydrogel, self-healing, tough hydrogel" />
                <SInput label="관련 저널 (선택)" value={theme.journals} onChange={v => { const n = [...themes]; n[i].journals = v; setThemes(n); }} placeholder="Adv. Mater., Nat. Mater." />
                <button onClick={() => setThemes(themes.filter((_, j) => j !== i))} className="text-xs text-red-400 hover:text-red-300">삭제</button>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-white">{theme.name}</p>
                <p className="text-xs text-text-muted">키워드: {theme.keywords}</p>
                {theme.journals && <p className="text-xs text-text-muted">저널: {theme.journals}</p>}
              </>
            )}
          </div>
        ))}
        {editing && (
          <div className="flex items-center gap-3">
            <button onClick={() => setThemes([...themes, { name: '', keywords: '', journals: '' }])} className="text-xs text-primary">+ 테마 추가</button>
            <button onClick={handleSave} disabled={saving} className="px-4 py-2 bg-primary text-white rounded-lg text-xs font-medium disabled:opacity-50 ml-auto">
              {saving ? '저장 중...' : '저장'}
            </button>
          </div>
        )}
      </section>

      {/* Instructions (claude.md 스타일) */}
      <section className="bg-bg-card rounded-xl border border-bg-input/50 p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-white text-sm">AI 지침</h3>
            <p className="text-xs text-text-muted mt-0.5">Brain 응답 시 항상 참조되는 사용자 지침 (claude.md 방식)</p>
          </div>
          <button
            onClick={async () => {
              setSavingInstructions(true);
              try {
                const updated = await updateLab({ instructions } as any);
                onUpdate(updated as any);
              } catch (err) { console.error('Save instructions failed:', err); }
              finally { setSavingInstructions(false); }
            }}
            disabled={savingInstructions}
            className="text-xs px-3 py-1.5 bg-primary text-white rounded-lg disabled:opacity-50"
          >
            {savingInstructions ? '저장 중...' : '저장'}
          </button>
        </div>
        <textarea
          value={instructions}
          onChange={e => setInstructions(e.target.value)}
          rows={8}
          placeholder={`예시:\n- 한국어로 답변해줘\n- 논문 요약은 3문장 이내로\n- 학생 이름은 존칭 없이\n- 과제 정보 물어보면 사사 문구도 같이 알려줘\n- 이메일 브리핑은 긴급한 것만 먼저`}
          className="w-full px-4 py-3 bg-bg-input rounded-lg text-white text-sm border border-bg-input/50 focus:border-primary outline-none placeholder:text-text-muted/50 resize-none font-mono"
        />
      </section>

      {/* Members */}
      <section className="bg-bg-card rounded-xl border border-bg-input/50 p-5 space-y-4">
        <h3 className="font-semibold text-white text-sm">팀원 ({members.length}명)</h3>
        {members.map(m => (
          <div key={m.id} className="flex items-center justify-between bg-bg/50 rounded-lg p-3">
            <div>
              <span className="text-sm text-white font-medium">{m.name}</span>
              <span className="text-xs text-text-muted ml-2">{m.role}</span>
              {m.email && <span className="text-xs text-primary ml-2">{m.email}</span>}
            </div>
            <button onClick={() => handleRemoveMember(m.id)} className="text-xs text-red-400 hover:text-red-300">삭제</button>
          </div>
        ))}
        <div className="flex gap-2">
          <input value={newMember.name} onChange={e => setNewMember({...newMember, name: e.target.value})} placeholder="이름" className="flex-1 px-3 py-1.5 bg-bg-input rounded text-sm text-white border border-bg-input/50" />
          <input value={newMember.email} onChange={e => setNewMember({...newMember, email: e.target.value})} placeholder="이메일" className="flex-1 px-3 py-1.5 bg-bg-input rounded text-sm text-white border border-bg-input/50" />
          <button onClick={handleAddMember} className="px-3 py-1.5 bg-primary text-white rounded text-sm">추가</button>
        </div>
      </section>
    </div>
  );
}

// ── Email Classification Tab ─────────────────────
function EmailTab({ connected }: { connected: boolean }) {
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [keywords, setKeywords] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');
  const [groups, setGroups] = useState<Array<{ name: string; domains: string; emoji: string }>>([]);

  useEffect(() => {
    async function load() {
      try {
        const res = await getEmailProfile();
        const p = (res as any).data || res;
        setProfile(p);
        setKeywords((p.keywords || []).join(', '));
        setTimezone(p.timezone || 'America/New_York');
        setGroups((p.groups || []).map((g: any) => ({
          name: g.name, domains: g.domains.join(', '), emoji: g.emoji || '📧',
        })));
      } catch { /* no profile */ }
      setLoading(false);
    }
    if (connected) load();
    else setLoading(false);
  }, [connected]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateEmailProfile({
        classifyByGroup: groups.length > 0,
        groups: groups.filter(g => g.name.trim()).map(g => ({
          name: g.name.trim(),
          domains: g.domains.split(',').map(d => d.trim()).filter(Boolean),
          emoji: g.emoji,
        })),
        keywords: keywords.split(',').map(k => k.trim()).filter(Boolean),
        timezone,
      } as any);
    } catch (err) {
      console.error('Save failed:', err);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="text-text-muted text-center py-8">로딩 중...</div>;

  return (
    <div className="space-y-4">
      <section className="bg-bg-card rounded-xl border border-bg-input/50 p-5 space-y-4">
        <h3 className="font-semibold text-white text-sm">기관별 분류 그룹</h3>
        <p className="text-xs text-text-muted">발신자 이메일 도메인 기반으로 기관별 자동 분류</p>
        {groups.map((g, i) => (
          <div key={i} className="grid grid-cols-[3rem_1fr_2fr] gap-2 items-end">
            <div>
              <label className="block text-xs text-text-muted mb-1">이모지</label>
              <input value={g.emoji} onChange={e => { const n = [...groups]; n[i].emoji = e.target.value; setGroups(n); }}
                className="w-full px-2 py-1.5 bg-bg-input rounded text-sm text-white text-center border border-bg-input/50" />
            </div>
            <SInput label="기관명" value={g.name} onChange={v => { const n = [...groups]; n[i].name = v; setGroups(n); }} />
            <SInput label="도메인 (쉼표)" value={g.domains} onChange={v => { const n = [...groups]; n[i].domains = v; setGroups(n); }} />
          </div>
        ))}
        <button onClick={() => setGroups([...groups, { name: '', domains: '', emoji: '🏫' }])} className="text-xs text-primary">+ 기관 추가</button>
      </section>

      <section className="bg-bg-card rounded-xl border border-bg-input/50 p-5 space-y-4">
        <h3 className="font-semibold text-white text-sm">중요도 상향 키워드</h3>
        <p className="text-xs text-text-muted">이 키워드가 이메일 제목/내용에 포함되면 중요도 1단계 상향</p>
        <SInput label="키워드 (쉼표 구분)" value={keywords} onChange={setKeywords} />
      </section>

      <section className="bg-bg-card rounded-xl border border-bg-input/50 p-5 space-y-4">
        <h3 className="font-semibold text-white text-sm">시간대</h3>
        <select value={timezone} onChange={e => setTimezone(e.target.value)}
          className="px-3 py-2 bg-bg-input rounded-lg text-white text-sm border border-bg-input/50">
          <option value="America/New_York">미국 동부 (EDT/EST)</option>
          <option value="America/Los_Angeles">미국 서부 (PDT/PST)</option>
          <option value="Asia/Seoul">한국 (KST)</option>
          <option value="Europe/London">영국 (GMT/BST)</option>
          <option value="UTC">UTC</option>
        </select>
      </section>

      <button onClick={handleSave} disabled={saving}
        className="w-full py-3 bg-primary hover:bg-primary-hover text-white rounded-lg font-medium disabled:opacity-50">
        {saving ? '저장 중...' : '이메일 설정 저장'}
      </button>
    </div>
  );
}

// ── Dictionary Tab ───────────────────────────────
function DictionaryTab() {
  const [entries, setEntries] = useState<Array<{ id: string; wrongForm: string; correctForm: string; category: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [newWrong, setNewWrong] = useState('');
  const [newCorrect, setNewCorrect] = useState('');

  const loadDict = useCallback(async () => {
    try {
      const res = await getLabDictionary();
      setEntries(Array.isArray(res) ? res : (res as any).data || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadDict(); }, [loadDict]);

  const handleAdd = async () => {
    if (!newWrong.trim() || !newCorrect.trim()) return;
    try {
      await addDictEntry({ wrongForm: newWrong.trim(), correctForm: newCorrect.trim() });
      setNewWrong('');
      setNewCorrect('');
      loadDict();
    } catch (err) {
      console.error('Add dict entry failed:', err);
    }
  };

  return (
    <div className="space-y-4">
      <section className="bg-bg-card rounded-xl border border-bg-input/50 p-5 space-y-4">
        <h3 className="font-semibold text-white text-sm">기술 용어 사전 ({entries.length}개)</h3>
        <p className="text-xs text-text-muted">미팅 노트 교정, 논문 교정에서 공유되는 도메인 용어 사전</p>

        <div className="flex gap-2">
          <input value={newWrong} onChange={e => setNewWrong(e.target.value)} placeholder="잘못된 표기"
            className="flex-1 px-3 py-1.5 bg-bg-input rounded text-sm text-white border border-bg-input/50" />
          <span className="text-text-muted self-center">→</span>
          <input value={newCorrect} onChange={e => setNewCorrect(e.target.value)} placeholder="올바른 표기"
            className="flex-1 px-3 py-1.5 bg-bg-input rounded text-sm text-white border border-bg-input/50" />
          <button onClick={handleAdd} className="px-3 py-1.5 bg-primary text-white rounded text-sm">추가</button>
        </div>

        {loading ? (
          <p className="text-text-muted text-sm text-center py-4">로딩 중...</p>
        ) : entries.length === 0 ? (
          <p className="text-text-muted text-sm text-center py-4">등록된 용어가 없습니다</p>
        ) : (
          <div className="max-h-80 overflow-y-auto space-y-1">
            {entries.map(e => (
              <div key={e.id} className="flex items-center justify-between bg-bg/50 rounded px-3 py-2">
                <span className="text-sm">
                  <span className="text-red-400 line-through">{e.wrongForm}</span>
                  <span className="text-text-muted mx-2">→</span>
                  <span className="text-green-400">{e.correctForm}</span>
                </span>
                {e.category && <span className="text-xs text-text-muted">{e.category}</span>}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ── Shared Components ────────────────────────────
function StatusItem({ label, status, detail }: { label: string; status: string; detail: string }) {
  const colors: Record<string, string> = {
    healthy: 'bg-green-400', error: 'bg-red-400', disconnected: 'bg-gray-500', info: 'bg-blue-400',
  };
  return (
    <div className="flex items-center gap-3 bg-bg/50 rounded-lg p-3">
      <span className={`w-2.5 h-2.5 rounded-full ${colors[status] || 'bg-gray-400'}`} />
      <div>
        <p className="text-xs font-medium text-white">{label}</p>
        <p className="text-[10px] text-text-muted">{detail}</p>
      </div>
    </div>
  );
}

function SInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <label className="block text-xs text-text-muted mb-1">{label}</label>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="w-full px-3 py-1.5 bg-bg-input rounded-lg text-white text-sm border border-bg-input/50 focus:border-primary outline-none placeholder:text-text-muted/50" />
    </div>
  );
}
