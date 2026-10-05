import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config, inject, name } from '../src/index.ts'

test('plugin metadata', () => {
  assert.equal(name, 'cordis-plugin-local-dream')
  assert.ok(inject.includes('tools'))
})

test('apply registers local_dream_api, local_dream_device and local_dream_generate', () => {
  const registered: string[] = []
  const ctx = {
    tools: {
      register: (tool: { name: string }) => {
        registered.push(tool.name)
        return () => {}
      },
    },
  }
  apply(ctx as never, Config({}) as never)
  assert.deepEqual(registered, ['local_dream_api', 'local_dream_device', 'local_dream_generate'])
})

test('apply rejects an invalid config before registering anything', () => {
  const registered: string[] = []
  const ctx = {
    tools: {
      register: (tool: { name: string }) => {
        registered.push(tool.name)
        return () => {}
      },
    },
  }
  assert.throws(() => apply(ctx as never, Config({ port: 123456 }) as never), /port 必须在 0-65535/)
  assert.deepEqual(registered, [])
})

test('registered tools keep the documented exec contract', () => {
  const tools: Array<Record<string, unknown>> = []
  const ctx = {
    tools: {
      register: (tool: Record<string, unknown>) => {
        tools.push(tool)
        return () => {}
      },
    },
  }
  apply(ctx as never, Config({ waitTimeoutMs: 1000, requestTimeoutMs: 2000 }) as never)
  assert.equal(tools.length, 3)
  for (const tool of tools) {
    assert.equal(typeof tool.execute, 'function')
    assert.equal((tool as { timeoutMs: number }).timeoutMs, 3000)
    assert.equal(typeof (tool as { presentCall: unknown }).presentCall, 'function')
    const parameters = (tool as { parameters: Record<string, { required?: boolean }> }).parameters
    assert.ok(Object.keys(parameters).length > 0)
  }
  const api = tools.find((tool) => tool.name === 'local_dream_api')!
  const apiSchema = api.parameters as { properties: Record<string, { default?: unknown; enum?: unknown[] }> }
  assert.equal(apiSchema.properties.method!.default, 'POST')
  assert.deepEqual(apiSchema.properties.method!.enum, ['GET', 'POST', 'HEAD'])
  assert.equal(apiSchema.properties.endpoint!.default, undefined)
  assert.deepEqual((api.parameters as { required?: string[] }).required, ['endpoint'])
  assert.equal((api.isConcurrencySafe as (args: Record<string, unknown>) => boolean)({ endpoint: 'tokenize', method: 'GET' }), true)
  assert.equal((api.isConcurrencySafe as (args: Record<string, unknown>) => boolean)({ endpoint: 'generate', method: 'POST' }), false)
  assert.equal((api.isConcurrencySafe as (args: Record<string, unknown>) => boolean)({ method: 'GET' }), false, 'invalid args are never concurrency-safe')
  const generate = tools.find((tool) => tool.name === 'local_dream_generate')!
  assert.equal((generate.isConcurrencySafe as (args: Record<string, unknown>) => boolean)({ prompt: 'x' }), false)
  const device = tools.find((tool) => tool.name === 'local_dream_device')!
  const deviceSchema = device.parameters as { properties: Record<string, { enum?: string[] }> }
  assert.deepEqual(deviceSchema.properties.action!.enum, [
    'status',
    'discover',
    'connect',
    'disconnect',
    'devices',
    'models',
    'select',
    'stop',
  ])
})
