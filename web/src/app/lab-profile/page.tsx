'use client';

import { useState, useEffect, useRef } from 'react';
import {
  getLabProfile, createLab, updateLab, addLabMember, removeLabMember, addLabProject, addDictEntry,
  analyzeSeedPapers, applySeedPaperResults, getLabCompleteness, runPaperCrawl, uploadPaperPdf,
  apiFetch, type Lab,
} from '@/lib/api';
// Skeleton imports removed — using inline spinner
import {
  FlaskConical, FileText, BookOpen, Brain, User, Search, CheckCircle,
  RefreshCw, ClipboardList, Lightbulb, PartyPopper, X, Upload, Loader2,
} from 'lucide-react';

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
  const [editingInfo, setEditingInfo] = useState(false);
  const [editName, setEditName] = useState('');
  const [editInstitution, setEditInstitution] = useState('');
  const [editDepartment, setEditDepartment] = useState('');
  const [editPiName, setEditPiName] = useState('');
  const [editPiEmail, setEditPiEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberNameEn, setNewMemberNameEn] = useState('');
  const [newMemberRole, setNewMemberRole] = useState('학생');
  const [newMemberEmail, setNewMemberEmail] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectFunder, setNewProjectFunder] = useState('');
  const [newDictWrong, setNewDictWrong] = useState('');
  const [newDictCorrect, setNewDictCorrect] = useState('');
  const [pdfUploading, setPdfUploading] = useState(false);
  const [pdfProgress, setPdfProgress] = useState('');
  const [pdfResult, setPdfResult] = useState<string | null>(null);
  const [fetchingHomepage, setFetchingHomepage] = useState(false);
  const [homepageData, setHomepageData] = useState<any>(null);
  const [homepageChecked, setHomepageChecked] = useState<Record<string, boolean>>({});
  const [applyingHomepage, setApplyingHomepage] = useState(false);
  const pdfInputRef = useRef<HTMLInputElement>(null);

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

  // ── 기본 정보 수정 ──
  function startEditing() {
    if (!lab) return;
    setEditName(lab.name || '');
    setEditInstitution(lab.institution || '');
    setEditDepartment(lab.department || '');
    setEditPiName(lab.piName || '');
    setEditPiEmail(lab.piEmail || '');
    setEditingInfo(true);
  }
  async function handleSaveInfo() {
    // Optimistic: update UI immediately
    const prevLab = lab;
    setLab(prev => prev ? { ...prev, name: editName, institution: editInstitution, department: editDepartment, piName: editPiName, piEmail: editPiEmail } : prev);
    setEditingInfo(false);
    try {
      await updateLab({
        name: editName,
        institution: editInstitution,
        department: editDepartment,
        piName: editPiName,
        piEmail: editPiEmail || undefined,
      });
      await loadProfile();
    } catch (err: any) {
      setLab(prevLab); // rollback
      setEditingInfo(true);
      setError(err.message);
    }
  }

  // ── 멤버 삭제 ──
  async function handleDeleteMember(id: string, name: string) {
    if (!confirm(`${name}을(를) 삭제하시겠습니까?`)) return;
    // Optimistic: remove immediately
    const prevLab = lab;
    setLab(prev => prev ? { ...prev, members: (prev.members || []).filter((m: any) => m.id !== id) } : prev);
    try {
      await removeLabMember(id);
      loadProfile();
    } catch (err: any) {
      setLab(prevLab); // rollback
      setError(err.message);
    }
  }

  // ── 기존 CRUD ──
  async function handleAddMember() {
    if (!newMemberName.trim()) return;
    // Optimistic: append immediately
    const tempMember = { id: `temp-${Date.now()}`, name: newMemberName, nameEn: newMemberNameEn || '', role: newMemberRole, email: newMemberEmail || '' };
    setLab(prev => prev ? { ...prev, members: [...(prev.members || []), tempMember] } : prev);
    const saved = { name: newMemberName, nameEn: newMemberNameEn || undefined, role: newMemberRole, email: newMemberEmail || undefined };
    setNewMemberName(''); setNewMemberNameEn(''); setNewMemberEmail('');
    try {
      await addLabMember(saved);
      loadProfile();
    } catch {
      setLab(prev => prev ? { ...prev, members: (prev.members || []).filter((m: any) => m.id !== tempMember.id) } : prev);
    }
  }
  async function handleAddProject() {
    if (!newProjectName.trim()) return;
    // Optimistic: append immediately
    const tempProject = { id: `temp-${Date.now()}`, name: newProjectName, funder: newProjectFunder || '', status: 'active' };
    setLab(prev => prev ? { ...prev, projects: [...(prev.projects || []), tempProject] } : prev);
    const saved = { name: newProjectName, funder: newProjectFunder || undefined };
    setNewProjectName(''); setNewProjectFunder('');
    try {
      await addLabProject(saved);
      loadProfile();
    } catch {
      setLab(prev => prev ? { ...prev, projects: (prev.projects || []).filter((p: any) => p.id !== tempProject.id) } : prev);
    }
  }
  async function handleAddDict() {
    if (!newDictWrong.trim() || !newDictCorrect.trim()) return;
    // Optimistic: append immediately
    const tempDict = { id: `temp-${Date.now()}`, wrongForm: newDictWrong, correctForm: newDictCorrect };
    setLab(prev => prev ? { ...prev, domainDict: [...(prev.domainDict || []), tempDict] } : prev);
    const saved = { wrongForm: newDictWrong, correctForm: newDictCorrect };
    setNewDictWrong(''); setNewDictCorrect('');
    try {
      await addDictEntry(saved);
      loadProfile();
    } catch {
      setLab(prev => prev ? { ...prev, domainDict: (prev.domainDict || []).filter((d: any) => d.id !== tempDict.id) } : prev);
    }
  }

  async function handlePdfUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setPdfUploading(true);
    setPdfResult(null);
    const successes: string[] = [];
    const failures: string[] = [];
    for (let i = 0; i < files.length; i++) {
      if (files.length > 1) setPdfProgress(`${i + 1}/${files.length} 처리 중... (${files[i].name})`);
      else setPdfProgress(`처리 중... (${files[i].name})`);
      try {
        const res = await uploadPaperPdf(files[i]);
        successes.push(res.title ? `"${res.title}"` : files[i].name);
      } catch (err: any) {
        // 1회 재시도 (Gemini rate limit 대응)
        await new Promise(r => setTimeout(r, 3000));
        try {
          const res = await uploadPaperPdf(files[i]);
          successes.push(res.title ? `"${res.title}"` : files[i].name);
        } catch (err2: any) {
          failures.push(files[i].name);
        }
      }
      // Gemini rate limit 방지: 파일 간 2초 대기
      if (i < files.length - 1) await new Promise(r => setTimeout(r, 2000));
    }
    const parts = [];
    if (successes.length) parts.push(`성공 ${successes.length}건: ${successes.join(', ')}`);
    if (failures.length) parts.push(`실패 ${failures.length}건: ${failures.join(', ')}`);
    setPdfResult(parts.join(' / '));
    setPdfProgress('');
    setPdfUploading(false);
    if (pdfInputRef.current) pdfInputRef.current.value = '';
    loadProfile();
  }

  async function handleFetchHomepage() {
    setFetchingHomepage(true);
    setHomepageData(null);
    try {
      const res = await apiFetch<{ success: boolean; extracted: any }>('/api/lab/homepage/extract', { method: 'POST' });
      setHomepageData(res.extracted);
      // Default: check all items
      const checks: Record<string, boolean> = {};
      (res.extracted.members || []).forEach((_: any, i: number) => { checks[`member-${i}`] = true; });
      (res.extracted.researchKeywords || []).forEach((_: any, i: number) => { checks[`keyword-${i}`] = true; });
      (res.extracted.publications || []).forEach((_: any, i: number) => { checks[`pub-${i}`] = true; });
      if (res.extracted.labDescription) checks['description'] = true;
      setHomepageChecked(checks);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setFetchingHomepage(false);
    }
  }

  async function handleApplyHomepage() {
    if (!homepageData) return;
    setApplyingHomepage(true);
    try {
      const payload: any = {};
      const checkedMembers = (homepageData.members || []).filter((_: any, i: number) => homepageChecked[`member-${i}`]);
      if (checkedMembers.length) payload.members = checkedMembers;
      const checkedKeywords = (homepageData.researchKeywords || []).filter((_: any, i: number) => homepageChecked[`keyword-${i}`]);
      if (checkedKeywords.length) payload.researchKeywords = checkedKeywords;
      const checkedPubs = (homepageData.publications || []).filter((_: any, i: number) => homepageChecked[`pub-${i}`]);
      if (checkedPubs.length) payload.publications = checkedPubs;
      if (homepageChecked['description'] && homepageData.labDescription) payload.labDescription = homepageData.labDescription;

      await apiFetch('/api/lab/homepage/apply', { method: 'POST', body: JSON.stringify(payload) });
      setHomepageData(null);
      loadProfile();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setApplyingHomepage(false);
    }
  }

  if (loading) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="w-10 h-10 rounded-full border-[3px] border-border border-t-primary animate-spin" />
    </div>
  );

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
              <FlaskConical className="w-10 h-10 text-primary mx-auto mb-2" />
              <h2 className="text-xl font-bold text-text-heading">연구실 기본 정보</h2>
              <p className="text-text-muted text-sm">30초면 완료됩니다</p>
            </div>
            <div>
              <label className="text-text-heading text-sm block mb-1">연구실 이름 *</label>
              <input value={labName} onChange={e => setLabName(e.target.value)} placeholder="예: BLISS Lab" className="w-full bg-bg-input text-text-heading px-4 py-2.5 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:outline-none" />
            </div>
            <div>
              <label className="text-text-heading text-sm block mb-1">PI 이름</label>
              <input value={piName} onChange={e => setPiName(e.target.value)} placeholder="예: 서정목" className="w-full bg-bg-input text-text-heading px-4 py-2.5 rounded-lg text-sm focus:outline-none" />
            </div>
            <div>
              <label className="text-text-heading text-sm block mb-1">소속 기관</label>
              <input value={institution} onChange={e => setInstitution(e.target.value)} placeholder="예: 연세대학교 화공생명공학과" className="w-full bg-bg-input text-text-heading px-4 py-2.5 rounded-lg text-sm focus:outline-none" />
            </div>
            <button onClick={handleStep1} disabled={!labName.trim()} className="w-full py-3 bg-primary text-white rounded-lg font-medium disabled:opacity-50">다음: 대표 논문 입력 →</button>
          </div>
        )}

        {/* Step 2: 시드 논문 (핵심, 1분) */}
        {step === 2 && (
          <div className="bg-bg-card rounded-xl p-6 space-y-4">
            <div className="text-center mb-4">
              <FileText className="w-10 h-10 text-primary mx-auto mb-2" />
              <h2 className="text-xl font-bold text-text-heading">대표 논문 입력</h2>
              <p className="text-text-muted text-sm">DOI나 제목을 입력하면 연구 분야, 전문용어, 관련 저널이 자동으로 채워집니다</p>
            </div>
            <div>
              <label className="text-text-heading text-sm block mb-1">논문 DOI 또는 제목 (줄바꿈으로 구분, 최대 5편)</label>
              <textarea value={seedDoiInput} onChange={e => setSeedDoiInput(e.target.value)} rows={3}
                placeholder={"10.1038/s41467-024-xxxxx\n또는 논문 제목을 입력하세요"}
                className="w-full bg-bg-input text-text-heading px-4 py-2.5 rounded-lg text-sm focus:ring-2 focus:ring-primary focus:outline-none resize-none" />
            </div>

            {!seedResult ? (
              <div className="flex gap-2">
                <button onClick={handleSeedAnalyze} disabled={seedAnalyzing || !seedDoiInput.trim()} className="flex-1 py-3 bg-primary text-white rounded-lg font-medium disabled:opacity-50">
                  {seedAnalyzing ? '분석 중...' : <><Search className="w-4 h-4 inline mr-1" /> 논문 분석</>}
                </button>
                <button onClick={() => setStep(3)} className="px-4 py-3 bg-bg-input text-text-muted rounded-lg text-sm">건너뛰기</button>
              </div>
            ) : (
              <div className="space-y-4">
                {/* 분석 결과 미리보기 */}
                {seedResult.papers.map((p: any, i: number) => (
                  <div key={i} className="bg-bg-input rounded-lg p-4">
                    <p className="text-text-heading text-sm font-medium">{p.title}</p>
                    <p className="text-text-muted text-xs mt-1">{p.journal} ({p.year}) · 인용 {p.citationCount}회</p>
                  </div>
                ))}

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-primary text-xs font-medium mb-2">추출된 키워드 ({seedResult.mergedKeywords.length})</p>
                    <div className="flex flex-wrap gap-1">
                      {seedResult.mergedKeywords.slice(0, 12).map((kw: string) => (
                        <span key={kw} className="bg-primary-light text-primary px-2 py-0.5 rounded-full text-xs">{kw}</span>
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
                    <p className="text-amber-600 text-xs font-medium mb-1">관련 저널 (상위 5개)</p>
                    <p className="text-text-muted text-xs">{seedResult.mergedJournals.slice(0, 5).join(' · ')}</p>
                  </div>
                )}

                <button onClick={handleApplySeedResults} className="w-full py-3 bg-green-500 text-white rounded-lg font-medium flex items-center justify-center gap-1.5">
                  <CheckCircle className="w-4 h-4" /> 분석 결과 적용 → 다음
                </button>
              </div>
            )}
          </div>
        )}

        {/* Step 3: 논문 알림 크롤링 */}
        {step === 3 && (
          <div className="bg-bg-card rounded-xl p-6 space-y-4">
            <div className="text-center mb-4">
              <BookOpen className="w-10 h-10 text-primary mx-auto mb-2" />
              <h2 className="text-xl font-bold text-text-heading">최신 관련 논문 확인</h2>
              <p className="text-text-muted text-sm">설정된 키워드로 주요 저널에서 관련 논문을 가져옵니다</p>
            </div>

            {!crawlResult ? (
              <div className="flex gap-2">
                <button onClick={handleCrawlNow} disabled={crawling} className="flex-1 py-3 bg-primary text-white rounded-lg font-medium disabled:opacity-50">
                  {crawling ? '크롤링 중...' : <><RefreshCw className="w-4 h-4 inline mr-1" /> 지금 관련 논문 가져오기</>}
                </button>
                <button onClick={() => { setShowOnboarding(false); loadProfile(); }} className="px-4 py-3 bg-bg-input text-text-muted rounded-lg text-sm">나중에</button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="bg-green-500/10 text-green-400 px-4 py-3 rounded-lg text-sm">
                  {crawlResult.totalFetched}편 수집 → {crawlResult.matched}편 매칭 → {crawlResult.newSaved}편 저장!
                </div>
                <button onClick={() => { setStep(4); }} className="w-full py-3 bg-primary text-white rounded-lg font-medium">다음 →</button>
              </div>
            )}
          </div>
        )}

        {/* Step 4: 완료 + 안내 */}
        {step === 4 && (
          <div className="bg-bg-card rounded-xl p-6 text-center space-y-4">
            <PartyPopper className="w-12 h-12 text-primary mx-auto mb-2" />
            <h2 className="text-xl font-bold text-text-heading">온보딩 완료!</h2>
            <p className="text-text-muted text-sm">연구실 정보가 등록되었습니다</p>
            <div className="bg-bg-input rounded-lg p-4 text-left space-y-2 text-sm text-text-muted">
              <p>이제 할 수 있는 것들:</p>
              <p className="flex items-center gap-1.5"><Brain className="w-4 h-4 text-primary flex-shrink-0" /> <span className="text-text-heading">"NRF 과제 사사 문구 알려줘"</span> -- DB 기반 정확한 답변</p>
              <p className="flex items-center gap-1.5"><BookOpen className="w-4 h-4 text-green-400 flex-shrink-0" /> <span className="text-text-heading">"최신 hydrogel 논문 있어?"</span> -- RSS 크롤링 결과</p>
              <p className="flex items-center gap-1.5"><User className="w-4 h-4 text-blue-400 flex-shrink-0" /> <span className="text-text-heading">"태영이 이메일 뭐야?"</span> -- 구성원 즉시 조회</p>
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
          <h1 className="text-3xl font-bold text-text-heading flex items-center gap-2"><FlaskConical className="w-6 h-6 text-primary" /> {lab.name}</h1>
          <p className="text-text-muted text-base mt-1">{lab.institution} {lab.department}</p>
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
          <p className="text-primary text-xs font-medium mb-2 flex items-center gap-1"><Lightbulb className="w-3.5 h-3.5" /> 프로필 완성도를 높여보세요</p>
          {completeness.suggestions.map((s: string, i: number) => (
            <p key={i} className="text-text-muted text-xs mt-1">• {s}</p>
          ))}
        </div>
      )}

      {/* 탭 */}
      <div className="flex gap-1 bg-bg-card rounded-lg p-1">
        {(['info', 'members', 'projects', 'dict'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} className={`flex-1 px-3 py-2 rounded text-sm ${tab === t ? 'bg-primary text-white' : 'text-text-muted hover:text-text-heading'}`}>
            {t === 'info' ? '기본 정보' : t === 'members' ? `구성원 (${(lab.members || []).length})` : t === 'projects' ? `과제 (${(lab.projects || []).length})` : `교정 사전 (${(lab.domainDict || []).length})`}
          </button>
        ))}
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      <div className="bg-bg-card rounded-xl p-6">
        {tab === 'info' && (
          <div className="space-y-4">
            {editingInfo ? (
              <div className="space-y-3">
                <div>
                  <label className="text-text-muted text-xs block mb-1">연구실 이름</label>
                  <input value={editName} onChange={e => setEditName(e.target.value)} className="w-full bg-bg-input text-text-heading px-3 py-2 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-text-muted text-xs block mb-1">소속 기관</label>
                    <input value={editInstitution} onChange={e => setEditInstitution(e.target.value)} className="w-full bg-bg-input text-text-heading px-3 py-2 rounded-lg text-sm focus:outline-none" />
                  </div>
                  <div>
                    <label className="text-text-muted text-xs block mb-1">학과/학부</label>
                    <input value={editDepartment} onChange={e => setEditDepartment(e.target.value)} className="w-full bg-bg-input text-text-heading px-3 py-2 rounded-lg text-sm focus:outline-none" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-text-muted text-xs block mb-1">PI 이름</label>
                    <input value={editPiName} onChange={e => setEditPiName(e.target.value)} className="w-full bg-bg-input text-text-heading px-3 py-2 rounded-lg text-sm focus:outline-none" />
                  </div>
                  <div>
                    <label className="text-text-muted text-xs block mb-1">PI 이메일</label>
                    <input value={editPiEmail} onChange={e => setEditPiEmail(e.target.value)} className="w-full bg-bg-input text-text-heading px-3 py-2 rounded-lg text-sm focus:outline-none" />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={handleSaveInfo} disabled={saving} className="px-4 py-2 bg-primary text-white rounded-lg text-sm disabled:opacity-50">
                    {saving ? '저장 중...' : '저장'}
                  </button>
                  <button onClick={() => setEditingInfo(false)} className="px-4 py-2 bg-bg-input text-text-muted rounded-lg text-sm">취소</button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex justify-between items-start">
                  <div className="grid grid-cols-2 gap-4 flex-1">
                    <div><span className="text-text-muted text-xs">PI</span><p className="text-text-heading text-sm">{lab.piName || '미등록'}</p></div>
                    <div><span className="text-text-muted text-xs">학과</span><p className="text-text-heading text-sm">{lab.department || '미등록'}</p></div>
                    <div><span className="text-text-muted text-xs">소속</span><p className="text-text-heading text-sm">{lab.institution || '미등록'}</p></div>
                    <div><span className="text-text-muted text-xs">PI 이메일</span><p className="text-text-heading text-sm">{lab.piEmail || '미등록'}</p></div>
                  </div>
                  <button onClick={startEditing} className="text-xs text-primary hover:text-primary/80 px-3 py-1.5 rounded-lg hover:bg-primary-light">수정</button>
                </div>
                <div>
                  <span className="text-text-muted text-xs">연구 분야</span>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {(lab.researchFields || []).length > 0 ? (lab.researchFields || []).map((f: string) => (
                      <span key={f} className="bg-primary-light text-primary px-3 py-1 rounded-full text-xs">{f}</span>
                    )) : <span className="text-text-muted text-xs">미등록 — 대표 논문 DOI를 입력하면 자동 추출됩니다</span>}
                  </div>
                </div>

                {/* 핵심 논문 PDF 등록 */}
                <div className="pt-4 border-t border-border/30">
                  <span className="text-text-muted text-xs">핵심 논문 등록</span>
                  <p className="text-text-muted text-[11px] mt-0.5 mb-2">PDF를 업로드하면 메타데이터 자동 추출 + Brain 대화에서 참고 가능</p>
                  <input type="file" ref={pdfInputRef} onChange={handlePdfUpload} className="hidden" accept=".pdf" multiple />
                  <button onClick={() => pdfInputRef.current?.click()} disabled={pdfUploading}
                    className="px-4 py-2 bg-bg-input text-text-muted border border-border rounded-lg text-sm hover:text-text-heading disabled:opacity-50">
                    {pdfUploading ? <Loader2 className="w-4 h-4 animate-spin inline mr-1" /> : <Upload className="w-4 h-4 inline mr-1" />} PDF 업로드 (다중 선택 가능)
                  </button>
                  {pdfProgress && <p className="text-text-muted text-xs mt-2">{pdfProgress}</p>}
                  {pdfResult && <p className="text-green-500 text-xs mt-2">{pdfResult}</p>}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'members' && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <input value={newMemberName} onChange={e => setNewMemberName(e.target.value)} placeholder="이름 (한국어)" className="w-28 bg-bg-input text-text-heading px-3 py-2 rounded-lg text-sm focus:outline-none" />
              <input value={newMemberNameEn} onChange={e => setNewMemberNameEn(e.target.value)} placeholder="English Name" className="w-36 bg-bg-input text-text-heading px-3 py-2 rounded-lg text-sm focus:outline-none" />
              <select value={newMemberRole} onChange={e => setNewMemberRole(e.target.value)} className="bg-bg-input text-text-heading px-3 py-2 rounded-lg text-sm">
                {['학부연구생', '석사과정', '박사과정', '포닥', '교수'].map(r => <option key={r}>{r}</option>)}
              </select>
              <input value={newMemberEmail} onChange={e => setNewMemberEmail(e.target.value)} placeholder="이메일" className="flex-1 bg-bg-input text-text-heading px-3 py-2 rounded-lg text-sm focus:outline-none" />
              <button onClick={handleAddMember} className="px-4 py-2 bg-primary text-white rounded-lg text-sm">추가</button>
            </div>
            {(lab.members || []).map((m: any) => (
              <div key={m.id} className="flex items-center gap-3 bg-bg-input p-3 rounded-lg">
                <User className="w-5 h-5 text-text-muted" />
                <div className="flex-1">
                  <p className="text-text-heading text-sm font-medium">{m.name}{m.nameEn ? ` (${m.nameEn})` : ''}</p>
                  <p className="text-text-muted text-xs">{m.role} · {m.email || '이메일 미등록'}</p>
                </div>
                <button onClick={() => handleDeleteMember(m.id, m.name)} className="text-xs text-text-muted hover:text-red-400 px-2 py-1 rounded hover:bg-red-500/10"><X className="w-3.5 h-3.5" /></button>
              </div>
            ))}
            {(lab.members || []).length === 0 && <p className="text-text-muted text-xs text-center py-4">구성원을 추가해보세요. Brain 대화에서도 가능해요: "김태영 박사과정 추가해줘"</p>}
            {lab.homepageUrl && (
              <div className="pt-3 border-t border-border/30">
                <button onClick={handleFetchHomepage} disabled={fetchingHomepage}
                  className="px-4 py-2 bg-bg-input text-text-muted border border-border rounded-lg text-sm hover:text-text-heading disabled:opacity-50">
                  {fetchingHomepage ? <Loader2 className="w-4 h-4 animate-spin inline mr-1" /> : <Search className="w-4 h-4 inline mr-1" />}
                  홈페이지에서 정보 가져오기
                </button>
                <p className="text-text-muted text-[11px] mt-1">멤버 영문 이름, 연구 키워드, 논문 등을 자동 추출합니다</p>
              </div>
            )}
          </div>
        )}

        {tab === 'projects' && (
          <div className="space-y-4">
            <div className="flex gap-2">
              <input value={newProjectName} onChange={e => setNewProjectName(e.target.value)} placeholder="과제명" className="flex-1 bg-bg-input text-text-heading px-3 py-2 rounded-lg text-sm focus:outline-none" />
              <input value={newProjectFunder} onChange={e => setNewProjectFunder(e.target.value)} placeholder="지원기관" className="w-40 bg-bg-input text-text-heading px-3 py-2 rounded-lg text-sm focus:outline-none" />
              <button onClick={handleAddProject} className="px-4 py-2 bg-primary text-white rounded-lg text-sm">추가</button>
            </div>
            {(lab.projects || []).map((p: any) => (
              <div key={p.id} className="flex items-center gap-3 bg-bg-input p-3 rounded-lg">
                <ClipboardList className="w-5 h-5 text-text-muted" />
                <div className="flex-1">
                  <p className="text-text-heading text-sm font-medium">{p.name}</p>
                  <p className="text-text-muted text-xs">{p.funder || '미등록'} · {p.status}</p>
                </div>
              </div>
            ))}
            {(lab.projects || []).length === 0 && <p className="text-text-muted text-xs text-center py-4">과제 정보를 등록하면 사사 문구를 빠르게 조회할 수 있어요</p>}
          </div>
        )}

        {tab === 'dict' && (
          <div className="space-y-4">
            <p className="text-text-muted text-xs mb-2">회의록과 대화에서 전문용어를 자동 교정합니다. 대표 논문 DOI를 입력하면 자동 구축됩니다.</p>
            <div className="flex gap-2">
              <input value={newDictWrong} onChange={e => setNewDictWrong(e.target.value)} placeholder="잘못된 표현" className="flex-1 bg-bg-input text-text-heading px-3 py-2 rounded-lg text-sm focus:outline-none" />
              <span className="text-text-muted self-center">→</span>
              <input value={newDictCorrect} onChange={e => setNewDictCorrect(e.target.value)} placeholder="올바른 표현" className="flex-1 bg-bg-input text-text-heading px-3 py-2 rounded-lg text-sm focus:outline-none" />
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

      {/* 홈페이지 정보 미리보기 모달 */}
      {homepageData && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={() => setHomepageData(null)}>
          <div className="bg-bg-card rounded-xl border border-border max-w-2xl w-full max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="p-4 border-b border-border flex items-center justify-between sticky top-0 bg-bg-card z-10">
              <h3 className="text-text-heading font-medium">홈페이지에서 추출된 정보</h3>
              <button onClick={() => setHomepageData(null)} className="text-text-muted hover:text-text-heading"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-4 space-y-5">

              {/* 멤버 */}
              {(homepageData.members || []).length > 0 && (
                <div>
                  <h4 className="text-text-heading text-sm font-medium mb-2">구성원 ({homepageData.members.length})</h4>
                  <div className="space-y-1.5">
                    {homepageData.members.map((m: any, i: number) => (
                      <label key={i} className="flex items-center gap-2 p-2 rounded-lg hover:bg-bg-hover cursor-pointer">
                        <input type="checkbox" checked={!!homepageChecked[`member-${i}`]}
                          onChange={e => setHomepageChecked(prev => ({ ...prev, [`member-${i}`]: e.target.checked }))}
                          className="rounded" />
                        <div className="flex-1 min-w-0">
                          <span className="text-text-heading text-sm">{m.name}{m.nameEn ? ` (${m.nameEn})` : ''}</span>
                          <span className="text-text-muted text-xs ml-2">{m.role}</span>
                          {m.email && <span className="text-text-muted text-xs ml-2">{m.email}</span>}
                        </div>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${m.isNew ? 'bg-green-500/10 text-green-500' : 'bg-blue-500/10 text-blue-400'}`}>
                          {m.isNew ? '신규' : '업데이트'}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* 연구 키워드 */}
              {(homepageData.researchKeywords || []).length > 0 && (
                <div>
                  <h4 className="text-text-heading text-sm font-medium mb-2">연구 키워드 ({homepageData.researchKeywords.length})</h4>
                  <div className="flex flex-wrap gap-2">
                    {homepageData.researchKeywords.map((kw: string, i: number) => (
                      <label key={i} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-bg-hover cursor-pointer hover:bg-bg-input">
                        <input type="checkbox" checked={!!homepageChecked[`keyword-${i}`]}
                          onChange={e => setHomepageChecked(prev => ({ ...prev, [`keyword-${i}`]: e.target.checked }))}
                          className="rounded w-3 h-3" />
                        <span className="text-text-heading text-xs">{kw}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* 논문 */}
              {(homepageData.publications || []).length > 0 && (
                <div>
                  <h4 className="text-text-heading text-sm font-medium mb-2">논문 ({homepageData.publications.length})</h4>
                  <div className="space-y-1.5">
                    {homepageData.publications.map((p: any, i: number) => (
                      <label key={i} className="flex items-start gap-2 p-2 rounded-lg hover:bg-bg-hover cursor-pointer">
                        <input type="checkbox" checked={!!homepageChecked[`pub-${i}`]}
                          onChange={e => setHomepageChecked(prev => ({ ...prev, [`pub-${i}`]: e.target.checked }))}
                          className="rounded mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <p className="text-text-heading text-sm leading-snug">{p.title}</p>
                          <p className="text-text-muted text-xs truncate">{p.authors} · {p.journal} ({p.year})</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* 연구실 소개 */}
              {homepageData.labDescription && (
                <div>
                  <label className="flex items-start gap-2 cursor-pointer">
                    <input type="checkbox" checked={!!homepageChecked['description']}
                      onChange={e => setHomepageChecked(prev => ({ ...prev, description: e.target.checked }))}
                      className="rounded mt-1" />
                    <div>
                      <h4 className="text-text-heading text-sm font-medium">연구실 소개</h4>
                      <p className="text-text-muted text-xs mt-1 line-clamp-3">{homepageData.labDescription}</p>
                    </div>
                  </label>
                </div>
              )}

              {/* 전체 선택/해제 + 적용 */}
              <div className="flex items-center justify-between pt-3 border-t border-border/30">
                <button onClick={() => {
                  const allChecked = Object.values(homepageChecked).every(v => v);
                  const newChecks: Record<string, boolean> = {};
                  Object.keys(homepageChecked).forEach(k => { newChecks[k] = !allChecked; });
                  setHomepageChecked(newChecks);
                }} className="text-text-muted text-xs hover:text-text-heading">
                  {Object.values(homepageChecked).every(v => v) ? '전체 해제' : '전체 선택'}
                </button>
                <div className="flex gap-2">
                  <button onClick={() => setHomepageData(null)} className="px-4 py-2 text-text-muted text-sm hover:text-text-heading">취소</button>
                  <button onClick={handleApplyHomepage} disabled={applyingHomepage || !Object.values(homepageChecked).some(v => v)}
                    className="px-4 py-2 bg-primary text-white rounded-lg text-sm disabled:opacity-50">
                    {applyingHomepage ? <Loader2 className="w-4 h-4 animate-spin inline mr-1" /> : null}
                    선택 항목 반영 ({Object.values(homepageChecked).filter(v => v).length}건)
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
