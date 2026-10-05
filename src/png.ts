import { deflateSync } from 'node:zlib'
import { LocalDreamError } from './errors.ts'

/** The 8-byte PNG file signature. */
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** Standard PNG/zlib CRC-32. Exported for unit tests. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** One length/type/data/crc PNG chunk. Exported for unit tests. */
export function pngChunk(type: string, data: Uint8Array): Buffer {
  if (type.length !== 4) throw new LocalDreamError('protocol', `PNG chunk 类型必须是 4 个字符：${type}`)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/** Number of bytes a base64 string decodes to, without decoding it. */
export function base64ByteLength(base64: string): number {
  const cleaned = base64.replace(/\s+/g, '')
  if (cleaned === '') return 0
  const padding = cleaned.endsWith('==') ? 2 : cleaned.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((cleaned.length * 3) / 4) - padding)
}

/**
 * Reshape the backend's `complete.image` payload into raw RGB bytes.
 *
 * The Local Dream backend sends RAW RGB BYTE PIXELS (not a PNG/JPG), so the
 * length must be exactly `width * height * channels` and `channels` must be 3
 * (`(height, width, channels)` row-major). A mismatch means the response is not
 * usable as an image, so it fails loudly instead of producing a corrupt PNG.
 */
export function reshapeRgb(base64: string, width: number, height: number, channels: number): Buffer {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new LocalDreamError('protocol', `生成结果尺寸非法：width=${width} height=${height}`)
  }
  if (channels !== 3) {
    throw new LocalDreamError('protocol', `生成结果 channels=${channels}，本插件只支持 3（RGB）`)
  }
  const bytes = Buffer.from(base64, 'base64')
  const expected = width * height * channels
  if (bytes.length !== expected) {
    throw new LocalDreamError(
      'protocol',
      `生成结果像素字节数不匹配：期望 width*height*channels=${width}*${height}*${channels}=${expected}，实际 ${bytes.length}。` +
        'complete.image 应为原始 RGB 字节（非 PNG/JPG）的 base64。',
    )
  }
  return bytes
}

/** Encode 8-bit RGB pixels as a PNG (colour type 2, filter 0 per scanline). */
export function encodePngRgb(width: number, height: number, rgb: Uint8Array, level = 6): Buffer {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new LocalDreamError('protocol', `PNG 尺寸非法：${width}x${height}`)
  }
  const expected = width * height * 3
  if (rgb.length !== expected) {
    throw new LocalDreamError('protocol', `PNG 像素长度不匹配：期望 ${expected}，实际 ${rgb.length}`)
  }
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let row = 0; row < height; row += 1) {
    const target = row * (stride + 1)
    raw[target] = 0 // filter type 0 (None)
    Buffer.from(rgb.buffer, rgb.byteOffset + row * stride, stride).copy(raw, target + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.writeUInt8(8, 8) // bit depth
  ihdr.writeUInt8(2, 9) // colour type: truecolour RGB
  ihdr.writeUInt8(0, 10) // compression
  ihdr.writeUInt8(0, 11) // filter
  ihdr.writeUInt8(0, 12) // interlace
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** Encode a decoded image descriptor as a PNG (channels must be 3). */
export function encodePng(image: { width: number; height: number; channels: number; data: Uint8Array }): Buffer {
  if (image.channels !== 3) {
    throw new LocalDreamError('protocol', `PNG 编码只支持 channels=3，收到 ${image.channels}`)
  }
  return encodePngRgb(image.width, image.height, image.data)
}
