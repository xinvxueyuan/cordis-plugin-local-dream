/**
 * Lossless JSON value.
 *
 * Declared locally on purpose: `@deepseek-ai/dsh-tools` re-exported this type at
 * the root in 0.1.0-rc.x but not in 0.2.0-rc.x, and the declared peer range
 * (`^0.1.0-rc.6 || ^0.2.0-rc.1`) allows both, so importing it from the package
 * root would break one of the two supported lines.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** One read from a web ReadableStream, typed without the DOM lib. */
export type StreamRead = { done: boolean; value?: Uint8Array }

/** Transport selection. `auto` tries LAN first and falls back to USB/adb. */
export type LocalDreamMode = 'auto' | 'lan' | 'usb'

/** A transport that actually carries the HTTP traffic. */
export type TransportKind = 'lan' | 'usb'

/** Where a candidate LAN host came from, in increasing discovery cost order. */
export type HostSource = 'configured' | 'cache' | 'usb-derived' | 'subnet-sweep'

/** Which of the phone's two local HTTP planes a host was recognised on. */
export type HostKind = 'control' | 'generation'

/** One host the plugin may probe for the Local Dream backend. */
export interface DiscoveredHost {
  host: string
  source: HostSource
  /** Set for sweep results, which know which port answered. */
  kind?: HostKind
}

/** Result of a cheap backend liveness + identity probe. */
export interface ProbeResult {
  /**
   * True only when the host is really a Local Dream backend: `GET /health`
   * answered, or `POST /tokenize` returned `max_length === 77` with an integer
   * `count`.
   */
  ok: boolean
  count?: number
  maxLength?: number
  /** Which probe matched: the `/health` liveness check or the tokenize fingerprint. */
  kind?: 'health' | 'tokenize'
  /** Failure detail, or the answering host's identity summary. */
  detail?: string
}

/** One entry of `adb devices -l`. */
export interface DeviceEntry {
  serial: string
  state: string
  /** `-l` properties, e.g. `{ model: 'Pixel_7', product: 'panther' }`. */
  properties: Record<string, string>
  raw: string
}

/** One entry of `adb forward --list`. */
export interface ForwardEntry {
  serial: string
  localPort: number
  remotePort: number
  raw: string
}

/** How adb was resolved (the first candidate that answered `adb version`). */
export type AdbSource = 'config' | 'sdk' | 'path' | 'vendor'

export interface ResolvedAdb {
  path: string
  source: AdbSource
  /** First line of `adb version`. */
  version: string
}

/** Query parameters — flat primitive values only. */
export interface LocalDreamQuery {
  [key: string]: string | number | boolean | null | undefined
}

/** One connection attempt recorded while waiting for a transport. */
export interface ConnectionAttempt {
  transport: TransportKind
  target: string
  ok: boolean
  source?: string
  reason?: string
}

/** A generation/upscale model that is actually downloaded on the phone. */
export interface ModelSummary {
  id: string
  name?: string
  generation_size?: number
  is_sdxl?: boolean
  dit_kind?: string
}

/** One SSE event, after JSON decoding. */
export type SseJsonEvent = Record<string, JsonValue>

/** A generate response summarized with image payloads replaced by byte counts. */
export interface ImageSummary {
  imageBytes: number
  width?: number
  height?: number
  channels?: number
}

export type LocalDreamToolResult = JsonValue
