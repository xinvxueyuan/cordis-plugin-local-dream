import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { LocalDreamError } from './errors.ts'
import { encodePngRgb, reshapeRgb } from './png.ts'
import { decodeSseEvent, SseParser } from './sse.ts'
import type { JsonValue, SseJsonEvent, StreamRead } from './types.ts'

/** Schedulers the backend accepts. An unknown value silently falls back to `dpm`. */
export const SCHEDULERS = [
  'dpm',
  'dpm_karras',
  'dpm_sde',
  'dpm_sde_karras',
  'euler_a',
  'eulera',
  'euler_a_karras',
  'euler',
  'euler_karras',
  'lcm',
] as const

export type Scheduler = (typeof SCHEDULERS)[number]

/** Every field `POST /generate` documents. Unknown fields are rejected. */
export const GENERATE_FIELDS = new Set<string>([
  'prompt',
  'negative_prompt',
  'steps',
  'cfg',
  'seed',
  'scheduler',
  'size',
  'width',
  'height',
  'use_opencl',
  'show_diffusion_process',
  'show_diffusion_stride',
  'image',
  'mask',
  'denoise_strength',
  'aspect_ratio',
])

/** Tool-level arguments that are not part of the `/generate` JSON body. */
export const TOOL_ONLY_FIELDS = new Set<string>(['outputPath', 'transport', 'host', 'serial', 'model'])

/** Reject an unknown scheduler — including the unsupported `lcm_karras`. */
export function assertScheduler(value: string): void {
  if ((SCHEDULERS as readonly string[]).includes(value)) return
  if (value === 'lcm_karras') {
    throw new LocalDreamError('args', 'scheduler "lcm_karras" 不受支持：lcm 没有 _karras 变体，请改用 "lcm" 或 "dpm_karras"')
  }
  throw new LocalDreamError(
    'args',
    `未知 scheduler "${value}"；可选值：${SCHEDULERS.join(', ')}（未知值在服务端会静默回退为 dpm，插件直接拒绝以免产生意外结果）`,
  )
}

function assertInteger(name: string, value: unknown, options: { min: number; max?: number }): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < options.min || (options.max !== undefined && value > options.max)) {
    const range = options.max !== undefined ? `${options.min}-${options.max}` : `>= ${options.min}`
    throw new LocalDreamError('args', `${name} 必须是 ${range} 的整数，收到 ${JSON.stringify(value)}`)
  }
  return value
}

function assertNumber(name: string, value: unknown, options: { min?: number; max?: number } = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new LocalDreamError('args', `${name} 必须是有限数字，收到 ${JSON.stringify(value)}`)
  }
  if (options.min !== undefined && value < options.min) {
    throw new LocalDreamError('args', `${name} 不能小于 ${options.min}`)
  }
  if (options.max !== undefined && value > options.max) {
    throw new LocalDreamError('args', `${name} 不能大于 ${options.max}`)
  }
  return value
}

function assertBoolean(name: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new LocalDreamError('args', `${name} 必须是布尔值，收到 ${JSON.stringify(value)}`)
  }
  return value
}

function assertString(name: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new LocalDreamError('args', `${name} 必须是字符串，收到 ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Build the `/generate` request body from tool arguments.
 *
 * `size` is documented to OVERRIDE `width`/`height` server-side; this builder
 * also rewrites the pair to the same value so the body is self-consistent no
 * matter which field the running backend honours. Unknown fields are rejected
 * instead of being forwarded, so a typo cannot silently drop a parameter.
 *
 * Exported for unit tests.
 */
export function buildGenerateBody(args: Record<string, unknown>): Record<string, JsonValue> {
  const body: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue
    if (TOOL_ONLY_FIELDS.has(key)) continue
    if (!GENERATE_FIELDS.has(key)) {
      throw new LocalDreamError('args', `未知的 /generate 字段 "${key}"；可用字段：${[...GENERATE_FIELDS].join(', ')}`)
    }
    switch (key) {
      case 'prompt':
        body.prompt = assertString(key, value)
        break
      case 'negative_prompt':
        body.negative_prompt = assertString(key, value)
        break
      case 'steps':
        body.steps = assertInteger(key, value, { min: 1 })
        break
      case 'cfg':
        body.cfg = assertNumber(key, value, { min: 0 })
        break
      case 'seed':
        body.seed = assertInteger(key, value, { min: 0 })
        break
      case 'scheduler':
        assertScheduler(assertString(key, value))
        body.scheduler = value as string
        break
      case 'size':
        body.size = assertInteger(key, value, { min: 1 })
        break
      case 'width':
        body.width = assertInteger(key, value, { min: 1 })
        break
      case 'height':
        body.height = assertInteger(key, value, { min: 1 })
        break
      case 'use_opencl':
        body.use_opencl = assertBoolean(key, value)
        break
      case 'show_diffusion_process':
        body.show_diffusion_process = assertBoolean(key, value)
        break
      case 'show_diffusion_stride':
        body.show_diffusion_stride = assertInteger(key, value, { min: 1 })
        break
      case 'image':
        body.image = assertString(key, value)
        break
      case 'mask':
        body.mask = assertString(key, value)
        break
      case 'denoise_strength':
        body.denoise_strength = assertNumber(key, value, { min: 0, max: 1 })
        break
      case 'aspect_ratio':
        body.aspect_ratio = assertString(key, value)
        break
      default:
        throw new LocalDreamError('args', `未处理的 /generate 字段 "${key}"`)
    }
  }
  const prompt = body.prompt
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new LocalDreamError('args', 'prompt 必填且不能为空')
  }
  if (body.mask !== undefined && body.image === undefined) {
    throw new LocalDreamError('args', 'mask 必须与 image 同时提供（inpaint 需要底图）')
  }
  if (body.size !== undefined) {
    // `size` wins over width/height on the server; mirror that here so callers
    // that set both never get a silently different resolution.
    body.width = body.size
    body.height = body.size
  }
  return body
}

/** `<UTC yyyymmdd-HHMMSS>_<seed>.png`, the default output file name. */
export function defaultOutputPath(outputDir: string, seed: number, now: Date = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  return path.join(outputDir, `${stamp}_${seed}.png`)
}

/** Resolve a caller-supplied relative output path against the workspace. */
export function resolveOutputPath(outputPath: string, fallbackDir: string): string {
  if (path.isAbsolute(outputPath)) return outputPath
  const workspace = process.env.DSH_WORKSPACE?.trim() || process.cwd()
  if (outputPath.includes('/') || outputPath.includes('\\')) return path.resolve(workspace, outputPath)
  return path.join(fallbackDir, outputPath)
}

export interface GenerateStreamResult {
  progressEvents: SseJsonEvent[]
  complete: SseJsonEvent
  warnings: string[]
}

export interface GenerateStreamOptions {
  /** Fail when no chunk arrives for this long (stall detection). */
  inactivityTimeoutMs?: number
  signal?: AbortSignal
  onProgress?: (event: SseJsonEvent) => void
}

/**
 * Consume the `/generate` SSE body incrementally. An `error` event aborts the
 * call immediately with the server's own message, and the reader stops as soon
 * as the `complete` event arrives.
 */
export async function consumeGenerateStream(
  body: ReadableStream<Uint8Array>,
  options: GenerateStreamOptions = {},
): Promise<GenerateStreamResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  const warnings: string[] = []
  const progressEvents: SseJsonEvent[] = []
  let complete: SseJsonEvent | undefined

  const handle = (event: { data: string; event?: string }): boolean => {
    const decoded = decodeSseEvent(event, warnings)
    if (!decoded) return false
    const type = typeof decoded.type === 'string' ? decoded.type : ''
    if (type === 'error') {
      const message = typeof decoded.message === 'string' ? decoded.message : JSON.stringify(decoded)
      throw new LocalDreamError('protocol', `Local Dream 生成失败：${message}`, { connection: false })
    }
    if (type === 'complete') {
      complete = decoded
      return true
    }
    if (type === 'progress') {
      progressEvents.push(decoded)
      options.onProgress?.(decoded)
    }
    return false
  }

  try {
    for (;;) {
      if (options.signal?.aborted) throw new LocalDreamError('cancelled', '生成已取消（aborted）')
      const result = await readChunk(reader, options.inactivityTimeoutMs)
      if (result.done) break
      const chunk = decoder.decode(result.value, { stream: true })
      if (chunk === '') continue
      for (const event of parser.push(chunk)) {
        if (handle(event)) {
          return { progressEvents, complete: complete!, warnings }
        }
      }
    }
    for (const event of parser.flush()) {
      if (handle(event)) break
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  if (!complete) {
    throw new LocalDreamError('protocol', 'SSE 流在收到 complete 事件前结束（后端可能已崩溃或连接被中断）', {
      connection: true,
    })
  }
  return { progressEvents, complete, warnings }
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  inactivityTimeoutMs: number | undefined,
): Promise<StreamRead> {
  if (inactivityTimeoutMs === undefined || inactivityTimeoutMs <= 0) return reader.read()
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new LocalDreamError('timeout', `生成流 ${inactivityTimeoutMs}ms 内没有新数据，判定为连接中断`, {
              connection: true,
            }),
          )
        }, inactivityTimeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export interface GenerationDeps {
  /** Open the SSE response for a body already validated by `buildGenerateBody`. */
  openStream: (body: Record<string, JsonValue>, signal?: AbortSignal) => Promise<Response>
  writeFile: (file: string, data: Uint8Array) => Promise<void>
  mkdir: (directory: string) => Promise<void>
  now: () => Date
}

export interface GenerateOptions {
  body: Record<string, JsonValue>
  /** Explicit output file; relative paths resolve against the workspace. */
  outputPath?: string
  outputDir: string
  inactivityTimeoutMs: number
  signal?: AbortSignal
}

/**
 * Run one generation: stream the SSE body, verify the raw RGB payload and write
 * an encoded PNG to disk. Returns the JSON-safe summary the tool reports.
 */
export async function runGeneration(deps: GenerationDeps, options: GenerateOptions): Promise<Record<string, JsonValue>> {
  const response = await deps.openStream(options.body, options.signal)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new LocalDreamError('http', `POST /generate 返回 HTTP ${response.status}${text ? `：${text.slice(0, 300)}` : ''}`, {
      status: response.status,
    })
  }
  if (!response.body) {
    throw new LocalDreamError('protocol', 'POST /generate 没有返回响应体（期望 text/event-stream）')
  }
  const started = Date.now()
  const { progressEvents, complete, warnings } = await consumeGenerateStream(response.body, {
    inactivityTimeoutMs: options.inactivityTimeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const image = typeof complete.image === 'string' ? complete.image : undefined
  if (!image) throw new LocalDreamError('protocol', 'complete 事件缺少 image 字段')
  const width = Number(complete.width)
  const height = Number(complete.height)
  const channels = Number(complete.channels ?? 3)
  const pixels = reshapeRgb(image, width, height, channels)
  const png = encodePngRgb(width, height, pixels)
  const seed = Number.isInteger(Number(complete.seed)) ? Number(complete.seed) : 0
  const target = options.outputPath
    ? resolveOutputPath(options.outputPath, options.outputDir)
    : defaultOutputPath(options.outputDir, seed, deps.now())
  await deps.mkdir(path.dirname(target))
  await deps.writeFile(target, png)
  const generationTimeMs = Number(complete.generation_time_ms)
  const firstStepTimeMs = Number(complete.first_step_time_ms)
  const result: Record<string, JsonValue> = {
    path: target,
    bytes: png.length,
    seed,
    width,
    height,
    channels,
    generationTimeMs: Number.isFinite(generationTimeMs) ? generationTimeMs : null,
    firstStepTimeMs: Number.isFinite(firstStepTimeMs) ? firstStepTimeMs : null,
    progressEvents: progressEvents.length,
    elapsedMs: Date.now() - started,
    warnings: warnings.length > 0 ? warnings.join('; ') : null,
  }
  return result
}

/** Real filesystem deps for {@link runGeneration}. */
export function defaultGenerationDeps(openStream: GenerationDeps['openStream']): GenerationDeps {
  return {
    openStream,
    writeFile: async (file, data) => {
      await writeFile(file, data)
    },
    mkdir: async (directory) => {
      await mkdir(directory, { recursive: true })
    },
    now: () => new Date(),
  }
}
