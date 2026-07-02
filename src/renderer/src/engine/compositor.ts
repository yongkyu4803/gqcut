/**
 * WebGL 컴포지터 (1.3, 4.1, 4.2) — 프리뷰·내보내기가 공유하는 유일한 합성 경로 (WYSIWYG).
 *
 * 색공간/알파 규칙 (1.3.4 / ARCHITECTURE §6.3):
 * - 캔버스(텍스트 래스터) 업로드만 UNPACK_PREMULTIPLY_ALPHA=true. VideoFrame/ImageBitmap 은 불투명이라 불필요
 *   (플래그를 켜면 Chromium 이 비디오 업로드에 별도 변환 경로를 타며 색이 어긋난다).
 * - 블렌딩: premultiplied 표준 (ONE, ONE_MINUS_SRC_ALPHA)
 * - 색 연산(필터)은 sRGB 공간 — 수식은 shared/effects-spec 에만 정의.
 *
 * 전환(4.2): 두 클립 레이어를 각각 FBO 에 렌더한 뒤 전환 셰이더로 블렌딩.
 */
import type { Transform } from '@shared/model/types'
import { COLOR_ADJUST_GLSL, NEUTRAL_ADJUST, TRANSITION_GLSL, transitionTypeId, type ColorAdjust } from '@shared/effects-spec'

export interface Layer {
  source: TexImageSource | VideoFrame
  srcWidth: number
  srcHeight: number
  transform?: Transform
  opacity?: number
  /** true 면 캔버스에 contain-fit 하는 기본 스케일 (비디오/이미지), false 면 픽셀 1:1 (텍스트) */
  fitToCanvas: boolean
  /** 색보정 (effects-spec resolveColorAdjust 결과) */
  adjust?: ColorAdjust
}

export type SceneItem =
  | { kind: 'layer'; layer: Layer }
  | { kind: 'transition'; a: Layer | null; b: Layer | null; type: string; progress: number }

const VERT = `
attribute vec2 aPos;
attribute vec2 aUV;
uniform mat3 uMatrix;
varying vec2 vUV;
void main() {
  vec3 p = uMatrix * vec3(aPos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vUV = aUV;
}`

const FRAG_LAYER = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform float uOpacity;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uTemperature;
${COLOR_ADJUST_GLSL}
void main() {
  vec4 c = texture2D(uTex, vUV);
  vec3 rgb = c.a > 0.001 ? c.rgb / c.a : c.rgb;
  rgb = applyColorAdjust(rgb, uBrightness, uContrast, uSaturation, uTemperature);
  gl_FragColor = vec4(rgb * c.a, c.a) * uOpacity; // premultiplied 유지
}`

interface Fbo {
  framebuffer: WebGLFramebuffer
  texture: WebGLTexture
}

export class Compositor {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas
  width: number
  height: number
  private gl: WebGLRenderingContext
  private layerProg: WebGLProgram
  private transProg: WebGLProgram
  private texture: WebGLTexture
  private fboA: Fbo
  private fboB: Fbo
  private pixelBuf: Uint8Array | null = null
  private uni: Record<string, WebGLUniformLocation> = {}
  private tUni: Record<string, WebGLUniformLocation> = {}

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, width: number, height: number) {
    this.canvas = canvas
    this.width = width
    this.height = height
    canvas.width = width
    canvas.height = height
    const gl = canvas.getContext('webgl', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true, // readPixels(내보내기)용
      premultipliedAlpha: true
    }) as WebGLRenderingContext | null
    if (!gl) throw new Error('WebGL 컨텍스트를 만들 수 없습니다')
    this.gl = gl

    this.layerProg = this.buildProgram(VERT, FRAG_LAYER)
    this.transProg = this.buildProgram(VERT, TRANSITION_GLSL)

    // 단위 쿼드. 위치는 픽셀 공간(y 아래 방향) 기준 — 레이어 행렬이 y를 반전해 NDC 로 보낸다.
    // aPos y=-0.5 가 화면 위쪽 → 이미지 상단(v=0)과 짝. (전환 패스는 y 반전 없는 행렬 + FBO v=1=상단으로 상쇄)
    const quad = new Float32Array([
      -0.5, -0.5, 0, 0,
      0.5, -0.5, 1, 0,
      -0.5, 0.5, 0, 1,
      0.5, 0.5, 1, 1
    ])
    const vbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW)
    for (const prog of [this.layerProg, this.transProg]) {
      gl.useProgram(prog)
      const aPos = gl.getAttribLocation(prog, 'aPos')
      const aUV = gl.getAttribLocation(prog, 'aUV')
      gl.enableVertexAttribArray(aPos)
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0)
      gl.enableVertexAttribArray(aUV)
      gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 16, 8)
    }

    gl.useProgram(this.layerProg)
    for (const name of ['uMatrix', 'uOpacity', 'uBrightness', 'uContrast', 'uSaturation', 'uTemperature']) {
      this.uni[name] = gl.getUniformLocation(this.layerProg, name)!
    }
    gl.useProgram(this.transProg)
    for (const name of ['uMatrix', 'uTexA', 'uTexB', 'uProgress', 'uType']) {
      this.tUni[name] = gl.getUniformLocation(this.transProg, name)!
    }

    this.texture = this.createTex()
    this.fboA = this.createFbo(width, height)
    this.fboB = this.createFbo(width, height)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA) // premultiplied alpha 표준 (1.3.4)
    gl.viewport(0, 0, width, height)
  }

  private buildProgram(vert: string, frag: string): WebGLProgram {
    const gl = this.gl
    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type)!
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`셰이더 컴파일 실패: ${gl.getShaderInfoLog(sh)}`)
      return sh
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vert))
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, frag))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`프로그램 링크 실패: ${gl.getProgramInfoLog(prog)}`)
    return prog
  }

  private createTex(): WebGLTexture {
    const gl = this.gl
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
  }

  private createFbo(width: number, height: number): Fbo {
    const gl = this.gl
    const texture = this.createTex()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    const framebuffer = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { framebuffer, texture }
  }

  /** 장면 아이템을 아래→위 순서로 합성 */
  render(items: SceneItem[], backgroundColor: string): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const [r, g, b] = hexToRgb(backgroundColor)
    gl.clearColor(r, g, b, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    for (const item of items) {
      if (item.kind === 'layer') {
        this.drawLayer(item.layer)
      } else {
        this.drawTransition(item)
      }
    }
  }

  private drawTransition(item: Extract<SceneItem, { kind: 'transition' }>): void {
    const gl = this.gl
    // 1) 각 클립 레이어를 FBO 에 렌더 (투명 배경)
    for (const [fbo, layer] of [
      [this.fboA, item.a],
      [this.fboB, item.b]
    ] as Array<[Fbo, Layer | null]>) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.framebuffer)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      if (layer) this.drawLayer(layer)
    }
    // 2) 전환 셰이더로 두 FBO 를 기본 프레임버퍼에 블렌딩
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.useProgram(this.transProg)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.fboA.texture)
    gl.uniform1i(this.tUni.uTexA, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.fboB.texture)
    gl.uniform1i(this.tUni.uTexB, 1)
    gl.uniform1f(this.tUni.uProgress, item.progress)
    gl.uniform1i(this.tUni.uType, transitionTypeId(item.type))
    // 풀스크린: y 반전 없는 스케일-2 행렬 (FBO 의 v=1 이 화면 상단과 일치)
    gl.uniformMatrix3fv(this.tUni.uMatrix, false, new Float32Array([2, 0, 0, 0, 2, 0, 0, 0, 1]))
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.activeTexture(gl.TEXTURE0)
  }

  private drawLayer(layer: Layer): void {
    const gl = this.gl
    gl.useProgram(this.layerProg)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    const needsPremultiply =
      !(typeof VideoFrame !== 'undefined' && layer.source instanceof VideoFrame) && !(layer.source instanceof ImageBitmap)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, needsPremultiply)
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layer.source as TexImageSource)
    } catch {
      return // 닫힌 VideoFrame 등 — 이번 프레임은 스킵
    }

    const t = layer.transform ?? { x: 0, y: 0, scale: 1, rotation: 0 }
    const base = layer.fitToCanvas ? Math.min(this.width / layer.srcWidth, this.height / layer.srcHeight) : 1
    const w = layer.srcWidth * base * t.scale
    const h = layer.srcHeight * base * t.scale
    const rad = (t.rotation * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)

    // 픽셀 공간(중심 원점, y 아래 방향) → NDC. P_px = R(θ)·S(w,h)·p + (t.x, t.y)
    const px2ndcX = 2 / this.width
    const px2ndcY = -2 / this.height
    const m = new Float32Array([
      cos * w * px2ndcX, sin * w * px2ndcY, 0,
      -sin * h * px2ndcX, cos * h * px2ndcY, 0,
      t.x * px2ndcX, t.y * px2ndcY, 1
    ])

    const adjust = layer.adjust ?? NEUTRAL_ADJUST
    gl.uniformMatrix3fv(this.uni.uMatrix, false, m)
    gl.uniform1f(this.uni.uOpacity, Math.max(0, Math.min(1, layer.opacity ?? 1)))
    gl.uniform1f(this.uni.uBrightness, adjust.brightness)
    gl.uniform1f(this.uni.uContrast, adjust.contrast)
    gl.uniform1f(this.uni.uSaturation, adjust.saturation)
    gl.uniform1f(this.uni.uTemperature, adjust.temperature)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  /** 캔버스 크기 변경 — 컨텍스트 재생성 없이 (같은 캔버스는 getContext 가 동일 컨텍스트를 돌려주므로 재생성 불가) */
  resize(width: number, height: number): void {
    this.width = width
    this.height = height
    this.canvas.width = width
    this.canvas.height = height
    this.gl.viewport(0, 0, width, height)
    this.pixelBuf = null
    // FBO 재생성
    const gl = this.gl
    for (const fbo of [this.fboA, this.fboB]) {
      gl.deleteFramebuffer(fbo.framebuffer)
      gl.deleteTexture(fbo.texture)
    }
    this.fboA = this.createFbo(width, height)
    this.fboB = this.createFbo(width, height)
  }

  /** 현재 프레임버퍼를 RGBA 로 읽는다 (내보내기 1.5.2). WebGL 특성상 행이 bottom-up. */
  readPixels(): Uint8Array {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    const size = this.width * this.height * 4
    if (!this.pixelBuf || this.pixelBuf.length !== size) this.pixelBuf = new Uint8Array(size)
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, this.pixelBuf)
    return this.pixelBuf
  }

  dispose(): void {
    const ext = this.gl.getExtension('WEBGL_lose_context')
    ext?.loseContext()
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}
