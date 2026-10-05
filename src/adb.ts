import { spawn } from 'node:child_process'
import { chmodSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LocalDreamError } from './errors.ts'
import type { AdbSource, DeviceEntry, ForwardEntry, ResolvedAdb } from './types.ts'

/** adb states that `adb devices -l` may report in the second column. */
const DEVICE_STATES = new Set([
  'device',
  'offline',
  'unauthorized',
  'bootloader',
  'recovery',
  'rescue',
  'sideload',
  'host',
  'connecting',
  'authorizing',
  'unknown',
])

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

/** Runs one binary with an argument array (never through a shell). */
export type CommandRunner = (bin: string, args: string[], options?: RunOptions) => Promise<CommandResult>

/**
 * Parse `adb devices -l` output. adb mixes its daemon-start banner into stdout
 * or stderr depending on version, so both streams are scanned and banner lines
 * are skipped. CRLF input is tolerated.
 *
 * Exported for unit tests.
 */
export function parseDeviceList(stdout: string, stderr = ''): DeviceEntry[] {
  const devices: DeviceEntry[] = []
  let inList = false
  for (const stream of [stdout, stderr]) {
    for (const rawLine of stream.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line === '') continue
      if (line.startsWith('*')) continue // "* daemon not running; starting now at tcp:5037"
      if (line.startsWith('List of devices')) {
        inList = true
        continue
      }
      if (line.startsWith('adb server') || line.toLowerCase().startsWith('error:')) continue
      const tokens = line.split(/\s+/)
      if (tokens.length < 2) continue
      const serial = tokens[0]!
      let state = tokens[1]!
      let rest = tokens.slice(2)
      if (state === 'no' && rest[0] === 'permissions') {
        // "0123456789ABCDEF no permissions (user in plugdev group; are your udev rules wrong?)"
        state = 'no permissions'
        rest = rest.slice(1)
      }
      if (!inList && !DEVICE_STATES.has(state) && state !== 'no permissions') continue
      const properties: Record<string, string> = {}
      for (const token of rest) {
        const index = token.indexOf(':')
        if (index <= 0) continue
        properties[token.slice(0, index)] = token.slice(index + 1)
      }
      devices.push({ serial, state, properties, raw: line })
    }
  }
  return devices
}

/** Human-readable device list for error messages. */
function describeDevices(devices: DeviceEntry[]): string {
  if (devices.length === 0) return '（未检测到任何设备）'
  return devices
    .map((device) => {
      const props = Object.entries(device.properties)
        .filter(([key]) => key === 'model' || key === 'product' || key === 'device' || key === 'transport_id')
        .map(([key, value]) => `${key}=${value}`)
        .join(' ')
      return `  - serial=${device.serial} state=${device.state}${props ? ` ${props}` : ''}`
    })
    .join('\n')
}

/**
 * Select the one ready device. Zero ready devices is a retryable condition;
 * several ready devices (or an explicitly requested serial that is absent) is
 * a configuration error the user must fix, so it is marked fatal.
 */
export function selectDevice(devices: DeviceEntry[], serial?: string): DeviceEntry {
  const wanted = serial?.trim()
  if (wanted) {
    const match = devices.find((device) => device.serial === wanted)
    if (!match) {
      throw new LocalDreamError(
        'device',
        `指定的设备 serial="${wanted}" 不在 adb 设备列表中：\n${describeDevices(devices)}\n请检查 config.serial`,
        { fatal: true },
      )
    }
    if (match.state !== 'device') {
      throw new LocalDreamError(
        'device',
        `设备 serial="${wanted}" 当前状态是 "${match.state}"，不是 "device"（未授权/离线请先在手机上确认 USB 调试授权）`,
        { fatal: true },
      )
    }
    return match
  }
  const ready = devices.filter((device) => device.state === 'device')
  if (ready.length === 0) {
    throw new LocalDreamError('device', `没有处于 "device" 状态的设备：\n${describeDevices(devices)}`, {
      connection: true,
    })
  }
  if (ready.length > 1) {
    throw new LocalDreamError(
      'device',
      `检测到多台可用设备，插件不会替你猜测，请在 config.serial 中指定要使用的那一台：\n${describeDevices(ready)}`,
      { fatal: true },
    )
  }
  return ready[0]!
}

/** Parse `adb forward --list` (`<serial> tcp:<local> tcp:<remote>` per line). */
export function parseForwardList(text: string): ForwardEntry[] {
  const entries: ForwardEntry[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    const tokens = line.split(/\s+/)
    if (tokens.length < 3) continue
    const serial = tokens[0]!
    const local = parseTcpPort(tokens[1]!)
    const remote = parseTcpPort(tokens[2]!)
    if (local === undefined || remote === undefined) continue
    entries.push({ serial, localPort: local, remotePort: remote, raw: line })
  }
  return entries
}

function parseTcpPort(token: string): number | undefined {
  const match = /^(?:tcp:)?(\d{1,5})$/.exec(token)
  if (!match) return undefined
  const port = Number(match[1])
  if (!Number.isInteger(port) || port < 0 || port > 65535) return undefined
  return port
}

/** `adb devices -l` argument array. */
export function buildDevicesArgs(): string[] {
  return ['devices', '-l']
}

/** `adb forward` argument array for one device. */
export function buildForwardArgs(serial: string, localPort: number, remotePort: number): string[] {
  return ['-s', serial, 'forward', `tcp:${localPort}`, `tcp:${remotePort}`]
}

/** `adb forward --remove` argument array for one device. */
export function buildRemoveForwardArgs(serial: string, localPort: number): string[] {
  return ['-s', serial, 'forward', '--remove', `tcp:${localPort}`]
}

/** Extract the Wi-Fi IPv4 address from `ip -f inet addr show wlan0` output. */
export function parseWifiIp(text: string): string | undefined {
  const match = /\binet\s+(\d{1,3}(?:\.\d{1,3}){3})/.exec(text)
  return match ? match[1] : undefined
}

export interface ForwardPlanInput {
  /** `adb forward --list` output, already parsed. */
  existing: ForwardEntry[]
  serial: string
  remotePort: number
  /** Configured local port; 0 = prefer `preferLocalPort` and fall back to a free port. */
  localPort: number
  /** Port preferred when `localPort` is 0 (default 8081; the control plane uses 8808). */
  preferLocalPort?: number
  /** Whether a local TCP port can still be bound on this machine. */
  isPortFree: (port: number) => boolean | Promise<boolean>
  /** Pick a free ephemeral local port. */
  pickFreePort: () => number | Promise<number>
}

export interface ForwardPlan {
  localPort: number
  remotePort: number
  /** An existing forward already maps this device+remote to `localPort`. */
  reuse: boolean
  /** A new forward must be added with `args`. */
  create: boolean
  /** The forward this plugin would create, when `create` is true. */
  entry?: ForwardEntry
  /** `adb forward` arguments when `create` is true. */
  args?: string[]
  /** Why the preferred port was abandoned, for the status report. */
  note?: string
}

/**
 * Decide which local port to use and whether an `adb forward` is needed.
 *
 * A port may only be reused when an existing forward already maps OUR device's
 * remote port to it; a foreign forward (another device, or another remote port)
 * occupying the preferred 8081 makes us fall back to a free ephemeral port.
 *
 * Exported for unit tests.
 */
export async function planForward(input: ForwardPlanInput): Promise<ForwardPlan> {
  const preferred = input.localPort === 0 ? input.preferLocalPort ?? 8081 : input.localPort
  const owned = input.existing.find(
    (entry) => entry.serial === input.serial && entry.remotePort === input.remotePort && entry.localPort === preferred,
  )
  if (owned) {
    return { localPort: preferred, remotePort: input.remotePort, reuse: true, create: false }
  }
  let note: string | undefined
  let localPort = preferred
  const foreign = input.existing.find((entry) => entry.localPort === preferred)
  if (foreign) {
    note = `本地端口 ${preferred} 已被 adb forward 占用（serial=${foreign.serial} tcp:${foreign.remotePort}），改用空闲端口`
    localPort = await input.pickFreePort()
  } else if (input.localPort === 0 && !(await input.isPortFree(preferred))) {
    note = `本地端口 ${preferred} 已被其他进程占用，改用空闲端口`
    localPort = await input.pickFreePort()
  } else if (input.localPort !== 0 && !(await input.isPortFree(preferred))) {
    throw new LocalDreamError(
      'adb',
      `配置的 localPort=${preferred} 无法绑定（端口已被占用）。请改用 localPort: 0 让插件自动挑选空闲端口`,
      { fatal: true },
    )
  }
  const reusedElsewhere = input.existing.find(
    (entry) => entry.serial === input.serial && entry.remotePort === input.remotePort && entry.localPort === localPort,
  )
  if (reusedElsewhere) {
    return {
      localPort,
      remotePort: input.remotePort,
      reuse: true,
      create: false,
      ...(note !== undefined ? { note } : {}),
    }
  }
  return {
    localPort,
    remotePort: input.remotePort,
    reuse: false,
    create: true,
    entry: {
      serial: input.serial,
      localPort,
      remotePort: input.remotePort,
      raw: `${input.serial} tcp:${localPort} tcp:${input.remotePort}`,
    },
    args: buildForwardArgs(input.serial, localPort, input.remotePort),
    ...(note !== undefined ? { note } : {}),
  }
}

/** Directory name of the vendored platform-tools bundle for this platform. */
export function vendorPlatformDir(platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform === 'win32') return arch === 'x64' || arch === 'arm64' ? 'win32-x64' : undefined
  if (platform === 'linux') return arch === 'x64' ? 'linux-x64' : undefined
  if (platform === 'darwin') return 'darwin' // one bundle serves arm64 and x64
  return undefined
}

export function adbBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'adb.exe' : 'adb'
}

/**
 * Path join for a TARGET platform, not the host one. `path.join` always uses
 * the host separator, which is wrong when a test (or a caller passing an
 * explicit `platform`) reasons about a different OS.
 */
export function joinForPlatform(platform: NodeJS.Platform, ...parts: string[]): string {
  const separator = platform === 'win32' ? '\\' : '/'
  const cleaned = parts
    .filter((part) => part !== '')
    .map((part, index) => (index === 0 ? part.replace(/[\\/]+$/, '') : part.replace(/^[\\/]+|[\\/]+$/g, '')))
  return cleaned.join(separator)
}

/**
 * True only for a regular file. `existsSync` also matches directories, and a
 * directory named `adb` on PATH would otherwise shadow the real binary on a
 * later PATH entry (seen in the wild: `C:\Program Files (x86)\pcsuite\adb\`).
 */
function isFileSync(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

export interface FindOnPathOptions {
  pathValue?: string
  platform?: NodeJS.Platform
  exists?: (file: string) => boolean
}

/**
 * Self-implemented PATH lookup (no shell, no `where`/`which` subprocess). On
 * Windows the `.exe` suffix is tried first. Exported for unit tests.
 */
export function findOnPath(command: string, options: FindOnPathOptions = {}): string | undefined {
  const pathValue = options.pathValue ?? process.env.PATH ?? ''
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? isFileSync
  const suffixes = platform === 'win32' ? ['.exe', ''] : ['']
  const delimiter = platform === 'win32' ? ';' : ':'
  for (const directory of pathValue.split(delimiter)) {
    const trimmed = directory.trim().replace(/^"|"$/g, '')
    if (trimmed === '') continue
    for (const suffix of suffixes) {
      const candidate = joinForPlatform(platform, trimmed, `${command}${suffix}`)
      if (exists(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Resolve the package root from `import.meta.url`. Works both when the loader
 * loads `src/index.ts` over a `file://` URL and when the package is installed
 * under `node_modules` (where this module lives in `lib/`).
 */
export function resolvePackageRoot(importMetaUrl: string): string {
  const here = path.dirname(fileURLToPath(importMetaUrl))
  return path.dirname(here)
}

export interface ResolveAdbOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  arch?: string
  packageRoot: string
  exists?: (file: string) => boolean
  run?: CommandRunner
  chmod?: (file: string, mode: number) => void
  signal?: AbortSignal
}

export interface ResolveAdbInput {
  adbPath: string
  bundledAdbDir: string
}

interface Candidate {
  path: string
  source: AdbSource
  /** POSIX vendor binaries need the executable bit before the first run. */
  chmod?: boolean
}

/** Build the ordered adb candidate list. Exported for unit tests. */
export function adbCandidates(
  input: Pick<ResolveAdbInput, 'adbPath' | 'bundledAdbDir'>,
  options: Pick<ResolveAdbOptions, 'env' | 'platform' | 'arch' | 'packageRoot' | 'exists'>,
): Candidate[] {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const exists = options.exists ?? isFileSync
  const binary = adbBinaryName(platform)
  const candidates: Candidate[] = []

  if (input.adbPath.trim() !== '') {
    candidates.push({ path: input.adbPath.trim(), source: 'config' })
    return candidates // an explicit path is authoritative: never silently fall back
  }
  for (const root of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    const trimmed = root?.trim()
    if (!trimmed) continue
    const candidate = joinForPlatform(platform, trimmed, 'platform-tools', binary)
    if (!candidates.some((item) => item.path === candidate)) {
      candidates.push({ path: candidate, source: 'sdk' })
    }
  }
  const onPath = findOnPath('adb', { pathValue: env.PATH, platform, exists })
  if (onPath) candidates.push({ path: onPath, source: 'path' })

  if (input.bundledAdbDir.trim() !== '') {
    candidates.push({ path: joinForPlatform(platform, input.bundledAdbDir.trim(), binary), source: 'vendor', chmod: true })
  } else {
    const dir = vendorPlatformDir(platform, arch)
    if (dir) {
      candidates.push({
        path: joinForPlatform(platform, options.packageRoot, 'vendor', 'platform-tools', dir, binary),
        source: 'vendor',
        chmod: true,
      })
    }
  }
  return candidates
}

/**
 * Resolve a working adb binary. Every candidate is validated by running
 * `adb version` (5s timeout) before it is accepted, so a stale PATH entry or a
 * half-installed SDK cannot win. `adb kill-server` is never run.
 */
export async function resolveAdb(input: ResolveAdbInput, options: ResolveAdbOptions): Promise<ResolvedAdb> {
  const exists = options.exists ?? isFileSync
  const run = options.run ?? runCommand
  const chmod = options.chmod ?? ((file: string, mode: number) => chmodSync(file, mode))
  const platform = options.platform ?? process.platform
  const candidates = adbCandidates(input, options)
  const failures: string[] = []

  if (input.adbPath.trim() !== '' && !exists(input.adbPath.trim())) {
    throw new LocalDreamError('adb', `config.adbPath 指向的文件不存在：${input.adbPath.trim()}`, { fatal: true })
  }

  for (const candidate of candidates) {
    if (!exists(candidate.path)) {
      failures.push(`${candidate.source}: ${candidate.path}（不存在或不是普通文件）`)
      continue
    }
    if (candidate.chmod && platform !== 'win32') {
      try {
        chmod(candidate.path, 0o755)
      } catch (error) {
        failures.push(`${candidate.source}: ${candidate.path}（chmod 0o755 失败：${String(error)}）`)
        continue
      }
    }
    try {
      const result = await run(candidate.path, ['version'], { timeoutMs: 5000, ...(options.signal ? { signal: options.signal } : {}) })
      if (result.code !== 0) {
        failures.push(`${candidate.source}: ${candidate.path}（adb version 退出码 ${result.code}）`)
        continue
      }
      const version = result.stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '') ?? 'adb'
      return { path: candidate.path, source: candidate.source, version }
    } catch (error) {
      failures.push(`${candidate.source}: ${candidate.path}（adb version 执行失败：${error instanceof Error ? error.message : String(error)}）`)
    }
  }

  throw new LocalDreamError(
    'adb',
    [
      '找不到可用的 adb（已依次尝试：config.adbPath → ANDROID_HOME/ANDROID_SDK_ROOT/platform-tools → PATH → 内置 vendor/platform-tools）：',
      ...failures.map((line) => `  - ${line}`),
      '请安装 Android Platform Tools，或在插件配置中指定 adbPath；USB 回退需要 adb。',
    ].join('\n'),
    { fatal: true },
  )
}

/** Default command runner: spawn with an argument array, never a shell. */
export function runCommand(bin: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      windowsHide: true,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer =
      options.timeoutMs !== undefined && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            child.kill()
          }, options.timeoutMs)
        : undefined
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer)
      if (options.signal?.aborted) {
        reject(new Error('aborted'))
      } else if (error.code === 'ENOENT') {
        reject(new LocalDreamError('adb', `找不到命令 "${bin}"`))
      } else {
        reject(error)
      }
    })
    child.on('close', (code, closeSignal) => {
      if (timer) clearTimeout(timer)
      if (options.signal?.aborted) {
        reject(new Error('aborted'))
        return
      }
      if (timedOut) {
        reject(new LocalDreamError('timeout', `${bin} ${args.join(' ')} 超时（${options.timeoutMs}ms）`))
        return
      }
      resolve({ code: closeSignal ? 1 : code ?? -1, stdout, stderr })
    })
  })
}
