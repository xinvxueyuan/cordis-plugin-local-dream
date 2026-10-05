import { LocalDreamError } from './errors.ts'
import { isEventStream, jsonErrorMessage, parseSseJson } from './sse.ts'
import type { LocalDreamQuery, StreamRead } from './types.ts'

export interface LocalDreamRequest {
  /** e.g. `http://192.168.1.42:8081` or `http://127.0.0.1:8081`. */
  baseUrl: string
  /** Path without a leading slash, e.g. `tokenize` or `generate`. */
  endpoint: string
  method?: string
  query?: LocalDreamQuery
  body?: unknown
  /** Cooperative timeout budget; combined with `signal`. */
  timeoutMs?: number
  signal?: AbortSignal
  headers?: Record<string, string>
}

export interface ResponseInterpretation {
  kind: 'sse' | 'json' | 'text'
  /** Parsed JSON value for `json`, parsed SSE events for `sse`, raw text for `text`. */
  value: unknown
}

/** `fetch` plan for one Local Dream request. Exported for unit tests. */
export function buildLocalDreamRequest(request: LocalDreamRequest): { url: string; init: RequestInit } {
  const endpoint = request.endpoint.replace(/^\/+/, '')
  const base = request.baseUrl.endsWith('/') ? request.baseUrl : `${request.baseUrl}/`
  const url = new URL(endpoint, base)
  if (request.query) {
    for (const [key, value] of Object.entries(request.query)) {
      if (value === undefined || value === null) continue
      url.searchParams.set(key, String(value))
    }
  }
  const headers: Record<string, string> = {
    Accept: 'application/json, text/event-stream',
    'User-Agent': 'cordis-plugin-local-dream',
    ...request.headers,
  }
  const method = (request.method ?? 'POST').toUpperCase()
  const init: RequestInit = { method, headers }
  if (request.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body)
  }
  const signals: AbortSignal[] = []
  if (request.signal) signals.push(request.signal)
  if (request.timeoutMs !== undefined && request.timeoutMs > 0) signals.push(AbortSignal.timeout(request.timeoutMs))
  if (signals.length === 1) init.signal = signals[0]!
  else if (signals.length > 1) init.signal = AbortSignal.any(signals)
  return { url: url.toString(), init }
}

/** Issue one request, translating transport failures into structured errors. */
export async function fetchLocalDream(request: LocalDreamRequest): Promise<Response> {
  const { url, init } = buildLocalDreamRequest(request)
  try {
    return await fetch(url, init)
  } catch (error) {
    if (request.signal?.aborted) {
      throw new LocalDreamError('cancelled', '请求已取消（aborted）', { cause: error })
    }
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    throw new LocalDreamError(
      timedOut ? 'timeout' : 'connection',
      timedOut
        ? `${url} 请求超时（${request.timeoutMs}ms）`
        : `连接 ${url} 失败：${error instanceof Error ? error.message : String(error)}`,
      { connection: true, cause: error },
    )
  }
}

/** Decode a non-streaming response body: JSON when it parses, else raw text. */
export function interpretResponseBody(contentType: string | null, text: string): ResponseInterpretation {
  if (isEventStream(contentType)) {
    return { kind: 'sse', value: parseSseJson(text) }
  }
  const trimmed = text.trim()
  if (trimmed === '') return { kind: 'json', value: null }
  try {
    return { kind: 'json', value: JSON.parse(trimmed) }
  } catch {
    return { kind: 'text', value: text }
  }
}

/** Structured error for a non-2xx response, carrying the phone's own message. */
export function httpErrorFrom(response: Response, bodyText: string): LocalDreamError {
  const detail = jsonErrorMessage(bodyText)
  const message = detail ?? (`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`.trim() || bodyText.slice(0, 200))
  return new LocalDreamError('http', message, { status: response.status, connection: false })
}

export interface ReadStreamOptions {
  /** Abort the read when no chunk arrived for this long (stall detection). */
  inactivityTimeoutMs?: number
  signal?: AbortSignal
  /** Called for every decoded chunk, before it is appended to the result. */
  onChunk?: (chunk: string) => void
}

/**
 * Drain a response body as text, one chunk at a time, so a stall is detected by
 * an inactivity budget rather than only by a total timeout.
 */
export async function readStreamText(response: Response, options: ReadStreamOptions = {}): Promise<string> {
  const body = response.body
  if (!body) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  try {
    for (;;) {
      if (options.signal?.aborted) throw new LocalDreamError('cancelled', '请求已取消（aborted）')
      const result = await readWithInactivityTimeout(reader, options.inactivityTimeoutMs)
      if (result.done) break
      const chunk = decoder.decode(result.value, { stream: true })
      if (chunk !== '') {
        text += chunk
        options.onChunk?.(chunk)
      }
    }
    text += decoder.decode()
    return text
  } finally {
    await reader.cancel().catch(() => {})
  }
}

async function readWithInactivityTimeout(
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
            new LocalDreamError(
              'timeout',
              `后端 ${inactivityTimeoutMs}ms 内没有推送新数据，判定为连接中断（inactivity timeout）`,
              { connection: true },
            ),
          )
        }, inactivityTimeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
