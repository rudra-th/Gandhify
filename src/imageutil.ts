export interface ImageDataLike {
  width: number
  height: number
  data: Uint8ClampedArray<ArrayBuffer>
}

export type SourceLike =
  | ImageDataLike
  | (CanvasImageSource & { width: number; height: number })

function toCanvas(source: SourceLike): HTMLCanvasElement {
  if ('data' in source && source.data instanceof Uint8ClampedArray) {
    const c = document.createElement('canvas')
    c.width = source.width
    c.height = source.height
    const cx = c.getContext('2d', { willReadFrequently: true })
    cx?.putImageData(new ImageData(source.data, source.width, source.height), 0, 0)
    return c
  }
  return source as HTMLCanvasElement
}

/**
 * Center-crop `source` to a square (min(width,height)) and resize it to
 * `sidelen` x `sidelen`, returning raw RGBA. Used for the user photo, the
 * Gandhi target and the weights map alike.
 */
export function squareCropResizeToRgba(
  source: SourceLike,
  sidelen: number,
): ImageDataLike {
  const canvas = document.createElement('canvas')
  canvas.width = sidelen
  canvas.height = sidelen
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('2D canvas context unavailable')

  const img = toCanvas(source)
  const w = img.width
  const h = img.height
  const side = Math.min(w, h)
  const sx = (w - side) / 2
  const sy = (h - side) / 2
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, sx, sy, side, side, 0, 0, sidelen, sidelen)

  const imageData = ctx.getImageData(0, 0, sidelen, sidelen)
  return {
    width: sidelen,
    height: sidelen,
    data: imageData.data,
  }
}

export function dataUrlToImageData(dataUrl: string): Promise<ImageDataLike> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) {
        reject(new Error('2D canvas context unavailable'))
        return
      }
      ctx.drawImage(img, 0, 0)
      const id = ctx.getImageData(0, 0, canvas.width, canvas.height)
      resolve({ width: id.width, height: id.height, data: id.data })
    }
    img.onerror = () => reject(new Error('failed to decode image'))
    img.src = dataUrl
  })
}