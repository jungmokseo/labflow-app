/**
 * Javis DB → LabFlow Lab Memory 시드 스크립트
 * Notion Jarvis DB의 실제 데이터를 LabFlow의 Lab Members, Projects에 시드
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DIRECT_URL || process.env.DATABASE_URL || '' },
  },
});

async function seedJavis() {
  console.log('🔄 Seeding Javis DB data into LabFlow...\n');

  // Find the lab
  const lab = await prisma.lab.findFirst();
  if (!lab) { console.error('❌ Lab not found'); return; }
  console.log(`✅ Lab: ${lab.name} (${lab.id})`);

  // ── 1. Update members with real Javis data ─────────
  const javisMembers = [
    { name: '김태영', email: 'taeyoung.kim92@yonsei.ac.kr', phone: '010-4106-1039', role: '박사후연구원' },
    { name: '김수아', email: 'sooa.kim38@yonsei.ac.kr', phone: '010-2060-8743', role: '박사과정' },
    { name: '조예진', email: 'yejin.jo12@yonsei.ac.kr', phone: '010-9479-1121', role: '박사과정' },
    { name: '이유림', email: 'l22yurim@yonsei.ac.kr', phone: '010-4108-3715', role: '박사과정' },
    { name: '육근영', email: 'kyyook1118@yonsei.ac.kr', phone: '010-3747-1157', role: '박사과정' },
    { name: '손가영', email: 'sonky0803@yonsei.ac.kr', phone: '010-6678-4810', role: '박사과정' },
    { name: '강민경', email: 'mkkang@yonsei.ac.kr', phone: '010-6692-9020', role: '석사과정' },
    { name: '박시연', email: 'pksy51630@yonsei.ac.kr', phone: '010-4945-2992', role: '석사과정' },
    { name: '함혜인', email: 'hhi0706@yonsei.ac.kr', phone: '010-9265-8906', role: '석사과정' },
    { name: '정윤민', email: 'yunminj@yonsei.ac.kr', phone: '010-2226-6297', role: '석사과정' },
    { name: '김찬수', email: 'nce9080@yonsei.ac.kr', phone: '010-5918-3959', role: '석사과정' },
    { name: '김미도', email: 'mido.kim@yonsei.ac.kr', phone: '010-2761-3218', role: '석사과정' },
    { name: 'Xia BeiBei', email: '', phone: '', role: '박사과정' },
    { name: '장한빛', email: '', phone: '', role: '석사과정' },
    { name: '홍승완', email: '', phone: '', role: '학부연구생' },
    { name: '박지민', email: '', phone: '', role: '학부연구생' },
    { name: '조현지', email: '', phone: '', role: '학부연구생' },
  ];

  // Delete old members and re-seed with real data
  await prisma.labMember.deleteMany({ where: { labId: lab.id } });
  for (const m of javisMembers) {
    await prisma.labMember.create({
      data: {
        labId: lab.id,
        name: m.name,
        email: m.email || null,
        phone: m.phone || null,
        role: m.role,
      },
    });
  }
  console.log(`✅ Members: ${javisMembers.length}명 (Javis 실제 이메일/연락처 반영)`);

  // ── 2. Replace projects with real Javis data ───────
  await prisma.project.deleteMany({ where: { labId: lab.id } });
  const javisProjects = [
    { name: '항균·방오 기능과 연·경조직 선택적 조직 재생 성능을 지닌 차세대 융복합 소재 기반 골유착 촉진 임플란트 코팅 기술 개발', funder: '연세대학교 산학협력단', period: '25.04.01 ~ 26.03.31', pi: '서정목', pm: '태영', status: 'active' },
    { name: '힘줄 재건 및 재활을 위한 면역회피 기능성 봉합사 및 전자 봉합사 제품/사업화', funder: '범부처전주기의료기기연구개발사업단', period: '2023 ~ 2025.12.31', pm: '예진', status: 'active' },
    { name: '창상 회복 및 피부재생을 위한 스트레처블 LED 마스크 개발', funder: '산하기관 (시장대응형)', period: '24.11.02 ~ 27.06.02', pm: '수아/민경/근영', status: 'active' },
    { name: '인체유사 패치 기술을 활용한 투명 스킨패치 및 LED 패치 개발', funder: 'TIPS 기술창업기업', period: '24.12.02 ~ 27.06.02', pm: '수아/민경/근영', status: 'active' },
    { name: '미래기술연구실', funder: '미래기술연구실', period: '2021 ~ 2025.12.31', pm: '민경', status: 'active' },
    { name: '펠티에 소자 적용 냉각 및 발열 하이드로겔 패치 통합형 스마트 운동정보 측정기기 개발', funder: 'RISE-Y (연세대)', period: '25.08.25 ~ 30.02.28', pm: '시연', status: 'active' },
    { name: '신축성 바이오 인터페이싱 디바이스의 미세 피치 고집적 패키징 연구 수행을 위한 플립칩 본딩 장비 구축', funder: '한국기초과학지원연구원', period: '25.03.01 ~ 26.02.28', pm: '혜인/유림', status: 'active' },
    { name: '초격차산업기반표준전문인력양성', funder: '한국산업기술진흥원', period: '25.03.01 ~ 26.02.28', pm: '찬수/윤민', status: 'active' },
    { name: '고령 외상성 근손실 개선을 위한 약물전달 기반 자가전원형 생분해성 이온토포레틱 이식소자와 통합 재활 플랫폼 개발', funder: '한국연구재단 (나노소재)', period: '25.07.01 ~ 29.12.31', pm: '가영', status: 'active' },
    { name: '고밀도 이종 집적 반도체 패키징을 위한 수화-탈수화 기반 하이드로겔 비전도성 접착 필름 소재 기술 개발', funder: '한국연구재단 (국가아젠다 기초연구)', period: '25.09.01 ~ 28.08.31', pm: '유림/혜인', status: 'active' },
    { name: '손상된 말초 및 중추 신경 재생을 위한 신경 섬유 다발 수준 정밀 전기자극 치료 원천 기술 개발', funder: '한국연구재단 (BRL)', period: '25.06.01 ~ 28.05.31', pm: '근영/윤민', status: 'active' },
    { name: '이온영동법 기반 비침습법 약물 전달 결합형 LED 광마스크 패치 개발', funder: '서울경제진흥원 (SBA)', period: '25.09.01 ~ 27.07.31', pm: '시연', status: 'active' },
    { name: '파킨슨 환자의 장기능 저하 치료를 위한 초장기 초소형 IC 칩 통합형 연성 전자약 폐루프 시스템 개발', funder: '한국연구재단 (뇌과학선도융합기술)', period: '25.04.01 ~ 27.12.31', pm: '근영/찬수', status: 'active' },
    { name: '바이오 센테니얼 융합 연구소 (노화성 신경퇴행성 질환 치료를 위한 전기장 기반 무선 신경 차단-모니터링 HMI 플랫폼 개발)', funder: '한국연구재단 (NRL)', period: '25.09.01 ~ 28.08.31', pm: '근영', status: 'active' },
    { name: '첨단산업 글로벌 혁신인재 성장지원 사업 (핵심소재, 이차전지)', funder: '한국산업기술진흥원 (해외연계)', period: '24.03.01 ~ 27.02.28', pm: '예진', status: 'active' },
  ];

  for (const p of javisProjects) {
    await prisma.project.create({
      data: { labId: lab.id, ...p },
    });
  }
  console.log(`✅ Projects: ${javisProjects.length}개 (Javis 실제 과제 데이터)`);

  // ── 3. Add additional memos from Javis context ─────
  const user = await prisma.user.findFirst();
  if (!user) { console.error('❌ User not found'); return; }

  const extraMemos = [
    { content: 'Hemostatic hydrogel — Nature Communications Accepted! 김태영 박사, 손가영 공저. 특허 미팅 예정.', tags: ['논문', 'Nat.Com', '특허'], source: 'javis' },
    { content: 'LM Spray — Nature Communications 제출 완료 (manuscript in consideration). 육근영 담당.', tags: ['논문', 'LM Spray', '근영'], source: 'javis' },
    { content: 'Exosome Carrier — Science Advances 리뷰 중. 김태영 박사 주도.', tags: ['논문', 'Sci.Adv', '태영'], source: 'javis' },
    { content: 'AutoPCB 프로젝트 — 찬수(Track C), 미도(Track E/F), 한빛(Track A/B/D) 참여 중', tags: ['사업', 'AutoPCB'], source: 'javis' },
    { content: '4월 초 삼성서울병원 동물실험 예정 — 뇌선도 과제 관련 (근영)', tags: ['일정', '동물실험', '삼성서울병원'], source: 'javis' },
    { content: '아산병원 C-line 미팅 완료 — 대조군 선정 및 샘플 수정 예정 (가영)', tags: ['미팅', '아산병원', '가영'], source: 'javis' },
    { content: '뉴트리 LED 마스크 — TIPS+시장대응형 과제. 절연저항측정·광출력·임상용 샘플 제작 진행 중', tags: ['과제', '뉴트리', 'LED마스크'], source: 'javis' },
    { content: 'Clean View 내시경 — 임상 20번 완료, AI·VS code 도입 정리 중. 다음 보라매 병원 임상 예정 (가영/예진)', tags: ['임상', '내시경', 'Clean View'], source: 'javis' },
    { content: '플립칩 본더(Flip-chip bonder) — 혜인, 유림 담당. 외부 사용자 장비 운용 지원 중', tags: ['장비', '플립칩본더'], source: 'javis' },
    { content: '생체재료학회 포스터 제작 — 근영, 가영 담당', tags: ['학회', '포스터'], source: 'javis' },
    { content: 'PEDOT:PSS Synaptic Transistor — 박시연. 어레이 데이터 확보 중, MNIST simulation 스터디', tags: ['연구', 'PEDOT:PSS', '시연'], source: 'javis' },
    { content: '무선전력전송(WPT) — 정윤민. rigid PCB Tx → soft Rx 성공, AC/DC 컨버터 구현 완료', tags: ['연구', 'WPT', '윤민'], source: 'javis' },
    { content: 'Zwitterion Hydrogel — 박지민. UV 최적화, tensile test, PBS degradation 진행 중', tags: ['연구', '하이드로겔', '지민'], source: 'javis' },
    { content: 'MXene Hydrogel — 손가영+박지민. drug releasing 방향 아이디어 구상, 프린팅 가능여부 파악 예정', tags: ['연구', 'MXene', '가영', '지민'], source: 'javis' },
    { content: 'LM Paste — 육근영. 비정질 갈륨옥사이드 In-situ XRD 분석 완료, micro LED 시연 중', tags: ['연구', 'LM Paste', '근영'], source: 'javis' },
  ];

  for (const m of extraMemos) {
    await prisma.memo.create({
      data: { labId: lab.id, userId: user.id, ...m },
    }).catch(() => {});
  }
  console.log(`✅ Memos: ${extraMemos.length}개 추가 (Javis 기반 연구 진행 정보)`);

  console.log('\n🎉 Javis DB 시드 완료!');
  console.log(`   구성원: ${javisMembers.length}명 (실제 이메일/연락처)`);
  console.log(`   과제: ${javisProjects.length}개 (실제 과제명/기관/기간)`);
  console.log(`   메모: ${extraMemos.length}개 (연구 진행 정보)`);

  await prisma.$disconnect();
}

seedJavis().catch(e => { console.error('❌ Seed failed:', e); process.exit(1); });
