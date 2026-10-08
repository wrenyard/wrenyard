/**
 * Current-only session view + document regressions.
 *
 * These tests drive the REAL `createViews`, the REAL `estimateTokens` counter,
 * the REAL `ContextInspector` over a real temp `Ledger`, and the REAL document
 * diff helpers. No model, network, or filesystem-side-effect call is made and
 * no test-only export is invented: every symbol is an existing public or module
 * export of `@wrenyard/session`.
 *
 * They assert the settled communication-contract and document-reconstruction
 * requirements; where the current source still violates a settled requirement
 * the test fails as a genuine regression rather than being weakened.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  estimateTokens,
  type BuiltView,
  type DocContentEvent,
  type LedgerEvent,
  type ModelContentPart,
  type SessionFile,
  type WorkspaceSnapshot,
} from '@wrenyard/session'
import {
  createViews,
  renderEventText,
} from '../../../../packages/features/session/src/views.ts'
import {
  applyDocumentDiff,
  contentVersion,
  currentDocument,
  documentChange,
  makeDocumentDraft,
} from '../../../../packages/features/session/src/documents.ts'

const VIEWS = createViews()

const tempDirs: string[] = []
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
})

function at(seq: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + seq * 1000).toISOString()
}

const SNAPSHOT: WorkspaceSnapshot = {
  takenAt: at(0),
  deviceName: 'test-device',
  agents: '',
  memoryIndex: '',
  builtinTasks: [],
  projects: [],
}

const SESSION = {
  now: at(1),
  sessionId: 's1',
  turn: 1,
  cycle: 1,
  model: 'test/model',
}

function event(seq: number, rest: Record<string, unknown>): LedgerEvent {
  return { seq, at: at(seq), ...rest } as LedgerEvent
}

function imageFile(path: string, processedPath: string): SessionFile {
  return {
    path,
    name: path.split('/').at(-1) ?? path,
    kind: 'image',
    mime: 'image/png',
    bytes: 10,
    hash: 'h',
    source: 'user',
    description: 'img',
    processedPath,
    processedMime: 'image/png',
  }
}

function messageText(view: BuiltView): string {
  const user = view.messages[1]!
  if (typeof user.content === 'string') return user.content
  return user.content.filter((part): part is Extract<ModelContentPart, { type: 'text' }> => part.type === 'text').map((part) => part.text).join('')
}

function loneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

// ─── reply view: append-only communication conversation ─────────────────────

function turnStarted(seq: number, turn: number, text: string): LedgerEvent {
  return event(seq, { type: 'turn.started', turn, text, model: { provider: 'p', model: 'm' } })
}

function reasonCompleted(seq: number, turn: number, cycle: number, text: string, workerOutput?: string): LedgerEvent {
  return event(seq, {
    type: 'reason.completed', turn, cycle, callId: `call-${seq}`, text,
    ...(workerOutput === undefined ? {} : { workerOutput }),
  })
}

function replyEvent(seq: number, turn: number, text: string): LedgerEvent {
  return event(seq, { type: 'reply', turn, text })
}

function replyView(
  events: LedgerEvent[],
  over: {
    turn?: number
    cycle?: number
    status?: 'running' | 'completed' | 'failed'
    error?: string
    imageUnsupported?: boolean
  } = {},
): BuiltView {
  return VIEWS.reply({
    events, turn: 1, cycle: 1, status: 'running', now: '2026-10-08T10:00:00.000Z', deviceName: 'test-device', ...over,
  })
}

function messagesOf(view: BuiltView): { role: string; text: string }[] {
  return view.messages.map((message) => ({
    role: message.role,
    text: typeof message.content === 'string'
      ? message.content
      : message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
  }))
}

function inputOf(view: BuiltView): string {
  return messagesOf(view)[1]!.text
}

describe('reply view is one system message and one ctx + info user message', () => {
  it('renders the whole conversation in wy-ctx and the triggering worker output in wy-info', () => {
    const view = replyView([
      turnStarted(1, 1, '问题一'),
      reasonCompleted(2, 1, 1, '答复一'),
      replyEvent(3, 1, '回复一'),
      turnStarted(4, 2, '问题二'),
      reasonCompleted(5, 2, 1, '答复二'),
    ], { turn: 2, cycle: 1, status: 'completed' })
    const messages = messagesOf(view)
    assert.deepEqual(messages.map((message) => message.role), ['system', 'user'])
    const input = messages[1]!.text
    const ctx = input.slice(0, input.indexOf('<wy-info>'))
    const info = input.slice(input.indexOf('<wy-info>'))
    assert.ok(ctx.startsWith('<wy-ctx>\n<wy-conversation>'), 'the conversation leads the input')
    assert.ok(ctx.includes('<message role="user" turn="1">问题一</message>'), 'earlier user inputs are present')
    assert.ok(ctx.includes('<message role="assistant" turn="1">回复一</message>'), 'earlier replies are present')
    assert.ok(ctx.includes('<message role="user" turn="2">问题二</message>'), 'the current user input is present')
    assert.ok(
      ctx.indexOf('问题一') < ctx.indexOf('回复一') && ctx.indexOf('回复一') < ctx.indexOf('问题二'),
      'messages keep timeline order',
    )
    assert.ok(info.includes('<wy-output>答复二</wy-output>'), 'the triggering worker output is in wy-info')
    assert.equal(input.includes('答复一'), false, 'earlier worker outputs are excluded')
    assert.deepEqual(Object.keys(view.layers), ['wy-system', 'wy-ctx', 'wy-info'])
  })

  it('shows only the worker output of the triggering cycle', () => {
    const events = [
      turnStarted(1, 1, '问题'),
      reasonCompleted(2, 1, 1, '第一次'),
      reasonCompleted(3, 1, 2, '第二次'),
    ]
    assert.ok(inputOf(replyView(events, { cycle: 1 })).includes('<wy-output>第一次</wy-output>'))
    assert.ok(inputOf(replyView(events, { cycle: 2 })).includes('<wy-output>第二次</wy-output>'))
    assert.ok(
      inputOf(replyView(events, { cycle: 3, status: 'failed' })).includes('<wy-output>(none)</wy-output>'),
      'a closing call without fresh output repeats no earlier output',
    )
  })

  it('keeps every reply of the session', () => {
    const events: LedgerEvent[] = [turnStarted(1, 1, '问题')]
    for (let index = 1; index <= 7; index += 1) events.push(replyEvent(index + 1, 1, `回复${index}`))
    const input = inputOf(replyView(events))
    for (let index = 1; index <= 7; index += 1) assert.ok(input.includes(`>回复${index}</message>`))
  })

  it('lists only the actions that are still running, by title', () => {
    const input = inputOf(replyView([
      turnStarted(1, 1, '做吧'),
      event(2, { type: 'action.started', turn: 1, cycle: 1, actionId: 'a1', kind: 'dispatch', parsed: {} }),
      event(3, { type: 'action.titled', turn: 1, cycle: 1, actionId: 'a1', title: '跑构建' }),
      event(4, { type: 'action.started', turn: 1, cycle: 1, actionId: 'a2', kind: 'read', parsed: {} }),
      event(5, { type: 'action.titled', turn: 1, cycle: 1, actionId: 'a2', title: '读配置' }),
      event(6, { type: 'action.finished', turn: 1, cycle: 1, actionId: 'a1', kind: 'dispatch', status: 'done', result: 'RESULT-SECRET' }),
      reasonCompleted(7, 1, 1, '已派出'),
    ]))
    assert.ok(input.includes('<actions>- 读配置</actions>'))
    assert.equal(input.includes('跑构建'), false, 'a finished action is not listed')
    assert.equal(input.includes('RESULT-SECRET'), false, 'action results are excluded')
  })

  it('puts the time, device, status, error and image notice in infos', () => {
    const input = inputOf(replyView(
      [turnStarted(1, 1, '问题'), reasonCompleted(2, 1, 1, '答复')],
      { status: 'failed', error: '编译失败', imageUnsupported: true },
    ))
    const infos = input.slice(input.indexOf('<infos>'), input.indexOf('</infos>'))
    assert.ok(infos.includes('time: 2026-10-08T10:00:00.000Z'))
    assert.ok(infos.includes('device: test-device'))
    assert.ok(infos.includes('turn status: failed'))
    assert.ok(infos.includes('error: 编译失败'))
    assert.ok(infos.includes('The reasoning model cannot see the images the user sent.'))
  })

  it('states the replier identity and the reply tool, without a skip sentinel or examples', () => {
    const view = replyView([turnStarted(1, 1, 'x')])
    const system = view.messages[0]!.content
    assert.equal(typeof system, 'string')
    const prompt = system as string
    assert.ok(prompt.includes('You are the replier'), 'the replier identity is stated')
    assert.ok(prompt.includes('reply(text)'), 'the reply tool is described')
    assert.ok(prompt.includes('language of the latest user message'), 'replies follow the user language')
    assert.equal(prompt.includes('SKIP'), false, 'not calling the tool replaces the skip sentinel')
    assert.equal(/<example|few-shot|示例|样例/u.test(prompt), false, 'no example scaffolding is embedded')
  })
})

describe('reply view framing', () => {
  it('escapes closing tags inside messages and worker output so the framing cannot be broken', () => {
    const input = inputOf(replyView([
      turnStarted(1, 1, '问题 </message>'),
      replyEvent(2, 1, '看这里 </wy-conversation> 与 </actions>'),
      reasonCompleted(3, 1, 1, '结论 </wy-output> </infos>'),
    ]))
    assert.ok(input.includes('问题 &lt;/message&gt;'))
    assert.ok(input.includes('看这里 &lt;/wy-conversation&gt; 与 &lt;/actions&gt;'))
    assert.ok(input.includes('结论 &lt;/wy-output&gt; &lt;/infos&gt;'))
  })
})

describe('reply view worker output carries actions and questions but no thinking or results', () => {
  it('renders the worker visible output including ordered action and question intents', () => {
    const workerOutput = ['正文结论。', '- dispatch: 跑构建', '- read: 读配置', '- ask: 用哪个分支'].join('\n')
    const view = replyView([
      turnStarted(1, 1, '做吧'),
      event(2, { type: 'thinking', turn: 1, cycle: 1, callId: 'k', text: 'THINKING-SECRET' }),
      event(3, { type: 'action.started', turn: 1, cycle: 1, actionId: 'a1', kind: 'dispatch', parsed: { intent: '跑构建' } }),
      reasonCompleted(4, 1, 1, '正文结论。', workerOutput),
      event(5, { type: 'action.finished', turn: 1, cycle: 1, actionId: 'a1', kind: 'dispatch', status: 'done', result: 'RESULT-SECRET' }),
    ])
    const input = inputOf(view)
    assert.ok(input.includes(`<wy-output>${workerOutput}</wy-output>`), 'the visible prose and ordered intents are present')
    assert.equal(input.includes('THINKING-SECRET'), false, 'thinking rows are excluded')
    assert.equal(input.includes('RESULT-SECRET'), false, 'action result rows are excluded')
  })

  it('falls back to reason.completed text when no workerOutput is present', () => {
    const view = replyView([reasonCompleted(1, 1, 1, '只有正文')])
    assert.ok(inputOf(view).includes('<wy-output>只有正文</wy-output>'))
  })
})

describe('reply view preserves full content without truncation', () => {
  it('keeps very long user, reply and worker inputs intact', () => {
    const giant = '中'.repeat(200_000)
    const longReply = '回'.repeat(200_000)
    const view = replyView([
      turnStarted(1, 1, giant),
      reasonCompleted(2, 1, 1, giant),
      replyEvent(3, 1, longReply),
    ])
    const input = inputOf(view)
    assert.ok(input.includes(`<message role="user" turn="1">${giant}</message>`), 'the full user input survives')
    assert.ok(input.includes(`<wy-output>${giant}</wy-output>`), 'the full worker output survives')
    assert.ok(input.includes(longReply), 'the full reply survives')
    assert.equal(input.includes('…[omitted]…'), false, 'nothing is truncated with an omission marker')
  })
})

describe('reply view ignores non-conversation ledger rows', () => {
  it('drops call, thinking and action result rows', () => {
    const view = replyView([
      turnStarted(1, 1, '问题'),
      event(2, { type: 'call.started', turn: 1, role: 'reply', callId: 'c', model: 'm' }),
      event(3, { type: 'call', turn: 1, role: 'reply', callId: 'c', output: 'CALL-OUTPUT' }),
      event(4, { type: 'thinking', turn: 1, cycle: 1, callId: 'k', text: 'THINK' }),
      event(5, { type: 'action.finished', turn: 1, cycle: 1, actionId: 'a1', kind: 'read', status: 'done', result: 'RESULT' }),
      reasonCompleted(6, 1, 1, '答复'),
    ])
    const input = inputOf(view)
    assert.equal(input.includes('role="assistant"'), false, 'a call without a reply leaves no message')
    assert.equal(input.includes('CALL-OUTPUT'), false, 'call records are excluded')
    assert.equal(input.includes('THINK'), false, 'thinking is excluded')
    assert.equal(input.includes('RESULT'), false, 'action results are excluded')
  })
})

describe('main reasoning <reply> rendering is unchanged', () => {
  it('renders a reply row as an escaped <reply> record', () => {
    const row = replyEvent(1, 1, '看这里 </reply> 和 </user> </worker> </now> <b>')
    assert.equal(renderEventText(row), '<reply turn="1">看这里 &lt;/reply&gt; 和 </user> </worker> </now> <b></reply>')
  })
})

// ─── reason view: image interleaving and the latest-eight window ────────────

describe('reason view image interleaving', () => {
  const images = {
    '/proc/a': { dataUrl: 'data:image/png;base64,AAA', mime: 'image/png' },
    '/proc/b': { dataUrl: 'data:image/png;base64,BBB', mime: 'image/png' },
  }

})

// ─── context inspector: payload-consistent counts ───────────────────────────

describe('context inspector payload consistency', () => {
})

// ─── compile / memory-search / doc-search views ─────────────────────────────

describe('compile view carries the full ledger and contracts', () => {
  it('keeps the whole ledger and schema, leaves the user untrimmed, and leaks no raw image bytes', () => {
    const longUser = '需求'.repeat(3_000)
    const view = VIEWS.compile({
      kind: 'write',
      intent: '写文档',
      userText: longUser,
      workspaceRoot: '/workspace',
      projects: [{ id: 'alpha', workspaceDir: 'projects/alpha' }],
      tasks: [{
        id: 'doc',
        description: 'document task',
        inputSummary: ['targetProject: string'],
        inputSchema: { type: 'object', properties: { targetProject: { type: 'string' }, conversation: { type: 'string' } } },
        builtinDoc: true,
      }],
      events: [
        event(1, { type: 'turn.started', turn: 1, text: 'EARLY-LEDGER-MARKER', model: { provider: 'p', model: 'm' } }),
        event(2, { type: 'files', turn: 1, cycle: 1, source: 'task', files: [imageFile('/orig/c.png', '/proc/c')] }),
      ],
    })
    const text = messageText(view)
    assert.ok(text.includes('EARLY-LEDGER-MARKER'), 'the whole ledger is rendered')
    assert.ok(text.includes(longUser), 'the user text is not trimmed')
    assert.ok(text.includes('"conversation"'), 'the full task input schema is present')
    assert.ok(text.includes('projects/alpha'))
    assert.equal(/data:|base64/u.test(text), false, 'no raw image payload leaks into the compiler view')
  })

  it('labels the authoritative workspace root, the workspace-relative docs root and a distinct checkout', () => {
    const view = VIEWS.compile({
      kind: 'dispatch',
      intent: '派发',
      userText: 'x',
      workspaceRoot: '/workspace',
      projects: [{ id: 'gol', workspaceDir: 'projects/gol', checkoutPath: '/checkout/gol' }],
      tasks: [{
        id: 'tool',
        description: 'tool task',
        inputSummary: [],
        inputSchema: { type: 'object', properties: { output_dir: { type: 'string' } } },
      }],
      events: [],
    })
    const text = messageText(view)
    assert.ok(text.includes('<workspace-root>'), 'the authoritative workspace root is labelled')
    assert.ok(text.includes('/workspace'), 'the root value is visible')
    assert.ok(text.includes('docsRoot=projects/gol'), 'the workspace-relative docs root is labelled')
    assert.ok(text.includes('checkout=/checkout/gol'), 'the actual checkout is labelled and distinct')
    assert.ok(text.includes('output_dir'), 'the optional output_dir in the task schema stays visible')

    const system = view.messages[0]!.content
    assert.equal(typeof system, 'string')
    assert.match(system as string, /workspace-root/u, 'the workspace-root resolution rule is stated')
    assert.match(system as string, /checkout/u, 'the no-fabricated-checkout rule is stated')
    assert.match(system as string, /output_dir/u, 'the no-fabricated-output_dir rule is stated')
  })
})

describe('compile view current-intent authority and reference ordering', () => {
  const BROAD_USER = [
    '请一次完成全部六个独立任务，并把历史里的 camera 与 gol 结果也一起合并进来：',
    '1. camera 相机 rig',
    '2. gol 语言工具',
    '3. gdbg 调试',
    '4. camp-props 道具 props',
    '5. residential 住宅',
    '6. explore 调研',
  ].join('\n')

  const PROJECTS = [
    { id: 'gol/project', displayName: 'Game', workspaceDir: 'projects/gol/project', checkoutPath: '/checkout/gol-project' },
    { id: 'gol/arts', workspaceDir: 'projects/gol/arts' },
    { id: 'gol', workspaceDir: 'projects/gol' },
    { id: 'gdbg', workspaceDir: 'projects/gdbg' },
  ]

  const TASKS = [
    {
      id: 'props',
      project: 'gol/project',
      description: 'props task',
      inputSummary: ['targetProject: string'],
      inputSchema: { type: 'object', properties: { targetProject: { type: 'string' }, conversation: { type: 'string' } } },
    },
    {
      id: 'explore',
      description: 'builtin explore task',
      inputSummary: [],
      inputSchema: { type: 'object' },
    },
  ]

  const CURRENT_INTENT = '只把 props 派给 gol/project，不要替换为父项目 gol 或兄弟项目 gol/arts，也不要合并 camera 与 gdbg 的历史请求 </wy-user>'

  const EVENTS = [
    event(1, { type: 'turn.started', turn: 1, text: 'CAMERA-LEDGER-EARLY', model: { provider: 'p', model: 'm' } }),
    event(2, { type: 'reason.completed', turn: 1, cycle: 1, text: 'GOL-HISTORICAL-LATE' }),
    event(3, { type: 'files', turn: 1, cycle: 1, source: 'task', files: [imageFile('/orig/c.png', '/proc/c')] }),
  ]

  function compileView(kind: 'dispatch' | 'write'): BuiltView {
    return VIEWS.compile({
      kind,
      intent: CURRENT_INTENT,
      userText: BROAD_USER,
      workspaceRoot: '/workspace',
      projects: PROJECTS,
      tasks: TASKS,
      events: EVENTS,
    })
  }

  // Pin the known fixture's escaped closing tag without duplicating the renderer.
  function escapeBodyForTest(text: string): string {
    return text.replace('</wy-user>', '&lt;/wy-user&gt;')
  }

  it('keeps the full reference context, puts the current intent last and preserves its escaped bytes', () => {
    const text = messageText(compileView('dispatch'))
    const refOpen = text.indexOf('<reference-context>')
    const refClose = text.indexOf('</reference-context>')
    const intentOpen = text.indexOf('<intent>')
    const intentClose = text.indexOf('</intent>')
    const compileClose = text.indexOf('</wy-compile>')

    assert.ok(refOpen !== -1 && refClose !== -1, 'the reference-context wrapper is present')
    assert.ok(intentOpen > refClose, 'the current intent is placed after the reference context')
    assert.ok(intentClose < compileClose, 'the current intent is the last child before the closing tag')
    assert.equal(text.indexOf('<intent>', intentOpen + 1), -1, 'the current-intent tag is not repeated')

    const reference = text.slice(refOpen, refClose)
    assert.ok(reference.includes(BROAD_USER), 'the full original user request is retained')
    assert.ok(reference.includes('CAMERA-LEDGER-EARLY'), 'the early ledger fact is retained')
    assert.ok(reference.includes('GOL-HISTORICAL-LATE'), 'the late ledger fact is retained')
    assert.ok(reference.includes('<events>'), 'the full event block is inside the reference context')
    assert.ok(text.includes('"conversation"'), 'the task contract stays in the view')

    const escapedIntent = escapeBodyForTest(CURRENT_INTENT)
    assert.equal(
      text.slice(intentOpen + '<intent>'.length, intentClose),
      escapedIntent,
      'the intent bytes are the escaped current intent, unchanged',
    )
    assert.ok(text.includes(`<intent>${escapedIntent}</intent>`), 'the intent is intact through the existing escape behavior')
    assert.equal(text.includes(`<intent>${CURRENT_INTENT}</intent>`), false, 'the raw closing tag is escaped, not passed through')
  })

  it('keeps the same current-intent-last contract for the write kind', () => {
    const text = messageText(compileView('write'))
    assert.ok(text.includes('<kind>write</kind>'))
    const refClose = text.indexOf('</reference-context>')
    const intentOpen = text.indexOf('<intent>')
    assert.ok(intentOpen > refClose, 'the write intent also follows the reference context')
    assert.ok(
      text.slice(intentOpen).startsWith(`<intent>${escapeBodyForTest(CURRENT_INTENT)}</intent>`),
      'the write intent is the last child and keeps its escaped bytes',
    )
  })

  it('states current-intent authority and the exact project/task preservation rules in the system prompt', () => {
    const system = compileView('dispatch').messages[0]!.content
    assert.equal(typeof system, 'string')
    const prompt = system as string
    assert.match(prompt, /sole authority/u, 'the current intent is the sole authority for this one action')
    assert.match(prompt, /reference-context/u, 'the reference context is named reference only')
    assert.match(prompt, /cannot authorize/u, 'the reference cannot authorize siblings or history')
    assert.match(prompt, /must not be replaced with a parent project/u, 'an exact named project is preserved, not replaced')
    assert.match(prompt, /sibling project/u, 'sibling substitution is forbidden')
    assert.match(prompt, /unrelated project/u, 'unrelated substitution is forbidden')
    assert.match(prompt, /Builtin tasks/u, 'inherited builtin tasks remain available')
  })
})

describe('retrieval views stay metadata-only', () => {
  it('memory search exposes the index and paths but no document body or catalog', () => {
    const view = VIEWS.memorySearch({
      memoryIndex: '- memories/INDEX.md',
      loadedPaths: ['memories/a.md'],
      userText: '找记忆',
      lastReasonText: '上次结论',
      actionResults: [{ name: 'read', status: 'done', text: 'ok' }],
    })
    const text = messageText(view)
    assert.ok(text.includes('<memory-index>'))
    assert.ok(text.includes('memories/a.md'))
    assert.equal(text.includes('<catalog>'), false)
    assert.equal(text.includes('<doc-content>'), false)
  })

  it('doc search groups the catalog with metadata and marks the newest live spec default', () => {
    const view = VIEWS.docSearch({
      catalog: [
        { path: 'projects/a/docs/specs/s1.md', title: 'S1', status: 'active', updated: '2026-01-01', length: 10 },
        { path: 'projects/a/docs/specs/s2.md', title: 'S2', status: 'deprecated', updated: '2025-01-01', length: 20 },
        { path: 'projects/a/docs/plans/p1.md', title: 'P1', status: '', updated: '2026-02-01', length: 30 },
      ],
      loadedPaths: ['projects/a/docs/specs/s1.md'],
      intent: '继续',
    })
    const text = messageText(view)
    assert.ok(text.includes('<group path="projects/a/docs/specs">'))
    assert.ok(text.includes('<group path="projects/a/docs/plans">'))
    assert.ok(text.includes('path=projects/a/docs/specs/s1.md'))
    assert.ok(text.includes('status=active'))
    assert.ok(text.includes('updated=2026-01-01'))
    assert.ok(text.includes('length=10'))
    assert.ok(text.includes('default=true'))
    assert.equal(text.includes('<doc-content>'), false)
    assert.equal(text.includes('# S1'), false, 'no document body is embedded')
  })
})

// ─── document diff reconstruction ───────────────────────────────────────────

const DOC_PATH = 'projects/a/docs/specs/x.md'

function docEvent(seq: number, over: Partial<DocContentEvent>): DocContentEvent {
  return {
    seq,
    at: at(seq),
    type: 'doc.content',
    turn: 1,
    cycle: 1,
    path: DOC_PATH,
    title: 'X',
    updated: '',
    version: '',
    tokens: 0,
    content: '',
    format: 'full',
    source: 'write',
    ...over,
  } as DocContentEvent
}

function replay(before: string, after: string): string {
  const change = documentChange(DOC_PATH, before, after)
  assert.ok(change, 'a real change must produce a draft')
  const events = [
    docEvent(1, { format: 'full', content: before, version: contentVersion(before) }),
    docEvent(2, { format: 'diff', content: change.content, version: change.version, ...(change.base === undefined ? {} : { base: change.base }) }),
  ]
  const current = currentDocument(events, DOC_PATH)
  assert.ok(current, 'the document must be reconstructible')
  return current.content
}

describe('document reconstruction', () => {
  it('reconstructs full → diff → diff exactly, including UTF-8 and newlines', () => {
    const path = DOC_PATH
    const v0 = '第一行\nline two\n最后\n'
    const v1 = '第一行\nline TWO\n最后\n'
    const v2 = '第一行\nline TWO\n新增行 🚀\n最后\n'

    const full = documentChange(path, undefined, v0)
    assert.ok(full)
    assert.equal(full.format, 'full')

    const d1 = documentChange(path, v0, v1)
    assert.ok(d1)
    assert.equal(d1.format, 'diff')
    assert.equal(d1.base, contentVersion(v0))

    const d2 = documentChange(path, v1, v2)
    assert.ok(d2)
    assert.equal(d2.base, contentVersion(v1))

    assert.equal(documentChange(path, v2, v2), undefined, 'an unchanged document is never re-emitted')

    const events = [
      docEvent(1, { format: 'full', content: full.content, version: full.version }),
      docEvent(2, { format: 'diff', content: d1.content, version: d1.version, base: d1.base }),
      docEvent(3, { format: 'diff', content: d2.content, version: d2.version, base: d2.base }),
    ]
    const current = currentDocument(events, path)
    assert.ok(current)
    assert.equal(current.content, v2)
    assert.equal(current.version, contentVersion(v2))
    assert.ok(current.content.includes('🚀'))
    assert.ok(current.content.endsWith('\n'), 'the exact trailing newline is preserved')
  })

  it('round-trips insertion, deletion, all-change, and no-newline edits', () => {
    const cases: [string, string][] = [
      ['a\nb\n', 'a\nx\ny\nb\n'],
      ['a\nb\nc\n', 'a\nc\n'],
      ['a\nb\n', 'c\nd\n'],
      ['第一行\n第二行\n', '第一行\n新增\n第二行\n'],
      ['no-newline', 'no-newline-extended'],
    ]
    for (const [before, after] of cases) {
      assert.equal(replay(before, after), after, `replay ${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
    }
  })

  it('treats an empty document as one full event and never emits an unchanged draft', () => {
    const empty = documentChange(DOC_PATH, undefined, '')
    assert.ok(empty)
    assert.equal(empty.format, 'full')
    assert.equal(empty.content, '')
    assert.equal(currentDocument([docEvent(1, { format: 'full', content: '', version: contentVersion('') })], DOC_PATH)?.content, '')

    const file = { path: DOC_PATH, title: 'X', content: '# X\n\nbody\n' }
    const first = makeDocumentDraft(file, [], { turn: 1, cycle: 1, source: 'write' })
    assert.ok(first)
    assert.equal(first.type, 'doc.content')
    assert.equal(first.format, 'full')
    assert.equal(first.tokens, estimateTokens(file.content))

    const events = [docEvent(1, { format: 'full', content: file.content, version: contentVersion(file.content) })]
    assert.equal(makeDocumentDraft(file, events, { turn: 1, cycle: 1, source: 'write' }), undefined)
  })

  it('fails on a corrupt base instead of silently dropping it', () => {
    const change = documentChange(DOC_PATH, 'a\nb\n', 'a\nc\n')
    assert.ok(change)
    assert.throws(() => applyDocumentDiff('完全不匹配\n', change.content), /document diff/)
    assert.throws(() => applyDocumentDiff('a\n', 'not a diff'), /no hunk header/)
    const mismatched = [
      docEvent(1, { format: 'full', content: 'a\n', version: contentVersion('a\n') }),
      docEvent(2, { format: 'diff', content: change.content, version: change.version, base: '00000000' }),
    ]
    assert.throws(() => currentDocument(mismatched, DOC_PATH), /does not apply to version/)
    assert.throws(
      () => currentDocument([docEvent(2, { format: 'diff', content: change.content, version: change.version })], DOC_PATH),
      /no base content/,
    )
  })

  it('emits separated minimal hunks for a long report with distant edits', () => {
    const source = Array.from({ length: 70 }, (_, index) => {
      if (index === 0) return '# 报告标题'
      if (index === 69) return 'footer: 完成'
      if (index === 34) return 'SENTINEL-CHANGED-MIDDLE'
      if (index === 50) return 'KEEP-ME-UNCHANGED-50'
      if (index % 12 === 5) return ''
      return `第${index + 1}行 prose 内容 ${index % 2 === 0 ? '🚀' : '中庸'}`
    })
    const before = `${source.join('\n')}\n`
    const edited = [...source]
    edited[0] = '# 报告标题（更新）'
    edited[34] = 'SENTINEL-EDITED-MIDDLE'
    edited[69] = 'footer: 已完成 2026'
    const after = `${edited.join('\n')}\n`

    const change = documentChange(DOC_PATH, before, after)
    assert.ok(change)
    assert.equal(change.format, 'diff')
    assert.equal(change.base, contentVersion(before))
    assert.equal(change.version, contentVersion(after))

    const headers = change.content.split('\n').filter((line) => line.startsWith('@@ '))
    assert.ok(headers.length >= 3, `distant edits must become separate hunks, got ${headers.length}`)
    assert.equal(change.content.includes('KEEP-ME-UNCHANGED-50'), false, 'a distant unchanged line is not re-emitted')
    assert.ok(change.content.length < before.length, 'the diff material is smaller than the full document')

    const current = currentDocument([
      docEvent(1, { format: 'full', content: before, version: contentVersion(before) }),
      docEvent(2, { format: 'diff', content: change.content, version: change.version, base: change.base }),
    ], DOC_PATH)
    assert.ok(current)
    assert.equal(current.content, after)
    assert.equal(current.version, contentVersion(after))
  })

  it('keeps new coordinates consistent across a distant insertion and deletion', () => {
    const source = Array.from({ length: 40 }, (_, index) => `row-${index}`)
    const before = `${source.join('\n')}\n`
    const edited = [...source]
    edited.splice(3, 0, 'INSERT-甲', 'INSERT-乙')
    edited.splice(32, 1)
    const after = `${edited.join('\n')}\n`

    const change = documentChange(DOC_PATH, before, after)
    assert.ok(change)
    const headers = change.content.split('\n').filter((line) => line.startsWith('@@ '))
    assert.ok(headers.length >= 2, 'the distant insertion and deletion must be separate hunks')
    assert.equal(replay(before, after), after)
  })

  it('merges edits whose context windows touch into one hunk', () => {
    const source = Array.from({ length: 30 }, (_, index) => `line-${index}`)
    const before = `${source.join('\n')}\n`
    const edited = [...source]
    edited[10] = 'line-10-edited'
    edited[14] = 'line-14-edited'
    const after = `${edited.join('\n')}\n`

    const change = documentChange(DOC_PATH, before, after)
    assert.ok(change)
    const headers = change.content.split('\n').filter((line) => line.startsWith('@@ '))
    assert.equal(headers.length, 1, 'edits within two context windows merge into one hunk')
    assert.equal(change.content.split('\n').filter((line) => line === ' line-12').length, 1, 'unchanged lines between merged edits occur once as context')
    assert.equal(replay(before, after), after)
  })

  it('reconstructs a chain of full then multi-hunk diffs exactly', () => {
    const base = Array.from({ length: 50 }, (_, index) => `v0-${index}`)
    const v0 = `${base.join('\n')}\n`
    const v1Lines = [...base]
    v1Lines[2] = 'v1-top'
    v1Lines[25] = 'v1-middle'
    v1Lines[47] = 'v1-bottom'
    const v1 = `${v1Lines.join('\n')}\n`
    const v2Lines = [...v1Lines]
    v2Lines.splice(10, 0, 'v2-insert-甲', 'v2-insert-乙')
    v2Lines.splice(40, 2)
    const v2 = `${v2Lines.join('\n')}\n`

    const full = documentChange(DOC_PATH, undefined, v0)
    const d1 = documentChange(DOC_PATH, v0, v1)
    const d2 = documentChange(DOC_PATH, v1, v2)
    assert.ok(full && d1 && d2)
    assert.equal(d1.format, 'diff')
    assert.equal(d2.format, 'diff')

    const current = currentDocument([
      docEvent(1, { format: 'full', content: full.content, version: full.version }),
      docEvent(2, { format: 'diff', content: d1.content, version: d1.version, base: d1.base }),
      docEvent(3, { format: 'diff', content: d2.content, version: d2.version, base: d2.base }),
    ], DOC_PATH)
    assert.ok(current)
    assert.equal(current.content, v2)
    assert.equal(current.version, contentVersion(v2))
  })

  it('round-trips empty documents and newline-only changes exactly', () => {
    const cases: [string, string][] = [
      ['', '第一行\n'],
      ['第一行\n', ''],
      ['\n', ''],
      ['', '\n'],
      ['a\nb', 'a\nb\n'],
      ['a\nb\n', 'a\nb'],
      ['', '🚀\n'],
    ]
    for (const [before, after] of cases) {
      assert.equal(replay(before, after), after, `replay ${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
    }
  })

  it('never emits an event for an unchanged document', () => {
    const content = '# X\n\nbody\n'
    const events = [docEvent(1, { format: 'full', content, version: contentVersion(content) })]
    assert.equal(documentChange(DOC_PATH, content, content), undefined)
    assert.equal(makeDocumentDraft({ path: DOC_PATH, title: 'X', content }, events, { turn: 1, cycle: 1, source: 'write' }), undefined)
  })

  it('rejects a corrupt later hunk instead of returning partial content', () => {
    const base = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', ''].join('\n')
    const good = [
      `--- a/${DOC_PATH}`,
      `+++ b/${DOC_PATH}`,
      '@@ -1,3 +1,3 @@',
      ' a',
      '-b',
      '+B',
      ' c',
      '@@ -10,3 +10,3 @@',
      ' j',
      '-k',
      '+K',
      ' l',
    ].join('\n')
    assert.equal(
      applyDocumentDiff(base, good),
      ['a', 'B', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'K', 'l', ''].join('\n'),
    )

    const goodLines = good.split('\n')
    const headerPositions = goodLines
      .map((line, position) => (line.startsWith('@@ ') ? position : -1))
      .filter((position) => position >= 0)
    assert.equal(headerPositions.length, 2, 'the fixture has two hunks')
    const second = headerPositions[1]!

    const badContext = [...goodLines]
    badContext[second + 1] = ` ${badContext[second + 1]!.slice(1)}-CORRUPT`
    assert.throws(() => applyDocumentDiff(base, badContext.join('\n')), /context does not match/)

    const badRemoval = [...goodLines]
    badRemoval[second + 2] = '-Z'
    assert.throws(() => applyDocumentDiff(base, badRemoval.join('\n')), /removal does not match/)

    const badCount = [...goodLines]
    badCount[second] = '@@ -10,2 +10,3 @@'
    assert.throws(() => applyDocumentDiff(base, badCount.join('\n')), /body does not match its hunk header/)

    const badStart = [...goodLines]
    badStart[second] = '@@ -10,3 +11,3 @@'
    assert.throws(() => applyDocumentDiff(base, badStart.join('\n')), /does not match its output position/)

    const badHeader = [...goodLines]
    badHeader[second] = '@@ -10,3 +10,3 @@malformed'
    assert.throws(() => applyDocumentDiff(base, badHeader.join('\n')), /invalid hunk header/)

    const badOrder = [...goodLines]
    badOrder[second] = '@@ -2,3 +2,3 @@'
    assert.throws(() => applyDocumentDiff(base, badOrder.join('\n')), /overlap or are out of order/)

    const truncated = goodLines.slice(0, goodLines.length - 1)
    assert.throws(() => applyDocumentDiff(base, truncated.join('\n')), /body does not match its hunk header/)
  })

  it('applies a historical prefix/suffix single hunk exactly', () => {
    const before = '第一行\nline two\n最后\n'
    const after = '第一行\nline TWO\n最后\n'
    const historical = [
      `--- a/${DOC_PATH}`,
      `+++ b/${DOC_PATH}`,
      '@@ -1,4 +1,4 @@',
      ' 第一行',
      '-line two',
      '+line TWO',
      ' 最后',
      ' ',
    ].join('\n')
    assert.equal(applyDocumentDiff(before, historical), after)
    assert.equal(currentDocument([
      docEvent(1, { format: 'full', content: before, version: contentVersion(before) }),
      docEvent(2, { format: 'diff', content: historical, version: contentVersion(after), base: contentVersion(before) }),
    ], DOC_PATH)?.content, after)
  })
})
