import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { inflateSync } from 'node:zlib'
import { adbCandidates, buildDevicesArgs, buildForwardArgs, buildRemoveForwardArgs, findOnPath, parseDeviceList, parseForwardList, parseWifiIp, planForward, resolveAdb, selectDevice } from '../src/adb.ts'
import { canBindPort, deriveSubnets, enumerateHosts, ipv4ToInt, intToIpv4, parseCidr, planSweep } from '../src/lan.ts'
import { decodeSseEvent, isEventStream, jsonErrorMessage, parseSseJson, SseParser } from '../src/sse.ts'
import { base64ByteLength, crc32, encodePngRgb, PNG_SIGNATURE, reshapeRgb } from '../src/png.ts'
import { buildGenerateBody, consumeGenerateStream, defaultOutputPath, GENERATE_FIELDS, runGeneration, SCHEDULERS } from '../src/generate.ts'
import { backoffDelay, ConnectionManager, probeTokenize, type ConnectionDeps } from '../src/connection.ts'
import { interpretResponseBody, httpErrorFrom } from '../src/http.ts'
import { summarizeGenerateResponse } from '../src/tool-api.ts'
import { Config, assertConfig, resolveOutputDir, type LocalDreamConfig } from '../src/config.ts'
import { LocalDreamError, isConnectionError } from '../src/errors.ts'
import {
  buildSelectBody,
  ControlClient,
  mapSelectResponse,
  mapStopResponse,
  parseControlCatalog,
  parseControlInfo,
  parseControlStatus,
  readinessDecision,
  resolveModelChoice,
  UPSCALER_ID,
  type ControlCatalog,
  type ControlResponse,
  type ControlStatus,
  type ControlTransport,
} from '../src/control.ts'
import type { DeviceEntry, ProbeResult, SseJsonEvent } from '../src/types.ts'

// ---------------------------------------------------------------- helpers ---

function makeConfig(overrides: Record<string, unknown> = {}): LocalDreamConfig {
  return { ...(Config({}) as unknown as LocalDreamConfig), ...overrides } as LocalDreamConfig
}

function device(serial: string, state: string, properties: Record<string, string> = {}): DeviceEntry {
  return { serial, state, properties, raw: `${serial} ${state}` }
}

/** Capture the error a call range-throws, so its structured fields are testable. */
function thrown(fn: () => unknown): LocalDreamError {
  try {
    fn()
  } catch (error) {
    return error as LocalDreamError
  }
  throw new Error('expected the call to throw')
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

/** A control transport that refuses every connection (no host mode). */
function refusingControl(): ControlTransport {
  return {
    async request() {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8808')
    },
  }
}

interface ControlRequest {
  baseUrl: string
  endpoint: string
  method: string
  body?: unknown
}

type ControlHandler = (request: ControlRequest) => ControlResponse | Promise<ControlResponse>

/** A scripted control transport: one handler per route, 404 otherwise. */
function controlTransport(handlers: Partial<Record<'info' | 'status' | 'models' | 'select' | 'stop', ControlHandler>>): ControlTransport {
  return {
    async request(options) {
      const handler = handlers[options.endpoint as keyof typeof handlers]
      if (!handler) return { status: 404, text: '{"error":"not found"}' }
      return handler(options)
    },
  }
}

function json(status: number, value: unknown): ControlResponse {
  return { status, text: JSON.stringify(value) }
}

function running(model: string | null, width: number | null, height: number | null): ControlStatus {
  return { serving_model_id: model, state: 'running', message: null, error_model_id: null, width, height }
}

const CATALOG: ControlCatalog = {
  use_img2img: true,
  models: [
    { id: 'sd15-core', name: 'SD 1.5', generation_size: 512 },
    { id: 'sdxl-turbo', name: 'SDXL Turbo', generation_size: 1024, is_sdxl: true },
  ],
  upscalers: [{ id: 'realesrgan', path: '/models/upscale.bin' }],
}

// ------------------------------------------------------- adb device list ---

test('parseDeviceList: daemon-start banner on stderr, CRLF and -l properties', () => {
  const stdout = [
    'List of devices attached',
    'R58M12345\tdevice product:panther model:Pixel_7 device:panther transport_id:1',
    '',
  ].join('\r\n')
  const stderr = '* daemon not running; starting now at tcp:5037\r\n* daemon started successfully\r\n'
  const devices = parseDeviceList(stdout, stderr)
  assert.equal(devices.length, 1)
  assert.equal(devices[0]!.serial, 'R58M12345')
  assert.equal(devices[0]!.state, 'device')
  assert.equal(devices[0]!.properties.model, 'Pixel_7')
  assert.equal(devices[0]!.properties.transport_id, '1')
})

test('parseDeviceList: unauthorized / offline / no permissions are all reported', () => {
  const stdout = [
    'List of devices attached',
    'AAA unauthorized usb:1-1 transport_id:2',
    'BBB offline',
    'CCC no permissions (user in plugdev group; are your udev rules wrong?)',
    '',
  ].join('\n')
  const devices = parseDeviceList(stdout)
  assert.deepEqual(
    devices.map((item) => [item.serial, item.state]),
    [
      ['AAA', 'unauthorized'],
      ['BBB', 'offline'],
      ['CCC', 'no permissions'],
    ],
  )
})

test('parseDeviceList: multiple devices and banner-only output', () => {
  const stdout = ['List of devices attached', 'AAA\tdevice', 'BBB\tdevice model:Pixel_8', ''].join('\n')
  const devices = parseDeviceList(stdout)
  assert.equal(devices.length, 2)
  assert.equal(devices[1]!.properties.model, 'Pixel_8')
  assert.deepEqual(parseDeviceList('* daemon started successfully *\n'), [])
})

test('selectDevice: one ready device wins, zero retries, several refuse to guess', () => {
  assert.equal(selectDevice([device('AAA', 'device')]).serial, 'AAA')

  const zero = thrown(() => selectDevice([device('AAA', 'unauthorized')]))
  assert.ok(zero instanceof LocalDreamError)
  assert.equal(zero.fatal, false)
  assert.equal(zero.connection, true)

  const many = thrown(() => selectDevice([device('AAA', 'device', { model: 'Pixel_7' }), device('BBB', 'device', { model: 'Pixel_8' })]))
  assert.equal(many.fatal, true)
  assert.match(many.message, /AAA/)
  assert.match(many.message, /Pixel_8/)
  assert.match(many.message, /config\.serial/)

  const missing = thrown(() => selectDevice([device('AAA', 'device')], 'ZZZ'))
  assert.equal(missing.fatal, true)
  assert.match(missing.message, /ZZZ/)

  const offline = thrown(() => selectDevice([device('AAA', 'offline')], 'AAA'))
  assert.equal(offline.fatal, true)
  assert.match(offline.message, /offline/)
})

test('parseForwardList / parseWifiIp / argument arrays', () => {
  const forwards = parseForwardList(['AAA tcp:8081 tcp:8081', 'BBB tcp:9222 tcp:8081', 'garbage', ''].join('\n'))
  assert.equal(forwards.length, 2)
  assert.deepEqual(
    forwards.map((entry) => [entry.serial, entry.localPort, entry.remotePort]),
    [
      ['AAA', 8081, 8081],
      ['BBB', 9222, 8081],
    ],
  )
  assert.equal(parseWifiIp('    inet 192.168.1.44/24 brd 192.168.1.255 scope global wlan0'), '192.168.1.44')
  assert.equal(parseWifiIp('Device "wlan0" does not exist'), undefined)
  assert.deepEqual(buildDevicesArgs(), ['devices', '-l'])
  assert.deepEqual(buildForwardArgs('AAA', 8081, 8081), ['-s', 'AAA', 'forward', 'tcp:8081', 'tcp:8081'])
  assert.deepEqual(buildRemoveForwardArgs('AAA', 8081), ['-s', 'AAA', 'forward', '--remove', 'tcp:8081'])
})

// ------------------------------------------------------ adb resolution ----

test('findOnPath: PATH lookup with .exe suffix on Windows', () => {
  const existing = new Set(['C:\\sdk\\platform-tools\\adb.exe'])
  assert.equal(
    findOnPath('adb', { pathValue: 'C:\\Windows;C:\\sdk\\platform-tools', platform: 'win32', exists: (file) => existing.has(file) }),
    'C:\\sdk\\platform-tools\\adb.exe',
  )
  assert.equal(findOnPath('adb', { pathValue: '/usr/bin', platform: 'linux', exists: () => false }), undefined)
})

test('findOnPath: the default predicate skips a directory named adb and keeps scanning later PATH entries', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'local-dream-adb-'))
  try {
    // Real-world layout: an earlier PATH entry holds a DIRECTORY named `adb`
    // (e.g. `C:\Program Files (x86)\pcsuite\adb\`) while the actual binary sits
    // in a later entry. `existsSync` accepts the directory; a file-only
    // predicate must reject it and continue.
    const shadow = path.join(root, 'pcsuite')
    mkdirSync(path.join(shadow, 'adb'), { recursive: true })
    const realDir = path.join(root, 'shims')
    mkdirSync(realDir, { recursive: true })
    const binary = path.join(realDir, process.platform === 'win32' ? 'adb.exe' : 'adb')
    writeFileSync(binary, '')

    // Sanity: this is exactly the entry the old `existsSync` default accepted.
    assert.equal(existsSync(path.join(shadow, 'adb')), true)
    assert.equal(findOnPath('adb', { pathValue: `${shadow}${path.delimiter}${realDir}`, platform: process.platform }), binary)
    // A PATH holding only the directory resolves to nothing, never a directory.
    assert.equal(findOnPath('adb', { pathValue: shadow, platform: process.platform }), undefined)

    // On the machine that originally reproduced this, pin the shipped predicate
    // against the real directory itself (no-op elsewhere).
    const pcsuite = 'C:\\Program Files (x86)\\pcsuite'
    if (process.platform === 'win32' && existsSync(path.join(pcsuite, 'adb'))) {
      assert.equal(findOnPath('adb', { pathValue: pcsuite, platform: 'win32' }), undefined)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('findOnPath: an injected predicate stays authoritative and is asked per candidate', () => {
  // A file-aware predicate reports the directory-shaped entry as a non-file, so
  // the scan must continue to the later PATH entry (Windows also tries `.exe`).
  const isRegularFile: Record<string, boolean> = {
    'C:\\pcsuite\\adb': false,
    'C:\\pcsuite\\adb.exe': false,
    'C:\\shims\\adb.exe': true,
  }
  assert.equal(
    findOnPath('adb', {
      pathValue: 'C:\\pcsuite;C:\\shims',
      platform: 'win32',
      exists: (file) => isRegularFile[file] === true,
    }),
    'C:\\shims\\adb.exe',
  )
  // The option is still the injectable authority (existing fakes keep working).
  const seen: string[] = []
  assert.equal(
    findOnPath('adb', {
      pathValue: '/pcsuite',
      platform: 'linux',
      exists: (file) => {
        seen.push(file)
        return file === '/pcsuite/adb'
      },
    }),
    '/pcsuite/adb',
  )
  assert.deepEqual(seen, ['/pcsuite/adb'])
})

test('adbCandidates: precedence config -> sdk -> PATH -> vendor', () => {
  const exists = (file: string) => file === '/opt/adb' || file === '/sdk/platform-tools/adb' || file === '/usr/local/bin/adb' || file === '/pkg/vendor/platform-tools/linux-x64/adb'
  const base = { platform: 'linux' as NodeJS.Platform, arch: 'x64', packageRoot: '/pkg', exists, env: { ANDROID_HOME: '/sdk', PATH: '/usr/local/bin' } as NodeJS.ProcessEnv }
  assert.deepEqual(
    adbCandidates({ adbPath: '', bundledAdbDir: '' }, base).map((item) => item.source),
    ['sdk', 'path', 'vendor'],
  )
  assert.deepEqual(
    adbCandidates({ adbPath: '/opt/adb', bundledAdbDir: '' }, base).map((item) => [item.source, item.path]),
    [['config', '/opt/adb']],
  )
  assert.deepEqual(
    adbCandidates({ adbPath: '', bundledAdbDir: '/custom/pt' }, { ...base, exists: () => true }).map((item) => item.path),
    ['/sdk/platform-tools/adb', '/usr/local/bin/adb', '/custom/pt/adb'],
  )
})

test('resolveAdb: validates every candidate with `adb version` and reports all failures', async () => {
  const calls: string[] = []
  const run = async (bin: string, args: string[]) => {
    calls.push(`${bin} ${args.join(' ')}`)
    if (bin === '/sdk/platform-tools/adb') return { code: 1, stdout: '', stderr: 'boom' }
    return { code: 0, stdout: 'Android Debug Bridge version 1.0.41\nVersion 35.0.2-android-tools\n', stderr: '' }
  }
  const exists = (file: string) => file === '/sdk/platform-tools/adb' || file === '/pkg/vendor/platform-tools/linux-x64/adb'
  const resolved = await resolveAdb(
    { adbPath: '', bundledAdbDir: '' },
    { packageRoot: '/pkg', platform: 'linux', arch: 'x64', env: { ANDROID_HOME: '/sdk', PATH: '' } as NodeJS.ProcessEnv, exists, run, chmod: () => {} },
  )
  assert.equal(resolved.source, 'vendor')
  assert.equal(resolved.path, '/pkg/vendor/platform-tools/linux-x64/adb')
  assert.match(resolved.version, /Android Debug Bridge/)
  assert.deepEqual(calls, ['/sdk/platform-tools/adb version', '/pkg/vendor/platform-tools/linux-x64/adb version'])

  await assert.rejects(
    resolveAdb(
      { adbPath: '', bundledAdbDir: '' },
      { packageRoot: '/pkg', platform: 'linux', arch: 'x64', env: { ANDROID_HOME: '/sdk' } as NodeJS.ProcessEnv, exists: () => false, run },
    ),
    (error: unknown) => {
      assert.ok(error instanceof LocalDreamError)
      assert.equal(error.code, 'adb')
      assert.equal(error.fatal, true)
      assert.match(error.message, /config\.adbPath/)
      assert.match(error.message, /ANDROID_SDK_ROOT/)
      assert.match(error.message, /vendor\/platform-tools/)
      return true
    },
  )

  await assert.rejects(
    resolveAdb({ adbPath: '/nope/adb', bundledAdbDir: '' }, { packageRoot: '/pkg', exists: () => false, run }),
    /config\.adbPath 指向的文件不存在/,
  )
})

test('resolveAdb: selects the PATH adb over the bundled vendor copy when both exist', async () => {
  const calls: string[] = []
  const run = async (bin: string, args: string[]) => {
    calls.push(`${bin} ${args.join(' ')}`)
    return { code: 0, stdout: 'Android Debug Bridge version 1.0.41\n', stderr: '' }
  }
  const exists = (file: string) => file === '/shims/adb' || file === '/pkg/vendor/platform-tools/linux-x64/adb'
  const resolved = await resolveAdb(
    { adbPath: '', bundledAdbDir: '' },
    { packageRoot: '/pkg', platform: 'linux', arch: 'x64', env: { PATH: '/pcsuite:/shims' } as NodeJS.ProcessEnv, exists, run, chmod: () => {} },
  )
  assert.equal(resolved.source, 'path')
  assert.equal(resolved.path, '/shims/adb')
  // The vendor copy is never even probed once PATH yields a working adb.
  assert.deepEqual(calls, ['/shims/adb version'])
})

test('resolveAdb: a PATH candidate whose spawn fails with ENOENT does not abort resolution', async () => {
  const calls: string[] = []
  const run = async (bin: string, args: string[]) => {
    calls.push(`${bin} ${args.join(' ')}`)
    if (bin === '/pcsuite/adb') throw new Error('ENOENT: spawn /pcsuite/adb ENOENT')
    return { code: 0, stdout: 'Android Debug Bridge version 1.0.41\n', stderr: '' }
  }
  const exists = (file: string) => file === '/pcsuite/adb' || file === '/pkg/vendor/platform-tools/linux-x64/adb'
  const resolved = await resolveAdb(
    { adbPath: '', bundledAdbDir: '' },
    { packageRoot: '/pkg', platform: 'linux', arch: 'x64', env: { PATH: '/pcsuite' } as NodeJS.ProcessEnv, exists, run, chmod: () => {} },
  )
  assert.equal(resolved.source, 'vendor')
  assert.equal(resolved.path, '/pkg/vendor/platform-tools/linux-x64/adb')
  assert.match(resolved.version, /Android Debug Bridge/)
  assert.deepEqual(calls, ['/pcsuite/adb version', '/pkg/vendor/platform-tools/linux-x64/adb version'])
})

// --------------------------------------------------------- forward plan ---

test('planForward: reuses a matching existing forward', async () => {
  const plan = await planForward({
    existing: [{ serial: 'AAA', localPort: 8081, remotePort: 8081, raw: 'AAA tcp:8081 tcp:8081' }],
    serial: 'AAA',
    remotePort: 8081,
    localPort: 0,
    isPortFree: () => true,
    pickFreePort: () => 49999,
  })
  assert.equal(plan.reuse, true)
  assert.equal(plan.create, false)
  assert.equal(plan.localPort, 8081)
})

test('planForward: prefers 8081 and picks a free port when it is taken', async () => {
  const free = await planForward({
    existing: [],
    serial: 'AAA',
    remotePort: 8081,
    localPort: 0,
    isPortFree: () => true,
    pickFreePort: () => 49999,
  })
  assert.equal(free.create, true)
  assert.equal(free.localPort, 8081)
  assert.deepEqual(free.args, ['-s', 'AAA', 'forward', 'tcp:8081', 'tcp:8081'])

  const foreign = await planForward({
    existing: [{ serial: 'OTHER', localPort: 8081, remotePort: 8081, raw: 'OTHER tcp:8081 tcp:8081' }],
    serial: 'AAA',
    remotePort: 8081,
    localPort: 0,
    isPortFree: () => true,
    pickFreePort: () => 49999,
  })
  assert.equal(foreign.localPort, 49999)
  assert.equal(foreign.create, true)
  assert.match(foreign.note!, /8081/)

  const occupied = await planForward({
    existing: [],
    serial: 'AAA',
    remotePort: 8081,
    localPort: 0,
    isPortFree: () => false,
    pickFreePort: () => 49999,
  })
  assert.equal(occupied.localPort, 49999)

  await assert.rejects(
    planForward({ existing: [], serial: 'AAA', remotePort: 8081, localPort: 9000, isPortFree: () => false, pickFreePort: () => 49999 }),
    /localPort=9000/,
  )
})

test('planForward: preferLocalPort drives the control-plane forward', async () => {
  const plan = await planForward({
    existing: [],
    serial: 'AAA',
    remotePort: 8808,
    localPort: 0,
    preferLocalPort: 8808,
    isPortFree: () => true,
    pickFreePort: () => 49999,
  })
  assert.equal(plan.localPort, 8808)
  assert.deepEqual(plan.args, ['-s', 'AAA', 'forward', 'tcp:8808', 'tcp:8808'])
})

// --------------------------------------------------------------- SSE ------

test('SseParser: partial lines across chunks and CRLF', () => {
  const parser = new SseParser()
  assert.deepEqual(parser.push('data: {"type":"pro'), [])
  assert.deepEqual(parser.push('gress","step":1}\n\n'), [{ data: '{"type":"progress","step":1}' }])
  assert.deepEqual(parser.push('event: error\r\ndata: boom\r\n\r\n'), [{ data: 'boom', event: 'error' }])
  assert.deepEqual(parser.push(': keep-alive comment\n\n'), [])
})

test('SseParser: multi-line data, [DONE] sentinel and flush', () => {
  const parser = new SseParser()
  const events = parser.push('data: line one\ndata: line two\n\n')
  assert.deepEqual(events, [{ data: 'line one\nline two' }])
  const done = parser.push('data: [DONE]\n\n')
  assert.deepEqual(done, [])
  assert.equal(parser.done, true)
  const trailing = new SseParser()
  assert.deepEqual(trailing.push('data: {"type":"complete"}'), [])
  assert.deepEqual(trailing.flush(), [{ data: '{"type":"complete"}' }])
})

test('parseSseJson: malformed JSON is skipped with a warning, event name becomes type', () => {
  const result = parseSseJson(
    [
      'data: {"type":"progress","step":1,"total_steps":20}',
      '',
      'data: {not json',
      '',
      'event: error',
      'data: {"message":"boom"}',
      '',
      '',
    ].join('\n'),
  )
  assert.equal(result.events.length, 2)
  assert.equal(result.events[0]!.type, 'progress')
  assert.equal(result.events[1]!.type, 'error')
  assert.equal(result.events[1]!.message, 'boom')
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0]!, /跳过无法解析/)
})

test('parseSseJson: non-JSON error payload becomes { type: error }', () => {
  const parser = new SseParser()
  const warnings: string[] = []
  const events = parser.push('event: error\ndata: model not loaded\n\n')
  const decoded = events.map((event) => decodeSseEvent(event, warnings))
  assert.deepEqual(decoded, [{ type: 'error', message: 'model not loaded' }])
  assert.deepEqual(warnings, [])
})

test('non-streaming JSON error body', () => {
  assert.equal(isEventStream('text/event-stream; charset=utf-8'), true)
  assert.equal(isEventStream('application/json'), false)
  assert.equal(jsonErrorMessage('{"message":"prompt is required"}'), 'prompt is required')
  assert.equal(jsonErrorMessage('plain text'), undefined)
  const interpretation = interpretResponseBody('application/json', '{"message":"bad request"}')
  assert.equal(interpretation.kind, 'json')
  assert.deepEqual(interpretation.value, { message: 'bad request' })
  const error = httpErrorFrom(new Response('{"message":"prompt is required"}', { status: 400 }), '{"message":"prompt is required"}')
  assert.equal(error.status, 400)
  assert.equal(error.message, 'prompt is required')
  assert.equal(isConnectionError(error), false)
})

// --------------------------------------------------------------- PNG ------

function readChunks(buffer: Buffer): Array<{ type: string; data: Buffer; crc: number }> {
  const chunks: Array<{ type: string; data: Buffer; crc: number }> = []
  let offset = 8
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    const crc = buffer.readUInt32BE(offset + 8 + length)
    chunks.push({ type, data: Buffer.from(data), crc })
    offset += 12 + length
  }
  return chunks
}

test('png: crc32 matches the zlib/PNG definition', () => {
  assert.equal(crc32(Buffer.from('IEND')), 0xae426082)
  assert.equal(crc32(Buffer.alloc(0)), 0)
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
})

test('png: signature, IHDR dimensions, chunk CRCs and pixel round-trip', () => {
  const width = 4
  const height = 3
  const pixels = Buffer.alloc(width * height * 3)
  for (let index = 0; index < pixels.length; index += 1) pixels[index] = (index * 7) % 256
  const png = encodePngRgb(width, height, pixels)

  assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE)
  const chunks = readChunks(png)
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['IHDR', 'IDAT', 'IEND'])
  assert.equal(chunks[0]!.data.readUInt32BE(0), width)
  assert.equal(chunks[0]!.data.readUInt32BE(4), height)
  assert.equal(chunks[0]!.data.readUInt8(8), 8)
  assert.equal(chunks[0]!.data.readUInt8(9), 2) // truecolour RGB
  assert.equal(chunks[2]!.data.length, 0)
  for (const chunk of chunks) {
    assert.equal(chunk.crc, crc32(Buffer.concat([Buffer.from(chunk.type, 'ascii'), chunk.data])), `CRC of ${chunk.type}`)
  }

  const raw = inflateSync(chunks[1]!.data)
  const stride = width * 3
  assert.equal(raw.length, (stride + 1) * height)
  for (let row = 0; row < height; row += 1) {
    assert.equal(raw[row * (stride + 1)], 0, 'filter byte must be 0')
    assert.deepEqual(
      raw.subarray(row * (stride + 1) + 1, row * (stride + 1) + 1 + stride),
      pixels.subarray(row * stride, (row + 1) * stride),
    )
  }
})

test('png: reshapeRgb validates length and channels; encodePngRgb rejects bad input', () => {
  const bytes = Buffer.alloc(2 * 2 * 3, 9)
  assert.deepEqual(reshapeRgb(bytes.toString('base64'), 2, 2, 3), bytes)
  assert.equal(base64ByteLength(bytes.toString('base64')), bytes.length)
  assert.throws(() => reshapeRgb(bytes.toString('base64'), 3, 2, 3), /像素字节数不匹配/)
  assert.throws(() => reshapeRgb(bytes.toString('base64'), 2, 2, 4), /只支持 3/)
  assert.throws(() => encodePngRgb(2, 2, Buffer.alloc(5)), /PNG 像素长度不匹配/)
})

// ---------------------------------------------------------- generate ------

test('buildGenerateBody: size overrides width/height and defaults are optional', () => {
  const body = buildGenerateBody({ prompt: 'a cat', size: 512, width: 768, height: 768, steps: 20 })
  assert.equal(body.size, 512)
  assert.equal(body.width, 512)
  assert.equal(body.height, 512)
  assert.equal(body.steps, 20)
  assert.deepEqual(buildGenerateBody({ prompt: 'x' }), { prompt: 'x' })
  assert.equal(buildGenerateBody({ prompt: 'x', negative_prompt: '' }).negative_prompt, '')
})

test('buildGenerateBody: unknown fields, bad types and mask-without-image are rejected', () => {
  assert.throws(() => buildGenerateBody({ prompt: 'x', widht: 512 }), /未知的 \/generate 字段 "widht"/)
  assert.throws(() => buildGenerateBody({ prompt: '' }), /prompt 必填/)
  assert.throws(() => buildGenerateBody({ prompt: 'x', steps: 0 }), /steps 必须是/)
  assert.throws(() => buildGenerateBody({ prompt: 'x', seed: -1 }), /seed 必须是/)
  assert.throws(() => buildGenerateBody({ prompt: 'x', mask: 'AAAA' }), /mask 必须与 image 同时提供/)
  assert.ok(GENERATE_FIELDS.has('prompt') && GENERATE_FIELDS.has('aspect_ratio'))
  assert.deepEqual(buildGenerateBody({ prompt: 'x', outputPath: 'C:/tmp/a.png', transport: 'usb', model: 'sd15' }), { prompt: 'x' })
})

test('buildGenerateBody: scheduler whitelist, including the lcm_karras rejection', () => {
  for (const scheduler of SCHEDULERS) {
    assert.equal(buildGenerateBody({ prompt: 'x', scheduler }).scheduler, scheduler)
  }
  assert.throws(() => buildGenerateBody({ prompt: 'x', scheduler: 'lcm_karras' }), /lcm 没有 _karras 变体/)
  assert.throws(() => buildGenerateBody({ prompt: 'x', scheduler: 'dpm_sde_karras_x' }), /未知 scheduler/)
})

test('consumeGenerateStream: progress + complete, and error events throw immediately', async () => {
  const complete: SseJsonEvent = { type: 'complete', image: 'AAAA', seed: 7, width: 2, height: 2, channels: 3 }
  const body = `${'data: {"type":"progress","step":1,"total_steps":20}\n\n'}data: ${JSON.stringify(complete)}\n\n`
  const result = await consumeGenerateStream(streamOf([body.slice(0, 20), body.slice(20)]))
  assert.equal(result.progressEvents.length, 1)
  assert.equal(result.complete.seed, 7)

  await assert.rejects(consumeGenerateStream(streamOf(['data: {"type":"error","message":"model not loaded"}\n\n'])), /Local Dream 生成失败：model not loaded/)
  await assert.rejects(consumeGenerateStream(streamOf(['data: {"type":"progress"}\n\n'])), /complete 事件前结束/)
})

test('runGeneration: writes an encoded PNG and reports the summary', async () => {
  const width = 2
  const height = 2
  const pixels = Buffer.alloc(width * height * 3, 200)
  const complete: SseJsonEvent = {
    type: 'complete',
    image: pixels.toString('base64'),
    seed: 42,
    width,
    height,
    channels: 3,
    generation_time_ms: 1234,
    first_step_time_ms: 99,
  }
  let written: { file: string; data: Uint8Array } | undefined
  let created = ''
  const result = await runGeneration(
    {
      openStream: async () =>
        new Response(streamOf([`data: ${JSON.stringify(complete)}\n\n`]), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      writeFile: async (file, data) => {
        written = { file, data }
      },
      mkdir: async (directory) => {
        created = directory
      },
      now: () => new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
    },
    { body: { prompt: 'x' }, outputDir: path.join('C:', 'out'), inactivityTimeoutMs: 5000 },
  )
  assert.equal(result.path, path.join('C:', 'out', '20260102-030405_42.png'))
  assert.equal(created, path.join('C:', 'out'))
  assert.equal(result.width, width)
  assert.equal(result.height, height)
  assert.equal(result.channels, 3)
  assert.equal(result.generationTimeMs, 1234)
  assert.equal(result.firstStepTimeMs, 99)
  assert.equal(result.progressEvents, 0)
  assert.ok(written)
  assert.deepEqual(Buffer.from(written!.data).subarray(0, 8), PNG_SIGNATURE)
  assert.equal(result.bytes, written!.data.length)
  assert.equal(defaultOutputPath('/out', 5, new Date(Date.UTC(2026, 10, 9, 8, 7, 6))), path.join('/out', '20261109-080706_5.png'))
})

test('runGeneration: rejects a complete event whose pixel length is wrong', async () => {
  const complete: SseJsonEvent = { type: 'complete', image: Buffer.alloc(10).toString('base64'), seed: 1, width: 4, height: 4, channels: 3 }
  await assert.rejects(
    runGeneration(
      {
        openStream: async () => new Response(streamOf([`data: ${JSON.stringify(complete)}\n\n`]), { status: 200 }),
        writeFile: async () => {},
        mkdir: async () => {},
        now: () => new Date(),
      },
      { body: { prompt: 'x' }, outputDir: '/out', inactivityTimeoutMs: 5000 },
    ),
    /像素字节数不匹配/,
  )
})

test('summarizeGenerateResponse: base64 images become byte counts unless includeImage', () => {
  const complete: SseJsonEvent = { type: 'complete', image: Buffer.alloc(12).toString('base64'), seed: 1, width: 2, height: 2, channels: 3 }
  const parsed = parseSseJson(
    `data: ${JSON.stringify({ type: 'progress', step: 1, image: Buffer.alloc(3).toString('base64') })}\n\ndata: ${JSON.stringify(complete)}\n\n`,
  )
  const summary = summarizeGenerateResponse(parsed, false)
  const events = summary.events as SseJsonEvent[]
  const done = summary.complete as SseJsonEvent
  assert.deepEqual(events[0]!.image, { imageBytes: 3, width: 2, height: 2, channels: 3 })
  assert.deepEqual(done.image, { imageBytes: 12 })
  const inline = summarizeGenerateResponse(parsed, true)
  assert.equal(typeof (inline.complete as SseJsonEvent).image, 'string')
})

// ---------------------------------------------------------- subnets -------

const NIC_MAP = {
  Ethernet: [
    { address: '192.168.1.37', family: 'IPv4', internal: false },
    { address: '127.0.0.1', family: 'IPv4', internal: true },
  ],
  'Wi-Fi': [{ address: '10.0.5.9', family: 'IPv4', internal: false }],
  lo: [
    { address: '::1', family: 'IPv6', internal: true },
    { address: '169.254.1.1', family: 4, internal: false },
  ],
}

test('lan: deriveSubnets skips loopback and non-IPv4, /24 per NIC', () => {
  assert.deepEqual(deriveSubnets(NIC_MAP), ['192.168.1.0/24', '10.0.5.0/24', '169.254.1.0/24'])
  assert.deepEqual(deriveSubnets({ lo: [{ address: '127.0.0.1', family: 'IPv4', internal: false }] }), [])
  assert.deepEqual(deriveSubnets({ eth: [{ address: '::1', family: 'IPv6', internal: false }] }), [])
  assert.equal(intToIpv4(ipv4ToInt('10.1.2.3')), '10.1.2.3')
  assert.deepEqual(parseCidr('192.168.1.5/24'), { network: ipv4ToInt('192.168.1.0'), prefixLength: 24 })
  assert.equal(parseCidr('not-a-cidr'), undefined)
})

test('lan: enumerateHosts and planSweep honour subnets and maxHosts', () => {
  assert.deepEqual(enumerateHosts('172.16.9.0/30', 100), ['172.16.9.1', '172.16.9.2'])
  assert.deepEqual(enumerateHosts('192.168.1.0/24', 3), ['192.168.1.1', '192.168.1.2', '192.168.1.3'])
  assert.deepEqual(enumerateHosts('bad', 10), [])

  const derived = planSweep({ nics: NIC_MAP, maxHosts: 3 })
  assert.deepEqual(derived.subnets, ['192.168.1.0/24', '10.0.5.0/24', '169.254.1.0/24'])
  assert.deepEqual(derived.hosts, ['192.168.1.1', '192.168.1.2', '192.168.1.3'])

  const overridden = planSweep({ nics: NIC_MAP, subnets: ['172.16.9.0/30'], maxHosts: 100 })
  assert.deepEqual(overridden.subnets, ['172.16.9.0/30'])
  assert.deepEqual(overridden.hosts, ['172.16.9.1', '172.16.9.2'])

  const capped = planSweep({ nics: NIC_MAP, maxHosts: 300 })
  assert.equal(capped.hosts.length, 300)
  assert.equal(capped.hosts[0], '192.168.1.1')
  assert.equal(capped.hosts[299], '10.0.5.46')

  // the cap counts KEPT hosts, and excluded hosts are skipped before the cap
  const excluded = planSweep({ nics: NIC_MAP, maxHosts: 3, exclude: ['192.168.1.1'] })
  assert.deepEqual(excluded.hosts, ['192.168.1.2', '192.168.1.3', '10.0.5.1'])
})

// ------------------------------------------------- control plane units ----

test('buildSelectBody: 512/512 defaults, upscaler pseudo-id, missing model rejected', () => {
  assert.deepEqual(buildSelectBody({ modelId: 'sd15-core' }), { model_id: 'sd15-core', width: 512, height: 512 })
  assert.deepEqual(buildSelectBody({ modelId: UPSCALER_ID, width: 1024, height: 1024 }), { model_id: '__upscaler__', width: 1024, height: 1024 })
  assert.deepEqual(buildSelectBody({ modelId: ' x ', width: 0, height: 0 }), { model_id: 'x', width: 512, height: 512 })
  assert.throws(() => buildSelectBody({ modelId: '' }), /model_id 必填/)
  assert.throws(() => buildSelectBody({ modelId: '   ' }), /model_id 必填/)
  assert.throws(() => buildSelectBody({ modelId: 'a', width: 12.5 }), /必须是整数/)
})

test('mapSelectResponse: 200/400/404/500 are mapped without guessing', () => {
  assert.deepEqual(mapSelectResponse(200, '{"ok":true}'), { ok: true, status: 200 })
  const bad400 = mapSelectResponse(400, '{"error":"DiT resolution must be 512..2048 in 24-pixel steps"}')
  assert.equal(bad400.ok, false)
  assert.match(bad400.error!, /512\.\.2048/)
  assert.equal(mapSelectResponse(404, '{"error":"model not found"}').error, 'model not found')
  assert.equal(mapSelectResponse(500, '{"error":"backend start rejected"}').error, 'backend start rejected')
  assert.equal(mapSelectResponse(200, '{"ok":false}').ok, false)
  assert.equal(mapSelectResponse(500, 'boom').error, 'HTTP 500')
})

test('mapStopResponse: the ignored flag is preserved truthfully', () => {
  assert.deepEqual(mapStopResponse(200, '{"ok":true,"ignored":true}'), { ok: true, ignored: true, status: 200 })
  assert.deepEqual(mapStopResponse(200, '{"ok":true}'), { ok: true, ignored: false, status: 200 })
  const failure = mapStopResponse(500, '{"error":"nope"}')
  assert.equal(failure.ok, false)
  assert.equal(failure.ignored, false)
  assert.equal(failure.error, 'nope')
})

test('control parsers: /info identity, /status states, /models catalog', () => {
  const info = parseControlInfo('{"app":"localdream","protocol":1,"version":"3.0.0-alpha.4","device":"V2463A"}')
  assert.equal(info.app, 'localdream')
  assert.equal(info.device, 'V2463A')
  assert.throws(() => parseControlInfo('{"app":"something-else"}'), /不是 Local Dream/)
  assert.throws(() => parseControlInfo('<html>'), /不是 JSON 对象/)

  const status = parseControlStatus('{"serving_model_id":"sd15-core","state":"running","message":null,"error_model_id":null,"width":512,"height":512}')
  assert.equal(status.state, 'running')
  assert.equal(status.width, 512)
  assert.throws(() => parseControlStatus('{"state":"weird"}'), /state 非法/)

  const catalog = parseControlCatalog(JSON.stringify(CATALOG))
  assert.equal(catalog.use_img2img, true)
  assert.deepEqual(catalog.models.map((model) => model.id), ['sd15-core', 'sdxl-turbo'])
  assert.equal(catalog.models[1]!.generation_size, 1024)
  assert.equal(catalog.upscalers[0]!.id, 'realesrgan')
  const messy = parseControlCatalog('{"models":[{"name":"no id"},{"id":"ok"}],"upscalers":[{"path":"x"}]}')
  assert.deepEqual(messy.models.map((model) => model.id), ['ok'])
  assert.deepEqual(messy.upscalers, [])
})

test('readinessDecision: the full (model, width, height) match table', () => {
  const want = { modelId: 'sd15-core', width: 512, height: 512 }
  assert.equal(readinessDecision(running('sd15-core', 512, 512), want), 'ready')
  assert.equal(readinessDecision(running('sd15-core', 1024, 1024), want), 'select')
  assert.equal(readinessDecision(running('sdxl-turbo', 512, 512), want), 'select')
  assert.equal(readinessDecision({ ...running('sd15-core', 512, 512), state: 'starting' }, want), 'poll')
  assert.equal(readinessDecision({ ...running(null, null, null), state: 'idle' }, want), 'select')
  assert.equal(readinessDecision({ ...running('sd15-core', 512, 512), state: 'error' }, want), 'error')
  // no model requirement: whatever is running counts, but the resolution still must match
  assert.equal(readinessDecision(running('anything', 512, 512), { modelId: null, width: 512, height: null }), 'ready')
  assert.equal(readinessDecision(running('anything', 768, 768), { modelId: null, width: 512, height: null }), 'select')
  assert.equal(readinessDecision(running(null, null, null), { modelId: null, width: null, height: null }), 'select')
})

test('resolveModelChoice: configured model wins, else the catalog default', () => {
  const configured = resolveModelChoice({ model: 'sdxl-turbo', selectWidth: 0, selectHeight: 0 }, CATALOG)
  assert.deepEqual(configured, { modelId: 'sdxl-turbo', width: 1024, height: 1024 })
  const first = resolveModelChoice({ model: '', selectWidth: 0, selectHeight: 0 }, CATALOG)
  assert.deepEqual(first, { modelId: 'sd15-core', width: 512, height: 512 })
  const forced = resolveModelChoice({ model: '', selectWidth: 768, selectHeight: 768 }, CATALOG)
  assert.deepEqual(forced, { modelId: 'sd15-core', width: 768, height: 768 })
  const upscaler = resolveModelChoice({ model: UPSCALER_ID, selectWidth: 0, selectHeight: 0 }, CATALOG)
  assert.deepEqual(upscaler, { modelId: '__upscaler__', width: 512, height: 512 })
  assert.throws(() => resolveModelChoice({ model: '', selectWidth: 0, selectHeight: 0 }, { use_img2img: false, models: [], upscalers: [] }), /没有已下载的模型/)
})

// ------------------------------------------------------- connection -------

interface Harness {
  manager: ConnectionManager
  state: {
    clock: number
    sleeps: number[]
    forwards: Array<{ serial: string; localPort: number; remotePort: number }>
    removed: Array<{ serial: string; localPort: number }>
    probes: string[]
    controlCalls: string[]
  }
}

function harness(config: LocalDreamConfig, options: {
  probe?: (host: string, port: number) => ProbeResult
  devices?: DeviceEntry[]
  forwards?: Array<{ serial: string; localPort: number; remotePort: number }>
  discovery?: Array<{ host: string; ports: number[] }>
  control?: ControlTransport
  adbError?: Error
  isPortFree?: (port: number) => boolean | Promise<boolean>
  pickFreePort?: () => number | Promise<number>
} = {}): Harness {
  const state: Harness['state'] = { clock: 0, sleeps: [], forwards: [], removed: [], probes: [], controlCalls: [] }
  const inner = options.control ?? refusingControl()
  const control: ControlTransport = {
    async request(request) {
      state.controlCalls.push(`${request.method} ${request.endpoint}`)
      return inner.request(request)
    },
  }
  const deps: ConnectionDeps = {
    config,
    adb: {
      resolve: async () => {
        if (options.adbError) throw options.adbError
        return { path: 'adb', source: 'path', version: 'Android Debug Bridge version 1.0.41' }
      },
      listDevices: async () => options.devices ?? [device('S1', 'device', { model: 'Pixel_7' })],
      listForwards: async () => [
        ...(options.forwards ?? []).map((entry) => ({ ...entry, raw: `${entry.serial} tcp:${entry.localPort} tcp:${entry.remotePort}` })),
        ...state.forwards.map((entry) => ({ ...entry, raw: `${entry.serial} tcp:${entry.localPort} tcp:${entry.remotePort}` })),
      ],
      addForward: async (_adbPath, serial, localPort, remotePort) => {
        state.forwards.push({ serial, localPort, remotePort })
      },
      removeForward: async (_adbPath, serial, localPort) => {
        state.removed.push({ serial, localPort })
      },
      wifiIp: async () => undefined,
    },
    lan: { sweep: async () => options.discovery ?? [] },
    control: new ControlClient({ transport: control }),
    probe: async (host, port) => {
      state.probes.push(`${host}:${port}`)
      return options.probe ? options.probe(host, port) : { ok: false, detail: 'refused' }
    },
    isPortFree: async (port) => (options.isPortFree ? options.isPortFree(port) : true),
    pickFreePort: async () => (options.pickFreePort ? options.pickFreePort() : 49999),
    now: () => state.clock,
    sleep: async (ms) => {
      state.sleeps.push(ms)
      state.clock += ms
    },
  }
  return { manager: new ConnectionManager(deps), state }
}

test('ConnectionManager: LAN success caches the host and skips adb entirely', async () => {
  const config = makeConfig({ host: '192.168.1.50' })
  const { manager, state } = harness(config, { probe: (host) => (host === '192.168.1.50' ? { ok: true, kind: 'health', detail: 'GET /health → HTTP 200' } : { ok: false }) })
  const snapshot = await manager.ensure()
  assert.equal(snapshot.transport, 'lan')
  assert.equal(snapshot.baseUrl, 'http://192.168.1.50:8081')
  assert.equal(snapshot.controlBaseUrl, null)
  assert.equal(snapshot.state, 'ready')
  assert.equal(manager.snapshot().cachedHost, '192.168.1.50')
  assert.deepEqual(state.forwards, [])
  assert.deepEqual(state.probes, ['192.168.1.50:8081'])
})

test('ConnectionManager: LAN failure falls through to USB and forwards both planes', async () => {
  const config = makeConfig({ host: '192.168.1.50' })
  const { manager, state } = harness(config, { probe: (host) => (host === '127.0.0.1' ? { ok: true, kind: 'health' } : { ok: false, detail: 'ECONNREFUSED' }) })
  const snapshot = await manager.ensure()
  assert.equal(snapshot.transport, 'usb')
  assert.equal(snapshot.serial, 'S1')
  assert.equal(snapshot.baseUrl, 'http://127.0.0.1:8081')
  assert.deepEqual(state.forwards, [
    { serial: 'S1', localPort: 8081, remotePort: 8081 },
    { serial: 'S1', localPort: 8808, remotePort: 8808 },
  ])
  assert.deepEqual(state.probes.filter((item) => item.startsWith('127.0.0.1')), ['127.0.0.1:8081'])
})

test('ConnectionManager: a foreign forward on 8081 pushes us to a free port', async () => {
  const config = makeConfig({ host: '192.168.1.50' })
  const { manager, state } = harness(config, {
    probe: (host, port) => (host === '127.0.0.1' && port === 49999 ? { ok: true } : { ok: false }),
    forwards: [{ serial: 'OTHER', localPort: 8081, remotePort: 8081 }],
    pickFreePort: () => 49999,
  })
  const snapshot = await manager.ensure()
  assert.equal(snapshot.baseUrl, 'http://127.0.0.1:49999')
  assert.deepEqual(state.forwards[0], { serial: 'S1', localPort: 49999, remotePort: 8081 })
})

test('ConnectionManager: both transports failing waits, then throws with every attempt', async () => {
  const config = makeConfig({ host: '192.168.1.50', waitTimeoutMs: 5000, pollIntervalMs: 2000, discovery: { enabled: false, concurrency: 8, connectTimeoutMs: 50, maxHosts: 16, subnets: [] } })
  const { manager, state } = harness(config, { probe: () => ({ ok: false, detail: 'ECONNREFUSED' }) })
  await assert.rejects(manager.ensure(), (error: unknown) => {
    assert.ok(error instanceof LocalDreamError)
    assert.equal(error.code, 'connection')
    assert.equal(error.attempts!.length, 8) // 4 rounds x (LAN + USB)
    assert.ok(error.attempts!.some((attempt) => attempt.transport === 'usb'))
    assert.match(error.message, /等待 5000ms/)
    return true
  })
  assert.deepEqual(state.sleeps, [2000, 2000, 1000])
  assert.equal(manager.snapshot().state, 'failed')
})

test('ConnectionManager: waitTimeoutMs 0 fails fast after exactly one round', async () => {
  const config = makeConfig({ host: '192.168.1.50', waitTimeoutMs: 0, discovery: { enabled: false, concurrency: 8, connectTimeoutMs: 50, maxHosts: 16, subnets: [] } })
  const { manager, state } = harness(config, { probe: () => ({ ok: false }) })
  await assert.rejects(manager.ensure(), /等待 0ms/)
  assert.deepEqual(state.sleeps, [])
  assert.deepEqual(state.probes, ['192.168.1.50:8081', '127.0.0.1:8081'])
})

test('ConnectionManager: mid-call connection loss retries with backoff and honours retryCount', async () => {
  const config = makeConfig({ host: '192.168.1.50', retryDelayMs: 1000, retryCount: 3 })
  const { manager, state } = harness(config, { probe: (host) => (host === '192.168.1.50' ? { ok: true } : { ok: false }) })
  let calls = 0
  const value = await manager.withRetry(async () => {
    calls += 1
    if (calls <= 2) {
      const error: NodeJS.ErrnoException = new Error('read ECONNRESET')
      error.code = 'ECONNRESET'
      throw error
    }
    return 'ok'
  })
  assert.equal(value, 'ok')
  assert.equal(calls, 3)
  assert.equal(state.sleeps.length, 2)
  assert.ok(state.sleeps[0]! >= 1000 && state.sleeps[0]! < 1250, `first backoff was ${state.sleeps[0]}`)
  assert.ok(state.sleeps[1]! >= 2000 && state.sleeps[1]! < 2250, `second backoff was ${state.sleeps[1]}`)

  const limited = harness(makeConfig({ host: '192.168.1.50', retryDelayMs: 10, retryCount: 1 }), { probe: (host) => (host === '192.168.1.50' ? { ok: true } : { ok: false }) })
  let limitedCalls = 0
  await assert.rejects(
    limited.manager.withRetry(async () => {
      limitedCalls += 1
      throw new Error('socket hang up')
    }),
    /socket hang up/,
  )
  assert.equal(limitedCalls, 2) // initial attempt + 1 retry

  assert.equal(isConnectionError(new Error('socket hang up')), true)
  assert.equal(isConnectionError(new LocalDreamError('args', 'bad args')), false)
  assert.equal(backoffDelay(1000, 0, () => 0), 1000)
  assert.equal(backoffDelay(1000, 10, () => 0), 30000)
})

test('ConnectionManager: concurrent ensure() calls create only one forward', async () => {
  const config = makeConfig({ host: '192.168.1.50' })
  const { manager, state } = harness(config, { probe: (host) => (host === '127.0.0.1' ? { ok: true } : { ok: false }) })
  const [first, second, third] = await Promise.all([manager.ensure(), manager.ensure(), manager.ensure()])
  assert.equal(first.baseUrl, second.baseUrl)
  assert.equal(second.baseUrl, third.baseUrl)
  assert.equal(state.forwards.length, 2) // one forward per plane, never one per caller
})

test('ConnectionManager: disconnect removes only plugin-created forwards', async () => {
  const config = makeConfig({ host: '192.168.1.50' })
  const { manager, state } = harness(config, {
    probe: (host) => (host === '127.0.0.1' ? { ok: true } : { ok: false }),
    forwards: [{ serial: 'OTHER', localPort: 9222, remotePort: 8081 }],
  })
  await manager.ensure()
  assert.equal(manager.snapshot().createdForwards.length, 2)
  const result = await manager.disconnect()
  assert.deepEqual(result.removed, ['tcp:8081 (S1)', 'tcp:8808 (S1)'])
  assert.deepEqual(result.failed, [])
  assert.deepEqual(state.removed, [
    { serial: 'S1', localPort: 8081 },
    { serial: 'S1', localPort: 8808 },
  ])
  assert.equal(manager.snapshot().state, 'idle')
  assert.equal(manager.snapshot().cachedHost, null)
  assert.equal(manager.snapshot().createdForwards.length, 0)
})

test('ConnectionManager: discover scores the control plane above an 8081-only host', async () => {
  const config = makeConfig({
    host: '192.168.1.50',
    discovery: { enabled: true, concurrency: 4, connectTimeoutMs: 10, maxHosts: 8, subnets: [] },
  })
  const { manager } = harness(config, {
    probe: (host) => (host === '10.0.5.9' ? { ok: true, kind: 'health', detail: 'GET /health → HTTP 200' } : { ok: false, detail: 'refused' }),
    discovery: [
      { host: '192.168.1.77', ports: [8808] },
      { host: '10.0.5.9', ports: [8081] },
    ],
    control: controlTransport({
      info: (request) =>
        request.baseUrl.includes('192.168.1.77')
          ? json(200, { app: 'localdream', protocol: 1, version: '3.0.0-alpha.4', device: 'V2463A' })
          : json(200, { app: 'something-else' }),
    }),
  })
  // host 192.168.1.50 (configured) has no control plane, so discovery must put
  // the scanned control-plane host ahead of the 8081-only host, and an /info
  // body that is not Local Dream must be rejected rather than accepted.
  const candidates = await manager.discover()
  assert.deepEqual(
    candidates.map((item) => [item.host, item.plane]),
    [
      ['192.168.1.77', 'control'],
      ['10.0.5.9', 'generation'],
      ['192.168.1.50', 'none'],
    ],
  )
  assert.equal(candidates[0]!.reachable, true)
  assert.equal(candidates[0]!.device, 'V2463A')
  assert.equal(candidates[2]!.reachable, false)
  assert.match(String(candidates[2]!.controlError), /不是 Local Dream/)
})

test('probeTokenize: only max_length 77 with an integer count passes', async () => {
  const original = globalThis.fetch
  const respond = (body: string, status = 200) => {
    globalThis.fetch = (async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })) as typeof fetch
  }
  try {
    respond('{"count":3,"max_length":77}')
    assert.deepEqual(await probeTokenize('127.0.0.1', 8081, 100), { ok: true, kind: 'tokenize', count: 3, maxLength: 77, detail: 'max_length=77 count=3' })
    respond('{"count":3,"max_length":75}')
    assert.equal((await probeTokenize('127.0.0.1', 8081, 100)).ok, false)
    respond('{"count":"3","max_length":77}')
    assert.equal((await probeTokenize('127.0.0.1', 8081, 100)).ok, false)
    respond('not json')
    assert.equal((await probeTokenize('127.0.0.1', 8081, 100)).ok, false)
    respond('{"error":"nope"}', 500)
    const failure = await probeTokenize('127.0.0.1', 8081, 100)
    assert.equal(failure.ok, false)
    assert.match(failure.detail!, /HTTP 500/)
  } finally {
    globalThis.fetch = original
  }
})

// --------------------------------------------- control-plane ensure flow ---

test('ConnectionManager: idle -> select -> starting -> running -> /health ok', async () => {
  const config = makeConfig({ host: '192.168.1.60', pollIntervalMs: 10, model: '', autoSelect: true })
  const statuses: ControlStatus[] = [
    { serving_model_id: null, state: 'idle', message: null, error_model_id: null, width: null, height: null },
    { serving_model_id: null, state: 'starting', message: null, error_model_id: null, width: null, height: null },
    running('sd15-core', 512, 512),
  ]
  const selectBodies: unknown[] = []
  const { manager, state } = harness(config, {
    probe: (host, port) => (host === '192.168.1.60' && port === 8081 ? { ok: true, kind: 'health' } : { ok: false }),
    control: controlTransport({
      info: () => json(200, { app: 'localdream', protocol: 1, version: '3.0.0-alpha.4', device: 'V2463A' }),
      status: () => json(200, statuses.shift() ?? running('sd15-core', 512, 512)),
      models: () => json(200, CATALOG),
      select: (request) => {
        selectBodies.push(request.body)
        return json(200, { ok: true })
      },
    }),
  })
  const snapshot = await manager.ensure()
  assert.equal(snapshot.transport, 'lan')
  assert.equal(snapshot.baseUrl, 'http://192.168.1.60:8081')
  assert.equal(snapshot.controlBaseUrl, 'http://192.168.1.60:8808')
  assert.equal(snapshot.model, 'sd15-core')
  assert.deepEqual(selectBodies, [{ model_id: 'sd15-core', width: 512, height: 512 }])
  assert.deepEqual(state.controlCalls, ['GET info', 'GET status', 'GET models', 'POST select', 'GET status', 'GET status'])
  assert.deepEqual(state.sleeps, [10, 10])
  assert.deepEqual(state.probes, ['192.168.1.60:8081'])
})

test('ConnectionManager: an already-running matching backend needs no /select', async () => {
  const config = makeConfig({ host: '192.168.1.60', model: 'sd15-core', selectWidth: 512, selectHeight: 512 })
  const { manager, state } = harness(config, {
    probe: (host) => (host === '192.168.1.60' ? { ok: true } : { ok: false }),
    control: controlTransport({
      info: () => json(200, { app: 'localdream' }),
      status: () => json(200, running('sd15-core', 512, 512)),
    }),
  })
  const snapshot = await manager.ensure()
  assert.equal(snapshot.model, 'sd15-core')
  assert.deepEqual(state.controlCalls, ['GET info', 'GET status'])
  assert.deepEqual(state.sleeps, [])
})

test('ConnectionManager: a running backend at the wrong resolution is re-selected', async () => {
  const config = makeConfig({ host: '192.168.1.60', model: 'sd15-core', selectWidth: 768, selectHeight: 768, pollIntervalMs: 5 })
  const statuses: ControlStatus[] = [running('sd15-core', 512, 512), running('sd15-core', 768, 768)]
  const selectBodies: unknown[] = []
  const { manager } = harness(config, {
    probe: () => ({ ok: true }),
    control: controlTransport({
      info: () => json(200, { app: 'localdream' }),
      status: () => json(200, statuses.shift() ?? running('sd15-core', 768, 768)),
      select: (request) => {
        selectBodies.push(request.body)
        return json(200, { ok: true })
      },
    }),
  })
  const snapshot = await manager.ensure()
  assert.deepEqual(selectBodies, [{ model_id: 'sd15-core', width: 768, height: 768 }])
  assert.equal(snapshot.model, 'sd15-core')
})

test('ConnectionManager: activation timeout reports the last observed status', async () => {
  const config = makeConfig({ host: '192.168.1.60', waitTimeoutMs: 1000, pollIntervalMs: 400, model: 'sd15-core' })
  const { manager, state } = harness(config, {
    probe: () => ({ ok: false }),
    control: controlTransport({
      info: () => json(200, { app: 'localdream' }),
      status: () => json(200, { serving_model_id: null, state: 'starting', message: 'loading', error_model_id: null, width: null, height: null }),
    }),
  })
  await assert.rejects(manager.ensure(), (error: unknown) => {
    assert.ok(error instanceof LocalDreamError)
    assert.equal(error.code, 'timeout')
    assert.match(error.message, /预算 1000ms/)
    assert.match(error.message, /state=starting/)
    assert.match(error.message, /loading/)
    return true
  })
  assert.deepEqual(state.sleeps, [400, 400, 200])
})

test('ConnectionManager: an error state is surfaced immediately with message and error_model_id', async () => {
  const config = makeConfig({ host: '192.168.1.60' })
  const { manager, state } = harness(config, {
    probe: () => ({ ok: false }),
    control: controlTransport({
      info: () => json(200, { app: 'localdream' }),
      status: () => json(200, { serving_model_id: null, state: 'error', message: 'backend start rejected', error_model_id: 'sdxl-turbo', width: null, height: null }),
      select: () => json(200, { ok: true }),
    }),
  })
  await assert.rejects(manager.ensure(), /backend start rejected.*sdxl-turbo/s)
  assert.deepEqual(state.controlCalls, ['GET info', 'GET status'])
  assert.deepEqual(state.sleeps, [])
})

test('ConnectionManager: autoSelect=false leaves an idle backend alone and reports why', async () => {
  const config = makeConfig({
    host: '192.168.1.60',
    autoSelect: false,
    waitTimeoutMs: 0,
    discovery: { enabled: false, concurrency: 4, connectTimeoutMs: 10, maxHosts: 8, subnets: [] },
  })
  const { manager, state } = harness(config, {
    probe: () => ({ ok: false }),
    control: controlTransport({
      info: () => json(200, { app: 'localdream' }),
      status: () => json(200, { serving_model_id: null, state: 'idle', message: null, error_model_id: null, width: null, height: null }),
      select: () => json(200, { ok: true }),
    }),
  })
  await assert.rejects(manager.ensure(), (error: unknown) => {
    assert.ok(error instanceof LocalDreamError)
    assert.match(error.message, /autoSelect=false/)
    return true
  })
  assert.ok(!state.controlCalls.includes('POST select'))
})

test('ConnectionManager: a rejected /select reports the server error', async () => {
  const config = makeConfig({ host: '192.168.1.60', model: 'sdxl-turbo', selectWidth: 1000, selectHeight: 1000 })
  const { manager } = harness(config, {
    probe: () => ({ ok: false }),
    control: controlTransport({
      info: () => json(200, { app: 'localdream' }),
      status: () => json(200, { serving_model_id: null, state: 'idle', message: null, error_model_id: null, width: null, height: null }),
      select: () => json(400, { error: 'DiT resolution must be 512..2048 in 24-pixel steps' }),
    }),
  })
  await assert.rejects(manager.ensure(), /POST \/select 被拒绝（HTTP 400）：DiT resolution must be 512\.\.2048/)
})

test('ConnectionManager: stop surfaces ignored:true instead of claiming success', async () => {
  const config = makeConfig({ host: '192.168.1.60' })
  const stopBodies: unknown[] = []
  const { manager } = harness(config, {
    control: controlTransport({
      info: () => json(200, { app: 'localdream' }),
      stop: (request) => {
        stopBodies.push(request.body)
        return json(200, { ok: true, ignored: true })
      },
    }),
  })
  const result = await manager.stopModel('stale-model')
  assert.equal(result.outcome.ok, true)
  assert.equal(result.outcome.ignored, true)
  assert.deepEqual(stopBodies, [{ model_id: 'stale-model' }])
})

// ------------------------------------------------------------ config ------

test('Config: defaults fill in, including the nested discovery object', () => {
  const config = Config({}) as unknown as Record<string, unknown>
  assert.equal(config.mode, 'auto')
  assert.equal(config.host, '')
  assert.equal(config.port, 8081)
  assert.equal(config.controlPort, 8808)
  assert.equal(config.localPort, 0)
  assert.equal(config.autoSelect, true)
  assert.equal(config.model, '')
  assert.equal(config.selectWidth, 0)
  assert.equal(config.selectHeight, 0)
  assert.equal(config.waitTimeoutMs, 120000)
  assert.equal(config.pollIntervalMs, 2000)
  assert.equal(config.retryCount, 3)
  assert.equal(config.retryDelayMs, 2000)
  assert.equal(config.probeTimeoutMs, 5000)
  assert.equal(config.requestTimeoutMs, 300000)
  assert.deepEqual(config.discovery, { enabled: true, concurrency: 64, connectTimeoutMs: 400, maxHosts: 1024, subnets: [] })
  assert.equal(config.outputDir, '')
})

test('Config: rejects an unknown mode and out-of-range numbers', () => {
  assert.throws(() => Config({ mode: 'bogus' } as never))
  assert.throws(() => assertConfig(makeConfig({ mode: 'carrier-pigeon' })), /未知 mode/)
  assert.throws(() => assertConfig(makeConfig({ port: 70000 })), /port 必须在 0-65535/)
  assert.throws(() => assertConfig(makeConfig({ controlPort: -1 })), /controlPort 必须在 0-65535/)
  assert.throws(() => assertConfig(makeConfig({ localPort: -1 })), /localPort 必须在 0-65535/)
  assert.throws(() => assertConfig(makeConfig({ selectWidth: -1 })), /selectWidth 必须是非负整数/)
  assert.throws(() => assertConfig(makeConfig({ pollIntervalMs: 0 })), /pollIntervalMs 必须是正整数/)
  assert.throws(() => assertConfig(makeConfig({ retryDelayMs: 1.5 })), /retryDelayMs 必须是正整数/)
  assert.throws(() => assertConfig(makeConfig({ retryCount: -1 })), /retryCount 必须是非负整数/)
  assert.throws(() => assertConfig(makeConfig({ waitTimeoutMs: 0.5 })), /waitTimeoutMs 必须是非负整数/)
  assert.throws(() => assertConfig(makeConfig({ autoSelect: 'yes' })), /autoSelect 必须是布尔值/)
  assert.throws(
    () => assertConfig(makeConfig({ discovery: { enabled: true, concurrency: 0, connectTimeoutMs: 400, maxHosts: 1, subnets: [] } })),
    /discovery.concurrency 必须是正整数/,
  )
  assert.doesNotThrow(() => assertConfig(makeConfig({ waitTimeoutMs: 0, port: 0, localPort: 65535, controlPort: 0 })))
})

test('Config: outputDir resolution and port checks degrade safely', async () => {
  assert.equal(resolveOutputDir({ outputDir: 'C:/custom' }, {}), 'C:/custom')
  assert.equal(resolveOutputDir({ outputDir: '' }, { DSH_HOME: 'C:/dsh-home' }), path.join('C:/dsh-home', 'outputs', 'local-dream'))
  assert.ok(resolveOutputDir({ outputDir: '' }, {}).endsWith(path.join('outputs', 'local-dream')))
  assert.equal(await canBindPort(0), true)
})
