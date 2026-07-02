# Video Editor (CapCut 유사 데스크톱 영상 편집기)

> 상태: **Phase 0~6 구현 완료 (자동 검증 통과 · 육안/청취 검증 및 코드사이닝 대기)** · 대상 플랫폼: Windows / macOS (Electron)

```bash
npm install
npm run dev        # 편집기 실행
npm run test       # 유닛 테스트 (모델/커맨드/시간환산/effects-spec)
npm run e2e        # 빌드 + e2e 스모크 (임포트→컷→필터/전환/텍스트→내보내기→WYSIWYG SSIM≥0.99)
npm run dist:mac   # macOS 패키징 (서명 없이: CSC_IDENTITY_AUTO_DISCOVERY=false)
```

숏폼~중편 영상을 쉽게 편집하고 내보낼 수 있는 데스크톱 영상 편집기. 실제 배포/수익화를 목표로 한다.

**핵심 원칙 — WYSIWYG**: 실시간 프리뷰 엔진(WebCodecs+WebGL)과 오프라인 내보내기 엔진(FFmpeg)을 분리하되, 이펙트/합성 결과는 반드시 동일해야 한다.

## 문서 인덱스

| 문서 | 내용 |
|------|------|
| [docs/PRD.md](./docs/PRD.md) | 제품 요구사항 (범위, 사용자 시나리오, 기능/비기능 요구) |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 기술 아키텍처 (프리뷰/내보내기 분리, 모듈 구조, 엔진 설계) |
| [docs/DATA-MODEL.md](./docs/DATA-MODEL.md) | 데이터 모델 (Project/Track/Clip/Effect, 커맨드, 불변식) |
| [docs/TECH-STACK.md](./docs/TECH-STACK.md) | 기술 선택 근거 (Electron/WebCodecs/WebGL/FFmpeg + 대안) |
| [dev-plan.json](./dev-plan.json) | **단계별 실행 계획 + 체크리스트 + 검증 루프** |
| [dev-plan.schema.json](./dev-plan.schema.json) | 계획 JSON 구조 스키마 |

## 개발 진행 방식

개발은 [dev-plan.json](./dev-plan.json)을 따라 진행한다. 각 step에는 **체크리스트**와 **검증 루프**가 있다.

1. step의 `checklist` 항목을 완료하면 `dev-plan.json`에서 해당 항목 `done`을 `true`로 변경
2. 모든 체크가 끝나면 `verification.loop`를 순서대로 실행
3. `verification.successCriteria`를 **전부** 만족하면 step `status`를 `done`으로 변경, 다음 step 진행
4. 막히면 `verification.onFailure` 힌트 참고, `status`를 `blocked`으로

### 진행률 확인 CLI

```bash
npm run progress            # 전체 진행률 요약 (페이즈별 진행 막대)
npm run progress:next       # 다음에 해야 할 미완료 체크리스트 항목
npm run progress:all        # 모든 페이즈의 체크리스트까지 상세
node scripts/progress.mjs --phase 1   # 특정 페이즈 상세
node scripts/progress.mjs --json      # 기계 판독용 JSON (CI 연동)
npm run plan:validate       # 계획 파일 구조/일관성 검증
```

`progress`/`validate`는 모든 체크리스트 완료 시 종료 코드 0, 아니면 1 → CI 게이트로 활용 가능.

## 개발 로드맵 (요약)

| Phase | 이름 | 핵심 |
|-------|------|------|
| 0 | 기반 세팅 | 앱 셸 + FFmpeg 프로브(VFR 감지) + 첫 프레임 렌더 + **코덱 호환 프록시 fallback** |
| 1 ★ | 타임라인 + 프리뷰 MVP + 내보내기 스파이크 | 데이터 모델, 타임라인 UI, **WebGL 컴포지터**, 재생/시크/AV싱크(소리 포함), **내보내기 스파이크**, e2e 스모크 |
| 2 | 오디오 / 배경음악 | 파형, 볼륨/페이드, 다중 트랙 믹싱 (1.4 최소 재생 경로 확장) |
| 3 | 자막 / 텍스트 | 텍스트 레이어(WebGL 텍스처 합성), 스타일, (선택) 자동 자막 |
| 4 | 효과 / 전환 / 필터 | effects-spec 확립, 필터 셰이더, 전환(핸들 규칙) |
| 5 ★ | 내보내기 엔진 | 1.5 스파이크 확장, WYSIWYG **수치 검증(SSIM ≥ 0.99)** |
| 6 | 제품화 | 저장/자동저장, 성능용 프록시, 배포/업데이트 |

★ = criticalPath (프로젝트 성패를 가르는 구간)

### 구현 현황 (2026-07-02)

Phase 0~6 코딩 완료 — `npm run progress` 로 확인.

- **자동 검증 완료**: IPC · 프로브(VFR/코덱/색공간) · 호환/성능 프록시 · 데이터 모델+undo/redo(유닛 22개) · 컷 편집 · 프레임 정확 시크 · WebGL 합성 · 텍스트 · **필터/전환(effects-spec 단일 정의)** · **오디오 믹스다운(OfflineAudioContext)** · 내보내기 프리셋 · **WYSIWYG 수치 게이트: 기준 프레임 SSIM 0.9992 (≥0.99)** · duration ±1프레임 · 패키징(DMG/ZIP 빌드 + 패키징 앱 부팅·ffmpeg 동작 확인)
- **실측**: 내보내기 파이프 ~500MB/s, 1080p30 타임라인 2.0× 실시간
- **육안/청취 검증 대기 (`verifying`)**: 드래그/트림/스냅 감각, A/V 싱크 체감, 무끊김 재생, 믹싱/페이드 청취, 전환/애니메이션 시각 확인(서로 다른 두 클립으로), 자동저장 복구 시나리오, 4K 소스 성능 — `npm run dev` 로 확인 후 done 전환
- **외부 요건 대기**: 6.3.2 코드사이닝/공증(Apple Developer 인증서 + `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`), 자동 업데이트 첫 게시(GitHub Releases), CI 첫 실행(저장소 push)
- **자동 자막(3.2, optional) 구현 완료**: 비디오 클립 선택 → 인스펙터 "자동 자막"에서 모델/언어 선택 → Whisper(ONNX, 오프라인)로 전사해 자막 트랙 자동 배치, SRT 내보내기. 엔진은 `@huggingface/transformers` + `onnxruntime-node`(순수 npm·N-API, whisper.cpp 대안). 첫 사용 시 모델(base ~90MB) 1회 다운로드. 통합 테스트는 `RUN_STT_E2E=1 npx playwright test stt` (모델 다운로드로 CI 기본 제외)
- ⚠ **라이선스**: 번들 FFmpeg 는 libx264 포함 GPL 빌드 — 상용 배포 전 [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md) 의 전환 방안(LGPL+하드웨어 인코더) 검토 필수

### 계획 개정 이력

- **v0.2.0 (2026-07-02)**: WebGL 컴포지터를 Phase 1로 전진(Canvas2D→WebGL 재작업 제거) · 내보내기 스파이크를 Phase 1.5로 전진(WYSIWYG/파이프 처리량 구조 리스크 조기 검증) · 최소 오디오 재생을 1.4에 포함(Phase 2 의존성 역전 해소) · 코덱 호환 프록시 fallback을 Phase 0.4로 승격 · 품질 기준 수치화(SSIM/2× 실시간) · 초기 내보내기 H.264+AAC 한정 · e2e 스모크/CI 게이트 추가 · DATA-MODEL에 전환 핸들 의미론, 트랙/마스터 볼륨 추가
- **v0.1.0 (2026-07-01)**: 최초 기획

## 다음 액션

코딩은 **Phase 0.1 프로젝트 스캐폴딩**부터 시작한다.

```bash
npm run progress:next    # 지금 할 일 확인
```

## 현재 리포지토리 구성 (기획 산출물)

```
.
├── README.md                 # 이 문서
├── dev-plan.json             # 실행 계획 + 체크리스트 + 검증 루프
├── dev-plan.schema.json      # 계획 스키마
├── package.json              # 진행률/검증 스크립트
├── docs/                     # 기획 문서
│   ├── PRD.md
│   ├── ARCHITECTURE.md
│   ├── DATA-MODEL.md
│   └── TECH-STACK.md
└── scripts/                  # 계획 관리 도구
    ├── progress.mjs          # 진행률 추적 CLI
    └── validate-plan.mjs     # 계획 검증기
```
