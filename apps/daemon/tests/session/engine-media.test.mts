/**
 * Focused PUBLIC engine integration tests for turn media semantics.
 *
 * These tests drive the real engine (`createEngine`) with a real temp `Ledger`,
 * a real `FileStore`, real views and a fake `CallsPort`/host. No model or
 * network call is made. The fake call port records the exact request messages
 * per role and writes the `call.started` observation marker, so the engine's
 * per-turn media delivery can be inspected from the public ledger alone.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  collectSessionFiles,
  FileStore,
  type AttachmentInput,
  type CallRunRequest,
  type CallRunResult,
  type CallsPort,
  type EnginePorts,
  type LedgerEvent,
  type LedgerEventDraft,
  type ModelContentPart,
  type ModelMessage,
  type Session,
  type SessionHost,
  type TaskArtifact,
} from '@wrenyard/session'
import { createEngine } from '../../../../packages/features/session/src/engine.ts'
import { Ledger } from '../../../../packages/features/session/src/ledger.ts'
import { createViews } from '../../../../packages/features/session/src/views.ts'
import { createCallRunner } from '../../../../packages/features/session/src/calls.ts'
import {
  createWorkspaceSnapshot,
  WorkspaceFileSource,
} from '../../../../packages/features/session/src/workspace.ts'

interface SharpPipeline {
  png(): SharpPipeline
  toBuffer(): Promise<Buffer>
}

interface SharpFactory {
  (options: { create: { width: number; height: number; channels: number; background: string } }): SharpPipeline
}

// sharp is owned by the session package; resolve it through that manifest.
const requireFromSession = createRequire(
  fileURLToPath(new URL('../../../../packages/features/session/package.json', import.meta.url)),
)
const sharp = requireFromSession('sharp') as SharpFactory

const IMAGE_MODEL = { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'high' } as const
const NOIMAGE_MODEL = { provider: 'anthropic', model: 'claude-haiku-4-5', reasoningEffort: 'high' } as const

const DEFAULTS: Record<string, string> = {
  'memory-search': '{"picks":[]}',
  'doc-search': '{"understanding":"","picks":[],"near":[]}',
  compile: '{"project":"demo","task":"tool","input":{},"ctx":{}}',
  reply: '收到',
  title: '会话标题',
}

// ─── fake call port ────────────────────────────────────────────────────────

interface StreamingEntry {
  text: string
  reasoning?: string
  chunk?: number
  /** Native tool calls delivered through `onToolCall`, before the visible text. */
  toolCalls?: ScriptToolCall[]
  /** Blocks the call until it resolves or the signal aborts (keeps it in flight). */
  wait?: Promise<void>
}

interface ScriptToolCall {
  id: string
  type: string
  intent: string
}

type ScriptEntry = string | StreamingEntry | ((input: CallRunRequest) => string)

/** Resolve with `promise`, or reject as soon as `signal` aborts. */
function waitForAbort(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('aborted'))
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(new Error('aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

interface FakeCallsOptions {
  ledger: Ledger
  sessionId: string
  script: Record<string, ScriptEntry[]>
  captured: CallRunRequest[]
  reasonModel: string
  auxiliaryModel: string
}

function createFakeCalls(options: FakeCallsOptions): CallsPort {
  const counts: Record<string, number> = {}
  return {
    async run(input: CallRunRequest): Promise<CallRunResult> {
      options.captured.push(input)
      const model = input.role === 'reason' ? options.reasonModel : options.auxiliaryModel
      await options.ledger.append(options.sessionId, {
        type: 'call.started',
        callId: input.callId,
        role: input.role,
        model,
        ...(input.turn === undefined ? {} : { turn: input.turn }),
        ...(input.cycle === undefined ? {} : { cycle: input.cycle }),
      })
      const list = options.script[input.role] ?? []
      const index = counts[input.role] ?? 0
      counts[input.role] = index + 1
      const entry = list.length === 0 ? undefined : list[Math.min(index, list.length - 1)]
      if (entry === undefined) {
        const text = DEFAULTS[input.role] ?? ''
        input.onText?.(text)
        return { model, text }
      }
      if (typeof entry === 'function') {
        const text = entry(input)
        input.onText?.(text)
        return { model, text }
      }
      if (typeof entry === 'string') {
        input.onText?.(entry)
        return { model, text: entry }
      }
      if (entry.wait !== undefined) await waitForAbort(entry.wait, input.signal)
      for (const [position, call] of (entry.toolCalls ?? []).entries()) {
        input.onToolCall?.({ index: position, type: call.type, intent: call.intent })
      }
      if (entry.reasoning !== undefined) input.onReasoning?.(entry.reasoning)
      if (entry.chunk === undefined) input.onText?.(entry.text)
      else for (let at = 0; at < entry.text.length; at += entry.chunk) input.onText?.(entry.text.slice(at, at + entry.chunk))
      return { model, text: entry.text, ...(entry.reasoning === undefined ? {} : { reasoning: entry.reasoning }) }
    },
  }
}

// ─── harness ───────────────────────────────────────────────────────────────

interface HarnessOptions {
  taskDefinitions?: { id: string; description: string; project?: string; inputSummary: string[] }[]
  describeTask?: SessionHost['describeTask']
  artifactsFor?: (taskRunId: string) => TaskArtifact[]
  waitTaskRun?: SessionHost['waitTaskRun']
}

interface Harness {
  root: string
  wsRoot: string
  ledger: Ledger
  fileStore: FileStore
  engine: Session
  script: Record<string, ScriptEntry[]>
  captured: Map<string, CallRunRequest[]>
  createdRuns: { task: string; project?: string }[]
  cleanup(): void
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'wrenyard-engine-media-'))
  const wsRoot = join(root, 'workspace')
  mkdirSync(wsRoot, { recursive: true })
  const ledger = new Ledger({ stateRoot: root, workspaceRoot: wsRoot })
  const fileStore = new FileStore({ stateRoot: root })
  const script: Record<string, ScriptEntry[]> = {
    reason: [],
    'memory-search': [],
    'doc-search': [],
    compile: [],
    reply: [],
    title: [],
  }
  const captured = new Map<string, CallRunRequest[]>()
  const createdRuns: { task: string; project?: string }[] = []

  const host: SessionHost = {
    workspaceRoot: wsRoot,
    stateRoot: root,
    resolveInferenceProvider: () => undefined,
    deviceName: 'test-device',
    gateway: async () => ({
      openaiChatBaseUrl: 'http://127.0.0.1:1',
      openaiResponsesBaseUrl: 'http://127.0.0.1:1',
      anthropicBaseUrl: 'http://127.0.0.1:1',
      token: 'test',
      models: [],
    }),
    selectAuxiliary: async () => [{ model: 'openai/gpt-6.1-sol', reasoningEffort: 'none' }],
    listProjects: async () => [{ id: 'demo', workspaceDir: 'projects/demo' }],
    gitHead: async () => ({}),
    listTaskDefinitions: async () => options.taskDefinitions ?? [],
    describeTask: options.describeTask ?? (async (id) => ({
      description: `${id} task`,
      inputSchema: { type: 'object' },
      source: 'project',
      builtinDoc: false,
    })),
    createTaskRun: async (params) => {
      createdRuns.push({ task: params.task, ...(params.project === undefined ? {} : { project: params.project }) })
      return { taskRunId: `run-${createdRuns.length}` }
    },
    waitTaskRun: options.waitTaskRun ?? (async (taskRunId) => {
      const artifacts = options.artifactsFor?.(taskRunId) ?? []
      return { status: 'done', output: `completed ${taskRunId}`, ...(artifacts.length === 0 ? {} : { artifacts }) }
    }),
    cancelTaskRun: async () => undefined,
  }

  const ports: EnginePorts = {
    ledger,
    createSnapshot: (input) => createWorkspaceSnapshot(input),
    files: (snapshot, workspaceRoot) => new WorkspaceFileSource({ workspaceRoot, snapshot }),
    views: createViews(),
    calls: (sessionId) => {
      let list = captured.get(sessionId)
      if (!list) {
        list = []
        captured.set(sessionId, list)
      }
      return createFakeCalls({
        ledger,
        sessionId,
        script,
        captured: list,
        reasonModel: `${IMAGE_MODEL.provider}/${IMAGE_MODEL.model}`,
        auxiliaryModel: 'test/cheap',
      })
    },
    fileStore,
  }

  const engine = createEngine(host, ports)
  return {
    root,
    wsRoot,
    ledger,
    fileStore,
    engine,
    script,
    captured,
    createdRuns,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

async function withHarness<T>(options: HarnessOptions, fn: (harness: Harness) => Promise<T>): Promise<T> {
  const harness = makeHarness(options)
  try {
    return await fn(harness)
  } finally {
    await harness.engine.close().catch(() => undefined)
    harness.cleanup()
  }
}

async function waitIdle(engine: Session, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (engine.hasRunningTurns()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the engine to go idle')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

// ─── fixtures and helpers ──────────────────────────────────────────────────

async function pngBytes(width: number, height: number, background = '#3355ff'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background } }).png().toBuffer()
}

function writePng(root: string, name: string, bytes: Buffer): string {
  const file = join(root, name)
  writeFileSync(file, bytes)
  return file
}

function attachment(path: string, name?: string): AttachmentInput {
  return { path, ...(name === undefined ? {} : { name }) }
}

function imageUrls(messages: readonly ModelMessage[]): string[] {
  const urls: string[] = []
  for (const message of messages) {
    if (typeof message.content === 'string') continue
    for (const part of message.content) if (part.type === 'image_url') urls.push(part.image_url.url)
  }
  return urls
}

function messageText(messages: readonly ModelMessage[]): string {
  return messages
    .map((message) => (typeof message.content === 'string'
      ? message.content
      : message.content.map((part: ModelContentPart) => (part.type === 'text' ? part.text : '')).join('')))
    .join('\n')
}

function callsOfRole(harness: Harness, sessionId: string, role: string): CallRunRequest[] {
  return (harness.captured.get(sessionId) ?? []).filter((call) => call.role === role)
}

function eventsOfType<T extends LedgerEvent['type']>(
  events: LedgerEvent[],
  type: T,
): Extract<LedgerEvent, { type: T }>[] {
  return events.filter((event): event is Extract<LedgerEvent, { type: T }> => event.type === type)
}

const IMAGE_TASK = { id: 'img', description: 'image task', project: 'demo', inputSummary: [] as string[] }
const ALL_TASKS = [IMAGE_TASK, { id: 'tool', description: 'tool', project: 'demo', inputSummary: [] as string[] }]

// ─── tests ─────────────────────────────────────────────────────────────────

describe('engine media delivery', () => {
  it('tells a no-image main model about the image textually and notes it only in the reply status block', async () => {
    await withHarness({}, async (harness) => {
      const png = writePng(harness.root, 'nopic.png', await pngBytes(32, 32))
      const { sessionId } = await harness.engine.createSession()
      harness.script.reason!.push('完成')
      harness.script.reply!.push('好的，已处理')

      await harness.engine.send(sessionId, { text: '看图片', model: NOIMAGE_MODEL, attachments: [attachment(png)] })
      await waitIdle(harness.engine)

      const persisted = collectSessionFiles(harness.ledger.read(sessionId)).find((file) => file.kind === 'image')!
      const reason = callsOfRole(harness, sessionId, 'reason')[0]!
      assert.equal(imageUrls(reason.messages).length, 0, 'no image bytes reach a no-image model')
      assert.ok(messageText(reason.messages).includes(persisted.path), 'the image is described textually')

      // The reply text is stored unchanged; the image limitation rides the
      // status block of the reply request, not a forced suffix.
      const replyEvents = eventsOfType(harness.ledger.read(sessionId), 'reply')
      assert.equal(replyEvents.at(-1)!.text, '好的，已处理', 'no forced image suffix is appended')
      const replyCalls = callsOfRole(harness, sessionId, 'reply')
      assert.equal(replyCalls.length, 1, 'one communication call is forwarded for the turn')
      assert.ok(
        messageText(replyCalls[0]!.messages).includes('The reasoning model cannot see the images the user sent'),
        'the infos block carries the image limitation',
      )

      for (const call of harness.captured.get(sessionId) ?? []) {
        assert.equal(messageText(call.messages).includes('base64,'), false, `no encoded bytes for ${call.role}`)
      }
    })
  })

  it('delivers a later files-event version of the same path as a new image', async () => {
    await withHarness({}, async (harness) => {
      const png = writePng(harness.root, 'versioned.png', await pngBytes(40, 40, '#112233'))
      const { sessionId } = await harness.engine.createSession()
      harness.script.reason!.push('第一轮完成')

      await harness.engine.send(sessionId, {
        text: '第一轮',
        model: IMAGE_MODEL,
        attachments: [attachment(png)],
      })
      await waitIdle(harness.engine)

      const original = collectSessionFiles(harness.ledger.read(sessionId)).find((file) => file.kind === 'image')!
      // Mutate the canonical copy and describe the new version, then record it as
      // a later `files` event for the same path.
      writeFileSync(original.path, await pngBytes(40, 40, '#445566'))
      const next = await harness.fileStore.prepareFile(original.path, { source: 'task' })
      assert.notEqual(next.hash, original.hash)
      assert.notEqual(next.processedPath, original.processedPath)
      await harness.ledger.append(sessionId, { type: 'files', turn: 1, cycle: 1, source: 'read', files: [next] })

      harness.script.reason!.push('第二轮完成')
      await harness.engine.send(sessionId, { text: '第二轮', model: IMAGE_MODEL })
      await waitIdle(harness.engine)

      const reasonCalls = callsOfRole(harness, sessionId, 'reason')
      assert.equal(imageUrls(reasonCalls[1]!.messages).length, 2, 'both the old and the new version are delivered')
    })
  })

  it('surfaces an unknown upstream failure without a blind retry', async () => {
    await withHarness({}, async (harness) => {
      const { sessionId } = await harness.engine.createSession()
      harness.script.reason!.push(() => { throw new Error('upstream boom') })

      await harness.engine.send(sessionId, { text: '失败', model: IMAGE_MODEL })
      await waitIdle(harness.engine)

      assert.equal(callsOfRole(harness, sessionId, 'reason').length, 1, 'an unknown failure is not retried')
      const finished = eventsOfType(harness.ledger.read(sessionId), 'turn.finished').at(-1)!
      assert.equal(finished.status, 'failed')
    })
  })

})

describe('engine media read surface', () => {
  it('returns metadata only for a non-image and a bounded data URL for an image', async () => {
    await withHarness({}, async (harness) => {
      const imagePath = writePng(harness.root, 'big.png', await pngBytes(6000, 4000))
      const textPath = writePng(harness.root, 'notes.txt', Buffer.from('hello 世界\n', 'utf8'))
      const { sessionId } = await harness.engine.createSession()
      harness.script.reason!.push('完成')

      await harness.engine.send(sessionId, {
        text: '两个附件',
        model: IMAGE_MODEL,
        attachments: [attachment(imagePath, 'big.png'), attachment(textPath, 'notes.txt')],
      })
      await waitIdle(harness.engine)

      const files = collectSessionFiles(harness.ledger.read(sessionId))
      const image = files.find((file) => file.kind === 'image')!
      const text = files.find((file) => file.kind === 'file')!

      const nonImage = await harness.engine.readMedia(sessionId, text.path)
      assert.equal(nonImage.mime, 'text/plain')
      assert.equal('dataUrl' in nonImage, false, 'a non-image read is metadata only')

      const read = await harness.engine.readMedia(sessionId, image.path)
      assert.equal(read.mime, 'image/png')
      assert.ok(read.dataUrl?.startsWith('data:image/png;base64,'))

      await assert.rejects(() => harness.engine.readMedia(sessionId, 'media:unknown'), /Unknown session file/u)
    })
  })
})

describe('engine old-session boundary', () => {
  it('rejects send and inspect for an unsupported session format before mutating state', async () => {
    await withHarness({}, async (harness) => {
      const sessionId = 'legacy-session'
      const snapshot = await createWorkspaceSnapshot({
        workspaceRoot: harness.wsRoot,
        deviceName: 'test-device',
        takenAt: new Date(0),
        projects: [],
        builtinTasks: [],
      })
      await harness.ledger.append(sessionId, {
        type: 'session.created',
        format: 1,
        workspaceRoot: harness.wsRoot,
        snapshot,
      } as unknown as LedgerEventDraft)
      const before = harness.ledger.read(sessionId).length

      await assert.rejects(
        () => harness.engine.send(sessionId, { text: 'x', model: IMAGE_MODEL }),
        /旧格式/u,
      )
      await assert.rejects(
        () => harness.engine.inspectContext({ sessionId, model: 'anthropic/claude-sonnet-5-5' }),
        /旧格式/u,
      )

      assert.equal(harness.ledger.read(sessionId).length, before, 'the timeline is unchanged')
      assert.equal(existsSync(join(harness.root, 'sessions', sessionId, 'files')), false, 'no files are written')
    })
  })
})

describe('engine memory-search contract', () => {
  async function seedMemories(harness: Harness, count: number): Promise<string[]> {
    const memoriesDir = join(harness.wsRoot, 'memories')
    mkdirSync(memoriesDir, { recursive: true })
    const paths: string[] = []
    const indexLines: string[] = []
    for (let number = 1; number <= count; number += 1) {
      const path = `memories/m${number}.md`
      writeFileSync(join(harness.wsRoot, path), `body-${number}`)
      paths.push(path)
      indexLines.push(`- ${path}`)
    }
    writeFileSync(join(memoriesDir, 'INDEX.md'), indexLines.join('\n'))
    return paths
  }

  it('recalls at most three indexed root memories once, without document content', async () => {
    await withHarness({ taskDefinitions: ALL_TASKS }, async (harness) => {
      const paths = await seedMemories(harness, 4)
      const { sessionId } = await harness.engine.createSession()
      harness.script['memory-search']!.push(JSON.stringify({
        picks: paths.map((path, index) => ({ path, reason: `r${index}` })),
      }))
      harness.script.reason!.push('<wy-action type="dispatch">dispatch tool</wy-action>', '完成')
      harness.script.compile!.push(JSON.stringify({ project: 'demo', task: 'tool', input: {}, ctx: {} }))

      await harness.engine.send(sessionId, { text: '回忆', model: IMAGE_MODEL })
      await waitIdle(harness.engine)

      const recalled = eventsOfType(harness.ledger.read(sessionId), 'memory.recalled')
      assert.equal(recalled.length, 3, 'at most three memories are recalled')
      assert.ok(recalled.every((event) => event.source === 'memory-search'))
      for (const event of recalled) {
        const number = event.path.slice('memories/m'.length, -'.md'.length)
        assert.equal(event.content, `body-${number}`, 'the raw body is recorded')
        assert.match(event.version, /^[0-9a-f]{8}$/u, 'a content hash is recorded')
      }
      assert.equal(eventsOfType(harness.ledger.read(sessionId), 'doc.content').length, 0, 'no documents are loaded')

      // Cycle 2 re-runs memory-search but must not append the same versions again.
      assert.equal(callsOfRole(harness, sessionId, 'memory-search').length, 2)
      assert.equal(eventsOfType(harness.ledger.read(sessionId), 'memory.recalled').length, 3)
    })
  })

  it('reports corrupt memory-search JSON and still runs the reason call', async () => {
    await withHarness({ taskDefinitions: ALL_TASKS }, async (harness) => {
      await seedMemories(harness, 1)
      const { sessionId } = await harness.engine.createSession()
      harness.script['memory-search']!.push('not json at all')
      harness.script.reason!.push('完成')

      await harness.engine.send(sessionId, { text: '回忆', model: IMAGE_MODEL })
      await waitIdle(harness.engine)

      const error = eventsOfType(harness.ledger.read(sessionId), 'error').find((event) => event.stage === 'memory-search')
      assert.ok(error !== undefined, 'the invalid result is reported')
      assert.match(error.message, /not valid JSON/u)
      assert.equal(callsOfRole(harness, sessionId, 'reason').length, 1, 'reasoning still runs')
    })
  })

  it('recalls relative-link memory targets once with their full body and version', async () => {
    await withHarness({ taskDefinitions: ALL_TASKS }, async (harness) => {
      const memoriesDir = join(harness.wsRoot, 'memories')
      mkdirSync(memoriesDir, { recursive: true })
      writeFileSync(join(memoriesDir, 'gol-ui-dialogue-convergence.md'), 'gol full body')
      writeFileSync(join(memoriesDir, 'alpha.md'), 'alpha full body')
      writeFileSync(
        join(memoriesDir, 'INDEX.md'),
        [
          '- [GOL UI 与 Dialogue 收敛](gol-ui-dialogue-convergence.md)',
          '- [Alpha notes](./alpha.md)',
        ].join('\n'),
      )

      const { sessionId } = await harness.engine.createSession()
      const selected = JSON.stringify({
        picks: [
          { path: 'memories/gol-ui-dialogue-convergence.md', reason: 'gol' },
          { path: 'memories/alpha.md', reason: 'alpha' },
        ],
      })
      harness.script['memory-search']!.push(selected, selected)
      harness.script.reason!.push('<wy-action type="dispatch">dispatch tool</wy-action>', '完成')
      harness.script.compile!.push(JSON.stringify({ project: 'demo', task: 'tool', input: {}, ctx: {} }))

      await harness.engine.send(sessionId, { text: '回忆', model: IMAGE_MODEL })
      await waitIdle(harness.engine)

      const recalled = eventsOfType(harness.ledger.read(sessionId), 'memory.recalled')
      assert.equal(recalled.length, 2, 'both relative-link targets are recalled')
      const gol = recalled.find((event) => event.path === 'memories/gol-ui-dialogue-convergence.md')!
      const alpha = recalled.find((event) => event.path === 'memories/alpha.md')!
      assert.equal(gol.content, 'gol full body', 'the root relative-link target keeps its full body')
      assert.match(gol.version, /^[0-9a-f]{8}$/u, 'a content hash is recorded')
      assert.equal(alpha.content, 'alpha full body', 'the ./ relative-link target keeps its full body')
      assert.match(alpha.version, /^[0-9a-f]{8}$/u, 'a content hash is recorded')

      // The second cycle re-selects the same unchanged memories: memory-search
      // still precedes every reason call, but nothing is recalled a second time.
      const order = (harness.captured.get(sessionId) ?? [])
        .map((call) => call.role)
        .filter((role) => role === 'reason' || role === 'memory-search')
      assert.deepEqual(order, ['memory-search', 'reason', 'memory-search', 'reason'])
      assert.equal(
        eventsOfType(harness.ledger.read(sessionId), 'memory.recalled').length,
        2,
        'an unchanged later selection does not duplicate a recalled event',
      )
    })
  })

  it('retains standalone canonical entries and exact canonical link targets', async () => {
    await withHarness({}, async (harness) => {
      const memoriesDir = join(harness.wsRoot, 'memories')
      mkdirSync(memoriesDir, { recursive: true })
      writeFileSync(join(memoriesDir, 'm1.md'), 'body-1')
      writeFileSync(join(memoriesDir, 'm2.md'), 'body-2')
      writeFileSync(
        join(memoriesDir, 'INDEX.md'),
        [
          '- memories/m1.md',
          '- [Named](memories/m2.md)',
        ].join('\n'),
      )

      const { sessionId } = await harness.engine.createSession()
      harness.script['memory-search']!.push(JSON.stringify({
        picks: [
          { path: 'memories/m1.md', reason: 'r1' },
          { path: 'memories/m2.md', reason: 'r2' },
        ],
      }))
      harness.script.reason!.push('完成')

      await harness.engine.send(sessionId, { text: '回忆', model: IMAGE_MODEL })
      await waitIdle(harness.engine)

      const recalled = eventsOfType(harness.ledger.read(sessionId), 'memory.recalled')
      assert.equal(recalled.length, 2, 'the existing standalone and canonical-link formats both work')
      assert.equal(recalled.find((event) => event.path === 'memories/m1.md')!.content, 'body-1')
      assert.equal(recalled.find((event) => event.path === 'memories/m2.md')!.content, 'body-2')
      assert.equal(callsOfRole(harness, sessionId, 'reason').length, 1)
    })
  })

  it('rejects unlisted, label-only, lookalike, traversal, nested and external targets while reasoning continues', async () => {
    await withHarness({}, async (harness) => {
      const memoriesDir = join(harness.wsRoot, 'memories')
      mkdirSync(join(memoriesDir, 'nested'), { recursive: true })
      // Every rejected canonical path physically exists, so a rejection proves
      // the index allowlist rather than a missing file.
      for (const name of [
        'listed.md',
        'unlisted.md',
        'label-only.md',
        'dialogue-convergence.md',
        'foo.md',
        'inner.md',
        'external.md',
        'orphan.md',
        'bare.md',
        'prose.md',
        'gol-ui-dialogue-convergence.md',
      ]) {
        writeFileSync(join(memoriesDir, name), `body:${name}`)
      }
      writeFileSync(join(memoriesDir, 'nested', 'inner.md'), 'nested body')
      writeFileSync(
        join(memoriesDir, 'INDEX.md'),
        [
          '- [label-only.md](listed.md)',
          '- [GOL](gol-ui-dialogue-convergence.md)',
          '- [traversal](../memories/foo.md)',
          '- [nested](nested/inner.md)',
          '- [external](https://example.com/external.md)',
          '- orphan](orphan.md)',
          'bare.md',
          'Mentioning memories/prose.md does not list it.',
        ].join('\n'),
      )

      const cases: { name: string; path: string }[] = [
        { name: 'unlisted existing file', path: 'memories/unlisted.md' },
        { name: 'name only inside a link label', path: 'memories/label-only.md' },
        { name: 'suffix of a different target', path: 'memories/dialogue-convergence.md' },
        { name: 'parent traversal target', path: 'memories/foo.md' },
        { name: 'nested-folder target', path: 'memories/inner.md' },
        { name: 'external target', path: 'memories/external.md' },
        { name: 'incomplete Markdown link', path: 'memories/orphan.md' },
        { name: 'bare filename outside a Markdown target', path: 'memories/bare.md' },
        { name: 'canonical path only inside prose', path: 'memories/prose.md' },
      ]

      for (const scenario of cases) {
        harness.script['memory-search'] = [JSON.stringify({ picks: [{ path: scenario.path, reason: 'r' }] })]
        harness.script.reason = ['完成']
        const { sessionId } = await harness.engine.createSession()
        await harness.engine.send(sessionId, { text: '回忆', model: IMAGE_MODEL })
        await waitIdle(harness.engine)

        const events = harness.ledger.read(sessionId)
        assert.equal(eventsOfType(events, 'memory.recalled').length, 0, `${scenario.name}: no memory is recalled`)
        const error = eventsOfType(events, 'error').find((event) => event.stage === 'memory-search')
        assert.ok(error !== undefined, `${scenario.name}: the rejection is reported`)
        assert.equal(callsOfRole(harness, sessionId, 'reason').length, 1, `${scenario.name}: reasoning still runs`)
      }
    })
  })
})

// ─── communication replies ──────────────────────────────────────────────────

describe('engine communication replies', () => {
  it('persists a standalone question in the worker output and uses one terminal reply', async () => {
    await withHarness({}, async (harness) => {
      const { sessionId } = await harness.engine.createSession()
      harness.script.reason!.push({ text: '需要选择。', reasoning: 'PRIVATE-THINKING', toolCalls: [{ id: 'q1', type: 'ask', intent: '选择哪一个？' }] })
      harness.script.reply!.push('选择哪一个？')
      await harness.engine.send(sessionId, { text: '处理', model: IMAGE_MODEL })
      await waitIdle(harness.engine)
      const rows = harness.ledger.read(sessionId)
      const reason = eventsOfType(rows, 'reason.completed')[0]!
      assert.equal(reason.text, '需要选择。')
      assert.equal(reason.workerOutput, '需要选择。\n- ask: 选择哪一个？')
      const replies = callsOfRole(harness, sessionId, 'reply')
      assert.equal(replies.length, 1)
      const prompt = messageText(replies[0]!.messages)
      assert.ok(prompt.includes('- ask: 选择哪一个？'))
      assert.ok(prompt.includes('turn status: completed'))
      assert.ok(prompt.includes('device: test-device'))
      assert.equal(prompt.includes('PRIVATE-THINKING'), false)
      assert.equal(eventsOfType(rows, 'turn.finished').at(-1)!.status, 'completed')
    })
  })

  it('closes with a failed status after two empty outputs and no progress communication', async () => {
    await withHarness({}, async (harness) => {
      const { sessionId } = await harness.engine.createSession()
      harness.script.reason!.push('', '')
      harness.script.reply!.push('未完成')
      await harness.engine.send(sessionId, { text: '处理', model: IMAGE_MODEL })
      await waitIdle(harness.engine)
      assert.equal(callsOfRole(harness, sessionId, 'reason').length, 2)
      const replies = callsOfRole(harness, sessionId, 'reply')
      assert.equal(replies.length, 1)
      assert.ok(messageText(replies[0]!.messages).includes('turn status: failed'))
      assert.equal(eventsOfType(harness.ledger.read(sessionId), 'turn.finished').at(-1)!.status, 'failed')
    })
  })

  it('interrupts one turn while another turn has a blocked communication call', async () => {
    await withHarness({}, async (harness) => {
      const { sessionId } = await harness.engine.createSession()
      const replyGate = deferred<void>()
      const reasonGate = deferred<void>()
      const replying = deferred<void>()
      const reasoning = deferred<void>()
      harness.script.reason!.push('完成一', { text: '完成二', wait: reasonGate.promise })
      harness.script.reply!.push({ text: '回复一', wait: replyGate.promise })
      const unsubscribe = harness.ledger.subscribe(sessionId, (event) => {
        if (event.type === 'call.started' && event.role === 'reply') replying.resolve()
        if (event.type === 'call.started' && event.role === 'reason' && event.turn === 2) reasoning.resolve()
      })
      try {
        await harness.engine.send(sessionId, { text: '一', model: IMAGE_MODEL })
        await replying.promise
        await harness.engine.send(sessionId, { text: '二', model: IMAGE_MODEL })
        await reasoning.promise
        const outcome = await Promise.race([
          harness.engine.interrupt(sessionId, 2).then(() => 'interrupted'),
          new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 500)),
        ])
        assert.equal(outcome, 'interrupted', 'interrupt must not wait for the other turn reply')
        assert.ok(eventsOfType(harness.ledger.read(sessionId), 'turn.finished').some((event) => event.turn === 2 && event.status === 'interrupted'))
      } finally {
        unsubscribe()
        replyGate.resolve()
        reasonGate.resolve()
      }
      await waitIdle(harness.engine)
      assert.equal(callsOfRole(harness, sessionId, 'reply').length, 1)
      assert.equal(eventsOfType(harness.ledger.read(sessionId), 'reply').some((event) => event.turn === 2), false)
    })
  })

  it('makes exactly one reply call per main reasoning output and none for its actions', async () => {
    await withHarness({ taskDefinitions: ALL_TASKS }, async (harness) => {
      const { sessionId } = await harness.engine.createSession()
      harness.script.reason!.push(
        {
          text: '开始执行',
          toolCalls: [
            { id: 't1', type: 'read', intent: '读一下资料' },
            { id: 't2', type: 'dispatch', intent: '把工作派出去' },
          ],
        },
        '已全部完成',
      )
      harness.script.compile!.push(JSON.stringify({ project: 'demo', task: 'tool', input: {}, ctx: {} }))
      harness.script.reply!.push('已经开始', '全部完成')

      await harness.engine.send(sessionId, { text: '做工作', model: IMAGE_MODEL })
      await waitIdle(harness.engine)

      // Cycle 1 dispatches a task and runs a read that fails; neither the
      // dispatch nor the failure adds a trigger. Exactly one running reply is
      // made for the cycle, and one terminal reply for the second cycle.
      assert.equal(callsOfRole(harness, sessionId, 'reason').length, 2, 'two reasoning cycles ran')
      assert.equal(callsOfRole(harness, sessionId, 'reply').length, 2, 'exactly one reply per reasoning output')
      const replies = eventsOfType(harness.ledger.read(sessionId), 'reply')
      assert.deepEqual(replies.map((event) => event.text), ['已经开始', '全部完成'])
      assert.equal(eventsOfType(harness.ledger.read(sessionId), 'turn.finished').at(-1)!.status, 'completed')
    })
  })

  it('records only the call, with no message, when the reply tool was not called', async () => {
    await withHarness({}, async (harness) => {
      const { sessionId } = await harness.engine.createSession()
      harness.script.reason!.push('完成')
      harness.script.reply!.push('')

      await harness.engine.send(sessionId, { text: 'x', model: IMAGE_MODEL })
      await waitIdle(harness.engine)

      assert.equal(eventsOfType(harness.ledger.read(sessionId), 'reply').length, 0, 'no reply call writes no reply')
      assert.equal(callsOfRole(harness, sessionId, 'reply').length, 1, 'the call is still recorded')
      assert.equal(
        eventsOfType(harness.ledger.read(sessionId), 'turn.finished').at(-1)!.status,
        'completed',
        'a terminal call without a reply still ends the turn',
      )
    })
  })

  it('stores any other successful output unchanged', async () => {
    await withHarness({}, async (harness) => {
      const { sessionId } = await harness.engine.createSession()
      harness.script.reason!.push('完成')
      harness.script.reply!.push('  收到，正在处理  ')

      await harness.engine.send(sessionId, { text: 'x', model: IMAGE_MODEL })
      await waitIdle(harness.engine)

      const replies = eventsOfType(harness.ledger.read(sessionId), 'reply')
      assert.equal(replies.length, 1)
      assert.equal(replies[0]!.text, '  收到，正在处理  ', 'the successful text is stored unchanged')
    })
  })

  it('keeps a running reply failure out of the reasoning context and still finishes the turn', async () => {
    await withHarness({ taskDefinitions: ALL_TASKS }, async (harness) => {
      const { sessionId } = await harness.engine.createSession()
      harness.script.reason!.push(
        { text: '开始', toolCalls: [{ id: 't1', type: 'dispatch', intent: '派发' }] },
        '完成',
      )
      harness.script.compile!.push(JSON.stringify({ project: 'demo', task: 'tool', input: {}, ctx: {} }))
      harness.script.reply!.push(() => { throw new Error('reply boom') }, '结束了')

      await harness.engine.send(sessionId, { text: 'x', model: IMAGE_MODEL })
      await waitIdle(harness.engine)

      const replyError = eventsOfType(harness.ledger.read(sessionId), 'error').find((event) => event.stage === 'reply')
      assert.equal(replyError, undefined, 'the running reply failure appends no error event')
      for (const call of callsOfRole(harness, sessionId, 'reason')) {
        assert.equal(messageText(call.messages).includes('reply boom'), false, 'reply failures do not enter reasoning context')
      }
      assert.deepEqual(
        eventsOfType(harness.ledger.read(sessionId), 'reply').map((event) => event.text),
        ['结束了'],
        'the running failure adds no fallback message',
      )
      assert.equal(eventsOfType(harness.ledger.read(sessionId), 'turn.finished').at(-1)!.status, 'completed')
    })
  })

  it('writes the fixed fallback when the terminal reply call fails', async () => {
    await withHarness({}, async (harness) => {
      const { sessionId } = await harness.engine.createSession()
      harness.script.reason!.push('完成')
      harness.script.reply!.push(() => { throw new Error('reply boom') })

      await harness.engine.send(sessionId, { text: 'x', model: IMAGE_MODEL })
      await waitIdle(harness.engine)

      assert.ok(eventsOfType(harness.ledger.read(sessionId), 'error').some((event) => event.stage === 'reply'))
      assert.deepEqual(
        eventsOfType(harness.ledger.read(sessionId), 'reply').map((event) => event.text),
        ['本轮已结束。'],
        'the terminal fallback is written',
      )
      assert.equal(eventsOfType(harness.ledger.read(sessionId), 'turn.finished').at(-1)!.status, 'completed')
    })
  })

  it('retries an empty reasoning output silently before making one reply', async () => {
    await withHarness({}, async (harness) => {
      const { sessionId } = await harness.engine.createSession()
      harness.script.reason!.push('', '完成')
      harness.script.reply!.push('回复')

      await harness.engine.send(sessionId, { text: 'x', model: IMAGE_MODEL })
      await waitIdle(harness.engine)

      assert.equal(callsOfRole(harness, sessionId, 'reason').length, 2, 'the empty output is retried')
      assert.equal(callsOfRole(harness, sessionId, 'reply').length, 1, 'the empty output triggers no communication')
      assert.deepEqual(eventsOfType(harness.ledger.read(sessionId), 'reply').map((event) => event.text), ['回复'])
      assert.equal(eventsOfType(harness.ledger.read(sessionId), 'turn.finished').at(-1)!.status, 'completed')
    })
  })

  it('serializes replies of two same-session turns so the later one sees the earlier reply', async () => {
    await withHarness({}, async (harness) => {
      const { sessionId } = await harness.engine.createSession()
      harness.script.reason!.push('A完成', 'B完成')
      harness.script.reply!.push('回复A', '回复B')

      await Promise.all([
        harness.engine.send(sessionId, { text: '一', model: IMAGE_MODEL }),
        harness.engine.send(sessionId, { text: '二', model: IMAGE_MODEL }),
      ])
      await waitIdle(harness.engine)

      const replyCalls = callsOfRole(harness, sessionId, 'reply')
      assert.equal(replyCalls.length, 2, 'each turn makes exactly one reply call')
      assert.equal(new Set(replyCalls.map((call) => call.turn)).size, 2, 'one reply call per turn')
      assert.equal(eventsOfType(harness.ledger.read(sessionId), 'reply').length, 2)
      assert.ok(
        messageText(replyCalls[1]!.messages).includes('回复A'),
        'the later reply is built from the ledger and includes the earlier assistant reply',
      )
    })
  })

  it('suppresses every communication on an interrupted turn', async () => {
    await withHarness({}, async (harness) => {
      const { sessionId } = await harness.engine.createSession()
      const gate = deferred<void>()
      harness.script.reason!.push({ text: '进行中', wait: gate.promise })

      await harness.engine.send(sessionId, { text: 'x', model: IMAGE_MODEL })
      await harness.engine.interrupt(sessionId, 1)
      gate.resolve()
      await waitIdle(harness.engine)

      assert.equal(callsOfRole(harness, sessionId, 'reply').length, 0, 'an interrupted turn makes no reply call')
      assert.equal(eventsOfType(harness.ledger.read(sessionId), 'reply').length, 0, 'and writes no reply')
      assert.equal(eventsOfType(harness.ledger.read(sessionId), 'turn.finished').at(-1)!.status, 'interrupted')
    })
  })

  it('forwards the session cache key to the driver on a reply call', async () => {
    const seen: { cacheKey?: string }[] = []
    const runner = createCallRunner({
      driver: {
        async complete(request) {
          seen.push(request)
          return { text: 'ok' }
        },
      },
      selectAuxiliary: async () => [{ model: 'openai/gpt-6.1-sol', reasoningEffort: 'none' }],
      cacheKey: 'session-42',
      append: async () => {},
    })

    await runner.run({
      callId: 'c1',
      role: 'reply',
      messages: [{ role: 'user', content: 'hi' }],
      layers: {},
      signal: new AbortController().signal,
    })

    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.cacheKey, 'session-42', 'the session id is forwarded as the prompt-cache key')
  })

  it('declares the reply tool and returns only its text as the reply output', async () => {
    const seen: { replyTool?: boolean; actionTool?: boolean }[] = []
    const outputs: string[] = []
    const run = async (replies: string[] | undefined): Promise<string> => {
      const runner = createCallRunner({
        driver: {
          async complete(request) {
            seen.push(request)
            return { text: 'prose outside the tool', ...(replies === undefined ? {} : { replies }) }
          },
        },
        selectAuxiliary: async () => [{ model: 'openai/gpt-6.1-sol', reasoningEffort: 'none' }],
        append: async (event) => { if (event.type === 'call') outputs.push(event.output ?? '') },
      })
      const result = await runner.run({
        callId: 'c1',
        role: 'reply',
        messages: [{ role: 'user', content: 'hi' }],
        layers: {},
        signal: new AbortController().signal,
      })
      return result.text
    }

    assert.equal(await run(['第一条', '第二条']), '第一条\n\n第二条')
    assert.equal(await run(undefined), '', 'no reply call means nothing is sent')
    assert.deepEqual(outputs, ['第一条\n\n第二条', ''], 'the call record holds what reached the user')
    assert.equal(seen[0]?.replyTool, true)
    assert.equal(seen[0]?.actionTool, undefined)
  })
})
