'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  createLab,
  completeOnboarding,
  addLabMember,
} from '@/lib/api';

type Step = 'lab' | 'themes' | 'members' | 'email' | 'done';

interface MemberInput {
  name: string;
  email: string;
  role: string;
}

interface ThemeInput {
  name: string;
  keywords: string;
  journals: string;
}

interface EmailAccount {
  name: string;
  domains: string;
  emoji: string;
}

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('lab');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1: Lab Info
  const [labName, setLabName] = useState('');
  const [institution, setInstitution] = useState('');
  const [department, setDepartment] = useState('');
  const [piName, setPiName] = useState('');
  const [piEmail, setPiEmail] = useState('');
  const [homepageUrl, setHomepageUrl] = useState('');

  // Step 2: Research Themes
  const [themes, setThemes] = useState<ThemeInput[]>([
    { name: '', keywords: '', journals: '' },
  ]);
  const [autoExtracted, setAutoExtracted] = useState(false);

  // Step 3: Members
  const [members, setMembers] = useState<MemberInput[]>([
    { name: '', email: '', role: '학생' },
  ]);

  // Step 4: Email Accounts
  const [emailAccounts, setEmailAccounts] = useState<EmailAccount[]>([]);

  const handleCreateLab = async () => {
    if (!labName.trim()) {
      setError('연구실 이름을 입력해주세요');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await createLab({
        name: labName,
        institution: institution || undefined,
        department: department || undefined,
        piName: piName || undefined,
        piEmail: piEmail || undefined,
        homepageUrl: homepageUrl || undefined,
      });
      setStep('themes');
    } catch (err: any) {
      if (err.message?.includes('409') || err.message?.includes('이미')) {
        // Lab already exists, just proceed
        setStep('themes');
      } else {
        setError(err.message);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleAutoExtract = async () => {
    if (!homepageUrl) return;
    setLoading(true);
    setError(null);
    try {
      const result = await completeOnboarding({ homepageUrl });
      if (result.extractedKeywords?.length > 0) {
        // Convert flat keywords to theme structure
        const lab = result.lab as any;
        if (lab.researchThemes?.length > 0) {
          setThemes(lab.researchThemes.map((t: any) => ({
            name: t.name,
            keywords: t.keywords.join(', '),
            journals: (t.journals || []).join(', '),
          })));
        } else {
          setThemes([{
            name: '연구 분야',
            keywords: result.extractedKeywords.join(', '),
            journals: '',
          }]);
        }
        setAutoExtracted(true);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveThemes = async () => {
    setLoading(true);
    setError(null);
    try {
      const validThemes = themes
        .filter(t => t.name.trim() && t.keywords.trim())
        .map(t => ({
          name: t.name.trim(),
          keywords: t.keywords.split(',').map(k => k.trim()).filter(Boolean),
          journals: t.journals ? t.journals.split(',').map(j => j.trim()).filter(Boolean) : [],
        }));

      const allKeywords = validThemes.flatMap(t => t.keywords);

      if (!autoExtracted) {
        await completeOnboarding({
          keywords: allKeywords,
          researchThemes: validThemes,
        });
      }
      setStep('members');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveMembers = async () => {
    setLoading(true);
    setError(null);
    try {
      const validMembers = members.filter(m => m.name.trim());
      for (const m of validMembers) {
        await addLabMember({
          name: m.name.trim(),
          email: m.email.trim() || undefined,
          role: m.role || '학생',
        });
      }
      setStep('email');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleFinish = async () => {
    setLoading(true);
    try {
      const validAccounts = emailAccounts
        .filter(a => a.name.trim() && a.domains.trim())
        .map(a => ({
          name: a.name.trim(),
          domains: a.domains.split(',').map(d => d.trim()).filter(Boolean),
          emoji: a.emoji || '📧',
        }));

      if (validAccounts.length > 0) {
        await completeOnboarding({ emailAccounts: validAccounts });
      }
      setStep('done');
      setTimeout(() => router.push('/brain'), 2000);
    } catch {
      setStep('done');
      setTimeout(() => router.push('/brain'), 2000);
    } finally {
      setLoading(false);
    }
  };

  const STEPS: { key: Step; label: string }[] = [
    { key: 'lab', label: '연구실 정보' },
    { key: 'themes', label: '연구 테마' },
    { key: 'members', label: '팀원' },
    { key: 'email', label: '이메일 설정' },
  ];

  const currentIdx = STEPS.findIndex(s => s.key === step);

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        {/* Progress Bar */}
        {step !== 'done' && (
          <div className="mb-8">
            <div className="flex items-center justify-between mb-2">
              {STEPS.map((s, i) => (
                <div key={s.key} className="flex items-center">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold
                    ${i <= currentIdx ? 'bg-primary text-white' : 'bg-bg-input text-text-muted'}`}>
                    {i + 1}
                  </div>
                  {i < STEPS.length - 1 && (
                    <div className={`w-16 h-0.5 mx-1 ${i < currentIdx ? 'bg-primary' : 'bg-bg-input'}`} />
                  )}
                </div>
              ))}
            </div>
            <p className="text-center text-sm text-text-muted">
              {STEPS[currentIdx]?.label}
            </p>
          </div>
        )}

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-red-400 text-sm mb-4">
            {error}
          </div>
        )}

        {/* Step 1: Lab Info */}
        {step === 'lab' && (
          <div className="bg-bg-card rounded-2xl border border-bg-input/50 p-8 space-y-6">
            <div className="text-center mb-4">
              <span className="text-5xl block mb-3">🔬</span>
              <h1 className="text-2xl font-bold text-white">연구실 설정</h1>
              <p className="text-text-muted mt-1">ResearchFlow가 연구실에 맞게 동작하도록 기본 정보를 입력해주세요</p>
            </div>

            <Input label="연구실 이름 *" value={labName} onChange={setLabName} placeholder="예: BLISS Lab" />
            <Input label="소속 기관" value={institution} onChange={setInstitution} placeholder="예: 연세대학교" />
            <Input label="학과/부서" value={department} onChange={setDepartment} placeholder="예: 전기전자공학과" />
            <div className="grid grid-cols-2 gap-4">
              <Input label="PI 이름" value={piName} onChange={setPiName} placeholder="예: 서정목" />
              <Input label="PI 이메일" value={piEmail} onChange={setPiEmail} placeholder="예: jungmok@yonsei.ac.kr" />
            </div>
            <Input label="홈페이지 URL (선택)" value={homepageUrl} onChange={setHomepageUrl} placeholder="AI가 연구 테마를 자동 추출합니다" />

            <button
              onClick={handleCreateLab}
              disabled={loading}
              className="w-full py-3 bg-primary hover:bg-primary-hover text-white rounded-lg font-medium transition-colors disabled:opacity-50"
            >
              {loading ? '생성 중...' : '다음'}
            </button>
          </div>
        )}

        {/* Step 2: Research Themes */}
        {step === 'themes' && (
          <div className="bg-bg-card rounded-2xl border border-bg-input/50 p-8 space-y-6">
            <div className="text-center mb-4">
              <span className="text-5xl block mb-3">📚</span>
              <h1 className="text-2xl font-bold text-white">연구 테마</h1>
              <p className="text-text-muted mt-1">연구 분야별 키워드를 설정하면 이메일 분류와 논문 모니터링에 활용됩니다</p>
            </div>

            {homepageUrl && !autoExtracted && (
              <button
                onClick={handleAutoExtract}
                disabled={loading}
                className="w-full py-2.5 bg-blue-500/10 text-blue-400 border border-blue-500/30 rounded-lg text-sm font-medium hover:bg-blue-500/20 transition-colors disabled:opacity-50"
              >
                {loading ? 'AI 분석 중...' : '🤖 홈페이지에서 자동 추출'}
              </button>
            )}

            {themes.map((theme, i) => (
              <div key={i} className="space-y-3 bg-bg/50 rounded-lg p-4 border border-bg-input/30">
                <div className="flex items-center justify-between">
                  <Input label={`테마 ${i + 1} 이름`} value={theme.name} onChange={v => {
                    const next = [...themes]; next[i].name = v; setThemes(next);
                  }} placeholder="예: 하이드로겔" />
                  {themes.length > 1 && (
                    <button onClick={() => setThemes(themes.filter((_, j) => j !== i))} className="text-red-400 text-xs ml-2 mt-5">삭제</button>
                  )}
                </div>
                <Input label="키워드 (쉼표 구분)" value={theme.keywords} onChange={v => {
                  const next = [...themes]; next[i].keywords = v; setThemes(next);
                }} placeholder="예: hydrogel, PVA, self-healing, 자가치유" />
                <Input label="관련 저널 (선택, 쉼표 구분)" value={theme.journals} onChange={v => {
                  const next = [...themes]; next[i].journals = v; setThemes(next);
                }} placeholder="예: Nature Materials, Advanced Materials" />
              </div>
            ))}

            <button
              onClick={() => setThemes([...themes, { name: '', keywords: '', journals: '' }])}
              className="w-full py-2 text-primary text-sm border border-primary/30 rounded-lg hover:bg-primary/5"
            >
              + 테마 추가
            </button>

            <div className="flex gap-3">
              <button onClick={() => setStep('lab')} className="flex-1 py-3 bg-bg-input text-white rounded-lg">이전</button>
              <button onClick={handleSaveThemes} disabled={loading} className="flex-1 py-3 bg-primary hover:bg-primary-hover text-white rounded-lg font-medium disabled:opacity-50">
                {loading ? '저장 중...' : '다음'}
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Team Members */}
        {step === 'members' && (
          <div className="bg-bg-card rounded-2xl border border-bg-input/50 p-8 space-y-6">
            <div className="text-center mb-4">
              <span className="text-5xl block mb-3">👥</span>
              <h1 className="text-2xl font-bold text-white">팀원 추가</h1>
              <p className="text-text-muted mt-1">팀원을 등록하면 이메일에서 멤버 메일을 자동으로 중요 처리합니다</p>
            </div>

            {members.map((m, i) => (
              <div key={i} className="flex items-start gap-3">
                <div className="flex-1 grid grid-cols-3 gap-3">
                  <Input label="이름" value={m.name} onChange={v => {
                    const next = [...members]; next[i].name = v; setMembers(next);
                  }} placeholder="이름" />
                  <Input label="이메일" value={m.email} onChange={v => {
                    const next = [...members]; next[i].email = v; setMembers(next);
                  }} placeholder="email@univ.ac.kr" />
                  <div>
                    <label className="block text-xs text-text-muted mb-1">역할</label>
                    <select
                      value={m.role}
                      onChange={e => {
                        const next = [...members]; next[i].role = e.target.value; setMembers(next);
                      }}
                      className="w-full px-3 py-2 bg-bg-input rounded-lg text-white text-sm border border-bg-input/50 focus:border-primary outline-none"
                    >
                      <option value="학생">학생 (대학원생)</option>
                      <option value="박사후연구원">박사후연구원</option>
                      <option value="연구원">연구원</option>
                      <option value="직원">직원</option>
                      <option value="교수">교수</option>
                    </select>
                  </div>
                </div>
                {members.length > 1 && (
                  <button onClick={() => setMembers(members.filter((_, j) => j !== i))} className="text-red-400 text-xs mt-6">삭제</button>
                )}
              </div>
            ))}

            <button
              onClick={() => setMembers([...members, { name: '', email: '', role: '학생' }])}
              className="w-full py-2 text-primary text-sm border border-primary/30 rounded-lg hover:bg-primary/5"
            >
              + 팀원 추가
            </button>

            <div className="flex gap-3">
              <button onClick={() => setStep('themes')} className="flex-1 py-3 bg-bg-input text-white rounded-lg">이전</button>
              <button onClick={handleSaveMembers} disabled={loading} className="flex-1 py-3 bg-primary hover:bg-primary-hover text-white rounded-lg font-medium disabled:opacity-50">
                {loading ? '저장 중...' : '다음'}
              </button>
              <button onClick={() => setStep('email')} className="py-3 px-4 text-text-muted text-sm hover:text-white">건너뛰기</button>
            </div>
          </div>
        )}

        {/* Step 4: Email Setup */}
        {step === 'email' && (
          <div className="bg-bg-card rounded-2xl border border-bg-input/50 p-8 space-y-6">
            <div className="text-center mb-4">
              <span className="text-5xl block mb-3">📧</span>
              <h1 className="text-2xl font-bold text-white">이메일 기관 분류</h1>
              <p className="text-text-muted mt-1">
                이메일을 받는 기관/조직을 등록하면, 브리핑에서 기관별로 자동 분류합니다.
                <br />여러 이메일 계정이 하나로 포워딩되어 있을 때 유용합니다.
              </p>
            </div>

            {emailAccounts.length === 0 && (
              <div className="bg-bg/50 rounded-lg p-4 text-center text-text-muted text-sm">
                기관별 분류 없이 성격별(긴급/대응필요/일정/정보/광고) 분류만 사용할 수 있습니다.
              </div>
            )}

            {emailAccounts.map((acc, i) => (
              <div key={i} className="grid grid-cols-[auto_1fr_2fr] gap-3 items-end">
                <div>
                  <label className="block text-xs text-text-muted mb-1">이모지</label>
                  <input
                    value={acc.emoji}
                    onChange={e => {
                      const next = [...emailAccounts]; next[i].emoji = e.target.value; setEmailAccounts(next);
                    }}
                    className="w-14 px-2 py-2 bg-bg-input rounded-lg text-white text-center text-sm border border-bg-input/50"
                  />
                </div>
                <Input label="기관명" value={acc.name} onChange={v => {
                  const next = [...emailAccounts]; next[i].name = v; setEmailAccounts(next);
                }} placeholder="예: 연세대학교" />
                <Input label="이메일 도메인 (쉼표 구분)" value={acc.domains} onChange={v => {
                  const next = [...emailAccounts]; next[i].domains = v; setEmailAccounts(next);
                }} placeholder="예: yonsei.ac.kr" />
              </div>
            ))}

            <button
              onClick={() => setEmailAccounts([...emailAccounts, { name: '', domains: '', emoji: '🏫' }])}
              className="w-full py-2 text-primary text-sm border border-primary/30 rounded-lg hover:bg-primary/5"
            >
              + 기관 추가
            </button>

            <div className="flex gap-3">
              <button onClick={() => setStep('members')} className="flex-1 py-3 bg-bg-input text-white rounded-lg">이전</button>
              <button onClick={handleFinish} disabled={loading} className="flex-1 py-3 bg-primary hover:bg-primary-hover text-white rounded-lg font-medium disabled:opacity-50">
                {loading ? '완료 중...' : '설정 완료'}
              </button>
            </div>
          </div>
        )}

        {/* Done */}
        {step === 'done' && (
          <div className="bg-bg-card rounded-2xl border border-bg-input/50 p-12 text-center">
            <span className="text-6xl block mb-4">✅</span>
            <h1 className="text-2xl font-bold text-white mb-2">설정 완료!</h1>
            <p className="text-text-muted">
              연구실 프로필이 설정되었습니다. 이메일 분류 키워드와 논문 알림이 자동으로 구성됩니다.
            </p>
            <p className="text-sm text-text-muted mt-4">잠시 후 대시보드로 이동합니다...</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Input({ label, value, onChange, placeholder }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-text-muted mb-1">{label}</label>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 bg-bg-input rounded-lg text-white text-sm border border-bg-input/50 focus:border-primary outline-none placeholder:text-text-muted/50"
      />
    </div>
  );
}
