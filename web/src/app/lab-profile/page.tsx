'use client';

import { useState, useEffect } from 'react';
import { getLabProfile, createLab, updateLab, addLabMember, addLabProject, addDictEntry, completeOnboarding, type Lab } from '@/lib/api';

export default function LabProfilePage() {
  const [lab, setLab] = useState<Lab | null>(null);
  const [loading, setLoading] = useState(true);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [error, setError] = useState('');

  // 온보딩 폼
  const [labName, setLabName] = useState('');
  const [institution, setInstitution] = useState('');
  const [department, setDepartment] = useState('');
  const [piName, setPiName] = useState('');
  const [homepageUrl, setHomepageUrl] = useState('');
  const [manualKeywords, setManualKeywords] = useState('');

  // 추가 폼
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberRole, setNewMemberRole] = useState('학생');
  const [newMemberEmail, setNewMemberEmail] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectFunder, setNewProjectFunder] = useState('');
  const [newDictWrong, setNewDictWrong] = useState('');
  const [newDictCorrect, setNewDictCorrect] = useState('');

  const [tab, setTab] = useState<'info' | 'members' | 'projects' | 'dict'>('info');

  useEffect(() => {
    loadProfile();
  }, []);

  async function loadProfile() {
    try {
      const data = await getLabProfile();
      setLab(data);
    } catch (err: any) {
      if (err.message.includes('404') || err.message.includes('설정되지')) {
        setShowOnboarding(true);
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleOnboarding() {
    try {
      await createLab({ name: labName, institution, department, piName });
      const kws = manualKeywords ? manualKeywords.split(',').map(k => k.trim()) : undefined;
      await completeOnboarding({ homepageUrl: homepageUrl || undefined, keywords: kws });
      setShowOnboarding(false);
      await loadProfile();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function handleAddMember() {
    if (!newMemberName.trim()) return;
    try {
      await addLabMember({ name: newMemberName, role: newMemberRole, email: newMemberEmail || undefined });
      setNewMemberName(''); setNewMemberEmail('');
      await loadProfile();
    } catch (err: any) { setError(err.message); }
  }

  async function handleAddProject() {
    if (!newProjectName.trim()) return;
    try {
      await addLabProject({ name: newProjectName, funder: newProjectFunder || undefined });
      setNewProjectName(''); setNewProjectFunder('');
      await loadProfile();
    } catch (err: any) { setError(err.message); }
  }

  async function handleAddDict() {
    if (!newDictWrong.trim() || !newDictCorrect.trim()) return;
    try {
      await addDictEntry({ wrongForm: newDictWrong, correctForm: newDictCorrect });
      setNewDictWrong(''); setNewDictCorrect('');
      await loadProfile();
    } catch (err: any) { setError(err.message); }
  }

  if (loading) return <div className="text-text-muted p-8">로딩 중...</div>;

  // 온보딩 화면
  if (showOnboarding) {
    return (
      <div className="max-w-lg mx-auto py-12">
        <div className="text-center mb-8">
          <p className="text-5xl mb-4">🔬</p>
          <h1 className="text-2xl font-bold text-white">Lab Profile 설정</h1>
          <p className="text-text-muted mt-2">5분 안에 시작할 수 있습니다</p>
        </div>
        <div className="bg-bg-card rounded-xl p-6 space-y-4">
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <div>
            <label className="text-white text-sm block mb-1">연구실 이름 *</label>
            <input value={labName} onChange={e => setLabName(e.target.value)} placeholder="예: BLISS Lab" className="w-full bg-bg-input text-white px-4 py-2 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-white text-sm block mb-1">소속 기관</label>
              <input value={institution} onChange={e => setInstitution(e.target.value)} placeholder="예: 연세대학교" className="w-full bg-bg-input text-white px-4 py-2 rounded-lg text-sm focus:outline-none" />
            </div>
            <div>
              <label className="text-white text-sm block mb-1">학과</label>
              <input value={department} onChange={e => setDepartment(e.target.value)} placeholder="예: 화공생명공학과" className="w-full bg-bg-input text-white px-4 py-2 rounded-lg text-sm focus:outline-none" />
            </div>
          </div>
          <div>
            <label className="text-white text-sm block mb-1">PI 이름</label>
            <input value={piName} onChange={e => setPiName(e.target.value)} placeholder="예: 서정목" className="w-full bg-bg-input text-white px-4 py-2 rounded-lg text-sm focus:outline-none" />
          </div>
          <div>
            <label className="text-white text-sm block mb-1">연구실 홈페이지 (선택 — 키워드 자동 추출)</label>
            <input value={homepageUrl} onChange={e => setHomepageUrl(e.target.value)} placeholder="https://..." className="w-full bg-bg-input text-white px-4 py-2 rounded-lg text-sm focus:outline-none" />
          </div>
          <div>
            <label className="text-white text-sm block mb-1">연구 키워드 (쉼표 구분, 또는 홈페이지에서 자동 추출)</label>
            <input value={manualKeywords} onChange={e => setManualKeywords(e.target.value)} placeholder="예: biosensor, flexible electronics, hydrogel" className="w-full bg-bg-input text-white px-4 py-2 rounded-lg text-sm focus:outline-none" />
          </div>
          <button onClick={handleOnboarding} disabled={!labName.trim()} className="w-full py-3 bg-primary text-white rounded-lg font-medium disabled:opacity-50">
            Lab Profile 생성
          </button>
        </div>
      </div>
    );
  }

  if (!lab) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">🔬 {lab.name}</h1>
          <p className="text-text-muted text-sm mt-1">{lab.institution} {lab.department}</p>
        </div>
        <div className="flex gap-2 text-xs">
          <span className="bg-bg-input px-3 py-1 rounded-full text-text-muted">구성원 {lab.members.length}명</span>
          <span className="bg-bg-input px-3 py-1 rounded-full text-text-muted">과제 {lab.projects.length}건</span>
          <span className="bg-bg-input px-3 py-1 rounded-full text-text-muted">논문 {lab._count.publications}편</span>
          <span className="bg-bg-input px-3 py-1 rounded-full text-text-muted">메모 {lab._count.memos}개</span>
        </div>
      </div>

      {/* 탭 */}
      <div className="flex gap-1 bg-bg-card rounded-lg p-1">
        {(['info', 'members', 'projects', 'dict'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-3 py-2 rounded text-sm ${tab === t ? 'bg-primary text-white' : 'text-text-muted hover:text-white'}`}>
            {t === 'info' ? '기본 정보' : t === 'members' ? `구성원 (${lab.members.length})` : t === 'projects' ? `과제 (${lab.projects.length})` : `교정 사전 (${lab.domainDict.length})`}
          </button>
        ))}
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {/* 탭 컨텐츠 */}
      <div className="bg-bg-card rounded-xl p-6">
        {tab === 'info' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-4">
              <div><span className="text-text-muted text-xs">PI</span><p className="text-white text-sm">{lab.piName || '미등록'}</p></div>
              <div><span className="text-text-muted text-xs">온보딩</span><p className="text-sm">{lab.onboardingDone ? <span className="text-green-400">✅ 완료</span> : <span className="text-yellow-400">⏳ 진행 중</span>}</p></div>
            </div>
            <div>
              <span className="text-text-muted text-xs">연구 분야</span>
              <div className="flex flex-wrap gap-2 mt-1">
                {lab.researchFields.map(f => (
                  <span key={f} className="bg-primary/20 text-primary px-3 py-1 rounded-full text-xs">{f}</span>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === 'members' && (
          <div className="space-y-4">
            <div className="flex gap-2">
              <input value={newMemberName} onChange={e => setNewMemberName(e.target.value)} placeholder="이름" className="flex-1 bg-bg-input text-white px-3 py-2 rounded-lg text-sm focus:outline-none" />
              <select value={newMemberRole} onChange={e => setNewMemberRole(e.target.value)} className="bg-bg-input text-white px-3 py-2 rounded-lg text-sm">
                {['학부연구생', '석사과정', '박사과정', '포닥', '교수'].map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              <input value={newMemberEmail} onChange={e => setNewMemberEmail(e.target.value)} placeholder="이메일 (선택)" className="flex-1 bg-bg-input text-white px-3 py-2 rounded-lg text-sm focus:outline-none" />
              <button onClick={handleAddMember} className="px-4 py-2 bg-primary text-white rounded-lg text-sm">추가</button>
            </div>
            {lab.members.map(m => (
              <div key={m.id} className="flex items-center gap-3 bg-bg-input p-3 rounded-lg">
                <span className="text-lg">👤</span>
                <div className="flex-1">
                  <p className="text-white text-sm font-medium">{m.name}</p>
                  <p className="text-text-muted text-xs">{m.role} · {m.email || '이메일 미등록'}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'projects' && (
          <div className="space-y-4">
            <div className="flex gap-2">
              <input value={newProjectName} onChange={e => setNewProjectName(e.target.value)} placeholder="과제명" className="flex-1 bg-bg-input text-white px-3 py-2 rounded-lg text-sm focus:outline-none" />
              <input value={newProjectFunder} onChange={e => setNewProjectFunder(e.target.value)} placeholder="지원기관" className="w-40 bg-bg-input text-white px-3 py-2 rounded-lg text-sm focus:outline-none" />
              <button onClick={handleAddProject} className="px-4 py-2 bg-primary text-white rounded-lg text-sm">추가</button>
            </div>
            {lab.projects.map(p => (
              <div key={p.id} className="flex items-center gap-3 bg-bg-input p-3 rounded-lg">
                <span className="text-lg">📋</span>
                <div className="flex-1">
                  <p className="text-white text-sm font-medium">{p.name}</p>
                  <p className="text-text-muted text-xs">{p.funder || '미등록'} · {p.number || '번호 미등록'} · {p.status}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'dict' && (
          <div className="space-y-4">
            <p className="text-text-muted text-xs mb-2">미팅 STT와 미니브레인 대화에서 자동으로 전문용어를 교정합니다.</p>
            <div className="flex gap-2">
              <input value={newDictWrong} onChange={e => setNewDictWrong(e.target.value)} placeholder="잘못된 표현 (예: pdms)" className="flex-1 bg-bg-input text-white px-3 py-2 rounded-lg text-sm focus:outline-none" />
              <span className="text-text-muted self-center">→</span>
              <input value={newDictCorrect} onChange={e => setNewDictCorrect(e.target.value)} placeholder="올바른 표현 (예: PDMS)" className="flex-1 bg-bg-input text-white px-3 py-2 rounded-lg text-sm focus:outline-none" />
              <button onClick={handleAddDict} className="px-4 py-2 bg-primary text-white rounded-lg text-sm">추가</button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {lab.domainDict.map(d => (
                <div key={d.id} className="bg-bg-input p-2 rounded-lg flex items-center gap-2">
                  <span className="text-red-400 text-xs line-through">{d.wrongForm}</span>
                  <span className="text-text-muted text-xs">→</span>
                  <span className="text-green-400 text-xs font-medium">{d.correctForm}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
