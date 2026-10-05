import type { JsonValue, SseJsonEvent } from './types.ts'

/** One decoded SSE event. */
export interface SseEvent {
  /** Value of the last `event:` line, when present. */
  event?: string
  /** Joined `data:` lines. */
  data: string
  id?: string
}

export interface SseJsonResult {
  events: SseJsonEvent[]
  /** Malformed payloads that were skipped instead of crashing the parse. */
  warnings: string[]
  /** The stream carried the `[DONE]` sentinel. */
  done: boolean
}

/** Whether a response Content-Type describes a Server-Sent Events stream. */
export function isEventStream(contentType: string | null | undefined): boolean {
  return typeof contentType === 'string' && contentType.toLowerCase().includes('text/event-stream')
}

/**
 * Incremental SSE parser. The server may split lines across chunks and may use
 * either `\n` or `\r\n`, so line assembly happens here rather than in the
 * caller. `:` comment lines are ignored, `data:` lines accumulate, and the
 * `[DONE]` sentinel ends the stream without producing an event.
 *
 * Exported for unit tests.
 */
export class SseParser {
  #buffer = ''
  #data: string[] = []
  #event: string | undefined
  #id: string | undefined
  #done = false

  get done(): boolean {
    return this.#done
  }

  /** Feed one decoded chunk and return every event it completed. */
  push(chunk: string): SseEvent[] {
    this.#buffer += chunk
    const events: SseEvent[] = []
    for (;;) {
      const line = this.#takeLine()
      if (line === undefined) break
      const event = this.#consumeLine(line)
      if (event) events.push(event)
    }
    return events
  }

  /** Emit any trailing event left by a stream that ended without a blank line. */
  flush(): SseEvent[] {
    const events: SseEvent[] = []
    if (this.#buffer !== '') {
      const line = this.#buffer
      this.#buffer = ''
      const event = this.#consumeLine(line)
      if (event) events.push(event)
    }
    const trailing = this.#dispatch()
    if (trailing) events.push(trailing)
    return events
  }

  #takeLine(): string | undefined {
    const buffer = this.#buffer
    for (let index = 0; index < buffer.length; index += 1) {
      const char = buffer[index]!
      if (char === '\n') {
        const line = buffer.slice(0, index)
        this.#buffer = buffer.slice(index + 1)
        return line
      }
      if (char === '\r') {
        // A lone \r at the end may be the first half of a \r\n split across chunks.
        if (index + 1 === buffer.length) return undefined
        const line = buffer.slice(0, index)
        this.#buffer = buffer.slice(buffer[index + 1] === '\n' ? index + 2 : index + 1)
        return line
      }
    }
    return undefined
  }

  #consumeLine(line: string): SseEvent | undefined {
    if (line === '') return this.#dispatch()
    if (line.startsWith(':')) return undefined // comment / keep-alive
    const index = line.indexOf(':')
    const field = index === -1 ? line : line.slice(0, index)
    let value = index === -1 ? '' : line.slice(index + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    switch (field) {
      case 'data':
        if (value.trim() === '[DONE]') {
          this.#done = true
          const event = this.#dispatch()
          return event
        }
        this.#data.push(value)
        return undefined
      case 'event':
        this.#event = value.trim()
        return undefined
      case 'id':
        this.#id = value
        return undefined
      default:
        return undefined // retry, unknown fields, blank-ish lines
    }
  }

  #dispatch(): SseEvent | undefined {
    const data = this.#data.join('\n')
    const event = this.#event
    const id = this.#id
    this.#data = []
    this.#event = undefined
    this.#id = undefined
    if (data === '' && event === undefined) return undefined
    return { data, ...(event !== undefined ? { event } : {}), ...(id !== undefined ? { id } : {}) }
  }
}

/**
 * Decode one SSE event's payload into a JSON object. Malformed payloads are
 * skipped with a recorded warning (never a crash), an `event: error` line with
 * a non-JSON body becomes `{ type: 'error', message }`, and an `event:` name is
 * injected as `type` when the payload has none.
 */
export function decodeSseEvent(event: SseEvent, warnings: string[]): SseJsonEvent | undefined {
  const raw = event.data.trim()
  if (raw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    if (event.event === 'error') {
      return { type: 'error', message: event.data }
    }
    warnings.push(`跳过无法解析的 SSE data: ${truncate(event.data)}`)
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push(`跳过非对象的 SSE data: ${truncate(event.data)}`)
    return undefined
  }
  const value = parsed as SseJsonEvent
  if (typeof value.type !== 'string' && event.event !== undefined) {
    return { ...value, type: event.event }
  }
  return value
}

/** Parse a complete SSE body into its JSON events. */
export function parseSseJson(text: string): SseJsonResult {
  const parser = new SseParser()
  const warnings: string[] = []
  const events: SseJsonEvent[] = []
  const collect = (items: SseEvent[]) => {
    for (const item of items) {
      const decoded = decodeSseEvent(item, warnings)
      if (decoded) events.push(decoded)
    }
  }
  collect(parser.push(text))
  collect(parser.flush())
  return { events, warnings, done: parser.done }
}

/** Interpret a non-streaming JSON error body (`{ "message": ... }`). */
export function jsonErrorMessage(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as unknown
    if (parsed === null) return undefined
    if (typeof parsed === 'string') return parsed
    if (typeof parsed === 'object') {
      const record = parsed as Record<string, JsonValue | undefined>
      for (const key of ['message', 'error', 'detail']) {
        const value = record[key]
        if (typeof value === 'string' && value !== '') return value
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

function truncate(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
