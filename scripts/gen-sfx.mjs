/**
 * 전환 효과음(SFX) 합성 생성기 (phase-9.1)
 * 순수 절차 합성으로 짧은 효과음 WAV(48kHz/16-bit/모노)를 resources/sfx/ 에 굽는다.
 * 직접 합성이므로 저작권/라이선스 이슈 없음(CC0 상당). 재생성 가능 — 소스는 이 스크립트.
 *
 * 각 사운드의 peakOffsetSec(지각적 피크 시각)는 shared/sfx.ts 의 SFX_LIBRARY 와 일치해야 한다.
 * 실행: node scripts/gen-sfx.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SR = 48000
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'sfx')

// 결정론적 노이즈 (mulberry32) — 실행마다 동일 파형
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const noise = (r) => r() * 2 - 1

// 상태변수필터(SVF) 밴드패스 한 스텝
function svfStep(state, input, fc, q) {
  const f = 2 * Math.sin((Math.PI * Math.min(fc, SR / 2.2)) / SR)
  state.low += f * state.band
  const high = input - state.low - q * state.band
  state.band += f * high
  return state.band // bandpass
}

function raisedCosine(rel, len, peak) {
  // 0..len 구간에서 peak 시각에 최대 1 이 되는 비대칭 벨 (attack/decay 분리)
  if (rel < 0 || rel > len) return 0
  if (rel <= peak) return 0.5 - 0.5 * Math.cos((Math.PI * rel) / Math.max(1e-4, peak))
  return 0.5 + 0.5 * Math.cos((Math.PI * (rel - peak)) / Math.max(1e-4, len - peak))
}

// ── 합성기들 (durationSec, peakSec 반환은 스펙과 일치) ──
function whoosh() {
  const dur = 0.5
  const n = Math.floor(dur * SR)
  const out = new Float32Array(n)
  const r = rng(1)
  const st = { low: 0, band: 0 }
  for (let i = 0; i < n; i++) {
    const rel = i / SR
    const t = rel / dur
    const fc = 400 + 2600 * Math.sin(Math.PI * t) // 중앙에서 밝아졌다 다시 어두워짐
    const bp = svfStep(st, noise(r), fc, 1.2)
    out[i] = bp * raisedCosine(rel, dur, 0.25)
  }
  return out
}

function swish() {
  const dur = 0.32
  const n = Math.floor(dur * SR)
  const out = new Float32Array(n)
  const r = rng(2)
  const st = { low: 0, band: 0 }
  for (let i = 0; i < n; i++) {
    const rel = i / SR
    const fc = 1800 + 3500 * (1 - rel / dur) // 높은 곳에서 빠르게 하강 (샤악)
    const bp = svfStep(st, noise(r), fc, 0.9)
    out[i] = bp * raisedCosine(rel, dur, 0.06)
  }
  return out
}

function pop() {
  const dur = 0.18
  const n = Math.floor(dur * SR)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const rel = i / SR
    const freq = 620 * Math.exp(-6 * rel) + 180 // 짧은 하강 피치
    const env = Math.exp(-32 * rel)
    out[i] = Math.sin(2 * Math.PI * freq * rel) * env
  }
  return out
}

function click() {
  const dur = 0.08
  const n = Math.floor(dur * SR)
  const out = new Float32Array(n)
  const r = rng(4)
  for (let i = 0; i < n; i++) {
    const rel = i / SR
    const env = Math.exp(-120 * rel)
    const tone = Math.sin(2 * Math.PI * 2200 * rel)
    out[i] = (0.6 * tone + 0.4 * noise(r)) * env
  }
  return out
}

function boom() {
  const dur = 0.6
  const n = Math.floor(dur * SR)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const rel = i / SR
    const freq = 120 * Math.exp(-4 * rel) + 45 // 저역 임팩트 + 피치 드롭
    const env = Math.exp(-6 * rel)
    out[i] = Math.sin(2 * Math.PI * freq * rel) * env
  }
  return out
}

const SOUNDS = [
  { id: 'whoosh', synth: whoosh },
  { id: 'swish', synth: swish },
  { id: 'pop', synth: pop },
  { id: 'click', synth: click },
  { id: 'boom', synth: boom }
]

function normalize(buf, target = 0.9) {
  let peak = 0
  for (const v of buf) peak = Math.max(peak, Math.abs(v))
  if (peak < 1e-6) return buf
  const g = target / peak
  for (let i = 0; i < buf.length; i++) buf[i] *= g
  return buf
}

// 소프트 클릭 방지용 2ms 페이드 인/아웃
function edgeFade(buf) {
  const f = Math.floor(0.002 * SR)
  for (let i = 0; i < f; i++) {
    const g = i / f
    buf[i] *= g
    buf[buf.length - 1 - i] *= g
  }
  return buf
}

function encodeWav(float) {
  const n = float.length
  const bytesPerSample = 2
  const dataSize = n * bytesPerSample
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16) // PCM fmt chunk size
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(SR, 24)
  buf.writeUInt32LE(SR * bytesPerSample, 28) // byte rate
  buf.writeUInt16LE(bytesPerSample, 32) // block align
  buf.writeUInt16LE(16, 34) // bits per sample
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, float[i]))
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2)
  }
  return buf
}

mkdirSync(OUT_DIR, { recursive: true })
for (const { id, synth } of SOUNDS) {
  const samples = edgeFade(normalize(synth()))
  const wav = encodeWav(samples)
  const path = join(OUT_DIR, `${id}.wav`)
  writeFileSync(path, wav)
  // 실제 피크 시각 측정 (스펙 peakOffsetSec 참고용)
  let peakIdx = 0
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) > peak) {
      peak = Math.abs(samples[i])
      peakIdx = i
    }
  }
  console.log(`${id}.wav  dur=${(samples.length / SR).toFixed(3)}s  peak@${(peakIdx / SR).toFixed(3)}s  (${wav.length} bytes)`)
}
console.log(`\n생성 완료 → ${OUT_DIR}`)
