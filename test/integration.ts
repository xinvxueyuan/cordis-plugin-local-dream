/**
 * Opt-in live integration check (NOT part of `npm test`).
 *
 * It exercises the real stack against a real phone: LAN discovery → Device Link
 * control plane (8808) → `/select` → generation backend (8081) → adb/USB
 * fallback. On a machine with no reachable device it prints SKIP lines and
 * exits 0, so it is safe to run anywhere.
 *
 * Environment:
 *   LOCAL_DREAM_HOST=192.168.1.42   force a LAN host (skips discovery)
 *   LOCAL_DREAM_DISCOVER=1          enable the subnet sweep when no host is set
 *   LOCAL_DREAM_MODE=auto|lan|usb   force one transport (default auto)
 *   LOCAL_DREAM_ADB=<path>          explicit adb binary
 *   LOCAL_DREAM_MODEL=<model id>    model to activate through /select
 *   LOCAL_DREAM_SERIAL=<serial>     target device when several are attached
 *   LOCAL_DREAM_GENERATE=1          also run one tiny 1-step generation
 *   LOCAL_DREAM_REQUEST_TIMEOUT_MS  per-request budget (default 120000)
 */
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LocalDreamError, errorMessage } from '../src/errors.ts'
import { Config, type LocalDreamConfig } from '../src/config.ts'
import { ConnectionManager, createConnectionDeps } from '../src/connection.ts'
import { defaultGenerationDeps, runGeneration } from '../src/generate.ts'
import { PNG_SIGNATURE } from '../src/png.ts'

const results: Array<{ name: string; pass: boolean; detail?: string }> = []
let skipped = 0

async function check(name: string, fn: () => Promise<string | void>): Promise<void> {
  try {
    const detail = await fn()
    results.push({ name, pass: true, ...(detail ? { detail } : {}) })
  } catch (error) {
    results.push({ name, pass: false, detail: errorMessage(error) })
  }
}

function skip(name: string, reason: string): void {
  skipped += 1
  console.log(`SKIP ${name} — ${reason}`)
}

function environmentConfig(): LocalDreamConfig {
  const base = Config({
    mode: (process.env.LOCAL_DREAM_MODE?.trim() || 'auto') as never,
    host: process.env.LOCAL_DREAM_HOST?.trim() ?? '',
    adbPath: process.env.LOCAL_DREAM_ADB?.trim() ?? '',
    serial: process.env.LOCAL_DREAM_SERIAL?.trim() ?? '',
    model: process.env.LOCAL_DREAM_MODEL?.trim() ?? '',
    requestTimeoutMs: Number(process.env.LOCAL_DREAM_REQUEST_TIMEOUT_MS ?? 120000),
    // Fail fast when nothing is there, and only sweep when explicitly asked for:
    // a full /24 sweep would otherwise dominate the runtime of a smoke test.
    waitTimeoutMs: 0,
  } as never) as unknown as LocalDreamConfig
  return {
    ...base,
    discovery: { ...base.discovery, enabled: process.env.LOCAL_DREAM_DISCOVER === '1' },
  }
}

const config = environmentConfig()
const manager = new ConnectionManager(createConnectionDeps(config))
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 300000)
timeout.unref?.()

let connected = false
try {
  const snapshot = await manager.ensure({ signal: controller.signal })
  connected = true
  console.log(
    `PASS connect — transport=${snapshot.transport} baseUrl=${snapshot.baseUrl} controlBaseUrl=${snapshot.controlBaseUrl ?? 'none'} model=${snapshot.model ?? 'unknown'}`,
  )
  results.push({ name: 'connect', pass: true, detail: `${snapshot.transport} ${snapshot.baseUrl}` })

  await check('GET /health on the generation port', async () => {
    const response = await fetch(`${snapshot.baseUrl}/health`)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return `HTTP ${response.status}`
  })

  await check('POST /tokenize fingerprint (max_length === 77)', async () => {
    const response = await fetch(`${snapshot.baseUrl}/tokenize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cordis-plugin-local-dream integration probe' }),
    })
    const body = (await response.json()) as { count?: unknown; max_length?: unknown }
    if (body.max_length !== 77) throw new Error(`max_length=${String(body.max_length)}`)
    if (typeof body.count !== 'number' || !Number.isInteger(body.count)) throw new Error(`count=${String(body.count)}`)
    return `max_length=77 count=${body.count}`
  })

  if (snapshot.controlBaseUrl) {
    await check('GET /info on the control plane (app === "localdream")', async () => {
      const response = await fetch(`${snapshot.controlBaseUrl}/info`)
      const body = (await response.json()) as { app?: unknown; version?: unknown; device?: unknown }
      if (body.app !== 'localdream') throw new Error(`app=${JSON.stringify(body.app)}`)
      return `version=${String(body.version)} device=${String(body.device)}`
    })
    await check('GET /models on the control plane', async () => {
      const response = await fetch(`${snapshot.controlBaseUrl}/models`)
      const body = (await response.json()) as { models?: unknown[] }
      if (!Array.isArray(body.models)) throw new Error('models is not an array')
      return `${body.models.length} model(s) downloaded`
    })
  } else {
    skip('GET /info on the control plane', 'the connection is a plain 8081 backend (no Device Link host mode)')
  }

  if (process.env.LOCAL_DREAM_GENERATE === '1') {
    await check(`POST /generate (1 step, ${process.env.LOCAL_DREAM_SIZE ?? 512}px) writes a PNG`, async () => {
      // Never litter the checkout: default to an OS temp directory (created
      // recursively by runGeneration), while still honouring an explicit override.
      const outputDir = process.env.LOCAL_DREAM_OUTPUT_DIR ?? path.join(tmpdir(), 'local-dream-integration')
      const result = await runGeneration(
        defaultGenerationDeps(async (body) =>
          fetch(`${snapshot.baseUrl}/generate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
        ),
        {
          // 512 is the native size of the usual SD 1.5 checkpoints; a smaller
          // request is not universally safe (some backends crash below native).
          body: { prompt: 'integration test', steps: 1, size: Number(process.env.LOCAL_DREAM_SIZE ?? 512), seed: 1 },
          outputDir,
          inactivityTimeoutMs: config.requestTimeoutMs,
          signal: controller.signal,
        },
      )
      const png = await readFile(String(result.path))
      if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`${String(result.path)} is not a PNG`)
      return `${String(result.path)} (${png.length} bytes, seed=${String(result.seed)})`
    })
  } else {
    skip('POST /generate', 'set LOCAL_DREAM_GENERATE=1 to run a real 1-step generation')
  }
} catch (error) {
  if (error instanceof LocalDreamError || error instanceof Error) {
    skip('all live checks', errorMessage(error).split('\n')[0]!)
  } else {
    skip('all live checks', String(error))
  }
} finally {
  clearTimeout(timeout)
  if (connected || manager.snapshot().createdForwards.length > 0) {
    try {
      const cleanup = await manager.disconnect()
      if (cleanup.removed.length > 0) console.log(`PASS cleanup — removed forwards: ${cleanup.removed.join(', ')}`)
      if (cleanup.failed.length > 0) console.log(`FAIL cleanup — ${cleanup.failed.join('; ')}`)
    } catch (error) {
      console.log(`FAIL cleanup — ${errorMessage(error)}`)
    }
  }
}

let failed = 0
for (const item of results) {
  console.log(`${item.pass ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`)
  if (!item.pass) failed += 1
}
if (results.length === 0) {
  console.log('SKIP: no Local Dream device or host reachable from this machine — nothing to verify')
}
console.log(failed === 0 ? (results.length === 0 ? 'ALL SKIPPED' : 'ALL PASS') : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
