// Minimal ambient typings for gifenc (the package ships plain JS).
declare module 'gifenc' {
  export type PixelFormat = 'rgb565' | 'rgb444' | 'rgba4444'

  export interface QuantizeOptions {
    format?: PixelFormat
    oneBitAlpha?: boolean | number
    clearAlpha?: boolean
    clearAlphaThreshold?: number
    clearAlphaColor?: number
    useSqrt?: boolean
  }

  export function quantize(
    rgba: Uint8ClampedArray | Uint8Array,
    maxColors: number,
    options?: QuantizeOptions,
  ): number[][]

  export function applyPalette(
    rgba: Uint8ClampedArray | Uint8Array,
    palette: number[][],
    format?: PixelFormat,
  ): Uint8Array

  export interface EncoderOptions {
    initialCapacity?: number
    auto?: boolean
  }

  export interface FrameOptions {
    transparent?: boolean
    transparentIndex?: number
    delay?: number
    palette?: number[][]
    repeat?: number
    colorDepth?: number
    dispose?: number
    first?: boolean
  }

  export interface GIFEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: FrameOptions,
    ): void
    finish(): void
    bytes(): Uint8Array
    reset(): void
  }

  export function GIFEncoder(opt?: EncoderOptions): GIFEncoderInstance

  export default GIFEncoder
}

// the ESM build that Vite resolves from package.json's `module` field
// (also used directly by tests running under Node)
declare module 'gifenc/dist/gifenc.esm.js' {
  export * from 'gifenc'
}