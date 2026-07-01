# ARCHITECTURE — 기술 아키텍처

> 최종 수정: 2026-07-02 · 상태: 기획

## 0. 핵심 원칙: 프리뷰 엔진 ≠ 내보내기 엔진, 그러나 결과는 같다

영상 편집기에서 가장 어려운 문제는 UI가 아니라 **"미리보기와 최종 결과물의 일치(WYSIWYG)"** 다.

- **프리뷰 엔진**: 실시간성이 중요 → 브라우저 네이티브(WebCodecs + WebGL + Web Audio)로 GPU 가속, 낮은 지연
- **내보내기 엔진**: 정확성이 중요 → FFmpeg로 프레임 단위 오프라인 렌더링

두 엔진은 실행 환경이 다르지만, **이펙트/합성/변환 로직은 반드시 공유 규격을 통해 동일한 결과**를 내야 한다.
→ 이펙트 파라미터는 데이터 모델에 직렬화하고, 렌더 수식(셰이더/필터)은 양쪽이 동일 정의를 사용한다.

```
                ┌─────────────────────────────┐
                │     Project (데이터 모델)      │  ← 단일 진실 공급원(SSOT)
                │  Track / Clip / Effect ...    │
                └───────────────┬───────────────┘
                                │ (동일한 이펙트 파라미터)
                ┌───────────────┴───────────────┐
                ▼                                 ▼
     ┌────────────────────┐          ┌──────────────────────┐
     │  프리뷰 엔진 (실시간)  │          │  내보내기 엔진 (오프라인) │
     │  WebCodecs 디코딩     │          │  프레임별 오프스크린     │
     │  WebGL 합성/이펙트    │  ==일치==>│  WebGL 렌더 → FFmpeg   │
     │  Web Audio 믹싱      │          │  오디오 믹스다운 → mux   │
     └────────────────────┘          └──────────────────────┘
```

## 1. 프로세스 구조 (Electron)

```
┌── Main Process (Node.js) ─────────────────────────┐
│  · 파일 시스템 접근 (임포트/저장)                     │
│  · FFmpeg / ffprobe 자식 프로세스 관리                │
│  · 내보내기 렌더 잡 오케스트레이션                     │
│  · 자동저장 / 크래시 복구                             │
└───────────────┬───────────────────────────────────┘
                │ IPC (contextBridge, 타입 안전 채널)
┌───────────────┴───────────────────────────────────┐
│  Renderer Process (Chromium + React)               │
│  · 타임라인 UI / 프리뷰 캔버스                        │
│  · WebCodecs 디코딩 · WebGL 합성 · Web Audio 믹싱     │
│  · Zustand 상태 + 커맨드(undo/redo)                  │
└────────────────────────────────────────────────────┘
```

- **보안**: `nodeIntegration: false`, `contextIsolation: true`, preload 에서 화이트리스트 API만 노출
- **무거운 작업**: 디코딩/합성은 렌더러(GPU 근처), 인코딩/파일 IO는 메인. 필요 시 Web Worker / OffscreenCanvas 활용

## 2. 모듈 구조 (제안)

```
src/
  main/                 # Electron 메인 프로세스
    ipc/                # 타입 안전 IPC 핸들러
    ffmpeg/             # ffprobe 프로브, 내보내기 잡
    project/            # 저장/열기/자동저장
  renderer/             # React 앱
    timeline/           # 타임라인 UI (트랙/클립/스냅/줌)
    preview/            # 프리뷰 캔버스 + 재생 엔진
    engine/
      decode/           # WebCodecs 디코더 + 프레임 캐시
      compositor/       # WebGL 합성 파이프라인
      effects/          # 필터/전환 셰이더 (공유 정의)
      audio/            # Web Audio 믹싱 그래프
    state/              # Zustand 스토어 + 커맨드 히스토리
    ui/                 # 공통 컴포넌트
  shared/               # 메인/렌더러 공유 타입 + 이펙트 규격
    model/              # Project/Track/Clip 타입 (DATA-MODEL.md)
    effects-spec/       # 이펙트 파라미터 & 렌더 수식 정의 (WYSIWYG 핵심)
  export/               # 내보내기 엔진 (오프스크린 렌더 + FFmpeg 파이프)
```

> `shared/effects-spec` 가 WYSIWYG의 핵심. 프리뷰와 내보내기가 이 정의를 함께 참조한다.

## 3. 재생 엔진 (프리뷰)

1. **디코딩**: mp4box.js 등으로 demux → WebCodecs `VideoDecoder` 로 프레임 디코딩
2. **프레임 매핑**: 타임라인 시간 → (클립, 소스 프레임) 매핑
3. **버퍼링**: 재생 위치 전방 프레임 프리페치 + LRU 캐시
4. **시크**: 목표 시점 직전 키프레임부터 디코딩하여 정확 프레임 도달
5. **합성**: 디코딩된 프레임을 WebGL 텍스처로 올려 transform/이펙트/레이어 블렌딩
6. **오디오 동기화**: `AudioContext.currentTime` 을 마스터 클럭으로, 비디오를 오디오에 맞춤
7. **표시**: `requestVideoFrameCallback` / rAF 기반 렌더 루프

### 난제 대응
- **프레임 정확 시크**: 디코더 flush/reset + 키프레임 인덱싱
- **A/V 싱크**: 오디오 클럭 기준, 비디오 지연 시 프레임 드랍/보정
- **미지원 코덱 / VFR**: WebCodecs 실패 시 FFmpeg 트랜스코딩으로 **호환 프록시(H.264 CFR)** 생성.
  Windows HEVC 등 흔한 소스가 여기 걸리므로 이 fallback 은 기반 세팅 단계(dev-plan **0.4**)에서 구축한다 — 성능용 저해상도 프록시(6.2)와는 목적이 다름.

> 합성은 처음부터 WebGL 컴포지터(dev-plan **1.3**)로 구축한다. Canvas2D 로 만들었다가 나중에 WebGL 로 갈아타는 재작업을 계획에서 제거했다 (0.3의 첫 프레임 drawImage 는 부트스트랩용 임시 렌더).

## 4. 합성/이펙트 파이프라인 (WebGL)

- 각 클립 프레임 → 텍스처 → transform(위치/크기/회전/투명도) → 필터 셰이더 → 레이어 블렌딩
- 전환(transition)은 두 클립 텍스처를 progress(0~1)로 보간하는 셰이더
- **색공간 주의**: sRGB ↔ linear 변환, premultiplied alpha 일관 처리
- 이펙트 파라미터는 `shared/effects-spec` 에 정의 → 내보내기에서 동일 셰이더/수식 재사용

## 5. 오디오 (Web Audio)

```
[클립 SourceNode] → [클립 GainNode(볼륨/페이드)] ┐
[클립 SourceNode] → [클립 GainNode] ─────────────┼→ [Master GainNode] → [Destination]
[BGM   SourceNode] → [BGM GainNode] ─────────────┘
```

- 페이드는 GainNode 파라미터 automation
- 재생/시크와 오디오 스케줄을 `currentTime` 기준으로 정렬
- 게인 단계: 클립 GainNode → 트랙 GainNode → 마스터 GainNode (DATA-MODEL 의 `volume`/`masterVolume` 과 1:1 대응)
- 비디오 클립의 소리 재생(최소 단일 경로)은 A/V 싱크 검증을 위해 **dev-plan 1.4** 에 포함, 믹싱/페이드는 Phase 2 에서 확장
- **내보내기 믹스다운 경로는 미정**: OfflineAudioContext vs FFmpeg 오디오 필터 — dev-plan **5.1** 에서 결정 후 TECH-STACK.md 에 기록

## 6. 내보내기 엔진

전략 A (권장, WYSIWYG에 유리): **프레임별 오프스크린 렌더 → FFmpeg 인코딩**
1. 타임라인 → 프레임 시퀀스 명세 (`frameCount = fps × duration`)
2. 각 프레임을 OffscreenCanvas + WebGL 로 렌더 (프리뷰와 동일 셰이더)
3. 렌더된 프레임을 FFmpeg `stdin` 파이프로 인코딩
4. 오디오는 Web Audio OfflineAudioContext 또는 FFmpeg 로 믹스다운
5. 비디오 + 오디오 mux → 최종 파일

전략 B (단순 케이스): 순수 FFmpeg 필터그래프 — 효과가 단순할 때만.

- 진행률: 인코딩된 프레임 수 / 전체 프레임 수
- 취소: FFmpeg 프로세스 종료 + 임시파일 정리

> 전략 A 의 구조적 리스크(아래 §6.1~6.2)는 Phase 5 가 아니라 **dev-plan 1.5 스파이크**(컷 편집만 되는 최소 내보내기, walking skeleton)에서 조기 검증한다.

### 6.1 렌더 실행 위치 (미정 → 1.5 스파이크에서 결정)

OffscreenCanvas + WebGL 렌더는 Chromium 컨텍스트가 필요하다. 후보:

| 후보 | 장점 | 단점 |
|------|------|------|
| **숨김 BrowserWindow** (유력) | 편집 UI와 격리, 프리뷰와 동일 렌더 환경 | 창 관리 복잡도, 메모리 추가 |
| 기존 렌더러에서 렌더 | 구현 단순 | 내보내기 중 UI 블로킹/경합 |
| UtilityProcess + 소프트웨어 렌더 | 인코더(메인)와 가까움 | GPU 접근 제약, 프리뷰와 환경 상이 → WYSIWYG 리스크 |

### 6.2 프레임 전송 대역폭 (검증 필수)

1080p30 RGBA 원시 프레임 ≈ **초당 250MB**. `renderer → main → FFmpeg stdin` 경로가 이걸 감당하는지가 숨은 병목이다.
- 완화 옵션: readPixels 후 **YUV 변환 후 전송**(대역폭 ~50%↓), transferable ArrayBuffer, 공유 메모리, 렌더 프로세스에서 FFmpeg 에 직접 파이프
- 1.5 스파이크에서 처리량을 실측하고 결정을 이 문서에 기록한다 (목표: 1080p30 5분 ≤ 2× 실시간)

## 7. 상태 관리 & Undo/Redo

- **SSOT**: `Project` 데이터 모델 (Zustand 스토어)
- **커맨드 패턴**: 모든 편집 조작을 `execute()/undo()` 쌍의 커맨드로 → 히스토리 스택
- **직렬화**: Project → JSON (프로젝트 파일). 스키마 버전 필드로 마이그레이션 대비

## 8. 성능 전략
- **프록시**: 고해상도 소스는 저해상도 프록시로 편집, 내보내기만 원본
- **캐시**: 디코딩 프레임 LRU, 썸네일 캐시
- **워커**: 디코딩/파형 생성 등 무거운 작업 오프로딩
- **메모리 상한**: 캐시 크기 제한, 장시간 세션 모니터링

관련 문서: [DATA-MODEL.md](./DATA-MODEL.md) · [TECH-STACK.md](./TECH-STACK.md) · [`../dev-plan.json`](../dev-plan.json)
