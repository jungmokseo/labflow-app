/**
 * LabFlow Seed Script — 실제 BLISS Lab 데이터로 Lab Memory 초기화
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL || '' },
  },
});

async function seed() {
  console.log('🌱 Seeding LabFlow with BLISS Lab data...\n');

  // 1. Create dev user if not exists
  // Try finding existing user first
  let existingUser = await prisma.user.findFirst({ where: { email: 'jungmok.seo@gmail.com' } });
  if (!existingUser) {
    existingUser = await prisma.user.findFirst({ where: { clerkId: 'dev-user-seo' } });
  }
  const user = existingUser || await prisma.user.create({
    data: {
      clerkId: 'dev-user-seo',
      email: 'jungmok.seo@gmail.com',
      name: '서정목',
      labName: 'BLISS Lab',
      plan: 'MAX',
      credits: 5000,
    },
  });
  // Update existing user plan if needed
  if (existingUser) {
    await prisma.user.update({ where: { id: existingUser.id }, data: { plan: 'MAX', credits: 5000, labName: 'BLISS Lab' } });
  }
  console.log(`✅ User: ${user.name} (${user.id})`);

  // 2. Create Lab Profile
  const lab = await prisma.lab.upsert({
    where: { ownerId: user.id },
    update: {
      researchFields: ['flexible electronics', 'hydrogel', 'liquid metal', 'wearable devices', 'soft robotics', 'biosensor', 'stretchable electronics'],
    },
    create: {
      ownerId: user.id,
      name: 'BLISS Lab (Bio-integrated Lab for Intelligent Soft Systems)',
      institution: '연세대학교',
      department: 'School of Electrical and Electronic Engineering',
      piName: '서정목',
      piEmail: 'jungmok.seo@yonsei.ac.kr',
      researchFields: ['flexible electronics', 'hydrogel', 'liquid metal', 'wearable devices', 'soft robotics', 'biosensor', 'stretchable electronics'],
      homepageUrl: 'https://blisslab.yonsei.ac.kr',
      acknowledgment: 'This work was supported by the National Research Foundation of Korea (NRF) grant funded by the Korea government (MSIT)',
      responseStyle: 'formal',
      onboardingDone: true,
    },
  });
  console.log(`✅ Lab: ${lab.name} (${lab.id})`);

  // 3. Seed Lab Members (from 연구실 개인별 관리)
  const members = [
    { name: '김태영', role: '박사후연구원', email: 'taeyoung.kim@yonsei.ac.kr' },
    { name: '김수아', role: '박사과정', email: 'sooa.kim@yonsei.ac.kr' },
    { name: '조예진', role: '박사과정', email: 'yejin.jo@yonsei.ac.kr' },
    { name: '이유림', role: '박사과정', email: 'yurim.lee@yonsei.ac.kr' },
    { name: '육근영', role: '박사과정', email: 'keunyoung.yook@yonsei.ac.kr' },
    { name: '손가영', role: '박사과정', email: 'gayoung.son@yonsei.ac.kr' },
    { name: '강민경', role: '석사과정', email: 'minkyung.kang@yonsei.ac.kr' },
    { name: '박시연', role: '석사과정', email: 'siyeon.park@yonsei.ac.kr' },
    { name: '함혜인', role: '석사과정', email: 'hyein.ham@yonsei.ac.kr' },
    { name: '정윤민', role: '석사과정', email: 'yunmin.jung@yonsei.ac.kr' },
    { name: '김찬수', role: '석사과정', email: 'chansu.kim@yonsei.ac.kr' },
    { name: '김미도', role: '석사과정', email: 'mido.kim@yonsei.ac.kr' },
    { name: '장한빛', role: '석사과정', email: 'hanbit.jang@yonsei.ac.kr' },
    { name: '홍승완', role: '학부연구생', email: 'seungwan.hong@yonsei.ac.kr' },
    { name: '박지민', role: '학부연구생', email: 'jimin.park@yonsei.ac.kr' },
  ];

  for (const m of members) {
    await prisma.labMember.upsert({
      where: { id: `${lab.id}-${m.name}` },
      update: m,
      create: { labId: lab.id, ...m },
    });
  }
  console.log(`✅ Members: ${members.length}명 시드 완료`);

  // 4. Seed Projects
  const projects = [
    { name: 'NRF 기본연구', funder: 'NRF', number: '2022R1A2C1234567', status: 'active', acknowledgment: 'This work was supported by the NRF grant funded by the Korea government (MSIT) (No. 2022R1A2C1234567)' },
    { name: '서울시 이온토포레틱', funder: '서울시', status: 'active' },
    { name: 'TIPS 창상치유', funder: 'TIPS', status: 'active' },
    { name: '뉴트리(Nutriadvisor) LED 마스크', funder: '기업협업', status: 'active' },
    { name: 'BK21 Four', funder: '교육부', status: 'active' },
    { name: '뇌선도/BRL 신경자극기', funder: '공동연구', status: 'active' },
    { name: '미래도전 과제', funder: 'NRF', status: 'active' },
    { name: 'Rise-Y 자율성과', funder: '연세대', status: 'active' },
  ];

  for (const p of projects) {
    await prisma.project.create({ data: { labId: lab.id, ...p } }).catch(() => {});
  }
  console.log(`✅ Projects: ${projects.length}개 시드 완료`);

  // 5. Seed Domain Dictionary (전문용어 교정 사전)
  const dictEntries = [
    { wrongForm: 'pdms', correctForm: 'PDMS', category: '재료' },
    { wrongForm: 'pedot pss', correctForm: 'PEDOT:PSS', category: '재료' },
    { wrongForm: 'pedotpss', correctForm: 'PEDOT:PSS', category: '재료' },
    { wrongForm: 'egain', correctForm: 'EGaIn', category: '재료' },
    { wrongForm: 'liquid metal', correctForm: 'Liquid Metal (LM)', category: '재료' },
    { wrongForm: 'gelma', correctForm: 'GelMA', category: '재료' },
    { wrongForm: 'gelta', correctForm: 'GelTA', category: '재료' },
    { wrongForm: 'pva', correctForm: 'PVA', category: '재료' },
    { wrongForm: 'mxene', correctForm: 'MXene', category: '재료' },
    { wrongForm: 'pda lm', correctForm: 'PDA-LM', category: '재료' },
    { wrongForm: 'sebs', correctForm: 'SEBS', category: '재료' },
    { wrongForm: 'pib', correctForm: 'PIB', category: '재료' },
    { wrongForm: 'pvb', correctForm: 'PVB', category: '재료' },
    { wrongForm: 'sa dopa', correctForm: 'SA-DOPA', category: '재료' },
    { wrongForm: 'fpcb', correctForm: 'FPCB', category: '장비/소자' },
    { wrongForm: 'pcb', correctForm: 'PCB', category: '장비/소자' },
    { wrongForm: 'ecg', correctForm: 'ECG', category: '측정' },
    { wrongForm: 'emg', correctForm: 'EMG', category: '측정' },
    { wrongForm: 'ppg', correctForm: 'PPG', category: '측정' },
    { wrongForm: 'emi', correctForm: 'EMI', category: '측정' },
    { wrongForm: 'vna', correctForm: 'VNA', category: '장비' },
    { wrongForm: 'ftir', correctForm: 'FT-IR', category: '분석' },
    { wrongForm: 'xps', correctForm: 'XPS', category: '분석' },
    { wrongForm: 'xrd', correctForm: 'XRD', category: '분석' },
    { wrongForm: 'sem', correctForm: 'SEM', category: '분석' },
    { wrongForm: 'tem', correctForm: 'TEM', category: '분석' },
    { wrongForm: 'dls', correctForm: 'DLS', category: '분석' },
    { wrongForm: 'dpv', correctForm: 'DPV', category: '분석' },
    { wrongForm: 'wvtr', correctForm: 'WVTR', category: '측정' },
    { wrongForm: 'otr', correctForm: 'OTR', category: '측정' },
    { wrongForm: 'nrf', correctForm: 'NRF', category: '과제' },
    { wrongForm: 'bk21', correctForm: 'BK21', category: '과제' },
    { wrongForm: 'iris', correctForm: 'IRIS', category: '과제' },
    { wrongForm: 'tips', correctForm: 'TIPS', category: '과제' },
    { wrongForm: 'ted', correctForm: 'TED (Thermoelectric Device)', category: '소자' },
    { wrongForm: 'stt', correctForm: 'STT (Speech-to-Text)', category: 'AI' },
    { wrongForm: 'stretchable', correctForm: 'stretchable (신축성)', category: '속성' },
    { wrongForm: 'biocompatibility', correctForm: 'biocompatibility (생체적합성)', category: '속성' },
    { wrongForm: 'iontophoretic', correctForm: 'iontophoretic (이온토포레틱)', category: '기술' },
  ];

  for (const d of dictEntries) {
    await prisma.domainDict.upsert({
      where: { labId_wrongForm: { labId: lab.id, wrongForm: d.wrongForm } },
      update: { correctForm: d.correctForm, category: d.category },
      create: { labId: lab.id, ...d },
    });
  }
  console.log(`✅ Dictionary: ${dictEntries.length}개 용어 시드 완료`);

  // 6. Seed Publications (주요 논문)
  const pubs = [
    { title: 'Hemostatic Hydrogel', journal: 'Nature Communications', year: 2026, authors: '김태영, 손가영 et al.' },
    { title: 'LM Spray', journal: 'Nature Communications', year: 2026, authors: '육근영, 김태영 et al.' },
    { title: 'Exosome Carrier', journal: 'Science Advances', year: 2026, authors: '김태영 et al.' },
    { title: '내시경 캡 코팅', journal: 'Under Review', year: 2026, authors: '손가영 et al.' },
    { title: 'Salting-out Hydrogel EC Sensor', journal: 'Advanced Materials', year: 2026, authors: '김수아 et al.' },
    { title: 'Electroceutical Patch', journal: 'Advanced Healthcare Materials', year: 2026, authors: '김수아 et al.' },
    { title: 'Soft Electronics Packaging Review', journal: 'Under Review', year: 2026, authors: '이유림 et al.' },
    { title: 'Bile Duct Smart Stent', journal: 'Bioactive Materials', year: 2026, authors: '김태영 et al.' },
    { title: 'ACS Nano Stent', journal: 'ACS Nano', year: 2026, authors: '조예진 et al.' },
  ];

  for (const p of pubs) {
    await prisma.publication.create({ data: { labId: lab.id, ...p } }).catch(() => {});
  }
  console.log(`✅ Publications: ${pubs.length}편 시드 완료`);

  // 7. Seed Memos (Lab Memory)
  const memos = [
    { content: 'Hemostatic hydrogel — Nature Communications Accepted! 김태영 박사, 손가영 공저', tags: ['논문', '축하', 'Nat.Com'], source: 'chat' },
    { content: 'LM Spray — Nature Communications 제출 완료 (manuscript in consideration)', tags: ['논문', 'LM Spray'], source: 'chat' },
    { content: '플립칩 본더(Flip-chip bonder) 외부 사용자 장비 운용 지원 — 유림, 혜인 담당', tags: ['장비', '플립칩본더'], source: 'chat' },
    { content: '뉴트리 LED 마스크 — TIPS 과제, 절연저항측정/광출력/임상용 샘플 제작 진행 중', tags: ['과제', '뉴트리', 'TIPS'], source: 'chat' },
    { content: '4월 초 삼성서울병원 동물실험 예정 — 뇌선도 관련', tags: ['일정', '동물실험', '뇌선도'], source: 'chat' },
    { content: 'AutoPCB 프로젝트 — 찬수, 미도, 한빛 참여 중. Track A~F 진행', tags: ['사업', 'AutoPCB'], source: 'chat' },
    { content: '생체재료학회 포스터 제작 — 근영, 가영 담당', tags: ['학회', '포스터'], source: 'chat' },
    { content: 'Burns & Trauma 리뷰 → Materials Today Bio로 포맷 변경하여 재제출 준비 — 가영, 수아', tags: ['논문', '리뷰'], source: 'chat' },
    { content: 'PDMS 기반 스트레처블 바이오센서 — 주요 연구 주제, SEM/FT-IR/XPS 분석 필수', tags: ['연구', '바이오센서'], source: 'manual' },
    { content: '아산병원 C-line 미팅 완료 — 대조군 선정 및 샘플 수정 예정 (가영)', tags: ['미팅', '병원', '가영'], source: 'chat' },
  ];

  for (const m of memos) {
    await prisma.memo.create({ data: { labId: lab.id, userId: user.id, ...m } }).catch(() => {});
  }
  console.log(`✅ Memos: ${memos.length}개 시드 완료`);

  // 8. Seed Paper Alert Setting
  await prisma.paperAlert.upsert({
    where: { id: `${lab.id}-default` },
    update: {
      keywords: ['flexible electronics', 'stretchable', 'hydrogel', 'liquid metal', 'wearable', 'biosensor', 'bioelectronics', 'soft robotics', 'PEDOT:PSS', 'MXene'],
    },
    create: {
      labId: lab.id,
      keywords: ['flexible electronics', 'stretchable', 'hydrogel', 'liquid metal', 'wearable', 'biosensor', 'bioelectronics', 'soft robotics', 'PEDOT:PSS', 'MXene'],
      journals: ['Nature', 'Nature Materials', 'Nature Electronics', 'ACS Nano', 'Advanced Materials', 'Advanced Functional Materials', 'Nano Letters', 'Small', 'Biosensors and Bioelectronics'],
      schedule: 'weekly',
    },
  });
  console.log(`✅ Paper Alert: 10개 키워드, 9개 저널 설정 완료`);

  // 9. Create default Brain channel
  await prisma.channel.create({
    data: { userId: user.id, type: 'BRAIN', name: '미니브레인' },
  }).catch(() => {});
  console.log(`✅ Default Brain channel 생성 완료`);

  console.log('\n🎉 시드 완료! 총 결과:');
  console.log(`   사용자: 1명`);
  console.log(`   연구실: ${lab.name}`);
  console.log(`   구성원: ${members.length}명`);
  console.log(`   과제: ${projects.length}개`);
  console.log(`   논문: ${pubs.length}편`);
  console.log(`   용어사전: ${dictEntries.length}개`);
  console.log(`   메모: ${memos.length}개`);

  await prisma.$disconnect();
}

seed().catch(e => {
  console.error('❌ Seed failed:', e);
  process.exit(1);
});
