# 서드파티 라이선스 고지 (6.3.4)

> 배포 전 반드시 아래 "라이선스 리스크" 섹션을 검토할 것.

## 번들 바이너리

| 구성요소 | 라이선스 | 비고 |
|----------|----------|------|
| FFmpeg (ffmpeg-static) | **GPL v3** | ffmpeg-static 은 GPL 빌드(libx264 포함)를 배포한다 |
| ffprobe (ffprobe-static) | GPL v3 | 상동 |
| libx264 (FFmpeg 내장) | **GPL v2+** | H.264 인코딩 담당 |

## 주요 라이브러리 (npm)

| 패키지 | 라이선스 |
|--------|----------|
| Electron | MIT |
| React / React DOM | MIT |
| Zustand | MIT |
| mp4box.js | BSD-3-Clause |
| electron-updater | MIT |

## ⚠ 라이선스 리스크 — 상용 배포 전 결정 필요

1. **GPL 전염성**: 현재 번들하는 ffmpeg-static 은 libx264 를 포함한 **GPL 빌드**다.
   GPL 바이너리를 앱과 함께 배포하면서 소스 비공개를 유지하려면, 자식 프로세스 실행이라도
   법적 해석이 갈린다. 안전한 선택지:
   - (a) 앱 전체를 GPL 로 공개
   - (b) **LGPL FFmpeg 커스텀 빌드**로 교체하고 인코딩은 OS 하드웨어 인코더 사용
     (`h264_videotoolbox`(macOS) / `h264_mf`(Windows) — libx264 불필요, 품질/CRF 제어는 비트레이트 방식으로 변경)
   - (c) x264 상용 라이선스 구매
2. **H.264 특허 풀**: 배포 규모가 커지면 MPEG LA(Via-LA) AVC 라이선스 검토 필요
   (연간 무료 한도 있음). H.265 인코딩을 미지원하는 현 정책은 유지 권장.
3. 폰트: 시스템 폰트만 사용 중 — 폰트 번들 추가 시 라이선스 확인.

> 권고: 상용 출시 전 (b) LGPL 빌드 + 하드웨어 인코더 경로로 전환. dev-plan 6.3.4 참조.
