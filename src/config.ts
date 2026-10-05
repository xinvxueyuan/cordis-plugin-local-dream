import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { LocalDreamMode } from './types.ts'

export interface DiscoveryConfig {
  /** Sweep the local IPv4 subnets for the phone's backend. */
  enabled: boolean
  /** Parallel TCP connects during a sweep. */
  concurrency: number
  /** Per-connect timeout of a sweep probe. */
  connectTimeoutMs: number
  /** Hard cap on hosts swept per call (runaway protection). */
  maxHosts: number
  /** Explicit CIDR list; empty derives /24 subnets from the local NICs. */
  subnets: string[]
}

export interface LocalDreamConfig {
  /** 'auto': LAN first, then USB/adb. 'lan'/'usb' force one transport. */
  mode: LocalDreamMode
  /** LAN host/IP of the phone. Empty = discover. */
  host: string
  /** Phone-side generation API port (8081 in the app). */
  port: number
  /** Phone-side Device Link CONTROL port (8808); 0 disables the control plane. */
  controlPort: number
  /** USB forward local port; 0 = prefer 8081, else pick a free ephemeral port. */
  localPort: number
  /** Explicit adb binary. */
  adbPath: string
  /** Override the vendored platform-tools directory. */
  bundledAdbDir: string
  /** Target device serial (required when several devices are attached). */
  serial: string
  /** Drive `POST /select` on the control plane when no backend is running. */
  autoSelect: boolean
  /** Model id to activate through the control plane; empty = catalog default. */
  model: string
  /** Resolution passed to `/select`; 0 = derive from the model, else 512. */
  selectWidth: number
  /** Resolution passed to `/select`; 0 = derive from the model, else 512. */
  selectHeight: number
  /** No-connection wait budget in milliseconds (0 = fail fast). */
  waitTimeoutMs: number
  /** Wait-phase poll interval. */
  pollIntervalMs: number
  /** Mid-call reconnect retries. */
  retryCount: number
  /** Base reconnect backoff. */
  retryDelayMs: number
  /** Per-probe timeout. */
  probeTimeoutMs: number
  /** Per-request inactivity budget (per SSE chunk, not per whole generation). */
  requestTimeoutMs: number
  /** LAN discovery settings. */
  discovery: DiscoveryConfig
  /** PNG output directory; empty resolves to <DSH_HOME or ~/.dsh>/outputs/local-dream. */
  outputDir: string
}

// The nested object carries its own complete default so `discovery` is filled
// in even when the caller omits it entirely (schemastery only walks into an
// object it actually materializes).
const discoverySchema = z
  .object({
    enabled: z.boolean().default(true),
    concurrency: z.number().default(64),
    connectTimeoutMs: z.number().default(400),
    maxHosts: z.number().default(1024),
    subnets: z.array(z.string()).default([]),
  })
  .default({ enabled: true, concurrency: 64, connectTimeoutMs: 400, maxHosts: 1024, subnets: [] })

export const Config = z.object({
  mode: z.union([z.const('auto'), z.const('lan'), z.const('usb')]).default('auto'),
  host: z.string().default(''),
  port: z.number().default(8081),
  controlPort: z.number().default(8808),
  localPort: z.number().default(0),
  adbPath: z.string().default(''),
  bundledAdbDir: z.string().default(''),
  serial: z.string().default(''),
  autoSelect: z.boolean().default(true),
  model: z.string().default(''),
  selectWidth: z.number().default(0),
  selectHeight: z.number().default(0),
  waitTimeoutMs: z.number().default(120000),
  pollIntervalMs: z.number().default(2000),
  retryCount: z.number().default(3),
  retryDelayMs: z.number().default(2000),
  probeTimeoutMs: z.number().default(5000),
  requestTimeoutMs: z.number().default(300000),
  discovery: discoverySchema,
  outputDir: z.string().default(''),
})

const PREFIX = 'cordis-plugin-local-dream: '
const MODES: readonly string[] = ['auto', 'lan', 'usb']

/** Hand-check the constraints the schema DSL does not express. */
export function assertConfig(config: LocalDreamConfig): void {
  if (!MODES.includes(config.mode)) {
    throw new Error(`${PREFIX}未知 mode "${String(config.mode)}"，只支持 auto / lan / usb`)
  }
  for (const key of ['pollIntervalMs', 'retryDelayMs', 'probeTimeoutMs', 'requestTimeoutMs'] as const) {
    const value = config[key]
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${PREFIX}${key} 必须是正整数`)
    }
  }
  for (const key of ['waitTimeoutMs', 'retryCount'] as const) {
    const value = config[key]
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${PREFIX}${key} 必须是非负整数`)
    }
  }
  for (const key of ['port', 'controlPort', 'localPort'] as const) {
    const value = config[key]
    if (!Number.isInteger(value) || value < 0 || value > 65535) {
      throw new Error(`${PREFIX}${key} 必须在 0-65535 之间`)
    }
  }
  for (const key of ['selectWidth', 'selectHeight'] as const) {
    const value = config[key]
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${PREFIX}${key} 必须是非负整数（0 = 由模型 generation_size 推导）`)
    }
  }
  if (typeof config.autoSelect !== 'boolean') {
    throw new Error(`${PREFIX}autoSelect 必须是布尔值`)
  }
  const discovery = config.discovery
  if (!discovery || typeof discovery !== 'object') {
    throw new Error(`${PREFIX}discovery 配置缺失`)
  }
  if (typeof discovery.enabled !== 'boolean') {
    throw new Error(`${PREFIX}discovery.enabled 必须是布尔值`)
  }
  for (const key of ['concurrency', 'connectTimeoutMs', 'maxHosts'] as const) {
    const value = discovery[key]
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${PREFIX}discovery.${key} 必须是正整数`)
    }
  }
  if (!Array.isArray(discovery.subnets) || discovery.subnets.some((item) => typeof item !== 'string')) {
    throw new Error(`${PREFIX}discovery.subnets 必须是 CIDR 字符串数组`)
  }
}

/** DSH home directory: $DSH_HOME, else ~/.dsh. */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim()
  if (configured) return configured
  return join(homedir(), '.dsh')
}

/** Resolve the PNG output directory (config.outputDir, else <DSH_HOME>/outputs/local-dream). */
export function resolveOutputDir(config: Pick<LocalDreamConfig, 'outputDir'>, env: NodeJS.ProcessEnv = process.env): string {
  const configured = config.outputDir.trim()
  if (configured) return configured
  return join(dshHome(env), 'outputs', 'local-dream')
}
