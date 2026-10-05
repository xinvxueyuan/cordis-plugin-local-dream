import { defineTool } from '@deepseek-ai/dsh-tools'
import { errorMessage, LocalDreamError } from './errors.ts'
import { toJsonValue } from './control.ts'
import type { LocalDreamConfig } from './config.ts'
import type { ConnectionManager, EnsureOptions } from './connection.ts'
import type { DeviceEntry, ForwardEntry, JsonValue } from './types.ts'

const ACTIONS = ['status', 'discover', 'connect', 'disconnect', 'devices', 'models', 'select', 'stop'] as const

function deviceJson(device: DeviceEntry): Record<string, JsonValue> {
  return {
    serial: device.serial,
    state: device.state,
    properties: device.properties,
    raw: device.raw,
  }
}

function forwardJson(entry: ForwardEntry): Record<string, JsonValue> {
  return {
    serial: entry.serial,
    localPort: entry.localPort,
    remotePort: entry.remotePort,
  }
}

/** Connection lifecycle and Device Link control tool. */
export function defineDeviceTool(config: LocalDreamConfig, manager: ConnectionManager) {
  return defineTool({
    name: 'local_dream_device',
    description:
      '管理 Local Dream 的设备连接与 Device Link 控制平面。' +
      'status 查看 adb 解析结果、当前传输与控制平面状态；discover 主动做一次 LAN 发现（先探 8808 /info 指纹，再探 8081 /health，并列出 adb 推导的手机 Wi-Fi IP 与网段扫描结果）；' +
      'connect 强制建立连接（可覆盖 transport/host/serial）；disconnect 只移除本插件创建的 adb forward 并清空缓存主机，绝不触碰 adb server 与其他 forward；devices 返回 adb devices -l 解析结果；' +
      'models 返回控制平面的模型目录（仅手机已下载的模型）；select 通过 POST /select 启动后端并轮询到 running；stop 通过 POST /stop 停止后端（会如实报告 ignored）。',
    parameters: {
      action: {
        type: 'string',
        enum: [...ACTIONS],
        required: true,
        description: '要执行的动作',
      },
      transport: { type: 'string', enum: ['auto', 'lan', 'usb'], description: 'connect 时覆盖传输方式' },
      host: { type: 'string', description: 'connect/discover 时覆盖局域网主机' },
      serial: { type: 'string', description: 'connect 时覆盖目标设备 serial' },
      model_id: {
        type: 'string',
        description: 'select/stop 的模型 id（select 必填；stop 可省略。伪 id "__upscaler__" 表示独立放大模式）',
      },
      width: { type: 'integer', description: 'select 的宽度，默认 512' },
      height: { type: 'integer', description: 'select 的高度，默认 512' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => {
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
        return [{ type: 'text', text }]
      },
    },
    timeoutMs: config.requestTimeoutMs + config.waitTimeoutMs,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: `LOCAL DREAM device ${args.action}${args.model_id ? ` ${args.model_id}` : ''}`,
      kind: 'other',
      rawInput:
        args.action === 'connect'
          ? { transport: args.transport, host: args.host, serial: args.serial }
          : args.action === 'select'
            ? { model_id: args.model_id, width: args.width, height: args.height }
            : args.action === 'stop'
              ? { model_id: args.model_id }
              : undefined,
    }),
    async execute(args, exec) {
      switch (args.action) {
        case 'status':
          return status(manager, exec.signal)
        case 'discover': {
          const candidates = await manager.discover({
            ...(args.host !== undefined && args.host !== '' ? { host: args.host } : {}),
            signal: exec.signal,
          })
          const devices = await safeDevices(manager, exec.signal)
          return { candidates, ...devices } as JsonValue
        }
        case 'connect': {
          const override: EnsureOptions = { signal: exec.signal }
          if (args.transport === 'lan' || args.transport === 'usb') override.transport = args.transport
          if (args.host !== undefined && args.host !== '') override.host = args.host
          if (args.serial !== undefined && args.serial !== '') override.serial = args.serial
          const snapshot = await manager.ensure(override)
          return { ok: true, connection: snapshotJson(snapshot) } as JsonValue
        }
        case 'disconnect': {
          const result = await manager.disconnect(exec.signal)
          return {
            ok: true,
            removedForwards: result.removed,
            failedForwards: result.failed,
            note: '仅移除本插件创建的 adb forward；adb server 与其他 forward 未被触碰',
          } as JsonValue
        }
        case 'devices':
          return { devices: (await manager.devices(exec.signal)).map(deviceJson) } as JsonValue
        case 'models': {
          const { baseUrl, catalog } = await manager.models(exec.signal)
          return {
            controlBaseUrl: baseUrl,
            use_img2img: catalog.use_img2img,
            models: toJsonValue(catalog.models),
            upscalers: toJsonValue(catalog.upscalers),
            note: '仅列出手机上已下载的模型；select 会用 model_id + width/height 激活其中之一',
          } as JsonValue
        }
        case 'select': {
          const modelId = args.model_id?.trim()
          if (!modelId) {
            throw new LocalDreamError('args', 'select 需要 model_id（先用 action: "models" 查看可用模型）')
          }
          const result = await manager.selectModel(
            {
              modelId,
              ...(args.width !== undefined && args.width > 0 ? { width: args.width } : {}),
              ...(args.height !== undefined && args.height > 0 ? { height: args.height } : {}),
            },
            exec.signal,
          )
          return {
            controlBaseUrl: result.baseUrl,
            ok: true,
            status: toJsonValue(result.status),
            note: '后端已进入 running；生成端口 8081 会在随后开始监听',
          } as JsonValue
        }
        case 'stop': {
          const { baseUrl, outcome } = await manager.stopModel(args.model_id, exec.signal)
          return {
            controlBaseUrl: baseUrl,
            ok: outcome.ok,
            ignored: outcome.ignored,
            httpStatus: outcome.status,
            note: outcome.ignored
              ? '服务端返回 ignored: true —— 该 model_id 不是当前选择，后端并未被停止（如实报告，不当作成功）'
              : '已请求停止后端',
          } as JsonValue
        }
        default:
          throw new LocalDreamError('args', `未知 action: ${String(args.action)}`)
      }
    },
  })
}

function snapshotJson(snapshot: ReturnType<ConnectionManager['snapshot']>): Record<string, JsonValue> {
  return {
    state: snapshot.state,
    transport: snapshot.transport,
    host: snapshot.host,
    serial: snapshot.serial,
    baseUrl: snapshot.baseUrl,
    controlBaseUrl: snapshot.controlBaseUrl,
    model: snapshot.model,
    cachedHost: snapshot.cachedHost,
    lastError: snapshot.lastError,
    createdForwards: snapshot.createdForwards.map(forwardJson),
  }
}

async function status(manager: ConnectionManager, signal: AbortSignal): Promise<JsonValue> {
  const config = manager.config
  let devices: DeviceEntry[] | null = null
  let devicesError: string | null = null
  try {
    devices = await manager.devices(signal)
  } catch (error) {
    devicesError = errorMessage(error)
  }
  const snapshot = manager.snapshot()
  return {
    mode: config.mode,
    configuredHost: config.host,
    port: config.port,
    controlPort: config.controlPort,
    localPort: config.localPort,
    autoSelect: config.autoSelect,
    model: config.model,
    selectWidth: config.selectWidth,
    selectHeight: config.selectHeight,
    waitTimeoutMs: config.waitTimeoutMs,
    discovery: {
      enabled: config.discovery.enabled,
      subnets: config.discovery.subnets,
      maxHosts: config.discovery.maxHosts,
      concurrency: config.discovery.concurrency,
      connectTimeoutMs: config.discovery.connectTimeoutMs,
    },
    connection: snapshotJson(snapshot),
    adb: snapshot.adb
      ? { path: snapshot.adb.path, source: snapshot.adb.source, version: snapshot.adb.version }
      : null,
    devices: devices ? devices.map(deviceJson) : null,
    devicesError,
  }
}

async function safeDevices(manager: ConnectionManager, signal: AbortSignal): Promise<Record<string, JsonValue>> {
  try {
    return { devices: (await manager.devices(signal)).map(deviceJson) }
  } catch (error) {
    return { devices: null, devicesError: errorMessage(error) }
  }
}
