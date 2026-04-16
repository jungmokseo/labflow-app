/**
 * Heavy User 시뮬레이션 — 직접 분석한 wiki article을 DB에 INSERT.
 *
 * 입력: scripts/heavy-user-sample.json (Notion에서 fetch한 raw 데이터)
 * 알고리즘: Claude Code(=Sonnet 4.6)가 직접 분석하여 article 정의 (이 파일에 하드코딩)
 * 출력: wiki_articles 테이블에 직접 INSERT
 *
 * 목적: deployed app의 알고리즘과 비교하여 이상적 결과물 품질 검증.
 */
import 'dotenv/config';
import { prisma } from '../src/config/prisma.js';

const LAB_ID = (process.env.LAB_ID ?? '').replace(/^"|"$/g, '');
if (!LAB_ID) { console.error('LAB_ID 환경변수 없음'); process.exit(1); }

const SIM_TAG = 'sim-by-claude-code';

// ── article 정의 ────────────────────────────────────────────
type Article = {
  title: string;
  category: 'person' | 'project' | 'research_trend' | 'meeting_thread' | 'experiment' | 'collaboration' | 'general';
  content: string;
  tags: string[];
  sources: Array<{ type: string; id: string; date?: string }>;
};

const articles: Article[] = [
  // ── PROJECT 8개 ───────────────────────────────────────────
  {
    title: 'PDA-LM Sintering-Free Spray Ink',
    category: 'project',
    content: `**상태**: 2. 실험중 / **팀**: [[LM Team]] / **담당**: [[김찬수]], [[육근영]]
**타겟 저널**: ACS Nano / Advanced Functional Materials
**유형**: 연구논문

## 핵심 컨셉
폴리도파민(PDA)을 활용한 sintering-free liquid metal 잉크. 별도 소결 공정 없이 스프레이만으로 전도성 패턴 형성.

## 진행 상황
- 잉크 조성 최적화 진행 중
- 스프레이 공정 균일성 검증

## 관련
- [[LM Team]] 통합 전략의 일부
- [[LM Paste]] 프로젝트와 페이스트 vs 잉크 형태 비교 연구

생성일: 2026-04-15`,
    tags: ['liquid-metal', 'PDA', 'spray-ink', 'sintering-free'],
    sources: [{ type: 'notion_page', id: 'project-pda-lm-spray', date: '2026-04-15' }],
  },
  {
    title: 'Stretchable LM Microstrip — RF Predictive Model',
    category: 'project',
    content: `**상태**: 2. 실험중 / **팀**: [[LM Team]] / **담당**: [[김미도]], [[육근영]]
**관련 과제**: 독립연구 / **유형**: 연구논문

## 핵심 컨셉
신축 가능한 LM 마이크로스트립의 변형률(strain) 의존 RF 특성 예측 모델 개발.

## 진행 상황
- 다양한 strain 조건에서 RF 특성 측정
- 예측 모델 빌딩 (변형 → S-parameter)

## 관련
- [[김미도]] 주도, EXG Bio-sensing Pill (LM Paste 서브)와 동일 PI
- [[LM Team]] RF 분야 핵심 작업
`,
    tags: ['liquid-metal', 'microstrip', 'RF', 'stretchable', 'predictive-model'],
    sources: [{ type: 'notion_page', id: 'project-lm-microstrip', date: '2026-04-15' }],
  },
  {
    title: 'Plant Electrophysiology — Leaf-Conformal Bio-Glue Multilayer Electrode',
    category: 'project',
    content: `**상태**: 1. 아이디어 / **팀**: [[Hydrogel Team]] / **담당**: [[손가영]], [[박지민]]
**관련 과제**: 독립연구 / **타겟 저널**: Science Advances / Nature Communications

## 핵심 컨셉
식물 잎 표면에 컨포멀하게 부착되는 바이오 글루 다층 전극. 식물 생리 신호(전기생리학) 비침습 측정.

## 접근법 후보 (3종)
1. 마이크로 니들 (침습)
2. 줄기 임플란트 (반침습)
3. **표면 부착 센서** (비침습, 채택 방향)

## 주요 챌린지
- 식물 생장 적응성
- 잎 표면 솜털과의 컨포멀 접촉
- 환경 내구성 (자외선, 습도, 온도 변화)

## 미팅 논의 ([[3/18 Hydrogel Team 미팅]])
- 작게 자라는 식물(예: 묘목)으로 시작
- 측정 커버 범위 결정이 핵심

## 관련
- [[Hydrogel Team]] 신규 탐색 영역
- 인공 피부 하이드로겔 → 식물용 적용 연계 가능
`,
    tags: ['plant-bioelectronics', 'electrophysiology', 'hydrogel', 'multilayer-electrode', 'conformal'],
    sources: [{ type: 'notion_page', id: 'project-plant-electro', date: '2026-04-15' }],
  },
  {
    title: 'LM Paste',
    category: 'project',
    content: `**상태**: 4. 그림/스토리 / **팀**: [[LM Team]] / **담당**: [[홍승완]], [[육근영]]
**관련 과제**: NRL / **유형**: 연구논문

## 핵심 컨셉
초음파 캐비테이션을 통해 in situ로 비정질 갈륨옥사이드(Ga₂O₃) 나노입자를 생성하여 LM paste 구현. 5분 sonication이 percolation threshold (Magic 5).

## 핵심 키워드 (5)
1. Cavitation-Induced In Situ Oxidation
2. Amorphous Ga₂O₃ Nanoparticles
3. Rheological Percolation Threshold
4. Triple Adhesion Mechanism (5 substrates 적용)
5. Percolation-Enabled Extreme Stretchability (1000% 인장)

## 피규어 구성 (Fig 1-6)
- Fig 1: In Situ Formation Mechanism + Amorphous Evidence
- Fig 2: Rheological Percolation & Phase Transition
- Fig 3: Conductivity & Electrical Performance
- Fig 4: Patterning & Extreme Stretchability
- Fig 5: Universal Substrate Adhesion (Skeleton/Interlocking/Chemical)
- Fig 6: Application Demonstrations

## 진행 (최신순)
- 2026-03-18: 스토리라인 — 나노 파티클 네트워크 포커스 / 레올로지 키네틱 핵심 / oscillatory shear 회복실험 필요
- 2026-03-15: In-situ XRD (상온~800°C) 진행 중
- 2026-02: 4x4 LED 어레이 안정적 신장 성공 (Stretchable LED Array 서브)

## 서브 프로젝트
- **Stretchable LED Array** ([[홍승완]]): 4x4 어레이 + CPU 통합 진행
- **EXG Bio-sensing Pill** ([[김미도]], [[육근영]]): 3.2×2.5mm 소형 설계 완료, ECG/EMG 측정

## 저널 전략 ([[4/1 LM Paste 논문 피규어 검토]])
- Nature Materials vs Nature Electronics 검토 → **절충안 채택**
- 앞쪽: 물질 분석 중심 (NM 스타일)
- 뒤쪽: 어플리케이션 (NE 스타일)

## 즉시 조치 사항
- Kinetics 데이터 재측정 (시간 vs oxide content)
- Rheology 측정 세트 (amplitude/frequency sweep, thixotropy)
- 기판별 adhesion force 정량 측정
- Cryo-FIB 크로스섹션 (서울대/생대 외주, ~50만원)
- C-AFM (난이도 높음, 제외 검토)

## 관련
- [[3/18 LM Team 미팅]] 스토리라인 합의
- [[4/1 LM Paste 논문 피규어 검토]] Nature Electronics 방향 결정
- [[LM Team]] 핵심 페이퍼
- HBM 응용 분기: LM Paste for HBM 서브 (Delamination/Thermal Cycling)
`,
    tags: ['liquid-metal', 'LM-paste', 'percolation', 'amorphous-oxide', 'stretchable', 'NRL'],
    sources: [
      { type: 'notion_page', id: 'project-lm-paste', date: '2026-04-15' },
      { type: 'meeting', id: 'meeting-4-1-lm-paste', date: '2026-04-01' },
      { type: 'meeting', id: 'meeting-3-18-lm-team', date: '2026-03-18' },
    ],
  },
  {
    title: 'LM/Organic Hybrid Multilayer Encapsulation',
    category: 'project',
    content: `**상태**: 2. 실험중 / **팀**: [[LM Team]] / **담당**: [[장한빛]], [[이유림]]
**타겟 저널**: Advanced Functional Materials / ACS Nano (후보) / **유형**: 연구논문

## 핵심 컨셉
LM과 유기 박막의 하이브리드 다층 구조로 스트레처블 전자소자 패시베이션. 수분/산소 차단 + 신축성 동시 확보.

## 진행 상황
- 다층 구조 최적화 실험
- 내구성 평가 진행

## 관련
- [[LM Team]] 패키징 응용
- [[Photo-patternable Hydrogel ACA]]와 함께 [[Packaging Team]] 협업 가능
- [[이유림]] 다중 프로젝트 참여
`,
    tags: ['encapsulation', 'liquid-metal', 'multilayer', 'stretchable-electronics'],
    sources: [{ type: 'notion_page', id: 'project-lm-encap', date: '2026-04-15' }],
  },
  {
    title: 'Photo-patternable Hydrogel ACA',
    category: 'project',
    content: `**상태**: 2. 실험중 / **팀**: [[Packaging Team]] / **담당**: [[이유림]], [[함혜인]]
**타겟 저널**: Advanced Functional Materials (1순위) / Nature Electronics (도전) / **유형**: 연구논문

## 핵심 컨셉
광패터닝 가능한 하이드로겔 기반 ACA(Anisotropic Conductive Adhesive). 미세 회로 본딩에서 등방성/비등방성 전도 제어.

## 관련
- [[Packaging Team]] 핵심 페이퍼
- [[LM/Organic Hybrid Multilayer Encapsulation]] 패키징 라인업과 시너지
- [[이유림]], [[함혜인]] 공통 라인 ([[Hygroscopic Hydrogel-based Wearable TED]] 동일 페어)
`,
    tags: ['hydrogel', 'ACA', 'photo-patternable', 'packaging', 'anisotropic-conductive'],
    sources: [{ type: 'notion_page', id: 'project-aca', date: '2026-04-15' }],
  },
  {
    title: 'Hygroscopic Hydrogel-based Wearable TED',
    category: 'project',
    content: `**상태**: 2. 실험중 / **팀**: [[Hydrogel Team]] / **담당**: [[함혜인]], [[이유림]]
**관련 과제**: 국가아젠다, NRL / **타겟 저널**: Advanced Energy Materials / Nano Energy / **유형**: 연구논문

## 핵심 컨셉
흡습성 하이드로겔을 활용한 wearable Thermoelectric Device(TED). 인체 발생 열 + 환경 수분 결합으로 자가 발전.

## 관련
- [[Hydrogel Team]] 에너지 응용 핵심
- [[Photo-patternable Hydrogel ACA]] 동일 페어 ([[이유림]], [[함혜인]])
- 국가아젠다 + NRL 다중 펀딩 매칭
`,
    tags: ['hydrogel', 'thermoelectric', 'wearable', 'energy-harvesting', 'hygroscopic'],
    sources: [{ type: 'notion_page', id: 'project-ted', date: '2026-04-15' }],
  },
  {
    title: 'Robot-Arm Bioprinting Review',
    category: 'project',
    content: `**상태**: 4. 그림/스토리 / **팀**: [[Hydrogel Team]] / **담당**: [[김수아]], [[조예진]]
**타겟 저널**: Prog. Mater. Sci. / Adv. Mater. / Bioactive Materials (후보) / **유형**: 리뷰논문

## 핵심 컨셉
6축 로봇 암 기반 바이오프린팅 기술 종합 리뷰. 자유곡면/대형 조직/in situ 프린팅 응용 정리.

## 진행 상황
- 그림/스토리 단계 (4단계)
- 저널 후보 검토 중

## 관련
- [[Hydrogel Team]] 유일 리뷰 페이퍼
- [[김수아]] 리뷰 작업 주도
`,
    tags: ['bioprinting', 'robot-arm', 'review', 'hydrogel', '6-axis'],
    sources: [{ type: 'notion_page', id: 'project-bioprint-review', date: '2026-04-15' }],
  },

  // ── TEAM (collaboration) 3개 ────────────────────────────
  {
    title: 'LM Team',
    category: 'collaboration',
    content: `**팀 리드 라인**: [[육근영]] (대부분 프로젝트 공저)
**활동 프로젝트 (4)**:
- [[LM Paste]] (4. 그림/스토리, NRL) — Nature Electronics 타겟
- [[PDA-LM Sintering-Free Spray Ink]] (2. 실험중)
- [[Stretchable LM Microstrip — RF Predictive Model]] (2. 실험중)
- [[LM/Organic Hybrid Multilayer Encapsulation]] (2. 실험중)

## 팀 핵심 미팅
- [[3/18 LM Team 미팅]]: LM Paste 스토리라인 + AutoPCB 피드백 + Wireless Power Transfer

## 공통 도전 과제
- 갈륨 산화물(Ga₂O₃) in-situ 형성 메커니즘 규명
- LM-기판 계면 화학 정량 분석
- Cryo-FIB / C-AFM 등 고난도 측정 외주

## 인력 핵심
- [[육근영]]: LM Paste, PDA-LM, LM Microstrip 모두 공저 — 팀 hub
- [[홍승완]]: LM Paste (Stretchable LED Array 서브)
- [[김미도]]: LM Microstrip 주도 + EXG 서브
- [[김찬수]]: PDA-LM 주도
- [[장한빛]]: Encapsulation 주도

## 관련 외부 협업
- 아산병원 스텐트 프로젝트
- PDIA 협업 (4/13 시연 미팅)
`,
    tags: ['team', 'liquid-metal', 'NRL'],
    sources: [{ type: 'aggregation', id: 'team-lm', date: '2026-04-15' }],
  },
  {
    title: 'Hydrogel Team',
    category: 'collaboration',
    content: `**활동 프로젝트 (3)**:
- [[Plant Electrophysiology — Leaf-Conformal Bio-Glue Multilayer Electrode]] (1. 아이디어, 신규 영역)
- [[Hygroscopic Hydrogel-based Wearable TED]] (2. 실험중, 국가아젠다 + NRL)
- [[Robot-Arm Bioprinting Review]] (4. 그림/스토리, 유일 리뷰)

## 팀 핵심 미팅
- [[3/18 Hydrogel Team 미팅]]: Zwitterion Hydrogel + 식물 센서 아이디어 + MXene 하이드로겔 리칭

## 진행 중인 별도 페이퍼
- Salting-out Hydrogel (Adv. Healthc. Mater.) — Peer review (~2주 경과)
- 내시경 코팅제 (ACS AMI) — 2026-03-02 Peer review 진입

## 공통 도전 과제
- Zwitterion 하이드로겔 산화 컨트롤 (UV 5cm/20-50mW 최적화)
- MXene 하이드로겔 드럭 리칭 검증
- PDMS UV curing 원료 수급 (국내 X, 미국/중국 100만원+)
- 식물 표면 컨포멀 부착 (잎 솜털 + 환경 내구성)

## 인력 핵심
- [[함혜인]]: TED + ACA
- [[이유림]]: TED + ACA + Encapsulation (다중 협업)
- [[김수아]]: Bioprinting Review 주도
- [[조예진]]: Bioprinting Review 공동
- [[손가영]], [[박지민]]: Plant Electrophysiology

## 외부 협업
- 아산병원 (나무 소재 + C-line 손소독 병리)
- 김세근 박사 (AI 활용)
`,
    tags: ['team', 'hydrogel', 'bioprinting'],
    sources: [{ type: 'aggregation', id: 'team-hydrogel', date: '2026-04-15' }],
  },
  {
    title: 'Packaging Team',
    category: 'collaboration',
    content: `**활동 프로젝트 (1)**:
- [[Photo-patternable Hydrogel ACA]] (2. 실험중) — Adv. Funct. Mater. 1순위, Nature Electronics 도전

## 협업 라인
- [[이유림]], [[함혜인]] 페어 공동 작업
- [[Hydrogel Team]]([[Hygroscopic Hydrogel-based Wearable TED]])과 동일 페어 → 인력 시너지

## 향후 확장
- LM/유기 다층 패키징과 결합 시 [[LM Team]] [[LM/Organic Hybrid Multilayer Encapsulation]]과 패키징 통합 라인 가능
`,
    tags: ['team', 'packaging', 'hydrogel'],
    sources: [{ type: 'aggregation', id: 'team-packaging', date: '2026-04-15' }],
  },

  // ── PERSON 5명 (핵심 hub) ──────────────────────────────
  {
    title: '육근영',
    category: 'person',
    content: `**소속 팀**: [[LM Team]] / **역할**: LM Team의 hub (대부분 프로젝트 공저)

## 담당 프로젝트
- [[LM Paste]] (메인 저자급 기여)
- [[PDA-LM Sintering-Free Spray Ink]] (with [[김찬수]])
- [[Stretchable LM Microstrip — RF Predictive Model]] (with [[김미도]])

## 미팅 참여
- [[3/18 LM Team 미팅]] 진행

## 특이사항
- LM 분야 전반에 걸쳐 협업 — 팀 내 connector 역할
- LM Paste 진척 보고에서 일관되게 등장 (위클리 보고)
`,
    tags: ['LM-Team', 'researcher', 'hub'],
    sources: [{ type: 'aggregation', id: 'person-yuk', date: '2026-04-15' }],
  },
  {
    title: '이유림',
    category: 'person',
    content: `**소속 팀**: [[Hydrogel Team]], [[Packaging Team]] (cross-team) / **역할**: 다중 프로젝트 참여

## 담당 프로젝트 (3건)
- [[Hygroscopic Hydrogel-based Wearable TED]] (with [[함혜인]])
- [[Photo-patternable Hydrogel ACA]] (with [[함혜인]])
- [[LM/Organic Hybrid Multilayer Encapsulation]] (with [[장한빛]])

## 특이사항
- TED와 ACA에서 [[함혜인]]과 일관된 페어
- LM Encapsulation으로 [[LM Team]]까지 cross-team
- 패키징/하이드로겔/LM 3분야 가교 인력
`,
    tags: ['Hydrogel-Team', 'Packaging-Team', 'cross-team', 'researcher'],
    sources: [{ type: 'aggregation', id: 'person-lee', date: '2026-04-15' }],
  },
  {
    title: '함혜인',
    category: 'person',
    content: `**소속 팀**: [[Hydrogel Team]], [[Packaging Team]] / **페어**: [[이유림]]

## 담당 프로젝트 (2건)
- [[Hygroscopic Hydrogel-based Wearable TED]]
- [[Photo-patternable Hydrogel ACA]]

## 특이사항
- 두 프로젝트 모두 [[이유림]]과 페어 협업
- 하이드로겔 기반 디바이스 양 분야 (에너지 + 패키징)
`,
    tags: ['Hydrogel-Team', 'Packaging-Team', 'researcher'],
    sources: [{ type: 'aggregation', id: 'person-ham', date: '2026-04-15' }],
  },
  {
    title: '김미도',
    category: 'person',
    content: `**소속 팀**: [[LM Team]] / **주요 분야**: RF + 생체신호

## 담당 프로젝트
- [[Stretchable LM Microstrip — RF Predictive Model]] (메인)
- [[LM Paste]] EXG Bio-sensing Pill 서브 (with [[육근영]])

## 진척
- EXG: 3.2mm × 2.5mm 소형 설계 완료, 투명 PDMS via 최적화 진행
- ECG/EMG/PPG 측정 + 앱 개발

## 미팅
- [[3/18 LM Team 미팅]]: EXG 설계 수정, 강민경 스트레인 센서 보조
`,
    tags: ['LM-Team', 'RF', 'biosensor', 'researcher'],
    sources: [{ type: 'aggregation', id: 'person-kim-mido', date: '2026-04-15' }],
  },
  {
    title: '홍승완',
    category: 'person',
    content: `**소속 팀**: [[LM Team]] / **주요 분야**: Stretchable LED Array

## 담당
- [[LM Paste]] Stretchable LED Array 서브

## 진척
- 4x4 다층 LED 어레이 안정적 신장 성공 (chip bonding 개선)
- CPU 분해/조립 실험 진행 중 (CPU 통합 시스템)
- Microbump 솔더링 도입 (2025-12 ~ 2026-01)
- ECG 노이즈 해결 위한 EMI 쉴딩 다층 구조 고안 (2025-11)
`,
    tags: ['LM-Team', 'LED-array', 'researcher'],
    sources: [{ type: 'aggregation', id: 'person-hong', date: '2026-04-15' }],
  },

  // ── MEETING THREAD 2개 ────────────────────────────────
  {
    title: '3/18 LM Team 미팅',
    category: 'meeting_thread',
    content: `**날짜**: 2026-03-18 / **유형**: 팀미팅 / **팀**: [[LM Team]]

## 안건
1. [[LM Paste]] 논문 스토리라인 + 추가 실험
2. Delamination 테스트 구조 (HBM 관련)
3. LED 마스크 & SPCB 제작
4. AutoPCB 피드백
5. 무선 전력 전송 Tx 개발
6. EMG 신호 분석
7. 종합설계

## 핵심 결정사항
- LM Paste: **나노 파티클 포커스 스토리라인** 채택. 5 vol% / 10⁶ S/m 기준. "빠른 공정" 키워드 제거.
- Oscillatory shear 회복 실험 필요 (조승호 교수 레오미터)
- C-AFM 1-2 마이크로 스케일 네트워크 확인. 이미지 스무딩 처리.
- HBM 서브: 4인치 웨이퍼 + 100μm SU-8 몰드 (갭 35~10μm, 5μm 단위)
- 알루미늄 히트싱크 LM과 반응 → 대체 부품 구매 후 써멀 사이클링 진행

## 액션 아이템
- 마이크로 LED 회로 패터닝 (스크린 30μm 한계 극복 시도)
- AutoPCB: 어떤 회로가 안 되는지 줄글로 정리하여 외부 전달
- Claude 사용: 학생 개별 결제 보류, 교수가 구조 완성 후 통째로 전달

## 관련
- [[LM Paste]] 핵심 의사결정
- [[육근영]], [[김미도]], [[홍승완]] 참여
`,
    tags: ['meeting', 'LM-Team', '2026-03'],
    sources: [{ type: 'meeting', id: 'meeting-3-18-lm-team', date: '2026-03-18' }],
  },
  {
    title: '3/18 Hydrogel Team 미팅',
    category: 'meeting_thread',
    content: `**날짜**: 2026-03-18 / **유형**: 팀미팅 / **팀**: [[Hydrogel Team]]

## 안건
1. 각 프로젝트 진행 현황 공유
2. 식물 생리정보 센서 아이디어 ([[Plant Electrophysiology — Leaf-Conformal Bio-Glue Multilayer Electrode]])
3. 아이오닉 하이드로겔 화학 분석 방향
4. MXene 하이드로겔 리칭 문제 점검

## 핵심 결정사항
- Zwitterion 하이드로겔: 디지털 온도계 도입, UV 5cm 거리 / 20-50mW 타겟 (80mW+는 열 손상)
- 식물 센서: 표면 부착 방식 채택, 작게 자라는 식물부터 시작
- MXene: 리딩 과정 드럭 용출 검증 위해 염료 사용 리칭 테스트
- PDMS UV curing: 원료 국내 수급 불가 → 프로토콜 자체 변경 검토

## 진행 중 외부 페이퍼
- Salting-out Hydrogel (Adv. Healthc. Mater.) — Peer review 중 (~2주 경과)
- 내시경 코팅제 (ACS AMI) — Peer review 진입 (2026-03-02)

## 외부 협업
- 아산병원 미팅 2건 예정 (나무 소재 + C-line 40분 병리)
- 김세근 박사 미팅 (AI 활용) 예정 — 4시간 캠 논문 차별화 작업

## 관련
- [[Plant Electrophysiology — Leaf-Conformal Bio-Glue Multilayer Electrode]] 신규 아이디어 채택 미팅
- [[김수아]], [[조예진]], [[함혜인]], [[이유림]] 참여 추정
`,
    tags: ['meeting', 'Hydrogel-Team', '2026-03'],
    sources: [{ type: 'meeting', id: 'meeting-3-18-hydrogel', date: '2026-03-18' }],
  },
  {
    title: '4/1 LM Paste 논문 피규어 검토',
    category: 'meeting_thread',
    content: `**날짜**: 2026-04-01 / **유형**: 개별미팅 / **관련 프로젝트**: [[LM Paste]]

## 안건
- 피규어 1-7 검토 / 저널 타겟 확정 / 갈륨-알루미늄 패드 메커니즘 / 아산병원 스텐트

## 핵심 결정사항
### 저널 타겟: Nature Electronics (절충안)
- Nature Materials: 최근 3년 LM 인터커넥트 논문 거의 전무 → risky
- Nature Electronics: LM 인터커넥트 다수 → safe
- **앞쪽은 NM 스타일(물질 분석), 뒤쪽은 NE 스타일(어플리케이션)** 절충

### 즉시 조치 필요
1. Kinetics 데이터 재측정 (시간 vs oxide content) — Fig.2 backbone
2. Rheology 측정 세트 (amplitude/frequency sweep, thixotropy) — 가장 부실
3. 기판별 adhesion force 정량 측정
4. 단순 파티클 혼합 대조군 전도도 (in situ 우위 증명)
5. C-AFM 측정 (국소 전류 매핑)

### 메커니즘 보강
- 갈륨-알루미늄: 산화 알루미늄 5nm 보호막이 패시베이션 — 정은용 교수 Science 트랜스퍼 프린팅 개념 참고

### 외주 측정
- Cryo-FIB 크로스섹션: 서울대 또는 생명과학대 (~50만원, 리뷰어 공격 대비 필수)

## 관련
- [[LM Paste]] 핵심 진행 단계
- [[3/18 LM Team 미팅]] 후속 의사결정
`,
    tags: ['meeting', 'LM-Team', 'paper-review', '2026-04'],
    sources: [{ type: 'meeting', id: 'meeting-4-1-lm-paste', date: '2026-04-01' }],
  },

  // ── COLLABORATION (외부 과제) ─────────────────────────────
  {
    title: '글로벌 협력 R&D — 스마트 LED 광치료 패치 (중기부)',
    category: 'collaboration',
    content: `**과제명**: 지속 가능한 피부 인터페이스 소재·센서 통합형 스마트 LED 광치료 패치 플랫폼 개발
**사업**: 중기부 글로벌 협력 R&D 자유공모
**예산/기간**: 최대 3년 15억 / 접수 마감 **2026-04-24**

## 컨소시엄
- **뉴트리어드바이저**(총괄): LED 광패치 제품화/사업화, 시스템 통합, IP 관리
- **하버드**(공동): 광치료 메커니즘 + in vitro 검증
- **연세대**(위탁): 플렉서블 회로, 블루투스, MCU 제어 — **BLISS Lab 담당**
- **한양대**(위탁): 비증발 고이온전도 하이드로겔 기반 인조피부 + 센싱

## 기술 방향 (전환)
- **미용 → 당뇨/만성 창상 치료** ([[3/26 과제 미팅]] 결정)
- 근거: 하이테크놀로지 가격 → 치료 효과 확실한 마켓 필요
- 만성 창상은 기존 치료법 부족 + 미국 시장 수요 큼
- 백업 데이터: LED 전기 자극 통한 창상 치료 선행 논문 보유

## 플랫폼 구조 (이중 레이어)
- **상층**: 비증발 하이드로겔 (LED/PCB 내장) — pH/온도/임피던스 센싱 + 수분 유지
- **하층**: 소모성 패치 — 피부 접착 + 약물 전달
- 임피던스로 조직 재생도(Tissue density) 모니터링
- 스마트폰 앱: 센서 데이터 → LED 파장/시간 제어 (Close-loop)

## 제기된 리스크
- 하버드 인터내셔널 콜라보레이션 승인 절차 강화: 디비전 헤드 레터 가능 여부 확인
- 이노베이션팀 리뷰 1개월+ 소요 — 즉시 간사(PM) 컨택 필요

## 선정 평가 가중치
- 국제 공동연구 필요성 (20점): 광치료 메커니즘 규명 (하버드 강점)

## 관련
- [[3/26 과제 미팅]] 컨소시엄 확정 미팅
- [[Hydrogel Team]] 인조피부 라인업 연계
`,
    tags: ['funding', 'collaboration', '중기부', 'global-R&D', 'wound-healing', 'LED-therapy'],
    sources: [{ type: 'meeting', id: 'meeting-3-26-funding', date: '2026-03-26' }],
  },

  // ── RESEARCH TREND 3개 (paper trend 페이지에서 추출) ──────
  {
    title: '연구동향 — Liquid Metal (2026-04 1주차)',
    category: 'research_trend',
    content: `**기간**: 2026-04-06 ~ 2026-04-12 / **수집**: 14개 주요 저널 RSS / **편수**: LM 분야 6편

## 핵심 발견 — On-Demand Operando Embolization (Adv. Mater., ★★★)
- 액체금속 매립 하이드로겔 + 소노다이나믹 겔레이션
- 종양 색전술(TAE) 응용
- **매칭 키워드**: hydrogel, liquid metal (멀티테마 교차)

## 다른 주요 논문
1. **Liquid Metal Microrobots** (Adv. Mater., ★★) — Ga-In + Fe nanoparticles, magnetic 혈관 항법
2. **Programmable Milli-Microfluidics via Oxide-Mediated Electrowetting** (Adv. Mater., ★★) — Faradaic electrowetting, 산화막 활용 — [[LM Paste]] 메커니즘과 직접 관련 (Ga₂O₃)
3. **Lignocellulosic-Encapsulated Liquid Metal** (Adv. Funct. Mater., ★★) — 친환경 thermal interface, full recyclable
4. **Implantable Epiretinal Device** (Nat. Electron., ★★) — LM interconnect, 망막 임플란트

## 관련 내부 연구
- [[LM Paste]] — Ga₂O₃ 산화 메커니즘 = Adv. Mater. electrowetting 논문의 산화막 활용과 직접 비교 가능. 우리 amorphous oxide 차별점 강조 필요.
- [[LM/Organic Hybrid Multilayer Encapsulation]] — Lignocellulosic encapsulation과 비교 — 우리 LM/유기 하이브리드의 stretchable 특성 강조
- [[Stretchable LM Microstrip — RF Predictive Model]] — 직접 매칭 없음, **신규 탐색 영역** (RF 모델링은 트렌드에 없음)
`,
    tags: ['research-trend', 'liquid-metal', '2026-04', 'paper-monitoring'],
    sources: [{ type: 'paper_alert', id: 'trend-lm-2026-04w1', date: '2026-04-12' }],
  },
  {
    title: '연구동향 — 하이드로겔 (2026-04 1주차)',
    category: 'research_trend',
    content: `**기간**: 2026-04-06 ~ 2026-04-12 / **수집**: 14개 주요 저널 RSS / **편수**: 하이드로겔 21편 (이번 주 최다)

## 주요 흐름
상처치유 / 신경재생 / 바이오전자 / 에너지 저장 / 센서 — 다양한 응용 분야 광범위.

## 핵심 논문
1. **Mechanophores in Glassy Hydrogels** (Adv. Mater., ★★) — mechanoresponsive function, soft hydrogel에서 효율/제어성 확보
2. **Tissue-Conforming Organoselenium Hydrogel** (Adv. Mater., ★★) — 당뇨 창상 치유, AGE-RAGE pathway 억제, microphase 가교 동역학
3. **Tough and Rapidly Relaxing Hydrogel** (Adv. Mater., ★★) — programmable 가교 동역학
4. **Mechanical Interlocking Solid-Solid Bicontinuous** (Adv. Funct. Mater., ★★)

## 관련 내부 연구
- [[Plant Electrophysiology — Leaf-Conformal Bio-Glue Multilayer Electrode]] — 컨포멀 부착 메커니즘 측면 organoselenium 논문 참고
- [[Hygroscopic Hydrogel-based Wearable TED]] — Tough hydrogel 가교 동역학을 흡습-팽창 사이클에 적용 가능
- [[Photo-patternable Hydrogel ACA]] — 광패터닝 + bicontinuous 구조 결합 검토
- [[글로벌 협력 R&D — 스마트 LED 광치료 패치 (중기부)]] — Organoselenium 당뇨 창상 = 우리 과제 응용 분야 정확 일치 (참고 + 차별화 전략)
- [[Robot-Arm Bioprinting Review]] — 다양한 가교 동역학 사례 리뷰에 반영
`,
    tags: ['research-trend', 'hydrogel', '2026-04', 'paper-monitoring', 'wound-healing'],
    sources: [{ type: 'paper_alert', id: 'trend-hydrogel-2026-04w1', date: '2026-04-12' }],
  },
  {
    title: '연구동향 — 종합 (2026-04 1주차 요약)',
    category: 'research_trend',
    content: `**총 수집/필터링**: 900편 → 34편 선별 (3.8% 관련도)
**테마별 분포**: 하이드로겔 21 / Neuromorphic 7 / Liquid Metal 6 / Antifouling 1

## 5대 모니터링 테마
1. 하이드로겔
2. 이종소재 접착제
3. Antifouling Coating
4. Liquid Metal
5. Neuromorphic Device

## 이번 주 최고 우선순위
**On-Demand Operando Embolization** (Adv. Mater., ★★★ 직접 관련) — 하이드로겔 + LM 멀티테마 교차의 첫 ★★★ 논문. 우리 [[Hydrogel Team]] + [[LM Team]] cross-team 통합 응용 가능성 시사.

## 이번 주 키 시사점
- LM에서 oxide-mediated 메커니즘이 트렌드 (electrowetting, encapsulation)
  → [[LM Paste]] amorphous Ga₂O₃ 차별화 강조 필요
- 하이드로겔 분야 다양화 — 우리 lab은 [[Plant Electrophysiology — Leaf-Conformal Bio-Glue Multilayer Electrode]], TED, ACA, Bioprinting 등 응용 다각화 진행 중 → 트렌드 부합

## 모니터링 저널 (14개)
Nature, Science, Nat. Mater., Nat. Nanotechnol., Nat. Biomed. Eng., Nat. Electron., Sci. Adv., Sci. Robot., Adv. Mater., Adv. Funct. Mater., Nat. Sensors, Nat. Chem. Eng., ACS Nano, ACS Sensors

## 관련
- [[연구동향 — Liquid Metal (2026-04 1주차)]] 상세
- [[연구동향 — 하이드로겔 (2026-04 1주차)]] 상세
`,
    tags: ['research-trend', 'summary', '2026-04', 'paper-monitoring'],
    sources: [{ type: 'paper_alert', id: 'trend-summary-2026-04w1', date: '2026-04-12' }],
  },
];

// ── INSERT ──────────────────────────────────────────────────
function generateId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 9);
  return `c${t}${r}`;
}

async function main() {
  console.log(`\n[heavy-user-insert] LAB_ID = ${LAB_ID}`);
  console.log(`[heavy-user-insert] 총 ${articles.length}개 article 처리 시작\n`);

  let created = 0;
  let updated = 0;
  let failed = 0;
  const now = new Date();

  for (const a of articles) {
    try {
      // 기존 article 확인
      const existing = await prisma.wikiArticle.findFirst({
        where: { labId: LAB_ID, title: a.title },
        select: { id: true, version: true },
      });

      // sim 태그 추가
      const tagsWithSim = [...new Set([...a.tags, SIM_TAG])];

      await prisma.$executeRawUnsafe(
        `INSERT INTO wiki_articles (id, lab_id, title, category, content, tags, sources, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 1, $8, $8)
         ON CONFLICT (lab_id, title)
         DO UPDATE SET
           category   = EXCLUDED.category,
           content    = EXCLUDED.content,
           tags       = EXCLUDED.tags,
           sources    = EXCLUDED.sources,
           version    = wiki_articles.version + 1,
           updated_at = EXCLUDED.updated_at`,
        generateId(),
        LAB_ID,
        a.title,
        a.category,
        a.content,
        tagsWithSim,
        JSON.stringify(a.sources),
        now,
      );

      if (existing) {
        updated++;
        console.log(`  ↑ ${a.title}  [${a.category}] (v${existing.version + 1})`);
      } else {
        created++;
        console.log(`  + ${a.title}  [${a.category}]`);
      }
    } catch (err: any) {
      failed++;
      console.error(`  ✗ ${a.title} — ${err.message}`);
    }
  }

  console.log(`\n[heavy-user-insert] 완료 — 신규 ${created}, 업데이트 ${updated}, 실패 ${failed}`);
  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
