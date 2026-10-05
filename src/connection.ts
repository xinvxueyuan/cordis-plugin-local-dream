import { networkInterfaces } from 'node:os'
import {
  buildDevicesArgs,
  buildForwardArgs,
  buildRemoveForwardArgs,
  parseDeviceList,
  parseForwardList,
  parseWifiIp,
  planForward,
  resolveAdb,
  resolvePackageRoot,
  runCommand,
  selectDevice,
  type CommandRunner,
} from './adb.ts'
import { canBindPort, pickFreePort, planSweep, sweepPorts, type HostPorts } from './lan.ts'
import { fetchLocalDream } from './http.ts'
import { LocalDreamError, errorMessage, isConnectionError } from './errors.ts'
import {
  buildSelectBody,
  ControlClient,
  describeStatus,
  readinessDecision,
  resolveModelChoice,
  type ControlCatalog,
  type ControlInfo,
  type ControlStatus,
  type ReadinessWant,
  type SelectOutcome,
  type StopOutcome,
} from './control.ts'
import type { LocalDreamConfig } from './config.ts'
import type {
  ConnectionAttempt,
  DeviceEntry,
  DiscoveredHost,
  ForwardEntry,
  JsonValue,
  LocalDreamMode,
  ProbeResult,
  ResolvedAdb,
  TransportKind,
} from './types.ts'

export type ConnectionState = 'idle' | 'connecting' | 'ready' | 'stale' | 'failed'

export interface ConnectionSnapshot {
  state: ConnectionState
  transport: TransportKind | null
  host: string | null
  serial: string | null
  /** Base URL of the generation backend (8081 side). */
  baseUrl: string | null
  /** Base URL of the Device Link control plane, when it was used. */
  controlBaseUrl: string | null
  /** Model id the backend is serving, when known. */
  model: string | null
  /** Forwards THIS plugin created (never foreign ones). */
  createdForwards: ForwardEntry[]
  cachedHost: string | null
  lastError: string | null
  adb: ResolvedAdb | null
}

/** adb surface the connection manager needs, injectable for unit tests. */
export interface AdbRuntime {
  resolve(signal?: AbortSignal): Promise<ResolvedAdb>
  listDevices(adbPath: string, signal?: AbortSignal): Promise<DeviceEntry[]>
  listForwards(adbPath: string, signal?: AbortSignal): Promise<ForwardEntry[]>
  addForward(adbPath: string, serial: string, localPort: number, remotePort: number, signal?: AbortSignal): Promise<void>
  removeForward(adbPath: string, serial: string, localPort: number, signal?: AbortSignal): Promise<void>
  wifiIp(adbPath: string, serial: string, signal?: AbortSignal): Promise<string | undefined>
}

/** LAN discovery surface, injectable for unit tests. */
export interface LanRuntime {
  /** Hosts whose generation and/or control port is open, control-first. */
  sweep(signal?: AbortSignal): Promise<HostPorts[]>
}

export interface ConnectionDeps {
  config: LocalDreamConfig
  adb: AdbRuntime
  lan: LanRuntime
  /** Device Link control plane client (port 8808). */
  control: ControlClient
  /** Generation-plane liveness probe (8081: /health, then /tokenize). */
  probe(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<ProbeResult>
  isPortFree(port: number): Promise<boolean>
  pickFreePort(): Promise<number>
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export interface EnsureOptions {
  /** Per-call transport override; forces a reconnect. */
  transport?: TransportKind
  /** Per-call LAN host override; forces a reconnect. */
  host?: string
  /** Per-call device serial override; forces a reconnect. */
  serial?: string
  /** Per-call model id override; forces a reconnect and a `/select` when needed. */
  model?: string
  signal?: AbortSignal
}

export const DEFAULT_GENERATION_PORT = 8081
export const DEFAULT_CONTROL_PORT = 8808

export function baseUrlFor(host: string, port: number): string {
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${bracketed}:${port}`
}

/** Exponential backoff with jitter, capped. Exported for unit tests. */
export function backoffDelay(baseMs: number, attempt: number, random: () => number = Math.random): number {
  const exponential = baseMs * 2 ** Math.max(0, attempt)
  const capped = Math.min(exponential, 30000)
  const jitter = Math.floor(random() * Math.min(baseMs, 250))
  return capped + jitter
}

/** `setTimeout` that rejects as soon as the abort signal fires. */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(new LocalDreamError('cancelled', '等待连接已取消（aborted）'))
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new LocalDreamError('cancelled', '操作已取消（aborted）')
}

/**
 * The `/tokenize` fingerprint probe: the only cheap, side-effect-free endpoint
 * that identifies a Local Dream generation backend (`max_length === 77`).
 */
export async function probeTokenize(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<ProbeResult> {
  try {
    const response = await fetchLocalDream({
      baseUrl: baseUrlFor(host, port),
      endpoint: 'tokenize',
      method: 'POST',
      body: { prompt: 'cordis-plugin-local-dream probe' },
      timeoutMs,
      ...(signal ? { signal } : {}),
    })
    const text = await response.text()
    if (!response.ok) {
      return { ok: false, detail: `HTTP ${response.status}${text ? `: ${text.slice(0, 120)}` : ''}` }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, detail: `响应不是 JSON：${text.slice(0, 120)}` }
    }
    if (parsed === null || typeof parsed !== 'object') {
      return { ok: false, detail: `响应不是对象：${text.slice(0, 120)}` }
    }
    const record = parsed as { count?: unknown; max_length?: unknown }
    if (record.max_length !== 77) {
      return { ok: false, detail: `max_length=${String(record.max_length)}（期望 77，可能不是 Local Dream 后端）` }
    }
    if (typeof record.count !== 'number' || !Number.isInteger(record.count)) {
      return { ok: false, detail: `count=${String(record.count)} 不是整数` }
    }
    return { ok: true, kind: 'tokenize', count: record.count, maxLength: 77, detail: `max_length=77 count=${record.count}` }
  } catch (error) {
    return { ok: false, detail: errorMessage(error) }
  }
}

/**
 * Generation-plane probe. `GET /health` is the cheap liveness check (the native
 * backend serves it whenever it listens with `--listen_all`); the `/tokenize`
 * fingerprint is kept as the secondary identity check.
 */
export async function probeGeneration(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<ProbeResult> {
  let healthDetail: string
  try {
    const response = await fetchLocalDream({
      baseUrl: baseUrlFor(host, port),
      endpoint: 'health',
      method: 'GET',
      timeoutMs,
      ...(signal ? { signal } : {}),
    })
    const text = await response.text().catch(() => '')
    if (response.ok) {
      return { ok: true, kind: 'health', detail: `GET /health → HTTP 200${text ? ` ${text.slice(0, 80)}` : ''}` }
    }
    healthDetail = `GET /health → HTTP ${response.status}`
  } catch (error) {
    healthDetail = `GET /health → ${errorMessage(error)}`
  }
  const fingerprint = await probeTokenize(host, port, timeoutMs, signal)
  if (fingerprint.ok) return fingerprint
  return { ok: false, detail: `${healthDetail}; POST /tokenize → ${fingerprint.detail ?? '失败'}` }
}

interface TransportCandidate {
  transport: TransportKind
  host: string
  serial: string | null
  baseUrl: string
  controlBaseUrl: string | null
  model: string | null
}

interface ActivateRequest {
  transport: TransportKind
  generationHost: string
  generationPort: number
  controlHost: string
  controlPort: number
  serial: string | null
  model?: string
  attempts: ConnectionAttempt[]
  signal?: AbortSignal
}

/**
 * One connection manager per plugin instance.
 *
 * `ensure()` is serialized through a single promise chain: DSH may run up to 50
 * tool calls concurrently and they must share one forward, not race to create
 * one each. On LAN the flow is control-plane aware — a reachable Device Link
 * control port (8808) with the generation port (8081) closed is a NORMAL state,
 * so the manager drives `POST /select` itself. Mid-call connection loss marks
 * the connection stale, re-runs `ensure()` and retries with exponential backoff.
 */
export class ConnectionManager {
  readonly deps: ConnectionDeps

  #state: ConnectionState = 'idle'
  #transport: TransportKind | null = null
  #host: string | null = null
  #serial: string | null = null
  #baseUrl: string | null = null
  #controlBaseUrl: string | null = null
  #model: string | null = null
  #createdForwards: ForwardEntry[] = []
  #cachedHost: string | null = null
  #lastError: string | null = null
  #adb: ResolvedAdb | null = null
  #chain: Promise<void> = Promise.resolve()

  constructor(deps: ConnectionDeps) {
    this.deps = deps
  }

  get config(): LocalDreamConfig {
    return this.deps.config
  }

  snapshot(): ConnectionSnapshot {
    return {
      state: this.#state,
      transport: this.#transport,
      host: this.#host,
      serial: this.#serial,
      baseUrl: this.#baseUrl,
      controlBaseUrl: this.#controlBaseUrl,
      model: this.#model,
      createdForwards: [...this.#createdForwards],
      cachedHost: this.#cachedHost,
      lastError: this.#lastError,
      adb: this.#adb,
    }
  }

  /** Mark the current transport stale so the next `ensure()` reconnects. */
  markStale(reason: string): void {
    if (this.#state === 'ready') this.#state = 'stale'
    this.#lastError = reason
  }

  /** Drop any established transport (per-call overrides and disconnect). */
  #invalidate(reason: string): void {
    if (this.#state === 'ready' || this.#state === 'stale') this.#state = 'idle'
    this.#lastError = reason
    this.#baseUrl = null
    this.#controlBaseUrl = null
    this.#transport = null
    this.#host = null
    this.#serial = null
    this.#model = null
  }

  /** Serialized connect: concurrent callers share one attempt. */
  ensure(options: EnsureOptions = {}): Promise<ConnectionSnapshot> {
    const override =
      options.transport !== undefined ||
      (options.host !== undefined && options.host !== '') ||
      (options.serial !== undefined && options.serial !== '') ||
      (options.model !== undefined && options.model !== '')
    if (override) this.#invalidate('调用方指定了 transport/host/serial/model 覆盖，重建连接')
    const run = () => this.#ensureInner(options)
    const queued = this.#chain.then(run, run)
    this.#chain = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }

  async #ensureInner(options: EnsureOptions): Promise<ConnectionSnapshot> {
    if (this.#state === 'ready' && this.#baseUrl) return this.snapshot()
    this.#state = 'connecting'
    const attempts: ConnectionAttempt[] = []
    const deadline = this.deps.now() + this.deps.config.waitTimeoutMs
    for (;;) {
      throwIfAborted(options.signal)
      const lan = await this.#attemptLan(options, attempts)
      if (lan) return this.#adopt(lan)
      const usb = await this.#attemptUsb(options, attempts)
      if (usb) return this.#adopt(usb)
      const remaining = deadline - this.deps.now()
      if (this.deps.config.waitTimeoutMs === 0 || remaining <= 0) break
      await this.deps.sleep(Math.min(this.deps.config.pollIntervalMs, remaining), options.signal)
    }
    this.#state = 'failed'
    const detail =
      attempts.length > 0
        ? attempts.map((item) => `  - [${item.transport}] ${item.target}${item.source ? ` (来源 ${item.source})` : ''}：${item.reason ?? '失败'}`).join('\n')
        : '  - 没有任何可用的候选目标（LAN 未配置 host 且 discovery 关闭，或 USB 不可用）'
    const message = `等待 ${this.deps.config.waitTimeoutMs}ms 后仍无法连接 Local Dream 后端。尝试记录：\n${detail}`
    this.#lastError = message
    throw new LocalDreamError('connection', message, { attempts })
  }

  async #lanCandidates(hostOverride?: string, signal?: AbortSignal): Promise<DiscoveredHost[]> {
    const config = this.deps.config
    const candidates: DiscoveredHost[] = []
    const push = (host: string | undefined, source: DiscoveredHost['source'], kind?: DiscoveredHost['kind']) => {
      const trimmed = host?.trim()
      if (!trimmed) return
      if (candidates.some((item) => item.host === trimmed)) return
      candidates.push({ host: trimmed, source, ...(kind !== undefined ? { kind } : {}) })
    }
    push(hostOverride, 'configured')
    push(config.host, 'configured')
    push(this.#cachedHost ?? undefined, 'cache')

    // (a) derive the phone's Wi-Fi address through adb; any failure is skipped.
    try {
      const adb = await this.#resolveAdb(signal)
      const devices = await this.deps.adb.listDevices(adb.path, signal)
      const ready = devices.filter((device) => device.state === 'device')
      const wanted = config.serial.trim()
      const target = wanted ? ready.find((device) => device.serial === wanted) : ready.length === 1 ? ready[0] : undefined
      if (target) {
        const ip = await this.deps.adb.wifiIp(adb.path, target.serial, signal)
        push(ip, 'usb-derived')
      }
    } catch {
      // adb missing / no device / shell error: silently skip this source
    }

    // (b) concurrent TCP sweep of both planes on the local subnets.
    if (config.discovery.enabled) {
      try {
        const found = await this.deps.lan.sweep(signal)
        const controlHosts = found.filter((item) => config.controlPort > 0 && item.ports.includes(config.controlPort))
        const generationHosts = found.filter((item) => !controlHosts.includes(item))
        for (const item of controlHosts) push(item.host, 'subnet-sweep', 'control')
        for (const item of generationHosts) push(item.host, 'subnet-sweep', 'generation')
      } catch {
        // a failed sweep must not break the explicit-host path
      }
    }
    return candidates
  }

  async #attemptLan(options: EnsureOptions, attempts: ConnectionAttempt[]): Promise<TransportCandidate | undefined> {
    const config = this.deps.config
    if (config.mode === 'usb' || options.transport === 'usb') return undefined
    const candidates = await this.#lanCandidates(options.host, options.signal)
    for (const candidate of candidates) {
      throwIfAborted(options.signal)
      const activated = await this.#activate({
        transport: 'lan',
        generationHost: candidate.host,
        generationPort: config.port,
        controlHost: candidate.host,
        controlPort: config.controlPort,
        serial: null,
        ...(options.model !== undefined ? { model: options.model } : {}),
        attempts,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      if (activated) {
        this.#cachedHost = candidate.host
        return activated
      }
    }
    return undefined
  }

  async #attemptUsb(options: EnsureOptions, attempts: ConnectionAttempt[]): Promise<TransportCandidate | undefined> {
    const config = this.deps.config
    if (config.mode === 'lan' || options.transport === 'lan') return undefined
    let adb: ResolvedAdb
    try {
      adb = await this.#resolveAdb(options.signal)
    } catch (error) {
      if (error instanceof LocalDreamError && error.fatal) throw error
      attempts.push({ transport: 'usb', target: 'adb', ok: false, reason: errorMessage(error) })
      return undefined
    }
    let device: DeviceEntry
    try {
      const devices = await this.deps.adb.listDevices(adb.path, options.signal)
      device = selectDevice(devices, options.serial ?? config.serial.trim() ?? '')
    } catch (error) {
      if (error instanceof LocalDreamError && error.fatal) throw error
      attempts.push({ transport: 'usb', target: 'adb devices', ok: false, reason: errorMessage(error) })
      return undefined
    }
    try {
      const existing = await this.deps.adb.listForwards(adb.path, options.signal)
      const generation = await planForward({
        existing,
        serial: device.serial,
        remotePort: config.port,
        localPort: config.localPort,
        isPortFree: (port) => this.deps.isPortFree(port),
        pickFreePort: () => this.deps.pickFreePort(),
      })
      const known = [...existing]
      if (generation.create && generation.entry) {
        await this.deps.adb.addForward(adb.path, device.serial, generation.localPort, generation.remotePort, options.signal)
        this.#createdForwards.push(generation.entry)
        known.push(generation.entry)
      }
      let controlLocalPort = 0
      if (config.controlPort > 0 && config.controlPort !== config.port) {
        const control = await planForward({
          existing: known,
          serial: device.serial,
          remotePort: config.controlPort,
          localPort: 0,
          preferLocalPort: config.controlPort,
          isPortFree: (port) => this.deps.isPortFree(port),
          pickFreePort: () => this.deps.pickFreePort(),
        })
        if (control.create && control.entry) {
          await this.deps.adb.addForward(adb.path, device.serial, control.localPort, control.remotePort, options.signal)
          this.#createdForwards.push(control.entry)
        }
        controlLocalPort = control.localPort
      }
      const activated = await this.#activate({
        transport: 'usb',
        generationHost: '127.0.0.1',
        generationPort: generation.localPort,
        controlHost: '127.0.0.1',
        controlPort: controlLocalPort,
        serial: device.serial,
        ...(options.model !== undefined ? { model: options.model } : {}),
        attempts,
        ...(options.signal ? { signal: options.signal } : {}),
      })
      if (!activated) return undefined
      return activated
    } catch (error) {
      if (error instanceof LocalDreamError && error.fatal) throw error
      attempts.push({
        transport: 'usb',
        target: `${device.serial} tcp:${config.port}`,
        ok: false,
        reason: errorMessage(error),
      })
      return undefined
    }
  }

  /**
   * Make the backend actually serve on the generation port.
   *
   * A Device Link control plane that answers `/info` with `app == "localdream"`
   * is the strongest signal, and a closed 8081 next to it is normal: the
   * generation backend only starts listening after a successful `POST /select`.
   */
  async #activate(request: ActivateRequest): Promise<TransportCandidate | undefined> {
    const config = this.deps.config
    const controlBaseUrl = request.controlPort > 0 ? baseUrlFor(request.controlHost, request.controlPort) : undefined
    let info: ControlInfo | undefined
    let infoError: string | undefined
    if (controlBaseUrl) {
      try {
        info = await this.deps.control.info(controlBaseUrl, config.probeTimeoutMs, request.signal)
      } catch (error) {
        infoError = errorMessage(error)
      }
    }

    if (!info || !controlBaseUrl) {
      // No control plane: plain "allow LAN access" mode, or a USB forward only.
      const health = await this.deps.probe(request.generationHost, request.generationPort, config.probeTimeoutMs, request.signal)
      request.attempts.push({
        transport: request.transport,
        target: `${request.generationHost}:${request.generationPort}`,
        ok: health.ok,
        source: 'generation',
        reason: health.ok
          ? `无控制平面（${infoError ?? 'controlPort=0'}）；${health.detail ?? '生成端口可用'}`
          : `控制平面不可用（${infoError ?? 'controlPort=0'}）；${health.detail ?? '生成端口不可用'}`,
      })
      if (!health.ok) return undefined
      return {
        transport: request.transport,
        host: request.generationHost,
        serial: request.serial,
        baseUrl: baseUrlFor(request.generationHost, request.generationPort),
        controlBaseUrl: null,
        model: null,
      }
    }

    const attempts = request.attempts
    attempts.push({
      transport: request.transport,
      target: `${request.controlHost}:${request.controlPort}`,
      ok: true,
      source: `control-plane${info.device ? ` device=${info.device}` : ''}`,
      reason: `GET /info → app=localdream${info.version ? ` version=${info.version}` : ''}${info.device ? ` device=${info.device}` : ''}`,
    })

    let status = await this.deps.control.status(controlBaseUrl, config.probeTimeoutMs, request.signal)
    const need = this.#want(request.model)
    const decision = readinessDecision(status, need)
    if (decision === 'error') throw errorState(status)
    if (decision === 'select' && !config.autoSelect && !(request.model ?? '').trim()) {
      attempts.push({
        transport: request.transport,
        target: controlBaseUrl,
        ok: false,
        source: 'control-plane',
        reason: `后端未运行（${describeStatus(status)}）且 autoSelect=false，请先在 App 中手动选择模型`,
      })
      return undefined
    }
    status = await this.#driveToReady(controlBaseUrl, need, status, request.model, request.signal)

    const health = await this.deps.probe(request.generationHost, request.generationPort, config.probeTimeoutMs, request.signal)
    attempts.push({
      transport: request.transport,
      target: `${request.generationHost}:${request.generationPort}`,
      ok: health.ok,
      source: 'generation',
      reason: `${describeStatus(status)}；${health.detail ?? (health.ok ? '生成端口可用' : '生成端口不可用')}`,
    })
    if (!health.ok) return undefined
    return {
      transport: request.transport,
      host: request.generationHost,
      serial: request.serial,
      baseUrl: baseUrlFor(request.generationHost, request.generationPort),
      controlBaseUrl,
      model: status.serving_model_id,
    }
  }

  /** What we need the backend to be serving, from config + per-call override. */
  #want(modelOverride?: string): ReadinessWant {
    const config = this.deps.config
    const configured = (modelOverride ?? '').trim() || config.model.trim()
    return {
      modelId: configured === '' ? null : configured,
      width: config.selectWidth > 0 ? config.selectWidth : null,
      height: config.selectHeight > 0 ? config.selectHeight : null,
    }
  }

  /**
   * Drive the control plane until the backend is `running` with a FULL
   * (model_id, width, height) match — never accepting a process that still
   * serves an older resolution. `state: "error"` is surfaced immediately.
   */
  async #driveToReady(
    controlBaseUrl: string,
    need: ReadinessWant,
    initial: ControlStatus,
    modelOverride: string | undefined,
    signal?: AbortSignal,
  ): Promise<ControlStatus> {
    const config = this.deps.config
    // waitTimeoutMs is the no-transport budget; a reachable control plane still
    // deserves a bounded activation window when that budget is 0.
    const budget = config.waitTimeoutMs > 0 ? config.waitTimeoutMs : config.probeTimeoutMs
    const deadline = this.deps.now() + budget
    let status = initial
    let want = need
    let selected = false
    for (;;) {
      const decision = readinessDecision(status, want)
      if (decision === 'ready') return status
      if (decision === 'error') throw errorState(status)
      if (decision === 'select' && !selected) {
        const choice = await this.#resolveChoice(controlBaseUrl, modelOverride, signal)
        const outcome = await this.deps.control.select(controlBaseUrl, buildSelectBody(choice), config.probeTimeoutMs, signal)
        if (!outcome.ok) {
          throw new LocalDreamError('protocol', `POST /select 被拒绝（HTTP ${outcome.status}）：${outcome.error ?? '未知错误'}`, {
            status: outcome.status,
          })
        }
        want = { modelId: choice.modelId, width: choice.width, height: choice.height }
        selected = true
      }
      const remaining = deadline - this.deps.now()
      if (remaining <= 0) {
        throw new LocalDreamError(
          'timeout',
          `等待 Local Dream 后端进入 running 超时（预算 ${budget}ms）。最后一次状态：${describeStatus(status)}`,
        )
      }
      await this.deps.sleep(Math.min(config.pollIntervalMs, remaining), signal)
      status = await this.deps.control.status(controlBaseUrl, config.probeTimeoutMs, signal)
    }
  }

  async #resolveChoice(controlBaseUrl: string, modelOverride: string | undefined, signal?: AbortSignal) {
    const config = this.deps.config
    const configured = (modelOverride ?? '').trim() || config.model.trim()
    let catalog: ControlCatalog | undefined
    try {
      catalog = await this.deps.control.catalog(controlBaseUrl, config.probeTimeoutMs, signal)
    } catch (error) {
      if (configured === '') {
        throw new LocalDreamError(
          'protocol',
          `无法读取控制端口的 /models 目录（${errorMessage(error)}），且 config.model 为空，无法确定要选择的模型`,
        )
      }
    }
    return resolveModelChoice(
      { model: configured, selectWidth: config.selectWidth, selectHeight: config.selectHeight },
      catalog,
    )
  }

  #adopt(candidate: TransportCandidate): ConnectionSnapshot {
    this.#state = 'ready'
    this.#transport = candidate.transport
    this.#host = candidate.host
    this.#serial = candidate.serial
    this.#baseUrl = candidate.baseUrl
    this.#controlBaseUrl = candidate.controlBaseUrl
    this.#model = candidate.model
    this.#lastError = null
    if (candidate.transport === 'lan') this.#cachedHost = candidate.host
    return this.snapshot()
  }

  async #resolveAdb(signal?: AbortSignal): Promise<ResolvedAdb> {
    if (this.#adb) return this.#adb
    const adb = await this.deps.adb.resolve(signal)
    this.#adb = adb
    return adb
  }

  /**
   * Ensure a connection, run `fn`, and retry connection-level failures up to
   * `retryCount` times with exponential backoff (each retry reconnects first).
   */
  async withRetry<T>(fn: (connection: ConnectionSnapshot) => Promise<T>, options: EnsureOptions = {}): Promise<T> {
    let attempt = 0
    for (;;) {
      const connection = await this.ensure(options)
      try {
        return await fn(connection)
      } catch (error) {
        if (options.signal?.aborted) throw error
        if (!isConnectionError(error) || attempt >= this.deps.config.retryCount) throw error
        const message = errorMessage(error)
        this.markStale(`连接中断：${message}`)
        await this.deps.sleep(backoffDelay(this.deps.config.retryDelayMs, attempt), options.signal)
        attempt += 1
      }
    }
  }

  /** Resolve the control-plane base URL without forcing a model selection. */
  async controlBaseUrl(signal?: AbortSignal): Promise<string> {
    const config = this.deps.config
    if (config.controlPort <= 0) {
      throw new LocalDreamError('config', 'config.controlPort = 0，Device Link 控制平面已被禁用')
    }
    const snapshot = this.snapshot()
    if (snapshot.controlBaseUrl) return snapshot.controlBaseUrl
    const hosts: string[] = []
    for (const host of [config.host, snapshot.cachedHost ?? '']) {
      const trimmed = host.trim()
      if (trimmed !== '' && !hosts.includes(trimmed)) hosts.push(trimmed)
    }
    for (const host of hosts) {
      const base = baseUrlFor(host, config.controlPort)
      try {
        await this.deps.control.info(base, config.probeTimeoutMs, signal)
        return base
      } catch {
        // try the next known host
      }
    }
    const connection = await this.ensure({ ...(signal ? { signal } : {}) })
    if (!connection.controlBaseUrl) {
      throw new LocalDreamError(
        'protocol',
        '当前连接不是通过 Device Link 控制平面建立的（控制端口不可达），无法访问 8808；请确认 App 已进入“设备互联/主机模式”',
      )
    }
    return connection.controlBaseUrl
  }

  /** `GET /models`: only models actually downloaded on the phone. */
  async models(signal?: AbortSignal): Promise<{ baseUrl: string; catalog: ControlCatalog }> {
    const baseUrl = await this.controlBaseUrl(signal)
    const catalog = await this.deps.control.catalog(baseUrl, this.deps.config.probeTimeoutMs, signal)
    return { baseUrl, catalog }
  }

  /** `POST /select` followed by polling until the backend is running. */
  async selectModel(
    input: { modelId: string; width?: number; height?: number },
    signal?: AbortSignal,
  ): Promise<{ baseUrl: string; status: ControlStatus; select: SelectOutcome }> {
    const config = this.deps.config
    const baseUrl = await this.controlBaseUrl(signal)
    const body = buildSelectBody(input)
    const outcome = await this.deps.control.select(baseUrl, body, config.probeTimeoutMs, signal)
    if (!outcome.ok) {
      throw new LocalDreamError('protocol', `POST /select 被拒绝（HTTP ${outcome.status}）：${outcome.error ?? '未知错误'}`, {
        status: outcome.status,
      })
    }
    const need: ReadinessWant = {
      modelId: String(body.model_id),
      width: typeof body.width === 'number' ? body.width : null,
      height: typeof body.height === 'number' ? body.height : null,
    }
    const initial = await this.deps.control.status(baseUrl, config.probeTimeoutMs, signal)
    const status = await this.#driveToReady(baseUrl, need, initial, String(body.model_id), signal)
    this.markStale('模型切换后需要重新探测生成端口')
    return { baseUrl, status, select: outcome }
  }

  /** `POST /stop`, preserving the server's honest `ignored` flag. */
  async stopModel(modelId: string | undefined, signal?: AbortSignal): Promise<{ baseUrl: string; outcome: StopOutcome }> {
    const baseUrl = await this.controlBaseUrl(signal)
    const body: Record<string, JsonValue> = modelId && modelId.trim() !== '' ? { model_id: modelId.trim() } : {}
    const outcome = await this.deps.control.stop(baseUrl, body, this.deps.config.probeTimeoutMs, signal)
    if (!outcome.ok) {
      throw new LocalDreamError('protocol', `POST /stop 失败（HTTP ${outcome.status}）：${outcome.error ?? '未知错误'}`, {
        status: outcome.status,
      })
    }
    this.markStale('后端已请求停止')
    return { baseUrl, outcome }
  }

  /**
   * Candidate hosts with their source and probe result (the `discover` action).
   * An 8808 that answers `/info` with `app === "localdream"` is the strongest
   * signal and is scored ahead of an 8081 `/health`-only host.
   */
  async discover(options: { host?: string; signal?: AbortSignal } = {}): Promise<Array<Record<string, JsonValue>>> {
    const config = this.deps.config
    const candidates = await this.#lanCandidates(options.host, options.signal)
    const results: Array<Record<string, JsonValue>> = []
    for (const candidate of candidates) {
      let controlError: string | undefined
      if (config.controlPort > 0) {
        const base = baseUrlFor(candidate.host, config.controlPort)
        try {
          const info = await this.deps.control.info(base, config.probeTimeoutMs, options.signal)
          results.push({
            host: candidate.host,
            source: candidate.source,
            port: config.controlPort,
            plane: 'control',
            reachable: true,
            device: info.device ?? null,
            version: info.version ?? null,
            detail: `GET /info → app=localdream${info.version ? ` version=${info.version}` : ''}${info.device ? ` device=${info.device}` : ''}`,
          })
          continue
        } catch (error) {
          controlError = errorMessage(error)
        }
      }
      const health = await this.deps.probe(candidate.host, config.port, config.probeTimeoutMs, options.signal)
      results.push({
        host: candidate.host,
        source: candidate.source,
        port: config.port,
        plane: health.ok ? 'generation' : 'none',
        reachable: health.ok,
        detail: health.detail ?? null,
        controlError: controlError ?? null,
      })
    }
    const rank = (item: Record<string, JsonValue>) => (item.plane === 'control' ? 0 : item.plane === 'generation' ? 1 : 2)
    return results.sort((left, right) => rank(left) - rank(right))
  }

  /** Parsed `adb devices -l` (the `devices` action). */
  async devices(signal?: AbortSignal): Promise<DeviceEntry[]> {
    const adb = await this.#resolveAdb(signal)
    return this.deps.adb.listDevices(adb.path, signal)
  }

  /**
   * Remove ONLY the forwards this plugin created and clear all connection
   * state. The adb server and foreign forwards are never touched.
   */
  async disconnect(signal?: AbortSignal): Promise<{ removed: string[]; failed: string[] }> {
    const removed: string[] = []
    const failed: string[] = []
    const adb = this.#adb
    if (adb) {
      for (const entry of this.#createdForwards) {
        try {
          await this.deps.adb.removeForward(adb.path, entry.serial, entry.localPort, signal)
          removed.push(`tcp:${entry.localPort} (${entry.serial})`)
        } catch (error) {
          failed.push(`tcp:${entry.localPort} (${entry.serial}): ${errorMessage(error)}`)
        }
      }
    }
    this.#createdForwards = []
    this.#cachedHost = null
    this.#state = 'idle'
    this.#transport = null
    this.#host = null
    this.#serial = null
    this.#baseUrl = null
    this.#controlBaseUrl = null
    this.#model = null
    this.#lastError = null
    return { removed, failed }
  }
}

function errorState(status: ControlStatus): LocalDreamError {
  return new LocalDreamError(
    'protocol',
    `Local Dream 后端进入 error 状态：${status.message ?? '（服务端未提供 message）'}` +
      `${status.error_model_id ? ` error_model_id=${status.error_model_id}` : ''}（${describeStatus(status)}）`,
    { fatal: false },
  )
}

function commandSignal(signal?: AbortSignal): { signal?: AbortSignal } {
  return signal ? { signal } : {}
}

function requireOk(result: { code: number; stdout: string; stderr: string }, what: string): void {
  if (result.code === 0) return
  const detail = result.stderr.trim() || result.stdout.trim() || `退出码 ${result.code}`
  throw new LocalDreamError('adb', `${what} 失败：${detail}`, { connection: true })
}

/** Real adb/LAN/HTTP wiring used by the plugin. */
export function createConnectionDeps(config: LocalDreamConfig, run: CommandRunner = runCommand): ConnectionDeps {
  const packageRoot = resolvePackageRoot(import.meta.url)
  const adbRuntime: AdbRuntime = {
    resolve: (signal) =>
      resolveAdb(
        { adbPath: config.adbPath, bundledAdbDir: config.bundledAdbDir },
        { packageRoot, run, ...commandSignal(signal) },
      ),
    listDevices: async (adbPath, signal) => {
      const result = await run(adbPath, buildDevicesArgs(), { timeoutMs: 15000, ...commandSignal(signal) })
      requireOk(result, 'adb devices -l')
      return parseDeviceList(result.stdout, result.stderr)
    },
    listForwards: async (adbPath, signal) => {
      const result = await run(adbPath, ['forward', '--list'], { timeoutMs: 15000, ...commandSignal(signal) })
      requireOk(result, 'adb forward --list')
      return parseForwardList(result.stdout)
    },
    addForward: async (adbPath, serial, localPort, remotePort, signal) => {
      const result = await run(adbPath, buildForwardArgs(serial, localPort, remotePort), {
        timeoutMs: 15000,
        ...commandSignal(signal),
      })
      requireOk(result, `adb forward tcp:${localPort} tcp:${remotePort}`)
    },
    removeForward: async (adbPath, serial, localPort, signal) => {
      const result = await run(adbPath, buildRemoveForwardArgs(serial, localPort), {
        timeoutMs: 15000,
        ...commandSignal(signal),
      })
      requireOk(result, `adb forward --remove tcp:${localPort}`)
    },
    wifiIp: async (adbPath, serial, signal) => {
      try {
        const result = await run(adbPath, ['-s', serial, 'shell', 'ip', '-f', 'inet', 'addr', 'show', 'wlan0'], {
          timeoutMs: 8000,
          ...commandSignal(signal),
        })
        if (result.code !== 0) return undefined
        return parseWifiIp(result.stdout)
      } catch {
        return undefined // getprop/ip variants differ; a miss is never fatal
      }
    },
  }
  const lanRuntime: LanRuntime = {
    sweep: async (signal) => {
      const discovery = config.discovery
      if (!discovery.enabled) return []
      const { hosts } = planSweep({
        nics: networkInterfaces(),
        subnets: discovery.subnets,
        maxHosts: discovery.maxHosts,
      })
      const ports = config.controlPort > 0 && config.controlPort !== config.port ? [config.controlPort, config.port] : [config.port]
      return sweepPorts(hosts, ports, {
        concurrency: discovery.concurrency,
        connectTimeoutMs: discovery.connectTimeoutMs,
        ...commandSignal(signal),
      })
    },
  }
  return {
    config,
    adb: adbRuntime,
    lan: lanRuntime,
    control: new ControlClient(),
    probe: (host, port, timeoutMs, signal) => probeGeneration(host, port, timeoutMs, signal),
    isPortFree: (port) => canBindPort(port),
    pickFreePort: () => pickFreePort(),
    now: () => Date.now(),
    sleep: sleepAbortable,
  }
}

/** Modes that may use each transport, for the status report. */
export function modeAllows(mode: LocalDreamMode, transport: TransportKind): boolean {
  if (mode === 'auto') return true
  return mode === transport
}
