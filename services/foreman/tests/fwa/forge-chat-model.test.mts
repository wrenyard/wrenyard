import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ForgeChatModel } from '../../lib/core/fwa/forge-chat-model.mts'
import { HumanMessage, AIMessage, ToolMessage, SystemMessage } from '@langchain/core/messages'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'

void describe('forge-chat-model', () => {
  void it('parses text response', async () => {
    const model = new ForgeChatModel({
      config: { model: 'test-model',  turnTimeoutMs: 30000 },
      rawExecutor: async () => ({
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Hello, world!' },
          finish_reason: 'stop',
        }],
      }),
    })
    const result = await model.invoke([new HumanMessage('Hi')])
    assert.equal(typeof result.content, 'string')
    assert.equal(result.content, 'Hello, world!')
  })

  void it('parses tool_calls with object-form args', async () => {
    const model = new ForgeChatModel({
      config: { model: 'test-model',  turnTimeoutMs: 30000 },
      rawExecutor: async () => ({
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'test_tool', arguments: '{"key":"value","num":42}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      }),
    })
    const result = await model.invoke([new HumanMessage('Use tool')])
    assert.ok(Array.isArray(result.tool_calls))
    assert.equal(result.tool_calls?.length, 1)
    assert.equal(result.tool_calls![0].name, 'test_tool')
    // Args must be an object (Record<string, any>), not a string
    assert.equal(typeof result.tool_calls![0].args, 'object')
    assert.notEqual(result.tool_calls![0].args, null)
    assert.ok(!Array.isArray(result.tool_calls![0].args))
    assert.deepEqual(result.tool_calls![0].args, { key: 'value', num: 42 })
  })

  void it('supports bindTools', async () => {
    const model = new ForgeChatModel({
      config: { model: 'test-model',  turnTimeoutMs: 30000 },
      rawExecutor: async () => ({
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'bound result' },
          finish_reason: 'stop',
        }],
      }),
    })
    const bound = model.bindTools([{
      name: 'my_tool',
      description: 'A test tool',
      schema: { type: 'object', properties: { x: { type: 'string' } } },
    }])
    const result = await bound.invoke([new HumanMessage('Test bound')])
    assert.equal(typeof result.content, 'string')
    assert.equal(result.content, 'bound result')
  })

  void it('serializes tool result continuation', async () => {
    const model = new ForgeChatModel({
      config: { model: 'test-model',  turnTimeoutMs: 30000 },
      rawExecutor: async () => ({
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Done' },
          finish_reason: 'stop',
        }],
      }),
    })
    const messages = [
      new HumanMessage('Continue'),
      new AIMessage({ content: '', tool_calls: [{ id: 'call_1', name: 't', args: {}, type: 'tool_call' }] }),
      new ToolMessage({ content: 'result', tool_call_id: 'call_1' }),
    ]
    const result = await model.invoke(messages)
    assert.equal(result.content, 'Done')
  })

  void it('throws on malformed response', async () => {
    const model = new ForgeChatModel({
      config: { model: 'test-model',  turnTimeoutMs: 30000 },
      rawExecutor: async () => ({ choices: [] }),
    })
    await assert.rejects(
      () => model.invoke([new HumanMessage('Hi')]),
      /empty choices/,
    )
  })

  void it('throws on executor error', async () => {
    const model = new ForgeChatModel({
      config: { model: 'test-model',  turnTimeoutMs: 30000 },
      rawExecutor: async () => { throw new Error('network error') },
    })
    await assert.rejects(
      () => model.invoke([new HumanMessage('Hi')]),
      /raw executor error/,
    )
  })

  void it('serializes DynamicStructuredTool Zod schema into JSON Schema parameters', async () => {
    let capturedTools: unknown[] | undefined
    const model = new ForgeChatModel({
      config: { model: 'test-model',  turnTimeoutMs: 30000 },
      rawExecutor: async (params) => {
        capturedTools = params.tools
        return {
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Tool result' },
            finish_reason: 'stop',
          }],
        }
      },
    })
    const tool = new DynamicStructuredTool({
      name: 'weather_tool',
      description: 'Get weather for a location',
      schema: z.object({
        location: z.string().describe('The city name'),
        unit: z.enum(['celsius', 'fahrenheit']).describe('Temperature unit'),
      }),
      func: async () => 'sunny',
    })
    const bound = model.bindTools([tool])
    await bound.invoke([new HumanMessage('Weather in Paris')])
    assert.ok(Array.isArray(capturedTools), 'tools should be present in raw request')
    assert.equal(capturedTools!.length, 1)
    const serialized = capturedTools![0] as Record<string, unknown>
    assert.equal(serialized.type, 'function')
    const fn = serialized.function as Record<string, unknown>
    assert.equal(fn.name, 'weather_tool')
    assert.equal(fn.description, 'Get weather for a location')
    const params = fn.parameters as Record<string, unknown>
    // Must be valid JSON Schema, not Zod internals
    assert.equal(params.type, 'object')
    const props = params.properties as Record<string, unknown>
    assert.ok(props.location, 'location property should be present')
    assert.ok(props.unit, 'unit property should be present')
  })

  void it('preserves already-formatted OpenAI tool definitions', async () => {
    let capturedTools: unknown[] | undefined
    const model = new ForgeChatModel({
      config: { model: 'test-model',  turnTimeoutMs: 30000 },
      rawExecutor: async (params) => {
        capturedTools = params.tools
        return {
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Preformatted done' },
            finish_reason: 'stop',
          }],
        }
      },
    })
    const preformatted = {
      type: 'function',
      function: {
        name: 'pre_tool',
        description: 'Already formatted tool',
        parameters: { type: 'object', properties: { x: { type: 'string' } } },
      },
    }
    const bound = model.bindTools([preformatted])
    await bound.invoke([new HumanMessage('Use preformatted')])
    assert.ok(Array.isArray(capturedTools))
    assert.equal(capturedTools!.length, 1)
    const serialized = capturedTools![0] as Record<string, unknown>
    assert.equal(serialized.type, 'function')
    const fn = serialized.function as Record<string, unknown>
    assert.equal(fn.name, 'pre_tool')
  })
})
