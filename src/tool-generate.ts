import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveOutputDir, type LocalDreamConfig } from './config.ts'
import { buildGenerateBody, defaultGenerationDeps, runGeneration, SCHEDULERS } from './generate.ts'
import { fetchLocalDream } from './http.ts'
import { LocalDreamError } from './errors.ts'
import type { ConnectionManager, EnsureOptions } from './connection.ts'
import type { JsonValue } from './types.ts'

/** The high-level generation tool: one phone, one backend, never concurrent. */
export function defineGenerateTool(config: LocalDreamConfig, manager: ConnectionManager) {
  return defineTool({
    name: 'local_dream_generate',
    description:
      '在 Local Dream 后端上执行一次 Stable Diffusion 生成，并把结果写成 PNG 文件。' +
      '插件自动建立连接（LAN 优先，USB/adb 回退），增量消费 /generate 的 SSE 流：progress 事件累计进度，' +
      '{"type":"error"} 立即抛出服务端错误，complete 事件里的 base64（原始 RGB 像素，非 PNG）会被校验长度并编码为 PNG 落盘。' +
      '未指定 outputPath 时写入 <DSH_HOME>/outputs/local-dream/<UTC 时间戳>_<seed>.png。' +
      '若 App 处于 Device Link 主机模式，插件会经 8808 控制平面确认/切换模型（必要时 POST /select 并轮询到 running）后再生成。' +
      '返回 { transport, host|serial, model, path, bytes, seed, width, height, channels, generationTimeMs, firstStepTimeMs, progressEvents }。',
    parameters: {
      prompt: { type: 'string', required: true, description: '正向提示词（必填）' },
      negative_prompt: { type: 'string', description: '负向提示词，默认空字符串' },
      steps: { type: 'integer', description: '采样步数，默认 20' },
      cfg: { type: 'number', description: 'CFG 强度，默认 7.5' },
      seed: { type: 'integer', description: '随机种子（uint）；省略时由后端随机' },
      scheduler: {
        type: 'string',
        enum: [...SCHEDULERS],
        description: `采样器，可选 ${SCHEDULERS.join(' / ')}（lcm 没有 _karras 变体）`,
      },
      size: { type: 'integer', description: '正方形边长；提供时覆盖 width/height' },
      width: { type: 'integer', description: '宽度，默认 512' },
      height: { type: 'integer', description: '高度，默认 512' },
      use_opencl: { type: 'boolean', description: '是否使用 OpenCL 后端，默认 false' },
      show_diffusion_process: { type: 'boolean', description: 'progress 事件是否附带中间预览图，默认 false' },
      show_diffusion_stride: { type: 'integer', description: '预览图输出步长，默认 1' },
      image: { type: 'string', description: 'img2img 底图：PNG/JPG 字节的 base64' },
      mask: { type: 'string', description: 'inpaint 蒙版：PNG/JPG 字节的 base64，必须与 image 同时提供' },
      denoise_strength: { type: 'number', description: 'img2img 去噪强度，默认 0.6' },
      aspect_ratio: { type: 'string', description: '宽高比（仅 SDXL NPU），如 "1:1"' },
      outputPath: {
        type: 'string',
        description: 'PNG 输出路径（绝对路径或相对工作区）；省略则写入 outputDir 下的时间戳文件名',
      },
      transport: { type: 'string', enum: ['auto', 'lan', 'usb'], description: '单次调用覆盖传输方式' },
      host: { type: 'string', description: '单次调用覆盖局域网主机' },
      serial: { type: 'string', description: '单次调用覆盖目标设备 serial' },
      model: {
        type: 'string',
        description: '期望的模型 id；与当前正在服务的模型不一致时会先经控制平面 POST /select 切换（Device Link 主机模式）',
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
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: 'generic',
      title: `LOCAL DREAM generate ${truncate(args.prompt, 60)}`,
      kind: 'execute',
      rawInput: {
        steps: args.steps ?? 20,
        size: args.size ?? `${args.width ?? 512}x${args.height ?? 512}`,
        scheduler: args.scheduler ?? 'dpm',
        outputPath: args.outputPath,
      },
    }),
    async execute(args, exec) {
      const body = buildGenerateBody(args as unknown as Record<string, unknown>)
      const override: EnsureOptions = { signal: exec.signal }
      if (args.transport === 'lan' || args.transport === 'usb') override.transport = args.transport
      if (args.host !== undefined && args.host !== '') override.host = args.host
      if (args.serial !== undefined && args.serial !== '') override.serial = args.serial
      if (args.model !== undefined && args.model !== '') override.model = args.model
      const outputDir = resolveOutputDir(config)
      return manager.withRetry(async (connection) => {
        if (!connection.baseUrl) throw new LocalDreamError('connection', '连接已建立但 baseUrl 缺失（内部状态异常）')
        const baseUrl = connection.baseUrl
        const deps = defaultGenerationDeps(async (streamBody, signal) =>
          fetchLocalDream({
            baseUrl,
            endpoint: 'generate',
            method: 'POST',
            body: streamBody,
            // 流式的超时预算由 inactivityTimeoutMs 逐块判定，不设整体超时
            timeoutMs: 0,
            signal: signal ?? exec.signal,
          }),
        )
        const result = await runGeneration(deps, {
          body,
          ...(args.outputPath !== undefined && args.outputPath !== '' ? { outputPath: args.outputPath } : {}),
          outputDir,
          inactivityTimeoutMs: config.requestTimeoutMs,
          signal: exec.signal,
        })
        return {
          transport: connection.transport,
          host: connection.host,
          serial: connection.serial,
          model: connection.model,
          ...result,
        } as JsonValue
      }, override)
    },
  })
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
