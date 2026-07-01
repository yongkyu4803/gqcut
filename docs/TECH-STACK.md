# TECH-STACK — 기술 선택 근거

> 최종 수정: 2026-07-02 · 상태: 기획
> 각 선택의 "왜"와 대안, 재검토 시점을 기록한다.

## 요약

| 영역 | 채택 | 주요 대안 | 재검토 트리거 |
|------|------|-----------|---------------|
| 데스크톱 셸 | **Electron** | Tauri | 성능/번들 크기가 병목이 되면 Tauri 이전 검토 |
| UI | **React + TypeScript** | Svelte, Vue | — |
| 상태관리 | **Zustand + 커맨드 패턴** | Redux, Jotai | 협업/시간여행 요구 커지면 재검토 |
| 실시간 프리뷰 | **WebCodecs** (+호환 프록시 fallback, Phase 0.4) | ffmpeg.wasm | 미지원 코덱 비중이 크면 트랜스코딩 병행 |
| 합성/이펙트 | **WebGL (Phase 1부터 채택, +PixiJS 선택)** | Canvas2D, WebGPU | WebGPU 성숙 시 이전 검토 |
| 오디오 | **Web Audio API** | — | — |
| 내보내기 | **FFmpeg (네이티브 바이너리)** | ffmpeg.wasm | — |
| 번들러 | **Vite** | webpack | — |
| 테스트 | **Vitest + Playwright** | Jest | — |

## 1. Electron vs Tauri

**채택: Electron**

- **장점**: 성숙한 생태계, 자료·예제 풍부, Node.js 통합으로 FFmpeg 자식 프로세스 관리 용이, 중급 개발자 학습 곡선 완만
- **단점**: 번들 크기 큼, 메모리 사용량 높음
- **Tauri 대안**: Rust 백엔드로 가볍고 빠르지만, Rust 학습 부담 + 미디어 관련 예제 부족
- **판단**: 영상 편집기의 무거운 작업은 결국 **FFmpeg(네이티브)** 와 **WebCodecs/WebGL(Chromium)** 이 담당하므로, 셸이 Electron이어도 성능 핵심은 동일. 개발 속도를 위해 Electron 채택.
- **재검토**: 앱 시작 속도/메모리가 상용 품질에 걸림돌이 되면 Tauri 이전을 별도 스파이크로 평가.

## 2. WebCodecs vs ffmpeg.wasm (프리뷰 디코딩)

**채택: WebCodecs (프리뷰), 네이티브 FFmpeg (내보내기/fallback)**

- **WebCodecs**: 브라우저 네이티브, GPU 가속 디코딩, 낮은 지연 → 실시간 프리뷰에 최적
- **ffmpeg.wasm**: 유연하지만 CPU 기반이라 실시간 프리뷰엔 느림
- **판단**: 프리뷰는 WebCodecs, 미지원 코덱은 네이티브 FFmpeg로 프록시 트랜스코딩 후 프리뷰. 내보내기는 항상 네이티브 FFmpeg.
- **주의**: WebCodecs 코덱 지원은 OS/빌드에 따라 편차 → 임포트 시 코덱 판별 + fallback 경로 필수.

## 3. WebGL vs WebGPU vs Canvas2D (합성/이펙트)

**채택: WebGL** (PixiJS는 생산성 필요 시 선택적 도입)

- **Canvas2D**: 필터·전환·블렌딩을 실시간으로 처리하기엔 성능 한계
- **WebGL**: 셰이더 기반 GPU 이펙트, 성숙·안정, 예제 풍부
- **WebGPU**: 미래 지향적이나 아직 지원/성숙도 편차 → 초기 채택 리스크
- **판단**: WebGL로 시작. 이펙트 셰이더는 `shared/effects-spec` 에 정의해 내보내기와 공유(WYSIWYG).
- **도입 시점**: Phase 4가 아니라 **Phase 1.3부터** WebGL 컴포지터를 채택한다. Canvas2D로 프리뷰/텍스트를 만들었다가 Phase 4에서 WebGL로 이전하는 재작업 비용이 조기 도입 비용보다 크다 (v0.2.0 계획 개정).
- **재검토**: WebGPU 지원이 타깃 OS에서 안정화되면 성능 이점 평가.

## 4. 상태관리: Zustand + 커맨드 패턴

- **Zustand**: 보일러플레이트 적고 React 외부에서도 접근 쉬움 → 재생 루프/엔진에서 상태 읽기 편함
- **커맨드 패턴**: undo/redo가 편집기의 필수 요구사항 → 조작을 커맨드로 캡슐화
- **Redux 대안**: 강력하지만 보일러플레이트 부담. 편집기 규모에선 Zustand가 실용적.

## 5. 내보내기: 네이티브 FFmpeg

- 프레임 정확 인코딩, 코덱/포맷 유연성, 오디오 믹스다운·mux 일괄 처리
- 프레임별 오프스크린 렌더 결과를 `stdin` 파이프로 전달하는 전략으로 WYSIWYG 확보
- 파이프라인 구조(렌더 실행 위치, 프레임 전송 대역폭)는 **Phase 1.5 스파이크**에서 조기 검증 (ARCHITECTURE §6.1~6.2)
- 라이선스(LGPL/GPL 빌드 구분) 및 배포 시 고지 필요 → dev-plan Phase 6.3
- **인코딩 프리셋은 초기 H.264 + AAC (MP4) 한정**: H.265 **인코딩**은 특허 풀 라이선스(HEVC Advance 등) 이슈가 있어 상용 배포 전 법적 검토가 필요. H.265 는 **디코딩(임포트)** 만 지원하고, 인코딩 프리셋 추가는 별도 결정 사항으로 분리 (dev-plan 5.2.4, 6.3.4)

## 6. 빌드/테스트/배포
- **Vite**: 빠른 HMR, Electron 플러그인 생태계
- **Vitest**: 데이터 모델/커맨드 유닛 테스트 (Vite와 통합)
- **Playwright**: 임포트→편집→내보내기 e2e 스모크
- **electron-builder + electron-updater**: 패키징/코드사이닝/자동 업데이트

## 7. 미정 / 후속 결정 필요
- **내보내기 렌더 실행 위치** (숨김 BrowserWindow vs 기존 렌더러 vs UtilityProcess) + 프레임 전송 경로 — **Phase 1.5 스파이크에서 확정** (ARCHITECTURE §6.1~6.2)
- **오디오 믹스다운 경로** (OfflineAudioContext vs FFmpeg 오디오 필터) — **Phase 5.1에서 확정**
- 자동 자막(STT) 엔진: Whisper 로컬 vs 클라우드 API — 비용/프라이버시/정확도 트레이드오프 (Phase 3.2에서 결정)
- MP4 demuxer 라이브러리 선정 (mp4box.js 등) — Phase 0.3 스파이크에서 확정
- 호환 프록시 트랜스코딩 파라미터(GOP/키프레임 간격 — 시크 성능 직결) — Phase 0.4에서 확정
- 성능용 프록시 코덱/해상도 정책 — Phase 6.2에서 확정 (0.4 호환 프록시 인프라 재사용)
- H.265 인코딩 프리셋 도입 여부(특허 라이선스 검토) — Phase 6.3 이전 결정

관련 문서: [ARCHITECTURE.md](./ARCHITECTURE.md) · [PRD.md](./PRD.md)
