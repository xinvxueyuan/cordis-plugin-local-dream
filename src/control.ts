import type { JsonValue } from './types.ts'
import { LocalDreamError, errorMessage } from './errors.ts'
import { fetchLocalDream } from './http.ts'

/**
 * Local Dream's "Device Link" host mode runs a second, tiny JSON HTTP/1.1
 * server (default port 8808) next to the generation backend. It has NO
 * authentication — matching the trust model of the app's "allow LAN access"
 * setting — and the generation backend (8081) only starts listening after a
 * successful `POST /select`. So a reachable control plane with 8081 closed is a
 * normal state, and this module drives that activation.
 */

/** Pseudo model id that starts the backend in standalone upscaler mode. */
export const UPSCALER_ID = '__upscaler__'

export interface ControlInfo {
  app: string
  protocol?: number
  version?: string
  device?: string
}

export interface ControlModelDefaults {
  prompt?: string
  negative_prompt?: string
  steps?: number
  cfg?: number
  scheduler?: string
}

export interface ControlModel {
  id: string
  name?: string
  description?: string
  run_on_cpu?: boolean
  is_sdxl?: boolean
  is_anima?: boolean
  dit_kind?: string
  is_custom?: boolean
  /** Native square resolution of the model. */
  generation_size?: number
  defaults?: ControlModelDefaults
  resolutions?: number[][]
}

export interface ControlCatalog {
  use_img2img: boolean
  models: ControlModel[]
  upscalers: Array<{ id: string; path?: string }>
}

export type ControlState = 'idle' | 'starting' | 'running' | 'error'

export interface ControlStatus {
  serving_model_id: string | null
  state: ControlState
  message: string | null
  error_model_id: string | null
  width: number | null
  height: number | null
}

export interface SelectOutcome {
  ok: boolean
  /** Server `error` text when the request was rejected. */
  error?: string
  /** HTTP status of the `/select` response. */
  status: number
}

export interface StopOutcome {
  ok: boolean
  /** True when the server answered `{"ok":true,"ignored":true}` (stale model_id). */
  ignored: boolean
  status: number
  error?: string
}

function asRecord(value: unknown): Record<string, JsonValue> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, JsonValue>
}

/**
 * Convert a parsed control-plane value into a lossless JSON value for a tool
 * result. Control structures are plain parsed JSON, so a JSON round-trip is
 * exact; `undefined`-valued optional fields simply disappear.
 */
export function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function stringOrNull(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null
}

function numberOrNull(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Validate a `GET /info` body. A non-Local-Dream body is rejected, not guessed. */
export function parseControlInfo(text: string): ControlInfo {
  const record = asRecord(parseJson(text))
  if (!record) throw new LocalDreamError('protocol', `控制端口返回的不是 JSON 对象：${text.slice(0, 120)}`)
  if (record.app !== 'localdream') {
    throw new LocalDreamError('protocol', `控制端口的 /info 不是 Local Dream（app=${JSON.stringify(record.app) ?? 'undefined'}，期望 "localdream"）`)
  }
  return {
    app: 'localdream',
    ...(typeof record.protocol === 'number' ? { protocol: record.protocol } : {}),
    ...(typeof record.version === 'string' ? { version: record.version } : {}),
    ...(typeof record.device === 'string' ? { device: record.device } : {}),
  }
}

export function parseControlStatus(text: string): ControlStatus {
  const record = asRecord(parseJson(text))
  if (!record) throw new LocalDreamError('protocol', `控制端口 /status 返回的不是 JSON 对象：${text.slice(0, 120)}`)
  const state = record.state
  if (state !== 'idle' && state !== 'starting' && state !== 'running' && state !== 'error') {
    throw new LocalDreamError('protocol', `控制端口 /status 的 state 非法：${JSON.stringify(state) ?? 'undefined'}`)
  }
  return {
    serving_model_id: stringOrNull(record.serving_model_id),
    state,
    message: stringOrNull(record.message),
    error_model_id: stringOrNull(record.error_model_id),
    width: numberOrNull(record.width),
    height: numberOrNull(record.height),
  }
}

export function parseControlCatalog(text: string): ControlCatalog {
  const record = asRecord(parseJson(text))
  if (!record) throw new LocalDreamError('protocol', `控制端口 /models 返回的不是 JSON 对象：${text.slice(0, 120)}`)
  const models: ControlModel[] = []
  const rawModels = record.models
  if (Array.isArray(rawModels)) {
    for (const item of rawModels) {
      const entry = asRecord(item)
      if (!entry || typeof entry.id !== 'string') continue
      const model: ControlModel = { id: entry.id }
      if (typeof entry.name === 'string') model.name = entry.name
      if (typeof entry.description === 'string') model.description = entry.description
      if (typeof entry.run_on_cpu === 'boolean') model.run_on_cpu = entry.run_on_cpu
      if (typeof entry.is_sdxl === 'boolean') model.is_sdxl = entry.is_sdxl
      if (typeof entry.is_anima === 'boolean') model.is_anima = entry.is_anima
      if (typeof entry.dit_kind === 'string') model.dit_kind = entry.dit_kind
      if (typeof entry.is_custom === 'boolean') model.is_custom = entry.is_custom
      if (typeof entry.generation_size === 'number') model.generation_size = entry.generation_size
      const defaults = asRecord(entry.defaults)
      if (defaults) model.defaults = defaults as ControlModelDefaults
      if (Array.isArray(entry.resolutions)) {
        model.resolutions = entry.resolutions.filter((pair): pair is number[] => Array.isArray(pair))
      }
      models.push(model)
    }
  }
  const upscalers: Array<{ id: string; path?: string }> = []
  if (Array.isArray(record.upscalers)) {
    for (const item of record.upscalers) {
      const entry = asRecord(item)
      if (!entry || typeof entry.id !== 'string') continue
      upscalers.push({ id: entry.id, ...(typeof entry.path === 'string' ? { path: entry.path } : {}) })
    }
  }
  return { use_img2img: record.use_img2img === true, models, upscalers }
}

/**
 * Build the `POST /select` body. Both dimensions default to 512 when omitted,
 * matching the server contract; a missing/empty `model_id` is rejected locally.
 */
export function buildSelectBody(input: { modelId: string; width?: number; height?: number }): Record<string, JsonValue> {
  const modelId = input.modelId?.trim()
  if (!modelId) throw new LocalDreamError('args', 'model_id 必填（可用 "models" 动作查看设备上已下载的模型）')
  const width = input.width !== undefined && input.width > 0 ? input.width : 512
  const height = input.height !== undefined && input.height > 0 ? input.height : 512
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new LocalDreamError('args', `width/height 必须是整数，收到 ${String(input.width)}/${String(input.height)}`)
  }
  return { model_id: modelId, width, height }
}

/** Map a `/select` response (200 / 400 / 404 / 500) to an outcome. */
export function mapSelectResponse(status: number, bodyText: string): SelectOutcome {
  const record = asRecord(parseJson(bodyText))
  if (status === 200 && record?.ok === true) return { ok: true, status }
  if (status === 200) {
    return { ok: false, status, error: '控制端口对 /select 返回 200 但没有 {"ok":true}' }
  }
  const error = record ? stringOrNull(record.error) : null
  return { ok: false, status, error: error ?? `HTTP ${status}` }
}

/** Map a `/stop` response, preserving the honest `ignored` flag. */
export function mapStopResponse(status: number, bodyText: string): StopOutcome {
  const record = asRecord(parseJson(bodyText))
  const ignored = record?.ignored === true
  if (record?.ok === true) return { ok: true, ignored, status }
  const error = record ? stringOrNull(record.error) : null
  return { ok: false, ignored: false, status, error: error ?? `HTTP ${status}` }
}

export interface ReadinessWant {
  /** Required model id, or null to accept whatever is already running. */
  modelId: string | null
  /** Required width, or null to skip the resolution check. */
  width: number | null
  height: number | null
}

export type Readiness = 'ready' | 'select' | 'poll' | 'error'

/**
 * The readiness decision table. The app's own controller requires a FULL
 * (model_id, width, height) match before declaring the backend ready, and a
 * process still serving an older resolution must never count as ready.
 */
export function readinessDecision(status: ControlStatus, want: ReadinessWant): Readiness {
  if (status.state === 'error') return 'error'
  if (status.state === 'starting') return 'poll'
  if (status.state !== 'running') return 'select'
  if (want.modelId !== null && status.serving_model_id !== want.modelId) return 'select'
  if (status.serving_model_id === null) return 'select'
  if (want.width !== null && status.width !== want.width) return 'select'
  if (want.height !== null && status.height !== want.height) return 'select'
  return 'ready'
}

/** Human-readable one-liner for status reports and timeout messages. */
export function describeStatus(status: ControlStatus): string {
  const resolution = status.width !== null && status.height !== null ? `${status.width}x${status.height}` : '?'
  return `state=${status.state} model=${status.serving_model_id ?? 'null'} ${resolution}${status.message ? ` message=${status.message}` : ''}`
}

/**
 * Resolve which model + resolution to ask for: the configured model wins, else
 * the catalog's first entry; the resolution comes from `selectWidth`/
 * `selectHeight`, else the model's `generation_size`, else 512.
 */
export function resolveModelChoice(
  input: { model: string; selectWidth: number; selectHeight: number },
  catalog: ControlCatalog | undefined,
): { modelId: string; width: number; height: number } {
  const configured = input.model.trim()
  const models = catalog?.models ?? []
  if (configured === '') {
    if (models.length === 0) {
      throw new LocalDreamError(
        'protocol',
        '设备报告没有已下载的模型（/models 为空），无法自动选择；请先在 App 中下载模型，或在 config.model 中给出 model_id',
      )
    }
    const first = models[0]!
    const size = first.generation_size && first.generation_size > 0 ? first.generation_size : 512
    return {
      modelId: first.id,
      width: input.selectWidth > 0 ? input.selectWidth : size,
      height: input.selectHeight > 0 ? input.selectHeight : size,
    }
  }
  const entry = models.find((model) => model.id === configured)
  const size = entry?.generation_size && entry.generation_size > 0 ? entry.generation_size : 512
  return {
    modelId: configured,
    width: input.selectWidth > 0 ? input.selectWidth : size,
    height: input.selectHeight > 0 ? input.selectHeight : size,
  }
}

export interface ControlResponse {
  status: number
  text: string
}

/** Transport seam so the control client can be unit-tested without a phone. */
export interface ControlTransport {
  request(options: {
    baseUrl: string
    endpoint: string
    method: string
    body?: unknown
    timeoutMs: number
    signal?: AbortSignal
  }): Promise<ControlResponse>
}

/** Real control transport: Node fetch against the control port. */
export const fetchControlTransport: ControlTransport = {
  async request(options) {
    const response = await fetchLocalDream({
      baseUrl: options.baseUrl,
      endpoint: options.endpoint,
      method: options.method,
      ...(options.body !== undefined ? { body: options.body } : {}),
      timeoutMs: options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    return { status: response.status, text: await response.text() }
  },
}

export interface ControlClientOptions {
  /** Path prefix under which a candidate was found (diagnostics only). */
  transport?: ControlTransport
}

/**
 * Typed client for the control plane. All failures become `LocalDreamError`s
 * that already carry enough context to report.
 */
export class ControlClient {
  readonly transport: ControlTransport

  constructor(options: ControlClientOptions = {}) {
    this.transport = options.transport ?? fetchControlTransport
  }

  async info(baseUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<ControlInfo> {
    const response = await this.#request({ baseUrl, endpoint: 'info', method: 'GET', timeoutMs, ...(signal ? { signal } : {}) })
    if (response.status !== 200) {
      throw new LocalDreamError('protocol', `${baseUrl}/info 返回 HTTP ${response.status}${response.text ? `：${response.text.slice(0, 120)}` : ''}`, {
        status: response.status,
        connection: response.status >= 500,
      })
    }
    return parseControlInfo(response.text)
  }

  async status(baseUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<ControlStatus> {
    const response = await this.#request({ baseUrl, endpoint: 'status', method: 'GET', timeoutMs, ...(signal ? { signal } : {}) })
    if (response.status !== 200) {
      throw new LocalDreamError('protocol', `${baseUrl}/status 返回 HTTP ${response.status}`, {
        status: response.status,
        connection: response.status >= 500,
      })
    }
    return parseControlStatus(response.text)
  }

  async catalog(baseUrl: string, timeoutMs: number, signal?: AbortSignal): Promise<ControlCatalog> {
    const response = await this.#request({ baseUrl, endpoint: 'models', method: 'GET', timeoutMs, ...(signal ? { signal } : {}) })
    if (response.status !== 200) {
      throw new LocalDreamError('protocol', `${baseUrl}/models 返回 HTTP ${response.status}`, { status: response.status })
    }
    return parseControlCatalog(response.text)
  }

  async select(baseUrl: string, body: Record<string, JsonValue>, timeoutMs: number, signal?: AbortSignal): Promise<SelectOutcome> {
    const response = await this.#request({ baseUrl, endpoint: 'select', method: 'POST', body, timeoutMs, ...(signal ? { signal } : {}) })
    return mapSelectResponse(response.status, response.text)
  }

  async stop(baseUrl: string, body: Record<string, JsonValue>, timeoutMs: number, signal?: AbortSignal): Promise<StopOutcome> {
    const response = await this.#request({ baseUrl, endpoint: 'stop', method: 'POST', body, timeoutMs, ...(signal ? { signal } : {}) })
    return mapStopResponse(response.status, response.text)
  }

  async #request(options: {
    baseUrl: string
    endpoint: string
    method: string
    body?: unknown
    timeoutMs: number
    signal?: AbortSignal
  }): Promise<ControlResponse> {
    try {
      return await this.transport.request(options)
    } catch (error) {
      if (error instanceof LocalDreamError) throw error
      throw new LocalDreamError('connection', `${options.baseUrl}/${options.endpoint} 请求失败：${errorMessage(error)}`, {
        connection: true,
        cause: error,
      })
    }
  }
}
