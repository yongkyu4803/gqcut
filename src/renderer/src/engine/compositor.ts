/**
 * WebGL 컴포지터 (1.3) — 프리뷰·내보내기가 공유하는 유일한 합성 경로 (WYSIWYG).
 *
 * 색공간/알파 규칙 (1.3.4):
 * - 텍스처 업로드 시 UNPACK_PREMULTIPLY_ALPHA_WEBGL=true → 모든 레이어는 premultiplied alpha
 * - 블렌딩: gl.blendFunc(ONE, ONE_MINUS_SRC_ALPHA) (premultiplied 표준)
 * - 셰이더는 sRGB 값을 그대로 다룬다(브라우저 디코딩 출력 = 표시 공간). 필터(Phase 4)에서
 *   linear 연산이 필요한 효과는 effects-spec 에서 변환을 명시한다.
 */
import type { Transform } from '@shared/model/types'

export interface Layer {
  source: TexImageSource | VideoFrame
  /** 소스 픽셀 크기 */
  srcWidth: number
  srcHeight: number
  transform?: Transform
  opacity?: number
  /** true 면 캔버스에 contain-fit 하는 기본 스케일을 적용 (비디오/이미지), false 면 픽셀 1:1 (텍스트) */
  fitToCanvas: boolean
}

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

const FRAG = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform float uOpacity;
void main() {
  vec4 c = texture2D(uTex, vUV);
  gl_FragColor = c * uOpacity; // premultiplied: rgb 에도 opacity 곱
}`

export class Compositor {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas
  readonly width: number
  readonly height: number
  private gl: WebGLRenderingContext
  private texture: WebGLTexture
  private uMatrix: WebGLUniformLocation
  private uOpacity: WebGLUniformLocation
  private pixelBuf: Uint8Array | null = null

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

    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type)!
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`셰이더 컴파일 실패: ${gl.getShaderInfoLog(sh)}`)
      return sh
    }
    const program = gl.createProgram()!
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT))
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`프로그램 링크 실패: ${gl.getProgramInfoLog(program)}`)
    gl.useProgram(program)

    // 단위 쿼드. 위치는 픽셀 공간(y 아래 방향) 기준 — 변환 행렬이 y를 반전해 NDC 로 보낸다.
    // 따라서 aPos y=-0.5 가 화면 위쪽 → 이미지 상단(v=0)과 짝지어야 방향이 맞는다.
    const quad = new Float32Array([
      -0.5, -0.5, 0, 0,
      0.5, -0.5, 1, 0,
      -0.5, 0.5, 0, 1,
      0.5, 0.5, 1, 1
    ])
    const vbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(program, 'aPos')
    const aUV = gl.getAttribLocation(program, 'aUV')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0)
    gl.enableVertexAttribArray(aUV)
    gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 16, 8)

    this.uMatrix = gl.getUniformLocation(program, 'uMatrix')!
    this.uOpacity = gl.getUniformLocation(program, 'uOpacity')!

    this.texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA) // premultiplied alpha 표준 (1.3.4)
    gl.viewport(0, 0, width, height)
  }

  /** 레이어 배열을 아래→위 순서로 합성 (호출자가 순서를 보장) */
  render(layers: Layer[], backgroundColor: string): void {
    const gl = this.gl
    const [r, g, b] = hexToRgb(backgroundColor)
    gl.clearColor(r, g, b, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    for (const layer of layers) {
      this.drawLayer(layer)
    }
  }

  private drawLayer(layer: Layer): void {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    // 색공간 규칙 (1.3.4): VideoFrame/ImageBitmap 은 불투명 → 프리멀티플라이 불필요.
    // 이 플래그가 켜져 있으면 Chromium 이 비디오 프레임 업로드에 별도 변환 경로를 타면서
    // 색이 어긋난다(실측: 녹색 189→159). 알파가 실재하는 캔버스(텍스트 래스터)에만 적용한다.
    const needsPremultiply = !(typeof VideoFrame !== 'undefined' && layer.source instanceof VideoFrame) && !(layer.source instanceof ImageBitmap)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, needsPremultiply)
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layer.source as TexImageSource)
    } catch {
      return // 닫힌 VideoFrame 등 — 이번 프레임은 스킵
    }

    const t = layer.transform ?? { x: 0, y: 0, scale: 1, rotation: 0 }
    // 기본 스케일: contain-fit(비디오/이미지) 또는 1:1(텍스트 래스터)
    const base = layer.fitToCanvas ? Math.min(this.width / layer.srcWidth, this.height / layer.srcHeight) : 1
    const w = layer.srcWidth * base * t.scale
    const h = layer.srcHeight * base * t.scale
    const rad = (t.rotation * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)

    // 픽셀 공간(중심 원점, y 아래 방향)에서 단위 쿼드에 회전·스케일·이동을 적용한 뒤 NDC 로 변환.
    // P_px = R(θ)·S(w,h)·p + (t.x, t.y) → NDC: x·(2/W), y·(−2/H)
    const px2ndcX = 2 / this.width
    const px2ndcY = -2 / this.height
    const m = new Float32Array([
      cos * w * px2ndcX, sin * w * px2ndcY, 0, // 1열: x축 기저
      -sin * h * px2ndcX, cos * h * px2ndcY, 0, // 2열: y축 기저
      t.x * px2ndcX, t.y * px2ndcY, 1 // 3열: 이동
    ])

    gl.uniformMatrix3fv(this.uMatrix, false, m)
    gl.uniform1f(this.uOpacity, Math.max(0, Math.min(1, layer.opacity ?? 1)))
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  /** 현재 프레임버퍼를 RGBA 로 읽는다 (내보내기 1.5.2). WebGL 특성상 행이 bottom-up. */
  readPixels(): Uint8Array {
    const gl = this.gl
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
