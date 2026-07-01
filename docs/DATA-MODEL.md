# DATA-MODEL — 데이터 모델 상세 설계

> 최종 수정: 2026-07-02 · 상태: 기획
> 이 모델은 프로젝트의 단일 진실 공급원(SSOT)이며, 프리뷰/내보내기/저장이 모두 이것을 참조한다.

## 0. 설계 원칙
- **불변(immutable) 업데이트**: 상태 변경은 새 객체 생성으로 → undo/redo·시간여행 용이
- **소스 참조 분리**: 클립은 원본을 복사하지 않고 `sourceIn/Out` 로 구간만 참조
- **시간 단위 통일**: 내부 시간은 **초(seconds, float)** 로 저장, 표시할 때 fps 로 프레임 환산
- **직렬화 가능**: 전체 모델은 JSON 직렬화 가능해야 함 (프로젝트 저장)

## 1. 타입 정의 (TypeScript)

```ts
// ── 프로젝트 루트 ────────────────────────────────────────
interface Project {
  schemaVersion: number;        // 마이그레이션용
  id: string;
  name: string;
  settings: ProjectSettings;
  assets: MediaAsset[];         // 임포트된 원본들
  tracks: Track[];              // 위→아래 = 합성 시 위 레이어가 앞
  createdAt: string;
  updatedAt: string;
}

interface ProjectSettings {
  width: number;                // 출력 캔버스 해상도
  height: number;
  fps: number;                  // 프로젝트 기준 프레임레이트
  sampleRate: number;           // 오디오 샘플레이트 (예: 48000)
  backgroundColor: string;      // 빈 영역 배경색
  masterVolume: number;         // 0~1, 최종 믹스 게인 (PRD 5.4)
}

// ── 원본 미디어 ─────────────────────────────────────────
interface MediaAsset {
  id: string;
  kind: "video" | "audio" | "image";
  path: string;                 // 상대경로 우선 (이식성)
  duration: number;             // 초
  width?: number;               // video/image
  height?: number;
  fps?: number;                 // video (가변 fps 여부 포함 고려)
  hasAudio?: boolean;
  proxyPath?: string;           // 저해상도 프록시 경로
  status: "ok" | "missing";     // 파일 누락 재연결용
}

// ── 트랙 ────────────────────────────────────────────────
interface Track {
  id: string;
  kind: "video" | "audio" | "text";
  clips: Clip[];                // timelineStart 기준 정렬
  volume?: number;              // 트랙 게인 0~1 (video/audio, 기본 1.0)
  muted?: boolean;
  hidden?: boolean;
  locked?: boolean;
}

// ── 클립 (편집의 최소 단위) ──────────────────────────────
interface Clip {
  id: string;
  assetId?: string;             // text 클립은 없을 수 있음
  kind: "video" | "audio" | "image" | "text";

  // 타임라인 상 배치 (프로젝트 시간축, 초)
  timelineStart: number;
  timelineEnd: number;

  // 원본에서 잘라온 구간 (소스 시간축, 초) — video/audio
  sourceIn?: number;
  sourceOut?: number;
  speed?: number;               // 재생 속도 배율 (기본 1.0)

  // 시각 속성 (video/image/text)
  transform?: Transform;
  opacity?: number;             // 0~1

  // 효과 & 전환
  effects?: Effect[];
  transitionIn?: Transition;
  transitionOut?: Transition;

  // 오디오 속성 (video/audio)
  volume?: number;              // 0~1 (이상 증폭 시 >1)
  fadeIn?: number;              // 초
  fadeOut?: number;             // 초

  // 텍스트 속성 (text)
  text?: TextContent;
}

interface Transform {
  x: number;                    // 캔버스 중심 기준 오프셋 (px)
  y: number;
  scale: number;                // 1.0 = 원본
  rotation: number;             // degree
}

// ── 효과 / 전환 (WYSIWYG 핵심: 프리뷰·내보내기 공유) ──────
interface Effect {
  type: "brightness" | "contrast" | "saturation" | "temperature" | "blur" | string;
  params: Record<string, number>;   // 정규화된 파라미터
  enabled: boolean;
}

interface Transition {
  type: "dissolve" | "wipe" | "slide" | "fade" | string;
  duration: number;             // 초 (시간 의미론은 §1.1 참조)
  params?: Record<string, number>;
}
```

### 1.1 전환(Transition)의 시간 의미론 — 소스 핸들 규칙

클립 간 전환(디졸브 등)은 전환 구간 동안 **두 클립의 프레임이 동시에** 필요하다.
그러나 불변식 1에 따라 타임라인상 클립은 겹치지 않으므로, 추가 프레임은
**컷 지점 너머의 소스 여유분(핸들, handle)** 에서 가져온다.

```
타임라인:   [   클립 A   ]│[   클립 B   ]     │ = 컷 지점 (겹침 없음)
                      ◄─ d ─►                 d = transition.duration
전환 구간에 필요한 소스:
  A: sourceOut 이후로  d × A.speed 만큼 추가로 읽음 (A의 핸들)
  B: sourceIn  이전으로 d × B.speed 만큼 추가로 읽음 (B의 핸들)
```

- **배치**: 인접한 두 클립의 컷 지점을 중심으로 `duration` 만큼의 전환 구간을 정의한다.
  데이터는 앞 클립의 `transitionOut` 에 저장하고, 뒤 클립의 `transitionIn` 은 같은 전환을 가리키는 파생 정보로 취급한다(이중 저장 금지).
- **핸들 확보 조건**: `A.sourceOut + d×A.speed ≤ A.asset.duration` 그리고 `B.sourceIn − d×B.speed ≥ 0`
- **핸들 부족 시 fallback**: 여유분이 모자라면 마지막/첫 프레임을 **프레임 홀드(freeze)** 로 채운다.
  이 fallback은 결정론적이어야 하며, 프리뷰와 내보내기가 **동일한 규칙**을 적용해야 WYSIWYG가 유지된다 (dev-plan 4.2).
- **UI 정책(권장)**: 전환 추가 시 핸들이 부족하면 duration 을 가용 핸들 길이로 자동 축소하고 사용자에게 알린다.

```ts

// ── 텍스트 ──────────────────────────────────────────────
interface TextContent {
  value: string;
  fontFamily: string;
  fontSize: number;
  color: string;
  align: "left" | "center" | "right";
  bold?: boolean;
  italic?: boolean;
  stroke?: { color: string; width: number };
  shadow?: { color: string; blur: number; x: number; y: number };
  background?: { color: string; padding: number };
  animationIn?: TextAnimation;
  animationOut?: TextAnimation;
}

interface TextAnimation {
  type: "fade" | "slide" | "pop" | string;
  duration: number;             // 초
  params?: Record<string, number>;
}
```

## 2. 커맨드(명령) 모델 — Undo/Redo

모든 편집 조작은 커맨드로 표현하여 히스토리 스택에 쌓는다.

```ts
interface Command {
  label: string;                // "클립 이동", "트림" 등 (UI 표시용)
  execute(state: Project): Project;
  undo(state: Project): Project;
}
```

예시 커맨드: `AddClip`, `RemoveClip`, `MoveClip`, `TrimClip`, `SplitClip`,
`AddEffect`, `UpdateEffectParams`, `AddTextClip`, `SetVolume`, `AddTransition` ...

- 히스토리: `past: Command[]`, `future: Command[]`
- 실행 시 `future` 비우고 `past` 에 push, undo 시 서로 이동

## 3. 불변식 (Invariants) — 검증에서 확인할 규칙
1. 같은 트랙 내 클립은 시간적으로 겹치지 않는다 (`timelineEnd ≤ 다음 clip.timelineStart`)
2. `timelineStart < timelineEnd`, `sourceIn < sourceOut`
3. `sourceOut - sourceIn` 과 `(timelineEnd - timelineStart) × speed` 는 일치 (속도 반영)
4. `transitionIn.duration` 은 클립 길이를 넘지 않는다
5. `assetId` 는 존재하는 `MediaAsset` 을 가리킨다 (없으면 status=missing 처리)
6. 클립 간 전환은 인접한(같은 트랙에서 맞닿은) 두 클립 사이에만 존재한다 — `transitionOut` 이 원본, 뒤 클립의 `transitionIn` 은 파생 (§1.1)
7. 전환의 소스 핸들 확보 조건(§1.1)을 검사하고, 부족하면 프레임 홀드 fallback 이 적용됨을 명시적으로 마킹한다 (프리뷰·내보내기 동일 규칙)

> 이 불변식들은 커맨드 실행 후 개발 모드에서 assert 하면 버그를 조기에 잡는다.

## 4. 시간·프레임 환산
```
frameIndex = round(timeSeconds × fps)
timeSeconds = frameIndex / fps
```
- 내부 저장은 초(float), UI/시크/내보내기 경계 계산은 프레임 인덱스로 정규화
- 반올림 오차로 인한 프레임 누락을 막기 위해 **경계 계산은 항상 프레임 단위로 스냅**

## 5. 직렬화 & 마이그레이션
- 프로젝트 파일 = `Project` JSON + `schemaVersion`
- 로드 시 `schemaVersion` 확인 → 필요 시 마이그레이션 함수 체인 적용
- 미디어는 상대경로 저장, 누락 시 재연결 UI (`MediaAsset.status = "missing"`)

관련 문서: [ARCHITECTURE.md](./ARCHITECTURE.md) · [PRD.md](./PRD.md)
