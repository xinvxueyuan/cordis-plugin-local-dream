import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallKind } from '@deepseek-ai/dsh-tools'
import { fetchLocalDream, httpErrorFrom, interpretResponseBody } from './http.ts'
import { base64ByteLength } from './png.ts'
import { LocalDreamError } from './errors.ts'
import { isEventStream, type SseJsonResult } from './sse.ts'
import type { LocalDreamConfig } from './config.ts'
import type { ConnectionManager, ConnectionSnapshot, EnsureOptions } from './connection.ts'
import { baseUrlFor } from './connection.ts'
import type { JsonValue, LocalDreamQuery, SseJsonEvent } from './types.ts'

/** Keep only flat primitive query values; the backend takes scalars only. */
function normalizeQuery(query: Record<string, JsonValue> | undefined): LocalDreamQuery | undefined {
  if (query === undefined) return undefined
  const result: LocalDreamQuery = {}
  for (const [key, value] of Object.entries(query)) {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value
    } else {
      throw new LocalDreamError('args', `query 参数 "${key}" 必须是字符串、数字或布尔值（Local Dream 只接受扁平标量查询参数）`)
    }
  }
  return result
}

function methodKind(method: string): ToolCallKind {
  switch (method) {
    case 'GET':
    case 'HEAD':
      return 'read'
    case 'POST':
      return 'edit'
    default:
      return 'other'
  }
}

/**
 * Replace an inline base64 image with its byte count so a multi-megabyte blob
 * never enters the model context. `includeImage: true` keeps the payload.
 */
function summarizeEvent(event: SseJsonEvent, dimensions: { width?: number; height?: number; channels?: number }): SseJsonEvent {
  const image = event.image
  if (typeof image !== 'string') return event
  const { image: _drop, ...rest } = event
  const summary: Record<string, JsonValue> = { imageBytes: base64ByteLength(image) }
  if (dimensions.width !== undefined) summary.width = dimensions.width
  if (dimensions.height !== undefined) summary.height = dimensions.height
  if (dimensions.channels !== undefined) summary.channels = dimensions.channels
  return { ...rest, image: summary }
}

/** Shape the SSE parse into `{ events, complete }`, images summarized by default. */
export function summarizeGenerateResponse(result: SseJsonResult, includeImage: boolean): Record<string, JsonValue> {
  const complete = result.events.find((event) => event.type === 'complete')
  const progress = result.events.filter((event) => event !== complete)
  if (includeImage) {
    return {
      events: progress,
      complete: complete ?? null,
      done: result.done,
      warnings: result.warnings,
    }
  }
  const dimensions =
    complete && typeof complete.width === 'number'
      ? {
          width: complete.width,
          height: typeof complete.height === 'number' ? complete.height : undefined,
          channels: typeof complete.channels === 'number' ? complete.channels : undefined,
        }
      : {}
  return {
    events: progress.map((event) => summarizeEvent(event, dimensions)),
    complete: complete ? summarizeEvent(complete, {}) : null,
    done: result.done,
    warnings: result.warnings,
  }
}

/**
 * The per-call `port` override. It only makes sense on LAN, where the phone's
 * port is reachable directly; under USB the local port is a forward, so the
 * phone's own port cannot be addressed and the override is refused loudly.
 */
function resolveTargetBaseUrl(connection: ConnectionSnapshot, port: number | undefined): string {
  if (port === undefined || port <= 0) return connection.baseUrl!
  if (connection.transport !== 'lan' || !connection.host) {
    throw new LocalDreamError(
      'args',
      'port 覆盖只在 LAN 传输下可用：USB 传输时本地端口是 adb forward，无法直接访问手机上的其他端口。请改用 transport: "lan"',
    )
  }
  return baseUrlFor(connection.host, port)
}

/** The generic passthrough tool, deliberately shaped like `github_api`. */export function defineApiTool(config: LocalDreamConfig, manager: ConnectionManager) {
  return defineTool({
    name: 'local_dream_api',
    description:
      '规范化调用 Android 应用 Local Dream 内置的 HTTP 后端（默认 POST /generate 走 SSE，POST /tokenize 用于探活）。' +
      '插件会自动管理连接：优先走局域网直连（LAN），失败时回退到 USB（adb forward），两者都不可用时按 waitTimeoutMs 轮询等待。' +
      'endpoint 不带前导斜杠，例如 "generate" / "tokenize"。' +
      'text/event-stream 响应会被解析为 { events, complete }；默认把 base64 图片替换为 { imageBytes, width, height, channels } 以免污染上下文，includeImage: true 可内联原始 base64；raw: true 则原样返回响应文本（用于拿到未经处理的 SSE 流）。',
    parameters: {
      endpoint: {
        type: 'string',
        required: true,
        description: 'API 路径，不带前导 "/"，例如 generate 或 tokenize',
      },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'HEAD'],
        default: 'POST',
        description: 'HTTP 方法，默认 POST（Local Dream 的两个业务端点都是 POST）',
      },
      query: {
        type: 'object',
        additionalProperties: true,
        description: '查询参数对象（仅扁平标量），例如 { foo: "bar" }',
      },
      body: { type: 'json', description: 'JSON 请求体（例如 /generate 的完整参数对象）' },
      raw: {
        type: 'boolean',
        default: false,
        description: '以原始文本返回响应体（用于获取未加工的 SSE 流）',
      },
      includeImage: {
        type: 'boolean',
        default: false,
        description: 'true 时在结果中内联 base64 图片；默认只返回 { imageBytes, width, height, channels }',
      },
      transport: {
        type: 'string',
        enum: ['auto', 'lan', 'usb'],
        description: '单次调用覆盖传输方式',
      },
      host: { type: 'string', description: '单次调用覆盖局域网主机（IP 或主机名）' },
      port: {
        type: 'integer',
        description:
          '单次调用覆盖端口。默认走传输自身的端口（局域网 8081 / USB 转发）；要访问 Device Link 控制平面请显式传 port: 8808（仅 LAN 传输支持覆盖）',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
        return [{ type: 'text', text }]
      },
    },
    timeoutMs: config.requestTimeoutMs + config.waitTimeoutMs,
    isConcurrencySafe: (args) => args.method === 'GET' || args.method === 'HEAD',
    presentCall: (args) => {
      const method = args.method ?? 'POST'
      return {
        card: 'generic',
        title: `LOCAL DREAM ${method} ${args.endpoint}`,
        kind: methodKind(method),
        rawInput: args.query,
      }
    },
    async execute(args, exec) {
      const endpoint = args.endpoint.replace(/^\/+/, '')
      const method = (args.method ?? 'POST').toUpperCase()
      const override: EnsureOptions = { signal: exec.signal }
      if (args.transport === 'lan' || args.transport === 'usb') override.transport = args.transport
      if (args.host !== undefined && args.host !== '') override.host = args.host
      return manager.withRetry(async (connection) => {
        if (!connection.baseUrl) throw new LocalDreamError('connection', '连接已建立但 baseUrl 缺失（内部状态异常）')
        const targetBaseUrl = resolveTargetBaseUrl(connection, args.port)
        const response = await fetchLocalDream({
          baseUrl: targetBaseUrl,
          endpoint,
          method,
          query: normalizeQuery(args.query as Record<string, JsonValue> | undefined),
          body: args.body,
          timeoutMs: config.requestTimeoutMs,
          signal: exec.signal,
        })
        const text = await response.text()
        if (!response.ok) throw httpErrorFrom(response, text)
        if (args.raw) return text
        const contentType = response.headers.get('content-type')
        if (isEventStream(contentType)) {
          const parsed = interpretResponseBody(contentType, text)
          return summarizeGenerateResponse(parsed.value as SseJsonResult, args.includeImage ?? false)
        }
        return interpretResponseBody(contentType, text).value as JsonValue
      }, override)
    },
  })
}
