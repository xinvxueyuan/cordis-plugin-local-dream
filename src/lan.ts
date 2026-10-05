import { createConnection, createServer } from 'node:net'
import type { AddressInfo } from 'node:net'

/** One NIC address, mirroring `os.networkInterfaces()` entries. */
export interface NicAddress {
  address: string
  family: string | number
  internal: boolean
}

export type NicMap = Record<string, NicAddress[] | undefined>

export function isIPv4(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4) return false
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

export function ipv4ToInt(address: string): number {
  return address.split('.').reduce((acc, part) => acc * 256 + Number(part), 0) >>> 0
}

export function intToIpv4(value: number): string {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.')
}

function isUsableNicAddress(entry: NicAddress): boolean {
  if (entry.internal) return false
  const family = typeof entry.family === 'string' ? entry.family : ''
  if (family !== '' && family !== 'IPv4') return false
  if (!isIPv4(entry.address)) return false
  if (entry.address.startsWith('127.')) return false // loopback
  if (entry.address === '0.0.0.0') return false
  return true
}

/**
 * Derive one /24 subnet per local non-loopback IPv4 address (`192.168.1.37` →
 * `192.168.1.0/24`). Exported for unit tests.
 */
export function deriveSubnets(nics: NicMap, prefixLength = 24): string[] {
  const subnets: string[] = []
  for (const addresses of Object.values(nics)) {
    for (const entry of addresses ?? []) {
      if (!isUsableNicAddress(entry)) continue
      const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0
      const network = (ipv4ToInt(entry.address) & mask) >>> 0
      const cidr = `${intToIpv4(network)}/${prefixLength}`
      if (!subnets.includes(cidr)) subnets.push(cidr)
    }
  }
  return subnets
}

export interface ParsedCidr {
  network: number
  prefixLength: number
}

export function parseCidr(cidr: string): ParsedCidr | undefined {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(cidr.trim())
  if (!match) return undefined
  const address = match[1]!
  const prefixLength = Number(match[2])
  if (!isIPv4(address) || prefixLength > 32) return undefined
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0
  return { network: (ipv4ToInt(address) & mask) >>> 0, prefixLength }
}

/**
 * Enumerate probe targets of one CIDR, network/broadcast addresses excluded and
 * capped at `maxHosts`. Only `maxHosts` strings are ever materialized, so a /8
 * cannot blow up memory.
 */
export function enumerateHosts(cidr: string, maxHosts: number): string[] {
  const parsed = parseCidr(cidr)
  if (!parsed || maxHosts <= 0) return []
  const hostBits = 32 - parsed.prefixLength
  const size = 2 ** hostBits
  const first = parsed.prefixLength >= 31 ? parsed.network : parsed.network + 1
  const last = parsed.prefixLength >= 31 ? parsed.network + size - 1 : parsed.network + size - 2
  const hosts: string[] = []
  for (let value = first; value <= last && hosts.length < maxHosts; value += 1) {
    hosts.push(intToIpv4(value >>> 0))
  }
  return hosts
}

export interface SweepPlanInput {
  nics: NicMap
  /** Explicit CIDR list; when non-empty it replaces subnet derivation. */
  subnets?: string[]
  maxHosts: number
  /** Hosts already known (configured/cached), never swept twice. */
  exclude?: string[]
}

/** Subnets actually swept, plus the flattened (deduped, capped) host list. */
export function planSweep(input: SweepPlanInput): { subnets: string[]; hosts: string[] } {
  const subnets = input.subnets && input.subnets.length > 0 ? input.subnets.map((item) => item.trim()).filter((item) => item !== '') : deriveSubnets(input.nics)
  const exclude = new Set(input.exclude ?? [])
  const hosts: string[] = []
  for (const subnet of subnets) {
    const remaining = input.maxHosts - hosts.length
    if (remaining <= 0) break
    for (const host of enumerateHosts(subnet, remaining)) {
      if (exclude.has(host) || hosts.includes(host)) continue
      hosts.push(host)
    }
  }
  return { subnets, hosts }
}

export interface SweepOptions {
  concurrency: number
  connectTimeoutMs: number
  /** Injected for unit tests; defaults to a real TCP connect. */
  tryConnect?: (host: string, port: number, timeoutMs: number, signal?: AbortSignal) => Promise<boolean>
  signal?: AbortSignal
}

/**
 * Concurrent TCP connect sweep. Any open port is only a candidate: the caller
 * confirms it with the `/tokenize` fingerprint before using it.
 */
export async function sweepHosts(hosts: string[], port: number, options: SweepOptions): Promise<string[]> {
  const tryConnect = options.tryConnect ?? tryConnectTcp
  const open: string[] = []
  const concurrency = Math.max(1, Math.min(options.concurrency, hosts.length || 1))
  let cursor = 0
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= hosts.length) return
      if (options.signal?.aborted) return
      const host = hosts[index]!
      try {
        if (await tryConnect(host, port, options.connectTimeoutMs, options.signal)) open.push(host)
      } catch {
        // a refused/unreachable host is the normal case, never an error
      }
    }
  })
  await Promise.all(workers)
  return open
}

/** One TCP connect attempt; resolves true when the port accepts a connection. */
export function tryConnectTcp(host: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const socket = createConnection({ host, port })
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    const onAbort = () => finish(false)
    if (signal) {
      if (signal.aborted) {
        finish(false)
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      socket.on('close', () => signal.removeEventListener('abort', onAbort))
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
  })
}

/** One host with the ports of interest that accepted a TCP connection. */
export interface HostPorts {
  host: string
  ports: number[]
}

/**
 * Sweep the same host list once per port of interest. Used to look for BOTH the
 * control plane (8808) and the generation backend (8081) in one pass; a host
 * that answers on the control port is scored first by the caller.
 */
export async function sweepPorts(
  hosts: string[],
  ports: number[],
  options: SweepOptions,
): Promise<HostPorts[]> {
  const results: HostPorts[] = []
  for (const port of ports) {
    if (options.signal?.aborted) break
    for (const host of await sweepHosts(hosts, port, options)) {
      const existing = results.find((item) => item.host === host)
      if (existing) existing.ports.push(port)
      else results.push({ host, ports: [port] })
    }
  }
  // Control-plane hosts first: an 8808 that answers is the strongest signal.
  return results.sort((left, right) => right.ports.length - left.ports.length)
}

/** Whether a local TCP port can still be bound (the preferred-port check). */export function canBindPort(port: number, host = '0.0.0.0'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, host)
  })
}

/** Bind port 0 and release it, yielding a free ephemeral local port. */
export function pickFreePort(host = '0.0.0.0'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address() as AddressInfo | null
      const port = address?.port
      server.close(() => {
        if (typeof port === 'number') resolve(port)
        else reject(new Error('无法获取空闲端口'))
      })
    })
  })
}
