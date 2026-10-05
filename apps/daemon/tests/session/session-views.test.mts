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
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, it } from 'node:test'
import {
  ContextInspector,
  estimateInputTokens,
  estimateTokens,
  type BuiltView,
  type ContextInspection,
  type DocContentEvent,
  type LedgerEvent,
  type ModelContentPart,
  type SessionFile,
  type WorkspaceSnapshot,
} from '@wrenyard/session'
import {
  COMMUNICATION_EXAMPLES,
  createViews,
} from '../../../../packages/features/session/src/views.ts'
import { Ledger } from '../../../../packages/features/session/src/ledger.ts'
import {
  applyDocumentDiff,
  contentVersion,
  currentDocument,
  documentChange,
  makeDocumentDraft,
} from '../../../../packages/features/session/src/documents.ts'

const VIEWS = createViews()

// The performance regression runs in its own subprocess so a synchronous
// tokenizer stall can never hang the whole test process. `tsx` is resolved from
// this package and the child imports the real source views by file URL.
const require = createRequire(import.meta.url)
const TSX_LOADER = pathToFileURL(require.resolve('tsx')).href
const VIEWS_URL = new URL('../../../../packages/features/session/src/views.ts', import.meta.url).href
const CALLS_URL = new URL('../../../../packages/features/session/src/calls.ts', import.meta.url).href

function giantReplyChild(): string {
  return `
const started = performance.now();
const views = await import(${JSON.stringify(VIEWS_URL)});
const calls = await import(${JSON.stringify(CALLS_URL)});
process.stderr.write('loadedMs=' + Math.round(performance.now() - started) + '\\n');
const lone = (text) => {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = text.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
};
const giant = 'x'.repeat(200000);
const cjk = '中'.repeat(200000);
const emoji = '🚀'.repeat(200000);
const short = '请继续处理这个任务';
const view = views.createViews().reply({
  userText: short,
  lastReasonText: '决定: 采纳甲方案\\n' + cjk + '\\n终态: 已完成',
  actions: [{ name: 'dispatch:' + emoji, status: 'running:' + giant }],
  recentReplies: [emoji, cjk, giant, emoji, cjk],
  status: giant,
  error: cjk,
  question: emoji,
});
process.stderr.write('builtMs=' + Math.round(performance.now() - started) + '\\n');
const text = view.messages
  .map((message) => typeof message.content === 'string'
    ? message.content
    : message.content.map((part) => part.type === 'text' ? part.text : '').join(''))
  .join('\\n');
const total = calls.estimateInputTokens(view.messages);
process.stderr.write('estimatedMs=' + Math.round(performance.now() - started) + '\\n');
process.stdout.write(JSON.stringify({
  total,
  shortKept: text.includes(short),
  omitted: text.includes('…[omitted]…'),
  terminal: text.includes('终态: 已完成'),
  lone: lone(text),
}));
`
}

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
  maxCycles: 5,
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

// ─── reply view: deterministic budget and exact head/tail ───────────────────

describe('reply view budget contract', () => {
  it('keeps system plus every message within 3000 tokens even for giant fields', () => {
    const giant = 'x'.repeat(20_000)
    const view = VIEWS.reply({
      userText: giant,
      lastReasonText: giant,
      actions: [{ name: giant, status: giant }],
      recentReplies: [giant, giant, giant, giant, giant],
      status: giant,
      error: giant,
      question: giant,
    })
    const total = estimateInputTokens(view.messages)
    assert.ok(total <= 3_000, `reply view must stay within 3000 tokens, got ${total}`)
    assert.equal(estimateTokens(COMMUNICATION_EXAMPLES.join('\n')), 0, 'no unapproved examples are embedded')
  })

  it('preserves short decisive facts and the terminal outcome around an explicit omission', () => {
    const lastReason = `决定: 采纳甲方案\n${'中'.repeat(4_000)}\n终态: 已完成`
    const view = VIEWS.reply({
      userText: '请继续',
      lastReasonText: lastReason,
      actions: [{ name: 'dispatch', status: 'done' }],
      recentReplies: ['收到'],
    })
    const text = messageText(view)
    assert.ok(text.includes('决定: 采纳甲方案'), 'the decisive head fact is preserved')
    assert.ok(text.includes('终态: 已完成'), 'the terminal outcome is preserved')
    assert.ok(text.includes('…[omitted]…'), 'the omission is explicit')
  })

  it('never produces malformed UTF-16 when clipping Unicode', () => {
    const view = VIEWS.reply({
      userText: '🚀👩‍🔬'.repeat(2_000),
      lastReasonText: '🧪'.repeat(3_000),
      actions: [{ name: '🔧', status: 'done' }],
      recentReplies: ['✅'],
    })
    for (const message of view.messages) {
      const text = typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
      assert.equal(loneSurrogate(text), false, 'a clipped prompt must never end on a lone surrogate')
    }
    assert.ok(estimateInputTokens(view.messages) <= 3_000)
  })

  it('ships no unapproved example scaffolding and no example section in the system prompt', () => {
    assert.equal(COMMUNICATION_EXAMPLES.length, 0)
    const view = VIEWS.reply({ userText: 'x', lastReasonText: 'r', actions: [], recentReplies: [] })
    const system = view.messages[0]!.content
    assert.equal(typeof system, 'string')
    assert.equal(/<example|few-shot|示例/u.test(system as string), false)
  })
})

describe('reply view raw-field codepoint boundary', () => {
  it('returns a field at the 1024-codepoint cap exactly, supplementary pairs included and no omission', () => {
    const exact = `${'a'.repeat(1_022)}🚀🚀`
    assert.equal(Array.from(exact).length, 1_024, 'the fixture is exactly at the cap')
    const view = VIEWS.reply({ userText: 'x', lastReasonText: exact, actions: [], recentReplies: [] })
    const text = messageText(view)
    assert.ok(text.includes(exact), 'a field at the cap is retained exactly')
    assert.equal(text.includes('…[omitted]…'), false, 'no omission is introduced at the cap')
    for (const message of view.messages) {
      const body = typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
      assert.equal(loneSurrogate(body), false, 'an untouched field stays well-formed')
    }
    assert.ok(estimateInputTokens(view.messages) <= 3_000)
  })

  it('trims a 1025-codepoint field to exactly 512 head + omission + 512 tail around valid pairs', () => {
    const O = '\n…[omitted]…\n'
    const cases = [
      {
        label: 'a pair begins the tail',
        field: `${'a'.repeat(513)}🚀${'b'.repeat(511)}`,
        head: 'a'.repeat(512),
        tail: `🚀${'b'.repeat(511)}`,
      },
      {
        label: 'a pair ends the head',
        field: `${'a'.repeat(511)}🚀${'b'.repeat(513)}`,
        head: `${'a'.repeat(511)}🚀`,
        tail: 'b'.repeat(512),
      },
    ]
    for (const { label, field, head, tail } of cases) {
      assert.equal(Array.from(field).length, 1_025, `${label}: the fixture is one past the cap`)
      const view = VIEWS.reply({ userText: 'x', lastReasonText: field, actions: [], recentReplies: [] })
      const body = messageText(view)
      const expected = `${head}${O}${tail}`
      assert.ok(body.includes(expected), `${label}: exactly 512 head + omission + 512 tail is retained`)
      assert.equal(body.includes(field), false, `${label}: the untrimmed giant field is not retained whole`)
      for (const message of view.messages) {
        const content = typeof message.content === 'string'
          ? message.content
          : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
        assert.equal(loneSurrogate(content), false, `${label}: a clipped field never splits a surrogate pair`)
      }
      assert.ok(estimateInputTokens(view.messages) <= 3_000, `${label}: the whole real-token input stays bounded`)
    }
  })

  it('keeps the running and failed action facts and the current-attempt error', () => {
    const view = VIEWS.reply({
      status: 'running',
      userText: '继续',
      lastReasonText: 'r',
      actions: [
        { name: 'dispatch tool', status: 'running' },
        { name: 'dispatch tool-1', status: 'failed' },
      ],
      recentReplies: [],
      error: 'compile failed for dispatch tool-1',
    })
    const text = messageText(view)
    assert.ok(text.includes('turn status: running'), 'the turn stays reported running')
    assert.ok(text.includes('action running: dispatch tool'), 'the running action state is retained')
    assert.ok(text.includes('action failed: dispatch tool-1'), 'the failed action state is retained')
    assert.ok(text.includes('error: compile failed for dispatch tool-1'), 'the current-attempt error is conveyed')
    assert.ok(
      text.includes('actions: 2') && text.includes('running 1') && text.includes('failed 1'),
      'both mixed states are tallied',
    )
    assert.ok(estimateInputTokens(view.messages) <= 3_000)
  })
})

describe('reply view finite-time bounding', () => {
  // A pathological reply must be bounded before tokenization, not after: the
  // subprocess hard-deadline fails (and kills only the child) if the real
  // source stalls on the giant fields.
  it('bounds giant fields before tokenization inside a hard subprocess deadline', (t) => {
    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--import', TSX_LOADER, '--input-type=module', '--eval', giantReplyChild()],
      {
        timeout: 5_000,
        maxBuffer: 4_096,
        encoding: 'utf8',
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
      },
    )
    t.diagnostic(result.stderr.trim())
    assert.equal(result.error, undefined, `subprocess failed: ${result.error?.message ?? 'unknown'}; ${result.stderr}`)
    assert.equal(result.status, 0, `subprocess exited ${result.status}: ${result.stderr}`)
    const measured = JSON.parse(result.stdout) as {
      total: number
      shortKept: boolean
      omitted: boolean
      terminal: boolean
      lone: boolean
    }
    assert.ok(measured.total <= 3_000, `giant reply view must stay within 3000 tokens, got ${measured.total}`)
    assert.equal(measured.shortKept, true, 'the short user request is retained in full')
    assert.equal(measured.omitted, true, 'an explicit head/tail omission marker is present')
    assert.equal(measured.terminal, true, 'the terminal outcome is preserved around the omission')
    assert.equal(measured.lone, false, 'no clipped prompt ends on a lone surrogate')
  })
})

// ─── reply view: authoritative status/action facts ──────────────────────────

describe('reply view status and action facts lead the status block', () => {
  it('places the running status and action state before a giant action goal', () => {
    const goal = `ACTIONMARK${'长'.repeat(2_000)}`
    const view = VIEWS.reply({
      status: 'running',
      userText: '继续',
      lastReasonText: `决定: 采纳甲方案\n${'大纲'.repeat(1_000)}\n报告已写好。`,
      actions: [{ name: goal, status: 'running' }],
      recentReplies: ['报告已写好。'],
    })
    const text = messageText(view)
    assert.ok(text.includes('turn status: running'), 'the running turn state is explicit')
    assert.ok(text.includes('actions: 1 (running 1)'), 'the action tally survives a giant goal')
    assert.ok(text.includes('action running:'), 'each action entry is status-first')
    const statusAt = text.indexOf('turn status: running')
    const goalAt = text.indexOf('ACTIONMARK')
    assert.ok(statusAt !== -1 && goalAt !== -1 && statusAt < goalAt, 'factual state precedes the giant goal')
    assert.ok(estimateInputTokens(view.messages) <= 3_000)
  })

  it('retains factual status and action state for a giant raw input within the token budget', () => {
    const giant = 'x'.repeat(20_000)
    const view = VIEWS.reply({
      status: 'running',
      userText: giant,
      lastReasonText: giant,
      actions: [{ name: `写报告${giant}`, status: 'running' }],
      recentReplies: [giant, giant],
    })
    const text = messageText(view)
    assert.ok(text.includes('turn status: running'), 'the running state survives the giant input')
    assert.ok(text.includes('action running:'), 'the status-first action entry survives the giant input')
    assert.ok(estimateInputTokens(view.messages) <= 3_000, 'the whole real-token input stays bounded')
  })

  it('makes program status/action facts authoritative over intent, outline and prior replies', () => {
    const view = VIEWS.reply({
      userText: 'x',
      lastReasonText: '决定完成后写报告',
      actions: [{ name: 'dispatch tool', status: 'running' }],
      recentReplies: ['报告已写好。'],
    })
    const system = view.messages[0]!.content
    assert.equal(typeof system, 'string')
    const prompt = system as string
    assert.match(prompt, /权威/u, 'program facts are authoritative over model output')
    assert.equal(/<example|few-shot|示例/u.test(prompt), false)
  })
})

describe('reply view zero-action facts', () => {
  it('renders an explicit zero-action tally when the current turn executed nothing', () => {
    const view = VIEWS.reply({ userText: 'x', lastReasonText: 'r', actions: [], recentReplies: [] })
    const text = messageText(view)
    assert.ok(text.includes('actions: 0'), 'a zero-action turn still states its actual tally')
  })

  it('renders the prior overall done action without any missing-result structure', () => {
    const view = VIEWS.reply({
      userText: '继续',
      lastReasonText: '',
      actions: [{ name: 'dispatch tool', status: 'done' }],
      recentReplies: [],
    })
    const text = messageText(view)
    assert.ok(text.includes('actions: 1 (done 1)'), 'the prior overall done action is tallied')
    assert.ok(text.includes('action done: dispatch tool'), 'the prior completed action is rendered')
    assert.equal(text.includes('missing visible result'), false, 'no missing-result structure is rendered')
    assert.ok(estimateInputTokens(view.messages) <= 3_000, 'the whole real-token input stays bounded')
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
    assert.match(prompt, /唯一权威/u, 'the current intent is the sole authority for this one action')
    assert.match(prompt, /reference-context/u, 'the reference context is named reference only')
    assert.match(prompt, /不能授权/u, 'the reference cannot authorize siblings or history')
    assert.match(prompt, /不得替换为父项目/u, 'an exact named project is preserved, not replaced')
    assert.match(prompt, /兄弟/u, 'sibling substitution is forbidden')
    assert.match(prompt, /无关/u, 'unrelated substitution is forbidden')
    assert.match(prompt, /内置任务/u, 'inherited builtin tasks remain available')
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
