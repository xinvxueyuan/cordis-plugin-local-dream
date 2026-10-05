import type { Context } from '@deepseek-ai/cordis'
import { assertConfig, Config, type LocalDreamConfig } from './config.ts'
import { createConnectionDeps, ConnectionManager } from './connection.ts'
import { defineApiTool } from './tool-api.ts'
import { defineDeviceTool } from './tool-device.ts'
import { defineGenerateTool } from './tool-generate.ts'

export const name = 'cordis-plugin-local-dream'
export const inject = ['tools']
export { Config }

/** Register the Local Dream tools. Registrations are effect-based: the loader
 *  disposes them automatically when the plugin fiber is removed. */
export function apply(ctx: Context, config: LocalDreamConfig): void {
  assertConfig(config)
  const manager = new ConnectionManager(createConnectionDeps(config))
  ctx.tools.register(defineApiTool(config, manager))
  ctx.tools.register(defineDeviceTool(config, manager))
  ctx.tools.register(defineGenerateTool(config, manager))
}
