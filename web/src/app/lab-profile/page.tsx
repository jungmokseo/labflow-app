'use client';

import { useState, useEffect } from 'react';
import {
  getLabProfile, createLab, addLabMember, addLabProject, addDictEntry,
  analyzeSeedPapers, applySeedPaperResults, getLabCompleteness, runPaperCrawl,
  type Lab,
} from '@/lib/api';

type OnboardingStep = 1 | 2 | 3 | 4;

export default function LabProfilePage() {
  const [lab, setLab] = useState<Lab | null>(null);
  const [loading, setLoading] = useState(true);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [error, setError] = useState('');

  // 온보딩 Step 1
  const [step, setStep] = useState<OnboardingStep>(1);
  const [labName, setLabName] = useState('');
  const [piName, setPiName] = useState('');
  const [institution, setInstitution] = useState('');

  // 온보딩 Step 2 (시드 논문)
  const [seedDoiInput, setSeedDoiInput] = useState('');
  const [seedAnalyzing, setSeedAnalyzing] = useState(false);
  const [seedResult, setSeedResult] = useState<any>(null);

  // 온보딩 Step 3 (논문 알림)
  const [crawling, setCrawling] = useState(false);
  const [crawlResult, setCrawlResult] = useState<any>(null);

  // 프로필 완성도
  const [completeness, setCompleteness] = useState<any>(null);

  // 기존 관리 탭
  const [tab, setTab] = useState<'info' | 'members' | 'projects' | 'dict'>('info');
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberRole, setNewMemberRole] = useState('학생');
  const [newMemberEmail, setNewMemberEmail] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectFunder, setNewProjectFunder] = useState('');
  const [newDictWrong, setNewDictWrong] = useState('');
  const [newDictCorrect, setNewDictCorrect] = useState('');

  useEffect(() => { loadProfile(); }, []);

  async function loadProfile() {
    try {
      const data = await getLabProfile();
      setLab(data);
      loadCompleteness();
    } catch (err: any) {
      if (err.message.includes('404') || err.message.includes('설정되지')) setShowOnboarding(true);
      else setError(err.message);
    } finally { setLoading(false); }
  }

  async function loadCompleteness() {
    try { setCompleteness(await getLabCompleteness()); } catch {}
  }

  // ── 온보딩 Step 1: 기본 정보 ──
  async function handleStep1() {
    if (!labName.trim()) return;
    try {
      await createLab({ name: labName, piName, institution });
      setStep(2);
    } catch (err: any) { setError(err.message); }
  }

  // ── 온보딩 Step 2: 시드 논문 분석 ──
  async function handleSeedAnalyze() {
    if (!seedDoiInput.trim()) return;
    setSeedAnalyzing(true);
    setError('');
    try {
      const dois = seedDoiInput.split('\n').map(s => s.trim()).filter(Boolean);
      const result = await analyzeSeedPapers(dois);
      setSeedResult(result);
    } catch (err: any) { setError(err.message); }
    finally { setSeedAnalyzing(false); }
  }

  async function handleApplySeedResults() {
    if (!seedResult) return;
    try {
      await applySeedPaperResults({
        keywords: seedResult.mergedKeywords,
        terms: seedResult.mergedTerms,
        papers: seedResult.papers.map((p: any) => ({
          title: p.title, authors: p.authors.join(', '), journal: p.journal, year: p.year, doi: p.doi,
        })),
        rssKeywords: seedResult.mergedRssKeywords,
        rssJournals: seedResult.mergedJournals?.slice(0, 10),
        setupPaperAlert: true,
      });
      setStep(3);
    } catch (err: any) { setError(err.message); }
  }

  // ── 온보딩 Step 3: 논문 크롤링 ──
  async function handleCrawlNow() {
    setCrawling(true);
    try {
      const result = await runPaperCrawl();
      setCrawlResult(result);
    } catch (err: any) { setError(err.message); }
    finally { setCrawling(false); }
  }

  // ── 기존 CRUD ──
  async function handleAddMember() {
    if (!newMemberName.trim()) return;
    await addLabMember({ name: newMemberName, role: newMemberRole, email: newMemberEmail || undefined });
    setNewMemberName(''); setNewMemberEmail(''); loadProfile();
  }
  async function handleAddProject() {
    if (!newProjectName.trim()) return;
    await addLabProject({ name: newProjectName, funder: newProjectFunder || undefined });
    setNewProjectName(''); setNewProjectFunder(''); loadProfile();
  }
  async function handleAddDict() {
    if (!newDictWrong.trim() || !newDictCorrect.trim()) return;
    await addDictEntry({ wrongForm: newDictWrong, correctForm: newDictCorrect });
    setNewDictWrong(''); setNewDictCorrect(''); loadProfile();
  }

  if (loading) return <div className="text-text-muted p-8">로딩 중...</div>;

  // ═══════════════════════════════════════════════
  //  온보딩 플로우 (4단계)
  // ═══════════════════════════════════════════════
  if (showOnboarding) {
    return (
      <div className="max-w-xl mx-auto py-8">
        {/* 진행 표시 */}
        <div className="flex items-center gap-2 mb-8">
          {[1, 2, 3, 4].map(s => (
            <div key={s} className="flex items-center gap-2">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                s < step ? 'bg-green-500 text-white' : s === step ? 'bg-primary text-white' : 'bg-bg-input text-text-muted'
              }`}>{s < step ? '✓' : s}</div>
              {s < 4 && <div className={`w-12 h-0.5 ${s < step ? 'bg-green-500' : 'bg-bg-input'}`} />}
            </div>
          ))}
        </div>

        {error && <div className="bg-red-500/10 text-red-400 px-4 py-3 rounded-lg text-sm mb-4">{error}</div>}

        {/* Step 1: 기본 정보 (30초) */}
        {step === 1 && (
          <div className="bg-bg-card rounded-xl p-6 space-y-4">
            <div className="text-center mb-4">
              <p className="text-4xl mb-2">🔬</p>
              <h2 className="text-xl font-bold text-white">연구실 기본 정보</h2>
              <p className="text-text-muted text-sm">30초면 완료됩니다</p>
            </div>
            <div>
              <label className="text-white text-sm block mb-1">연구실 이름 *</label>
              <input value={labName} onChange={e => setLabName(e.target.value)} placeholder="예: BLISS Lab" className="w-full bg-bg-input text-white px-4 py-2.5 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:outline-none" />
            </div>
            <div>
              <label className="text-white text-sm block mb-1">PI 이름</label>
              <input value={piName} onChange={e => setPiName(e.target.value)} placeholder="예: 서정목" className="w-full bg-bg-input text-white px-4 py-2.5 rounded-lg text-sm focus:outline-none" />
            </div>
            <div>
              <label className="text-white text-sm block mb-1">소속 기관</label>
              <input value={institution} onChange={e => setInstitution(e.target.value)} placeholder="예: 연세대학교 화공생명공학과" className="w-full bg-bg-input text-white px-4 py-2.5 rounded-lg text-sm focus:outline-none" />
            </div>
            <button onClick={handleStep1} disabled={!labName.trim()} className="w-full py-3 bg-primary text-white rounded-lg font-medium disabled:opacity-50">다음: 대표 논문 입력 →</button>
          </div>
        )}

        {/* Step 2: 시드 논문 (핵심, 1분) */}
        {step === 2 && (
          <div className="bg-bg-card rounded-xl p-6 space-y-4">
            <div className="text-center mb-4">
              <p className="text-4xl mb-2">📄</p>
              <h2 className="text-xl font-bold text-white">대표 논문 입력</h2>
              <p className="text-text-muted text-sm">DOI나 제목을 입력하면 연구 분야, 전문용어, 관련 저널이 자동으로 채워집니다</p>
            </div>
            <div>
              <label className="text-white text-sm block mb-1">논문 DOI 또는 제목 (줄바꿈으로 구분, 최대 5편)</label>
              <textarea value={seedDoiInput} onChange={e => setSeedDoiInput(e.target.value)} rows={3}
                placeholder={"10.1038/s41467-024-xxxxx\n또는 논문 제목을 입력하세요"}
                className="w-full bg-bg-input text-white px-4 py-2.5 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:outline-none resize-none" />
            </div>

            {!seedResult ? (
              <div className="flex gap-2">
                <button onClick={handleSeedAnalyze} disabled={seedAnalyzing || !seedDoiInput.trim()} className="flex-1 py-3 bg-primary text-white rounded-lg font-medium disabled:opacity-50">
                  {seedAnalyzing ? '분석 중... (Semantic Scholar + Gemini)' : '🔍 논문 분석'}
                </button>
                <button onClick={() => setStep(3)} className="px-4 py-3 bg-bg-input text-text-muted rounded-lg text-sm">건너뛰기</button>
              </div>
            ) : (
              <div className="space-y-4">
                {/* 분석 결과 미리보기 */}
                {seedResult.papers.map((p: any, i: number) => (
                  <div key={i} className="bg-bg-input rounded-lg p-4">
                    <p className="text-white text-sm font-medium">{p.title}</p>
                    <p className="text-text-muted text-xs mt-1">{p.journal} ({p.year}) · 인용 {p.citationCount}회</p>
                  </div>
                ))}

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-primary text-xs font-medium mb-2">추출된 키워드 ({seedResult.mergedKeywords.length})</p>
                    <div className="flex flex-wrap gap-1">
                      {seedResult.mergedKeywords.slice(0, 12).map((kw: string) => (
                        <span key={kw} className="bg-primary/20 text-primary px-2 py-0.5 rounded-full text-xs">{kw}</span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-green-400 text-xs font-medium mb-2">전문용어 ({seedResult.mergedTerms.length})</p>
                    <div className="flex flex-wrap gap-1">
                      {seedResult.mergedTerms.slice(0, 8).map((t: any) => (
                        <span key={t.term} className="bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full text-xs">{t.term}</span>
                      ))}
                    </div>
                  </div>
                </div>

                {seedResult.mergedJournals.length > 0 && (
                  <div>
                    <p className="text-yellow-400 text-xs font-medium mb-1">관련 저널 (상위 5개)</p>
                    <p className="text-text-muted text-xs">{seedResult.mergedJournals.slice(0, 5).join(' · ')}</p>
                  </div>
                )}

                <button onClick={handleApplySeedResults} className="w-full py-3 bg-green-500 text-white rounded-lg font-medium">
                  ✅ 분석 결과 적용 → 다음
                </button>
              </div>
            )}
          </div>
        )}

        {/* Step 3: 논문 알림 크롤링 */}
        {step === 3 && (
          <div className="bg-bg-card rounded-xl p-6 space-y-4">
            <div className="text-center mb-4">
              <p className="text-4xl mb-2">📚</p>
              <h2 className="text-xl font-bold text-white">최신 관련 논문 확인</h2>
              <p className="text-text-muted text-sm">설정된 키워드로 주요 저널에서 관련 논문을 가져옵니다</p>
            </div>

            {!crawlResult ? (
              <div className="flex gap-2">
                <button onClick={handleCrawlNow} disabled={crawling} className="flex-1 py-3 bg-primary text-white rounded-lg font-medium disabled:opacity-50">
                  {crawling ? '크롤링 중...' : '🔄 지금 관련 논문 가져오기'}
                </button>
                <button onClick={() => { setShowOnboarding(false); loadProfile(); }} className="px-4 py-3 bg-bg-input text-text-muted rounded-lg text-sm">나중에</button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="bg-green-500/10 text-green-400 px-4 py-3 rounded-lg text-sm">
                  🎉 {crawlResult.totalFetched}편 수집 → {crawlResult.matched}편 매칭 → {crawlResult.newSaved}편 저장!
                </div>
                <button onClick={() => { setStep(4); }} className="w-full py-3 bg-primary text-white rounded-lg font-medium">다음 →</button>
              </div>
            )}
          </div>
        )}

        {/* Step 4: 완료 + 안내 */}
        {step === 4 && (
          <div className="bg-bg-card rounded-xl p-6 text-center space-y-4">
            <p className="text-5xl mb-2">🎉</p>
            <h2 className="text-xl font-bold text-white">온보딩 완료!</h2>
            <p className="text-text-muted text-sm">미니브레인이 연구실 정보를 학습했습니다</p>
            <div className="bg-bg-input rounded-lg p-4 text-left space-y-2 text-sm text-text-muted">
              <p>이제 할 수 있는 것들:</p>
              <p>🧠 <span className="text-white">"NRF 과제 사사 문구 알려줘"</span> — DB 기반 정확한 답변</p>
              <p>📚 <span className="text-white">"최신 hydrogel 논문 있어?"</span> — RSS 크롤링 결과</p>
              <p>👤 <span className="text-white">"태영이 이메일 뭐야?"</span> — 구성원 즉시 조회</p>
            </div>
            <p className="text-text-muted text-xs">구성원, 과제는 대화하면서도 추가 가능해요: "김태영 박사과정 추가해줘"</p>
            <button onClick={() => { setShowOnboarding(false); loadProfile(); }} className="w-full py-3 bg-primary text-white rounded-lg font-medium">Lab Profile 확인하기</button>
          </div>
        )}
      </div>
    );
  }

  if (!lab) return null;

  // ═══════════════════════════════════════════════
  //  기존 Lab Profile 관리 화면
  // ═══════════════════════════════════════════════
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">🔬 {lab.name}</h1>
          <p className="text-text-muted text-sm mt-1">{lab.institution} {lab.department}</p>
        </div>
        <div className="flex gap-2 items-center">
          {completeness && (
            <div className="flex items-center gap-2 bg-bg-card px-3 py-1.5 rounded-full">
              <div className="w-20 h-2 bg-bg-input rounded-full overflow-hidden">
                <div className="h-full bg-primary rounded-full" style={{ width: `${completeness.percentage}%` }} />
              </div>
              <span className="text-xs text-text-muted">{completeness.percentage}%</span>
            </div>
          )}
          <span className="bg-bg-input px-3 py-1 rounded-full text-xs text-text-muted">{(lab.members || []).length}명</span>
          <span className="bg-bg-input px-3 py-1 rounded-full text-xs text-text-muted">{(lab.projects || []).length}과제</span>
        </div>
      </div>

      {/* 완성도 제안 */}
      {completeness && completeness.suggestions.length > 0 && (
        <div className="bg-primary/5 border border-primary/20 rounded-xl p-4">
          <p className="text-primary text-xs font-medium mb-2">💡 프로필 완성도를 높여보세요</p>
          {completeness.suggestions.map((s: string, i: number) => (
            <p key={i} className="text-text-muted text-xs mt-1">• {s}</p>
          ))}
        </div>
      )}

      {/* 탭 */}
      <div className="flex gap-1 bg-bg-card rounded-lg p-1">
        {(['info', 'members', 'projects', 'dict'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-3 py-2 rounded text-sm ${tab === t ? 'bg-primary text-white' : 'text-text-muted hover:text-white'}`}>
            {t === 'info' ? '기본 정보' : t === 'members' ? `구성원 (${(lab.members || []).length})` : t === 'projects' ? `과제 (${(lab.projects || []).length})` : `교정 사전 (${(lab.domainDict || []).length})`}
          </button>
        ))}
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

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
                {(lab.researchFields || []).length > 0 ? (lab.researchFields || []).map((f: string) => (
                  <span key={f} className="bg-primary/20 text-primary px-3 py-1 rounded-full text-xs">{f}</span>
                )) : <span className="text-text-muted text-xs">미등록 — 대표 논문 DOI를 입력하면 자동 추출됩니다</span>}
              </div>
            </div>
          </div>
        )}

        {tab === 'members' && (
          <div className="space-y-4">
            <div className="flex gap-2">
              <input value={newMemberName} onChange={e => setNewMemberName(e.target.value)} placeholder="이름" className="flex-1 bg-bg-input text-white px-3 py-2 rounded-lg text-sm focus:outline-none" />
              <select value={newMemberRole} onChange={e => setNewMemberRole(e.target.value)} className="bg-bg-input text-white px-3 py-2 rounded-lg text-sm">
                {['학부연구생', '석사과정', '박사과정', '포닥', '교수'].map(r => <option key={r}>{r}</option>)}
              </select>
              <input value={newMemberEmail} onChange={e => setNewMemberEmail(e.target.value)} placeholder="이메일" className="flex-1 bg-bg-input text-white px-3 py-2 rounded-lg text-sm focus:outline-none" />
              <button onClick={handleAddMember} className="px-4 py-2 bg-primary text-white rounded-lg text-sm">추가</button>
            </div>
            {(lab.members || []).map((m: any) => (
              <div key={m.id} className="flex items-center gap-3 bg-bg-input p-3 rounded-lg">
                <span className="text-lg">👤</span>
                <div className="flex-1">
                  <p className="text-white text-sm font-medium">{m.name}</p>
                  <p className="text-text-muted text-xs">{m.role} · {m.email || '이메일 미등록'}</p>
                </div>
              </div>
            ))}
            {(lab.members || []).length === 0 && <p className="text-text-muted text-xs text-center py-4">구성원을 추가해보세요. 미니브레인 대화로도 가능해요: "김태영 박사과정 추가해줘"</p>}
          </div>
        )}

        {tab === 'projects' && (
          <div className="space-y-4">
            <div className="flex gap-2">
              <input value={newProjectName} onChange={e => setNewProjectName(e.target.value)} placeholder="과제명" className="flex-1 bg-bg-input text-white px-3 py-2 rounded-lg text-sm focus:outline-none" />
              <input value={newProjectFunder} onChange={e => setNewProjectFunder(e.target.value)} placeholder="지원기관" className="w-40 bg-bg-input text-white px-3 py-2 rounded-lg text-sm focus:outline-none" />
              <button onClick={handleAddProject} className="px-4 py-2 bg-primary text-white rounded-lg text-sm">추가</button>
            </div>
            {(lab.projects || []).map((p: any) => (
              <div key={p.id} className="flex items-center gap-3 bg-bg-input p-3 rounded-lg">
                <span className="text-lg">📋</span>
                <div className="flex-1">
                  <p className="text-white text-sm font-medium">{p.name}</p>
                  <p className="text-text-muted text-xs">{p.funder || '미등록'} · {p.status}</p>
                </div>
              </div>
            ))}
            {(lab.projects || []).length === 0 && <p className="text-text-muted text-xs text-center py-4">과제 정보를 등록하면 사사 문구를 빠르게 조회할 수 있어요</p>}
          </div>
        )}

        {tab === 'dict' && (
          <div className="space-y-4">
            <p className="text-text-muted text-xs mb-2">미팅 STT와 미니브레인 대화에서 자동으로 전문용어를 교정합니다. 대표 논문 DOI를 입력하면 자동 구축됩니다.</p>
            <div className="flex gap-2">
              <input value={newDictWrong} onChange={e => setNewDictWrong(e.target.value)} placeholder="잘못된 표현" className="flex-1 bg-bg-input text-white px-3 py-2 rounded-lg text-sm focus:outline-none" />
              <span className="text-text-muted self-center">→</span>
              <input value={newDictCorrect} onChange={e => setNewDictCorrect(e.target.value)} placeholder="올바른 표현" className="flex-1 bg-bg-input text-white px-3 py-2 rounded-lg text-sm focus:outline-none" />
              <button onClick={handleAddDict} className="px-4 py-2 bg-primary text-white rounded-lg text-sm">추가</button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(lab.domainDict || []).map((d: any) => (
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
