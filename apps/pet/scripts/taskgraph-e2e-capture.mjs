// ── TaskGraph E2E capture harness ────────────────────────────────────
// Uses compiled production TaskGraphWindowOwner, production preloads,
// and genuine Electron input. Fakes only the ForemanIpcClient request
// boundary so every IPC path (entity:open-self, slip:open-transcript,
// slip:close, entity:set-mouse-passthrough, transcript:retry, panel:close)
// runs through production handlers.

import { createRequire } from 'node:module';
import { app, BrowserWindow, nativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const captureBase = path.join(rootDir, 'artifacts', 'ui-review');
const htmlDir = path.join(rootDir, 'dist', 'renderer');
const preloadDir = path.join(rootDir, 'dist', 'main', 'main');
const electronDataDir = path.join(captureBase, 'electron-user-data');

const { TaskGraphWindowOwner } = require(path.join(preloadDir, 'taskgraph-windows.js'));

const POLL_MS = 25;
const CASE_TIMEOUT_MS = 15000;

fs.mkdirSync(electronDataDir, { recursive: true });
fs.mkdirSync(captureBase, { recursive: true });
app.setPath('userData', electronDataDir);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// ── Fake ForemanIpcClient ────────────────────────────────────────────
// Fakes only the request() boundary. Each capture case calls setFixture()
// to program the response for each Foreman IPC method.

class FakeForemanIpcClient {
  constructor() {
    this.reset();
  }

  reset() {
    this._fixtures = new Map();
    this._callCounts = new Map();
    this._failures = new Map();  // method -> call-index after which to throw
    this._protocolIssues = [];   // task.run.status protocol deviations
  }

  setFixture(method, response) {
    this._fixtures.set(method, response);
  }

  setFailure(method, afterCallCount) {
    this._failures.set(method, afterCallCount);
  }

  async request(method, params) {
    const key = method;
    const count = (this._callCounts.get(key) || 0) + 1;
    this._callCounts.set(key, count);

    const failAfter = this._failures.get(key);
    if (failAfter !== undefined && count > failAfter) {
      throw new Error(`FakeForemanIpcClient: ${method} failing after ${failAfter} calls`);
    }

    const fixture = this._fixtures.get(method);
    if (fixture === undefined) {
      throw new Error(`FakeForemanIpcClient: no fixture for ${method}`);
    }
    const response = await (typeof fixture === 'function' ? fixture(params) : fixture);
    if (method === 'task.run.status') {
      this.validateRunStatus(params, response);
    }
    return response;
  }

  // The production reader consumes task.run.status through taskRunIsTerminal:
  // the response must echo the requested nonempty task_run_id and carry a
  // string status, with no is_terminal field. The transcript poller swallows
  // reader errors, so a deviation is recorded against this client and the
  // case asserts it — a broken fixture can never be hidden by screenshot
  // timing.
  validateRunStatus(params, response) {
    const requested = params && params.task_run_id;
    const issues = [];
    if (typeof requested !== 'string' || requested.length === 0) {
      issues.push('requested task_run_id is not a nonempty string: ' + JSON.stringify(requested));
    }
    if (response === null || typeof response !== 'object' || Array.isArray(response)) {
      issues.push('response is not a record');
    } else {
      if (response.task_run_id !== requested) {
        issues.push('response task_run_id "' + String(response.task_run_id) + '" does not echo requested "' + String(requested) + '"');
      }
      if (typeof response.status !== 'string') {
        issues.push('response status is not a string: ' + JSON.stringify(response.status));
      }
      if (Object.prototype.hasOwnProperty.call(response, 'is_terminal')) {
        issues.push('response carries a forbidden is_terminal field');
      }
    }
    if (issues.length > 0) {
      this._protocolIssues.push('task.run.status protocol violation: ' + issues.join('; ') + ' (response=' + JSON.stringify(response) + ')');
    }
  }
}

// ── Fixture helpers ────────────────────────────────────────────────────

const TS = '2025-06-01T00:00:00Z';

function baseInspect(graphId) {
  return {
    graph: {
      id: graphId,
      revision: 1,
      nodes: {
        'node-a1': { id: 'node-a1', name: 'Plan', action: { type: 'llm_call', params: {} }, deps: [] },
        'node-a2': { id: 'node-a2', name: 'Analyze', action: { type: 'task', params: {} }, deps: ['node-a1'] },
        'node-a3': { id: 'node-a3', name: 'Finalize', action: { type: 'end', params: {} }, deps: ['node-a2'] },
      },
    },
  };
}

// Mixed-node structure for the fact-slip content case: three task nodes plus
// multiple done control nodes. The paper-tag counts must reflect only the
// task nodes (2 done / 3 total), never the control nodes.
function contentInspect(graphId) {
  return {
    graph: {
      id: graphId,
      revision: 1,
      nodes: {
        'node-t1': { id: 'node-t1', name: '评审代码', action: { type: 'task', params: {} }, deps: [] },
        'node-t2': { id: 'node-t2', name: '验证改动', action: { type: 'task', params: {} }, deps: [] },
        'node-t3': { id: 'node-t3', name: '提交结果', action: { type: 'task', params: {} }, deps: [] },
        'node-c1': { id: 'node-c1', name: 'Start', action: { type: 'start', params: {} }, deps: [] },
        'node-c2': { id: 'node-c2', name: '审查', action: { type: 'llm_call', params: {} }, deps: [] },
        'node-c3': { id: 'node-c3', name: 'End', action: { type: 'end', params: {} }, deps: [] },
      },
    },
  };
}

// ── Activity snapshot presence factories ──────────────────────────────
// Dynamic Wren/Graph Slip state now derives exclusively from the single
// activity snapshot (applyActivity), not from per-graph status/slip/events
// calls. The fake boundary only serves the static structure (taskgraph.inspect)
// plus the transcript feed (task.run.events / task.run.status).

function nodePresence(id, state, overrides) {
  var n = { nodeId: id, state: state };
  if (!overrides) return n;
  if (overrides.taskRunId !== undefined) n.taskRunId = overrides.taskRunId;
  if (overrides.taskId !== undefined) n.taskId = overrides.taskId;
  if (overrides.taskStatus !== undefined) n.taskStatus = overrides.taskStatus;
  if (overrides.taskCategoryId !== undefined) n.taskCategoryId = overrides.taskCategoryId;
  if (overrides.taskCategoryLabel !== undefined) n.taskCategoryLabel = overrides.taskCategoryLabel;
  if (overrides.displayLabel !== undefined) n.displayLabel = overrides.displayLabel;
  if (overrides.description !== undefined) n.description = overrides.description;
  if (overrides.resolvedProfile !== undefined) n.resolvedProfile = overrides.resolvedProfile;
  if (overrides.toolCallCount !== undefined) n.toolCallCount = overrides.toolCallCount;
  if (overrides.tps !== undefined) n.tps = overrides.tps;
  if (overrides.summary !== undefined) n.summary = overrides.summary;
  return n;
}

function graphPresence(id, state, opts) {
  opts = opts || {};
  var nodes = opts.nodes || [];
  var counts = opts.nodeCounts || {
    planned: 0,
    running: nodes.filter(function (n) { return n.state === 'running'; }).length,
    waiting: 0,
    done: nodes.filter(function (n) { return n.state === 'done'; }).length,
    failed: opts.failed || 0,
    interrupted: 0,
    cancelled: 0,
  };
  var p = {
    taskgraphId: id,
    state: state,
    structureRevision: opts.structureRevision !== undefined ? opts.structureRevision : 1,
    latestSeq: opts.latestSeq !== undefined ? opts.latestSeq : 1,
    nodeCounts: counts,
    active: { running: [], waiting: [] },
    nodes: nodes,
  };
  if (opts.title) p.title = opts.title;
  if (opts.terminalReason) p.terminalReason = opts.terminalReason;
  return p;
}

function presenceWith(graphs, tasks) {
  return { sampledAt: TS, stale: false, tasks: tasks || [], taskgraphs: graphs };
}

function basePresenceNodes() {
  return [
    nodePresence('node-a1', 'done'),
    nodePresence('node-a2', 'running', {
      taskRunId: 'run-e2e-a2',
      taskId: 'forge-deploy',
      taskStatus: 'running',
      taskCategoryId: 'code-review',
      taskCategoryLabel: '代码审查',
      description: '审查代码改动并输出审查结论',
      resolvedProfile: 'fast',
      toolCallCount: 3,
      tps: 12.5,
    }),
    nodePresence('node-a3', 'planned'),
  ];
}

function baseGraphPresence(graphId, state, opts) {
  opts = opts || {};
  return graphPresence(graphId, state || 'running', {
    nodes: opts.nodes || basePresenceNodes(),
    latestSeq: opts.latestSeq !== undefined ? opts.latestSeq : 3,
    title: opts.title,
    failed: opts.failed,
    terminalReason: opts.terminalReason,
  });
}

function runEventsResponse(taskRunId, afterSeq) {
  const fixtures = {
    'run-e2e-a1': {
      task_run_id: 'run-e2e-a1',
      events: [
        { seq: 1, type: 'message', timestamp: '2025-06-01T00:00:01Z', data: { message_summary: 'Task requirements analyzed' } },
        { seq: 2, type: 'tool_call', timestamp: '2025-06-01T00:00:02Z', data: { tool_name: 'read_file', input_summary: 'Read config' } },
        { seq: 3, type: 'tool_result', timestamp: '2025-06-01T00:00:03Z', data: { output_summary: 'Config read', status: 'success' }, is_error: false },
        { seq: 4, type: 'turn_usage', timestamp: '2025-06-01T00:00:04Z', data: { input_tokens: 450, output_tokens: 120, total_tokens: 570, duration_ms: 3200 } },
        { seq: 5, type: 'lifecycle', timestamp: '2025-06-01T00:00:05Z', data: { event: 'completed', status: 'success' } },
      ],
      next_seq: 6,
      has_more: false,
    },
    'run-e2e-a2': {
      task_run_id: 'run-e2e-a2',
      events: [
        { seq: 1, type: 'message', timestamp: '2025-06-01T00:00:10Z', data: { message_summary: 'Analyzing results' } },
      ],
      next_seq: 2,
      has_more: true,
    },
  };
  // Honor the after_seq cursor like the production protocol: the initial
  // page (no after_seq) returns the run's events and any later page at/after
  // next_seq returns an empty page, so transcript polling never re-renders
  // the same events as duplicates.
  var base = fixtures[taskRunId] || { task_run_id: taskRunId, events: [], next_seq: 0, has_more: false };
  if (afterSeq !== undefined && afterSeq >= base.next_seq) {
    return { task_run_id: taskRunId, events: [], next_seq: afterSeq, has_more: false };
  }
  return base;
}

// task.run.status is consumed by the production taskRunIsTerminal contract:
// the response must echo the requested nonempty task_run_id and carry a
// string status (live 'running' by default, or an explicit terminal status).
function runStatusResponse(taskRunId, status) {
  return { task_run_id: taskRunId, status: status || 'running' };
}

// ── Default graph fixture setter ──────────────────────────────────────

function applyBaseFixtures(client, graphId, state, opts) {
  const gid = graphId || 'tg-e2e-a';
  client.setFixture('taskgraph.inspect', baseInspect(gid));
  client.setFixture('task.run.events', (params) => runEventsResponse(params.task_run_id, params.after_seq));
  client.setFixture('task.run.status', (params) => runStatusResponse(params.task_run_id));
  return baseGraphPresence(gid, state || 'running', opts);
}

function applyActivity(graphs, tasks) {
  if (!currentOwner) throw new Error('applyActivity requires a created owner');
  currentOwner.applyActivity(presenceWith(graphs, tasks));
}

// ── Utilities ──────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

var failures = [];
var manifestEntries = [];

function fail(message) {
  failures.push(message);
  console.error('[capture] FAIL:', message);
}

function hashImage(filePath) {
  if (!fs.existsSync(filePath)) return '';
  var buf = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(buf).digest('hex');
}

async function captureWindow(win, outFile) {
  var image = await win.capturePage(undefined, { stayHidden: true });
  if (image.isEmpty()) throw new Error('capturePage returned empty image');
  fs.writeFileSync(outFile, image.toPNG());
  return outFile;
}

async function captureInteractiveWindow(win, outFile) {
  var image = await win.capturePage(undefined, { stayHidden: true });
  if (image.isEmpty()) throw new Error('capturePage returned empty image');
  fs.writeFileSync(outFile, image.toPNG());
  return outFile;
}

async function captureMeaningfulEntityWindow(win, outFile) {
  await waitForMarker(win, 'entityReady', CASE_TIMEOUT_MS);
  var deadline = Date.now() + 2000;
  var lastNonTransparent = 0;
  while (Date.now() < deadline) {
    var image = await win.capturePage(undefined, { stayHidden: true });
    if (image.isEmpty()) { await delay(50); continue; }
    var pngBuf = image.toPNG();
    var decoded = nativeImage.createFromBuffer(pngBuf);
    if (decoded.isEmpty()) { await delay(50); continue; }
    var size = decoded.getSize();
    if (size.width !== 156 || size.height !== 84) { await delay(50); continue; }
    var bitmap = decoded.getBitmap();
    var nonTransparent = 0;
    for (var i = 3; i < bitmap.length; i += 4) {
      if (bitmap[i] > 0) nonTransparent++;
    }
    if (nonTransparent >= 100) {
      fs.writeFileSync(outFile, pngBuf);
      return outFile;
    }
    lastNonTransparent = nonTransparent;
    await delay(50);
  }
  throw new Error('Entity image never became meaningful; last non-transparent pixel count: ' + lastNonTransparent);
}

function findWindowByQuery(searchParam, expectedValue) {
  var allWins = BrowserWindow.getAllWindows();
  for (var i = 0; i < allWins.length; i++) {
    var w = allWins[i];
    if (w.isDestroyed()) continue;
    try {
      var url = w.webContents.getURL();
      var urlObj = new URL(url);
      if (urlObj.searchParams.get(searchParam) === expectedValue) return w;
    } catch (_) { /* ignore */ }
  }
  return null;
}

function findEntityWindow(entityId) {
  return findWindowByQuery('entity_id', entityId);
}

function findGraphSlipWindow(graphId) {
  return findWindowByQuery('graph_id', graphId);
}

function findTranscriptWindow(taskRunId) {
  return findWindowByQuery('task_run_id', taskRunId);
}

function findAnyGraphSlipWindow() {
  var allWins = BrowserWindow.getAllWindows();
  for (var i = 0; i < allWins.length; i++) {
    var w = allWins[i];
    if (w.isDestroyed()) continue;
    try {
      var url = w.webContents.getURL();
      if (url.includes('graph-slip.html')) return w;
    } catch (_) { /* ignore */ }
  }
  return null;
}

function findAnyTranscriptWindow() {
  var allWins = BrowserWindow.getAllWindows();
  for (var i = 0; i < allWins.length; i++) {
    var w = allWins[i];
    if (w.isDestroyed()) continue;
    try {
      var url = w.webContents.getURL();
      if (url.includes('transcript.html')) return w;
    } catch (_) { /* ignore */ }
  }
  return null;
}

async function waitForEntity(entityId, timeoutMs) {
  var started = Date.now();
  while (Date.now() - started < timeoutMs) {
    var win = findEntityWindow(entityId);
    if (win && !win.isDestroyed()) return win;
    await delay(POLL_MS);
  }
  throw new Error('Timeout waiting for entity window: ' + entityId);
}

async function waitForGraphSlip(graphId, timeoutMs) {
  var started = Date.now();
  while (Date.now() - started < timeoutMs) {
    var win = findGraphSlipWindow(graphId);
    if (win && !win.isDestroyed()) return win;
    await delay(POLL_MS);
  }
  throw new Error('Timeout waiting for graph slip window: ' + graphId);
}

async function waitForTranscript(taskRunId, timeoutMs) {
  var started = Date.now();
  while (Date.now() - started < timeoutMs) {
    var win = findTranscriptWindow(taskRunId);
    if (win && !win.isDestroyed()) return win;
    await delay(POLL_MS);
  }
  throw new Error('Timeout waiting for transcript window: ' + taskRunId);
}

async function waitForAnyGraphSlip(timeoutMs) {
  var started = Date.now();
  while (Date.now() - started < timeoutMs) {
    var win = findAnyGraphSlipWindow();
    if (win && !win.isDestroyed()) return win;
    await delay(POLL_MS);
  }
  throw new Error('Timeout waiting for any graph slip window');
}

async function waitForAnyTranscript(timeoutMs) {
  var started = Date.now();
  while (Date.now() - started < timeoutMs) {
    var win = findAnyTranscriptWindow();
    if (win && !win.isDestroyed()) return win;
    await delay(POLL_MS);
  }
  throw new Error('Timeout waiting for any transcript window');
}

async function assertMarker(win, marker, shouldBePresent) {
  var present = await win.webContents.executeJavaScript(
    '!!document.documentElement.dataset["' + marker + '"]',
  ).catch(function () { return false; });
  if (shouldBePresent && !present) fail('Expected marker ' + marker + ' to be present');
  if (!shouldBePresent && present) fail('Expected marker ' + marker + ' to be absent');
}

async function waitForMarker(win, marker, timeoutMs) {
  var started = Date.now();
  var deadline = timeoutMs || CASE_TIMEOUT_MS;
  while (Date.now() - started < deadline) {
    var present = await win.webContents.executeJavaScript(
      '!!document.documentElement.dataset["' + marker + '"]',
    ).catch(function () { return false; });
    if (present) return;
    await delay(POLL_MS);
  }
  throw new Error('Timeout waiting for marker: ' + marker);
}

async function assertElementVisible(win, selector) {
  var visible = await win.webContents.executeJavaScript(
    '(function() { var el = document.querySelector(' + JSON.stringify(selector) + '); return el && el.offsetParent !== null; })()',
  ).catch(function () { return false; });
  if (!visible) fail('Expected element visible: ' + selector);
}

async function assertElementHidden(win, selector) {
  var hidden = await win.webContents.executeJavaScript(
    '(function() { var el = document.querySelector(' + JSON.stringify(selector) + '); return !el || el.offsetParent === null || el.classList.contains("hidden"); })()',
  ).catch(function () { return true; });
  if (!hidden) fail('Expected element hidden: ' + selector);
}

async function assertElementAbsent(win, selector) {
  var count = await win.webContents.executeJavaScript(
    '(function() { return document.querySelectorAll(' + JSON.stringify(selector) + ').length; })()',
  ).catch(function () { return -1; });
  if (count > 0) fail('Expected no elements matching: ' + selector + ' (found ' + count + ')');
}

// Production-renderer check for the approved graph-slip visual contract.
// All task nodes must share ONE unified Agent glyph signature; every
// visible control keeps its own distinct procedural semantics; join/fanout
// transit nodes never render node DOM; and the collapsed junctions are
// exposed as 3px ink solder dots.
async function assertApprovedGraphSlipVisuals(win, expected) {
  var expectedTasks = expected.tasks || 0;
  var expectedControls = expected.controls || [];
  var expectedJunctions = expected.junctions !== undefined ? expected.junctions : 0;
  var snapshot = null;
  var started = Date.now();
  while (Date.now() - started < 5000) {
    snapshot = await win.webContents.executeJavaScript(
      '(function() { var nodes = Array.prototype.slice.call(document.querySelectorAll("[data-node-id]")); var glyph = function(el) { var parts = Array.prototype.map.call(el.querySelectorAll(".dag-icon path"), function(p) { return p.getAttribute("d") || ""; }); return parts.join("|"); }; var tasks = nodes.filter(function(el) { return el.getAttribute("data-node-kind") === "task"; }); var controls = nodes.filter(function(el) { return el.getAttribute("data-node-kind") === "control"; }); return { taskCount: tasks.length, taskSigs: tasks.map(glyph), controls: controls.map(function(el) { return { id: el.getAttribute("data-node-id"), type: el.getAttribute("data-action-type"), sig: glyph(el) }; }), transit: nodes.filter(function(el) { var t = el.getAttribute("data-action-type"); return t === "join" || t === "fanout"; }).length, solder: document.querySelectorAll(".dag-solder").length }; })()',
    ).catch(function () { return null; });
    if (snapshot && snapshot.taskCount >= expectedTasks) break;
    await delay(POLL_MS);
  }
  if (!snapshot) {
    fail('assertApprovedGraphSlipVisuals: could not read the rendered graph slip DOM');
    return;
  }
  if (snapshot.taskCount !== expectedTasks) {
    fail('assertApprovedGraphSlipVisuals: expected ' + expectedTasks + ' task nodes, got ' + snapshot.taskCount);
  }
  // 1) Unified Agent glyph: every task node shares one identical signature.
  if (new Set(snapshot.taskSigs).size !== 1) {
    fail('assertApprovedGraphSlipVisuals: task nodes are not unified on one Agent glyph: ' + JSON.stringify(snapshot.taskSigs));
  }
  // 2) Distinct control semantics, one stable signature per control type.
  var byType = {};
  for (var i = 0; i < snapshot.controls.length; i++) {
    var c = snapshot.controls[i];
    (byType[c.type] = byType[c.type] || []).push(c.sig);
  }
  for (var t in expectedControls) {
    if (!byType[expectedControls[t]]) {
      fail('assertApprovedGraphSlipVisuals: missing expected control type ' + expectedControls[t]);
      continue;
    }
    if (new Set(byType[expectedControls[t]]).size !== 1) {
      fail('assertApprovedGraphSlipVisuals: control type ' + expectedControls[t] + ' rendered multiple glyph signatures: ' + JSON.stringify(byType[expectedControls[t]]));
    }
  }
  var controlTypes = Object.keys(byType);
  var typeSigs = controlTypes.map(function (type) { return byType[type][0]; });
  if (new Set(typeSigs).size !== controlTypes.length) {
    fail('assertApprovedGraphSlipVisuals: control types do not keep distinct glyph signatures: ' + JSON.stringify(typeSigs));
  }
  // 3) join/fanout never render node DOM; solder dots stand in for them.
  if (snapshot.transit !== 0) {
    fail('assertApprovedGraphSlipVisuals: join/fanout rendered visible node DOM (' + snapshot.transit + ' nodes)');
  }
  if (snapshot.solder !== expectedJunctions) {
    fail('assertApprovedGraphSlipVisuals: expected ' + expectedJunctions + ' solder dots, got ' + snapshot.solder);
  }
}

// Every routed edge path must be M/V/H only — any L/C/Q/A command means a
// diagonal or curved segment crept back into the layout.
async function assertOrthogonalEdges(win) {
  var bad = await win.webContents.executeJavaScript(
    '(function() { var paths = Array.prototype.slice.call(document.querySelectorAll(".dag-edge")); var bad = []; for (var i = 0; i < paths.length; i++) { var d = paths[i].getAttribute("d") || ""; if (/[LCQAS]/.test(d)) bad.push(d); } return bad; })()',
  ).catch(function () { return null; });
  if (bad === null) {
    fail('assertOrthogonalEdges: could not inspect edge paths');
    return;
  }
  if (bad.length > 0) {
    fail('assertOrthogonalEdges: non-orthogonal edge path commands found: ' + JSON.stringify(bad));
  }
}

// Every routed edge segment must stay outside every visible node rect.
// Node boxes come from the real paper tag / control tile geometry (never
// the wider text bbox), so edges passing beside a label are not false
// positives. Only source/target attachment segments may touch their own
// node boundary; any other node crossed is a routing defect.
async function assertEdgesAvoidNodeRects(win) {
  var bad = await win.webContents.executeJavaScript(
    '(function() { var taskTags = Array.prototype.map.call(document.querySelectorAll("[data-node-kind=task] .dag-tag"), function (el) { var b = el.getBBox(); var g = el.closest("[data-node-id]"); return { id: g ? g.getAttribute("data-node-id") : null, x: b.x, y: b.y, w: b.width, h: b.height }; }); var controlTiles = Array.prototype.map.call(document.querySelectorAll("[data-node-kind=control] .dag-icon-tile"), function (el) { var b = el.getBBox(); var g = el.closest("[data-node-id]"); return { id: g ? g.getAttribute("data-node-id") : null, x: b.x, y: b.y, w: b.width, h: b.height }; }); var rects = taskTags.concat(controlTiles); var segCrosses = function (a, b, r) { if (a.x === b.x) { if (a.x <= r.x || a.x >= r.x + r.w) return false; var lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y); return hi > r.y && lo < r.y + r.h; } if (a.y <= r.y || a.y >= r.y + r.h) return false; var loX = Math.min(a.x, b.x), hiX = Math.max(a.x, b.x); return hiX > r.x && loX < r.x + r.w; }; var parsePoints = function (d) { var pts = []; var re = /([MHV])\\s*([0-9.eE+-]+)(?:\\s+([0-9.eE+-]+))?/g; var m; var cur = { x: 0, y: 0 }; while ((m = re.exec(d)) !== null) { var op = m[1]; if (op === "M" || op === "L") { cur = { x: parseFloat(m[2]), y: parseFloat(m[3]) }; pts.push(cur); } else if (op === "H") { cur = { x: parseFloat(m[2]), y: cur.y }; pts.push(cur); } else if (op === "V") { cur = { x: cur.x, y: parseFloat(m[2]) }; pts.push(cur); } } return pts; }; var bad = []; var edges = Array.prototype.slice.call(document.querySelectorAll(".dag-edge")); for (var i = 0; i < edges.length; i++) { var g = edges[i].closest("g[data-source-id]"); if (!g) continue; var from = g.getAttribute("data-source-id"); var to = g.getAttribute("data-target-id"); var pts = parsePoints(edges[i].getAttribute("d") || ""); for (var j = 1; j < pts.length; j++) { for (var k = 0; k < rects.length; k++) { var r = rects[k]; if (r.id === from || r.id === to) continue; if (segCrosses(pts[j - 1], pts[j], r)) bad.push(from + "->" + to + " crosses " + r.id); } } } return bad; })()',
  ).catch(function () { return null; });
  if (bad === null) {
    fail('assertEdgesAvoidNodeRects: could not inspect edge/node geometry');
    return;
  }
  if (bad.length > 0) {
    fail('assertEdgesAvoidNodeRects: routed edges pass through visible node rects: ' + JSON.stringify(bad));
  }
}

// The SVG canvas reports its natural layout width/height and the scroll
// container exposes the real overflow — wide/tall graphs scroll instead
// of being squashed into the viewport.
async function assertHonestContentSize(win) {
  var info = await win.webContents.executeJavaScript(
    '(function() { var svg = document.querySelector("#dag-canvas"); var content = document.querySelector("#content"); if (!svg || !content) return null; return { w: Number(svg.getAttribute("width")), h: Number(svg.getAttribute("height")), sw: content.scrollWidth, sh: content.scrollHeight }; })()',
  ).catch(function () { return null; });
  if (!info) {
    fail('assertHonestContentSize: canvas/content missing');
    return;
  }
  if (!(info.w > 0 && info.h > 0)) {
    fail('assertHonestContentSize: SVG canvas has non-positive natural size: ' + info.w + 'x' + info.h);
  }
  if (info.sw < info.w || info.sh < info.h) {
    fail('assertHonestContentSize: scroll dimensions under-report content: scroll ' + info.sw + 'x' + info.sh + ' vs svg ' + info.w + 'x' + info.h);
  }
}

// The content area paints a solid opaque paper (#F7EFD8); an opaque
// scroll container prevents desktop bleed-through behind the graph.
async function assertSolidPaperBackground(win) {
  var bg = await win.webContents.executeJavaScript(
    '(function() { var content = document.querySelector("#content"); if (!content) return null; return getComputedStyle(content).backgroundColor; })()',
  ).catch(function () { return null; });
  if (bg !== 'rgb(247, 239, 216)') {
    fail('assertSolidPaperBackground: graph slip content does not paint solid paper: ' + bg);
  }
}

// start/end are icon-only, noninteractive and titleless.
async function assertControlNoninteractive(win) {
  var bad = await win.webContents.executeJavaScript(
    '(function() { var bad = []; var controls = Array.prototype.slice.call(document.querySelectorAll("[data-node-kind=control]")); for (var i = 0; i < controls.length; i++) { var el = controls[i]; var type = el.getAttribute("data-action-type"); if (type === "start" || type === "end") { if (el.querySelector(".dag-node-name")) bad.push(type + ":title"); if (el.getAttribute("tabindex") !== null) bad.push(type + ":tabindex"); if (el.getAttribute("role") !== "graphics-symbol") bad.push(type + ":role"); } } return bad; })()',
  ).catch(function () { return null; });
  if (bad === null) {
    fail('assertControlNoninteractive: could not inspect control nodes');
    return;
  }
  if (bad.length > 0) {
    fail('assertControlNoninteractive: start/end controls are interactive or titled: ' + JSON.stringify(bad));
  }
}

// The drag header shows the exact normalized title or the Chinese
// '未命名任务图' fallback.
async function assertHeaderTitle(win, expected) {
  var text = await win.webContents.executeJavaScript(
    '(function() { var el = document.querySelector("#graph-id-display"); return el ? el.textContent : null; })()',
  ).catch(function () { return null; });
  if (text !== expected) {
    fail('assertHeaderTitle: expected "' + expected + '", got "' + text + '"');
  }
}

// The drag header shows the expected title (or the Chinese fallback) with
// the matching state-dot class for the current graph state.
async function assertHeaderTitleAndState(win, expectedTitle, expectedDotClass) {
  var header = await win.webContents.executeJavaScript(
    '(function() { var title = document.querySelector("#graph-id-display"); var dot = document.querySelector("#state-mark"); if (!title || !dot) return null; return { text: title.textContent, tooltip: title.title, dotClass: dot.className }; })()',
  ).catch(function () { return null; });
  if (!header) {
    fail('assertHeaderTitleAndState: header elements not found');
    return;
  }
  if (header.text !== expectedTitle) {
    fail('assertHeaderTitleAndState: title mismatch, expected "' + expectedTitle + '", got "' + header.text + '"');
  }
  if (header.tooltip !== expectedTitle) {
    fail('assertHeaderTitleAndState: title tooltip mismatch, expected "' + expectedTitle + '", got "' + header.tooltip + '"');
  }
  if (header.dotClass.indexOf(expectedDotClass) < 0) {
    fail('assertHeaderTitleAndState: state dot missing class ' + expectedDotClass + ': ' + header.dotClass);
  }
}

// A specific task node must render the exact name text (display_label or
// the Chinese '任务' fallback) inside its paper tag.
async function assertTaskNodeName(win, selector, expected) {
  var text = await win.webContents.executeJavaScript(
    '(function() { var g = document.querySelector(' + JSON.stringify(selector) + '); var name = g && g.querySelector(".dag-node-name"); return name ? name.textContent : null; })()',
  ).catch(function () { return null; });
  if (text !== expected) {
    fail('assertTaskNodeName: ' + selector + ' expected "' + expected + '", got "' + text + '"');
  }
}

// Hovering a routed edge must never surface a tooltip — edges are
// noninteractive carriers of semantic attributes only.
async function assertNoTooltipAfterHover(win, selector) {
  var center = await getElementCenter(win, selector);
  await sendMouseMove(win, center.x, center.y);
  var tipVisible = await win.webContents.executeJavaScript(
    '(function() { var tip = document.querySelector("[data-role=graph-slip-tooltip]"); return !!tip && getComputedStyle(tip).display === "block"; })()',
  ).catch(function () { return false; });
  if (tipVisible) {
    fail('assertNoTooltipAfterHover: unexpected tooltip after hovering ' + selector);
  }
}

// Bounded semantic wait for the paper tip of a hovered task node: the
// tooltip must be display:block, its .dag-tip-title must equal the expected
// title, and its .dag-tip-row label/value pairs must equal the expected
// ordered rows (absent rows are omitted — never placeholder; a row value of
// null means "row present, value any" for growing running 耗时). The target
// is located by data-node-id and centered in the real slip scroller's
// viewport with instant/no-animation scrollIntoView before every hover
// retry, so the helper also works for task nodes that sit horizontally or
// vertically off-screen inside a wide/tall natural graph. The hover point
// is always recomputed from the CURRENT post-layout bounding box — never a
// pre-scroll coordinate — and the natural graph width/height and its
// K3-approved scroll behavior are never altered to force the hover. By
// default it re-hovers the current target within the loop because a periodic
// snapshot re-render can replace the hover target; with { noReHover: true }
// the pointer must already be parked over the node and the loop only polls
// the tip, so hover-stability cases can prove persistence without synthetic
// re-hovers. Timeout errors include the last observed display/title/rows so
// a missing hover is distinguishable from a text-structure mismatch.
async function waitForSemanticTaskTip(win, targetSelector, expectedTitle, expectedRows, timeoutMs, options) {
  var noReHover = !!(options && options.noReHover);
  var deadline = timeoutMs || CASE_TIMEOUT_MS;
  var started = Date.now();
  var lastState = null;
  while (Date.now() - started < deadline) {
    lastState = await win.webContents.executeJavaScript(
      '(function() { var tip = document.querySelector("[data-role=graph-slip-tooltip]"); if (!tip) return null; var titleEl = tip.querySelector(".dag-tip-title"); var rows = Array.prototype.map.call(tip.querySelectorAll(".dag-tip-row"), function (r) { var label = r.querySelector(".dag-tip-label"); var value = r.querySelector(".dag-tip-value"); return { label: label ? label.textContent : null, value: value ? value.textContent : null }; }); return { display: getComputedStyle(tip).display, title: titleEl ? titleEl.textContent : null, rows: rows }; })()',
    ).catch(function () { return null; });
    if (lastState && lastState.display === 'block') {
      var titleOk = lastState.title === expectedTitle;
      var rowsOk = lastState.rows.length === expectedRows.length && expectedRows.every(function (expected, i) {
        return lastState.rows[i] && lastState.rows[i].label === expected.label &&
          (expected.value === null || lastState.rows[i].value === expected.value);
      });
      if (titleOk && rowsOk) return;
    }
    if (noReHover) {
      await delay(POLL_MS);
      continue;
    }
    // Center the target in the slip scroller before every hover retry and
    // recompute its box AFTER the scroll settles. Reading document.body
    // offsetHeight flushes layout synchronously; getBoundingClientRect then
    // returns the current post-scroll geometry. Reusing a pre-scroll box
    // would aim the hover at a point outside the visible window for
    // horizontally/vertically off-screen task nodes.
    var center = await win.webContents.executeJavaScript(
      '(function() { var el = document.querySelector(' + JSON.stringify(targetSelector) + '); if (!el) return null; try { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); } catch (_) { el.scrollIntoView(true); } document.body.offsetHeight; var r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()',
    ).catch(function () { return null; });
    if (center) {
      try {
        await sendMouseMove(win, center.x, center.y);
      } catch (_) { /* input raced a re-render; the bounded loop retries */ }
    } else {
      await delay(POLL_MS);
    }
  }
  throw new Error('Timeout waiting for task tip on ' + targetSelector + ' (title=' + JSON.stringify(expectedTitle) + ', rows=' + JSON.stringify(expectedRows) + '); last observed: ' + JSON.stringify(lastState));
}

// Poll until the graph-slip tooltip is hidden (or its element is gone).
// Used to prove the production tip hides on a genuine pointer leave and on
// snapshot-level node removal — never on a synthetic re-hover.
async function waitForTipHidden(win, label) {
  var deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    var visible = await win.webContents.executeJavaScript(
      '(function() { var tip = document.querySelector("[data-role=graph-slip-tooltip]"); return !!tip && getComputedStyle(tip).display === "block"; })()',
    ).catch(function () { return true; });
    if (!visible) return;
    await delay(POLL_MS);
  }
  throw new Error(label + ': graph-slip tooltip did not hide within 5s');
}

// Bounded wait for the done summary region of a task tip: the tooltip must
// be display:block and carry a .dag-tip-summary element whose textContent
// equals the expected summary, with no 结果摘要 label row anywhere in the tip.
// The region must explicitly declare width:100% with box-sizing:border-box
// (checked on the stylesheet rule, since computed width resolves to pixels)
// and span the tooltip inner width, keep both overflow axes hidden, border
// on, an 8-line clamp, and a content height (clientHeight minus vertical
// padding) of at most eight computed line heights. When expectOverflow is
// set the text must really overflow: scrollHeight greater than clientHeight
// (full bounded text stays in textContent while the screenshot shows the
// clamped presentation); otherwise the summary must not overflow.
async function assertTaskTipSummary(win, expectedText, options) {
  var deadline = Date.now() + (options && options.timeoutMs ? options.timeoutMs : 5000);
  var expectOverflow = !!(options && options.expectOverflow);
  var lastState = null;
  while (Date.now() < deadline) {
    lastState = await win.webContents.executeJavaScript(
      '(function() { var tip = document.querySelector("[data-role=graph-slip-tooltip]"); if (!tip || getComputedStyle(tip).display !== "block") return null; var s = tip.querySelector(".dag-tip-summary"); if (!s) return { present: false }; var cs = getComputedStyle(s); var tcs = getComputedStyle(tip); var tr = tip.getBoundingClientRect(); var sr = s.getBoundingClientRect(); var labelRow = Array.prototype.some.call(tip.querySelectorAll(".dag-tip-row"), function (r) { var l = r.querySelector(".dag-tip-label"); return !!l && l.textContent === "结果摘要"; }); var lineHeight = parseFloat(cs.lineHeight) || 0; var contentHeight = s.clientHeight - parseFloat(cs.paddingTop || "0") - parseFloat(cs.paddingBottom || "0"); var summaryRule = null; for (var i = 0; i < document.styleSheets.length; i++) { var rules = document.styleSheets[i].cssRules; if (!rules) continue; for (var j = 0; j < rules.length; j++) { var r = rules[j]; if (r && r.selectorText === ".dag-tip-summary") { summaryRule = r.style; break; } } if (summaryRule) break; } return { present: true, text: s.textContent, scrollHeight: s.scrollHeight, clientHeight: s.clientHeight, maxEightLines: lineHeight > 0 && contentHeight <= lineHeight * 8 + 0.5, lines: lineHeight > 0 ? contentHeight / lineHeight : 0, overflowX: cs.overflowX, overflowY: cs.overflowY, lineClamp: cs.webkitLineClamp || cs.lineClamp || null, border: parseFloat(cs.borderTopWidth) > 0, width100: !!summaryRule && summaryRule.width === "100%", borderBox: !!summaryRule && summaryRule.boxSizing === "border-box", spansInner: Math.abs(sr.left - (tr.left + parseFloat(tcs.borderLeftWidth) + parseFloat(tcs.paddingLeft))) < 1 && Math.abs(sr.right - (tr.right - parseFloat(tcs.borderRightWidth) - parseFloat(tcs.paddingRight))) < 1, labelRow: labelRow }; })()',
    ).catch(function () { return null; });
    if (!lastState || !lastState.present) {
      await delay(POLL_MS);
      continue;
    }
    var overflowOk = expectOverflow
      ? lastState.scrollHeight > lastState.clientHeight
      : lastState.scrollHeight <= lastState.clientHeight + 1;
    if (lastState.text === expectedText && !lastState.labelRow &&
        lastState.overflowX === 'hidden' && lastState.overflowY === 'hidden' &&
        lastState.lineClamp === '8' && lastState.border && lastState.width100 &&
        lastState.borderBox && lastState.spansInner && lastState.maxEightLines &&
        overflowOk) {
      return;
    }
    await delay(POLL_MS);
  }
  throw new Error('assertTaskTipSummary: summary region mismatch (expected ' + JSON.stringify(expectedText) + (expectOverflow ? ', expectOverflow' : '') + '); last observed: ' + JSON.stringify(lastState));
}

// Park the pointer ONCE over a task node and prove the same semantic tip
// survives consecutive 2s snapshot DOM rebuilds with no synthetic re-hover:
// the tip must stay visible, keep the same heading/rows, remain anchored
// beside the node (never covering it), and stay in the viewport. Anchoring
// is semantic: the tip must sit on the intended side with the designed 8px
// gap (sideGap 0..24), never overlap the node, and stay inside the
// viewport; its vertical offset may be displaced by the K3 viewport clamp
// (e.g. a bottom-pinned node whose card is pinned flush to the viewport
// bottom), so the vertical gate accepts either top alignment or a clamp
// against the viewport top/bottom edge. At the end the renderer's
// snapshot-update counter must show at least three refreshes. Runtime
// telemetry is no longer part of the activity snapshot, so no 耗时 growth
// is asserted here.
async function assertHoverPersistsAcrossSnapshots(win, targetSelector, expectedTitle, expectedRows, durationMs) {
  var duration = durationMs || 7500; // > three 2s snapshot intervals
  var started = Date.now();
  var updatesAtStart = await readSlipUpdateCount(win);
  var lastState = null;
  while (Date.now() - started < duration) {
    var state = await win.webContents.executeJavaScript(
      '(function() { var tip = document.querySelector("[data-role=graph-slip-tooltip]"); var el = document.querySelector(' + JSON.stringify(targetSelector) + '); if (!tip || !el) return null; var cs = getComputedStyle(tip); var titleEl = tip.querySelector(".dag-tip-title"); var rows = Array.prototype.map.call(tip.querySelectorAll(".dag-tip-row"), function (r) { var label = r.querySelector(".dag-tip-label"); var value = r.querySelector(".dag-tip-value"); return { label: label ? label.textContent : null, value: value ? value.textContent : null }; }); var tr = tip.getBoundingClientRect(); var nr = el.getBoundingClientRect(); var rowsOk = (function (expected) { if (rows.length !== expected.length) return false; return expected.every(function (exp, i) { return rows[i] && rows[i].label === exp.label && (exp.value === null || rows[i].value === exp.value); }); })(' + JSON.stringify(expectedRows) + '); var vw = window.innerWidth; var vh = window.innerHeight; var besideRight = tr.left >= nr.right - 1; var besideLeft = tr.right <= nr.left + 1; var sideGap = besideRight ? tr.left - nr.right : (besideLeft ? nr.left - tr.right : -1); var verticalAligned = Math.abs(tr.top - nr.top) < 40; var viewportClamped = tr.top <= 6 || tr.bottom >= vh - 6; return { display: cs.display, title: titleEl ? titleEl.textContent : null, rows: rows, rowsOk: rowsOk, nodeHovered: el.matches(":hover"), overlapsNode: !(tr.right <= nr.left + 1 || tr.left >= nr.right - 1 || tr.bottom <= nr.top || tr.top >= nr.bottom), anchoredBeside: (besideRight || besideLeft) && (verticalAligned || viewportClamped) && sideGap >= 0 && sideGap <= 24, insideViewport: tr.left >= -1 && tr.top >= -1 && tr.right <= vw + 1 && tr.bottom <= vh + 1 }; })()',
    ).catch(function () { return null; });
    if (!state) {
      throw new Error('assertHoverPersistsAcrossSnapshots: tip or target node vanished during a snapshot refresh');
    }
    lastState = state;
    if (state.display !== 'block') {
      throw new Error('assertHoverPersistsAcrossSnapshots: tip hidden during snapshot refresh: ' + JSON.stringify(state));
    }
    if (state.title !== expectedTitle) {
      throw new Error('assertHoverPersistsAcrossSnapshots: tip heading changed to ' + JSON.stringify(state.title));
    }
    if (!state.rowsOk) {
      throw new Error('assertHoverPersistsAcrossSnapshots: tip rows drifted: ' + JSON.stringify(state.rows));
    }
    if (!state.nodeHovered) {
      throw new Error('assertHoverPersistsAcrossSnapshots: pointer is no longer over the target node');
    }
    if (state.overlapsNode) {
      throw new Error('assertHoverPersistsAcrossSnapshots: tip covers the anchor node: ' + JSON.stringify(state));
    }
    if (!state.insideViewport) {
      throw new Error('assertHoverPersistsAcrossSnapshots: tip drifted outside the viewport: ' + JSON.stringify(state));
    }
    if (!state.anchoredBeside) {
      throw new Error('assertHoverPersistsAcrossSnapshots: tip lost its anchored position beside the node');
    }
    await delay(POLL_MS);
  }
  if (!lastState || lastState.display !== 'block') {
    throw new Error('assertHoverPersistsAcrossSnapshots: tip not visible at the end of the wait window');
  }
  var updatesAtEnd = await readSlipUpdateCount(win);
  if (updatesAtEnd - updatesAtStart < 3) {
    throw new Error('assertHoverPersistsAcrossSnapshots: fewer than 3 snapshot updates during the wait (' + updatesAtStart + ' -> ' + updatesAtEnd + ')');
  }
}

// Same-revision dynamic-field survival: the pointer is parked ONCE over a
// task node while the caller's 2s activity poller mutates its dynamic fields
// (telemetry, task status/state, display label, task run id) on the SAME
// structure revision. Every refresh must keep the same SVG hit element
// (window.__slipHoverProbe DOM identity — set by the caller before this
// helper runs), keep it under :hover, keep the tip visible and re-anchored
// beside it, and finally converge on the expected title/rows. The loop never
// re-hovers and never hides the tip, so a rebuild would fail the identity
// probe instead of being masked. At least three snapshot updates must land
// inside the wait window.
async function assertHoverSurvivesDynamicFields(win, targetSelector, finalTitle, finalRows, durationMs) {
  var duration = durationMs || 7500;
  var started = Date.now();
  var updatesAtStart = await readSlipUpdateCount(win);
  var lastState = null;
  var converged = false;
  while (Date.now() - started < duration) {
    lastState = await win.webContents.executeJavaScript(
      '(function() { var tip = document.querySelector("[data-role=graph-slip-tooltip]"); var el = document.querySelector(' + JSON.stringify(targetSelector) + '); if (!tip || !el) return null; var cs = getComputedStyle(tip); var titleEl = tip.querySelector(".dag-tip-title"); var rows = Array.prototype.map.call(tip.querySelectorAll(".dag-tip-row"), function (r) { var label = r.querySelector(".dag-tip-label"); var value = r.querySelector(".dag-tip-value"); return { label: label ? label.textContent : null, value: value ? value.textContent : null }; }); var tag = el.querySelector(".dag-tag"); var nameEl = el.querySelector(".dag-node-name"); var tr = tip.getBoundingClientRect(); var nr = el.getBoundingClientRect(); var vw = window.innerWidth; var vh = window.innerHeight; var besideRight = tr.left >= nr.right - 1; var besideLeft = tr.right <= nr.left + 1; var sideGap = besideRight ? tr.left - nr.right : (besideLeft ? nr.left - tr.right : -1); var verticalAligned = Math.abs(tr.top - nr.top) < 40; var viewportClamped = tr.top <= 6 || tr.bottom >= vh - 6; return { display: cs.display, title: titleEl ? titleEl.textContent : null, rows: rows, sameNode: window.__slipHoverProbe === el, nodeHovered: el.matches(":hover"), overlapsNode: !(tr.right <= nr.left + 1 || tr.left >= nr.right - 1 || tr.bottom <= nr.top || tr.top >= nr.bottom), anchoredBeside: (besideRight || besideLeft) && (verticalAligned || viewportClamped) && sideGap >= 0 && sideGap <= 24, insideViewport: tr.left >= -1 && tr.top >= -1 && tr.right <= vw + 1 && tr.bottom <= vh + 1, state: el.getAttribute("data-state"), tagFill: tag ? tag.getAttribute("fill") : null, aria: el.getAttribute("aria-label"), name: nameEl ? nameEl.textContent : null, hintPresent: !!el.querySelector(".dag-running-hint") }; })()',
    ).catch(function () { return null; });
    if (!lastState) {
      throw new Error('assertHoverSurvivesDynamicFields: tip or target node vanished during a same-revision refresh');
    }
    if (lastState.display !== 'block') {
      throw new Error('assertHoverSurvivesDynamicFields: tip hidden during same-revision refresh: ' + JSON.stringify(lastState));
    }
    if (!lastState.sameNode) {
      throw new Error('assertHoverSurvivesDynamicFields: hovered node lost its DOM identity during a same-revision refresh: ' + JSON.stringify(lastState));
    }
    if (!lastState.nodeHovered) {
      throw new Error('assertHoverSurvivesDynamicFields: pointer is no longer over the retained node: ' + JSON.stringify(lastState));
    }
    if (lastState.overlapsNode) {
      throw new Error('assertHoverSurvivesDynamicFields: tip covers the anchor node: ' + JSON.stringify(lastState));
    }
    if (!lastState.insideViewport) {
      throw new Error('assertHoverSurvivesDynamicFields: tip drifted outside the viewport: ' + JSON.stringify(lastState));
    }
    if (!lastState.anchoredBeside) {
      throw new Error('assertHoverSurvivesDynamicFields: tip lost its anchored position beside the node: ' + JSON.stringify(lastState));
    }
    var rowsOk = lastState.rows.length === finalRows.length && finalRows.every(function (expected, i) {
      return lastState.rows[i] && lastState.rows[i].label === expected.label &&
        (expected.value === null || lastState.rows[i].value === expected.value);
    });
    if (lastState.title === finalTitle && rowsOk) converged = true;
    await delay(POLL_MS);
  }
  if (!converged) {
    throw new Error('assertHoverSurvivesDynamicFields: tip never converged on final content: ' + JSON.stringify(lastState));
  }
  var updatesAtEnd = await readSlipUpdateCount(win);
  if (updatesAtEnd - updatesAtStart < 3) {
    throw new Error('assertHoverSurvivesDynamicFields: fewer than 3 same-revision snapshot updates during the wait (' + updatesAtStart + ' -> ' + updatesAtEnd + ')');
  }
  return lastState;
}

// Production-renderer check for the redesigned 24px drag header: state dot
// must lead, then the one-line graph-purpose title, then close — with the
// running dot green, accessible, and at a stable 8px footprint.
async function assertGraphSlipHeader(win) {
  var order = await win.webContents.executeJavaScript(
    '(function() { var edge = document.querySelector("#drag-edge"); var dot = edge && edge.querySelector("#state-mark"); var title = edge && edge.querySelector("#graph-id-display"); var close = edge && edge.querySelector("#close-btn"); if (!edge || !dot || !title || !close) return null; var children = Array.prototype.slice.call(edge.children); return { di: children.indexOf(dot), ti: children.indexOf(title), ci: children.indexOf(close) }; })()',
  ).catch(function () { return null; });
  if (!order || !(order.di >= 0 && order.di < order.ti && order.ti < order.ci)) {
    fail('Graph slip header DOM order is not dot → title → close: ' + JSON.stringify(order));
  }

  var header = await win.webContents.executeJavaScript(
    '(function() { var title = document.querySelector("#graph-id-display"); var dot = document.querySelector("#state-mark"); if (!title || !dot) return null; var r = dot.getBoundingClientRect(); var cs = getComputedStyle(dot); return { text: title.textContent, tooltip: title.title, aria: title.getAttribute("aria-label"), dotClass: dot.className, dotRole: dot.getAttribute("role"), dotAria: dot.getAttribute("aria-label"), dotTitle: dot.title, dotW: r.width, dotH: r.height, dotVisible: dot.offsetParent !== null, dotBg: cs.backgroundColor }; })()',
  ).catch(function () { return null; });
  if (!header) {
    fail('Graph slip header elements not found');
    return;
  }
  var TITLE = '展示任务图用途';
  if (header.text !== TITLE) fail('Graph slip header title mismatch: "' + header.text + '"');
  if (header.tooltip !== TITLE) fail('Graph slip header title tooltip mismatch: "' + header.tooltip + '"');
  if (!header.aria || header.aria.indexOf(TITLE) < 0) fail('Graph slip header aria-label missing: "' + header.aria + '"');
  if (header.dotClass.indexOf('running') < 0) fail('Graph slip state dot missing running class: "' + header.dotClass + '"');
  if (header.dotRole !== 'status') fail('Graph slip state dot missing role=status: "' + header.dotRole + '"');
  if (!header.dotAria || header.dotAria.indexOf('运行中') < 0) fail('Graph slip state dot aria-label missing: "' + header.dotAria + '"');
  if (!header.dotTitle || header.dotTitle.indexOf('运行中') < 0) fail('Graph slip state dot title tooltip missing: "' + header.dotTitle + '"');
  if (header.dotW < 7 || header.dotW > 9 || header.dotH < 7 || header.dotH > 9) {
    fail('Graph slip state dot is not a visible 8px footprint: ' + header.dotW + 'x' + header.dotH);
  }
  if (!header.dotVisible) fail('Graph slip state dot is not visible');
  if (header.dotBg !== 'rgb(76, 175, 80)') fail('Graph slip state dot is not green for running: ' + header.dotBg);
}

async function assertTextContent(win, selector, expected) {
  var actual = await win.webContents.executeJavaScript(
    '(function() { var el = document.querySelector(' + JSON.stringify(selector) + '); return el ? el.textContent.trim() : null; })()',
  ).catch(function () { return null; });
  if (actual === null) fail('Element not found: ' + selector);
  else if (actual.indexOf(expected) < 0) fail('Expected text "' + expected + '" in element, got "' + actual + '"');
}

// The paper tag's visible text, tooltip title, aria-label and role must all
// carry the exact untruncated label string.
async function assertFactSlip(win, expected) {
  var state = await win.webContents.executeJavaScript(
    '(function() { var el = document.querySelector("#fact-slip.visible"); if (!el) return null; return { text: el.textContent, title: el.title, aria: el.getAttribute("aria-label"), role: el.getAttribute("role") }; })()',
  ).catch(function () { return null; });
  if (!state) throw new Error('assertFactSlip: fact slip not visible');
  if (state.text !== expected) throw new Error('assertFactSlip: visible text mismatch, expected "' + expected + '", got "' + state.text + '"');
  if (state.title !== expected) throw new Error('assertFactSlip: title mismatch, expected "' + expected + '", got "' + state.title + '"');
  if (state.aria !== expected) throw new Error('assertFactSlip: aria-label mismatch, expected "' + expected + '", got "' + state.aria + '"');
  if (state.role !== 'tooltip') throw new Error('assertFactSlip: role is not tooltip, got "' + state.role + '"');
}

async function assertNoWindowByQuery(searchParam, expectedValue) {
  var allWins = BrowserWindow.getAllWindows();
  for (var i = 0; i < allWins.length; i++) {
    var w = allWins[i];
    if (w.isDestroyed()) continue;
    try {
      var url = w.webContents.getURL();
      var urlObj = new URL(url);
      if (urlObj.searchParams.get(searchParam) === expectedValue) {
        fail('Found unexpected window with ' + searchParam + '=' + expectedValue);
      }
    } catch (_) { /* ignore */ }
  }
}

async function sendRealClick(win, selector, overrideX, overrideY) {
  var center = (overrideX !== undefined && overrideY !== undefined)
    ? { x: overrideX, y: overrideY }
    : await getElementCenter(win, selector);
  // When clicking #entity-hit, validate API existence before proceeding.
  // The actual setMousePassthrough(false) call happens after sendMouseMove
  // and immediately before each mouseDown/up inside the loop, because
  // sendMouseMove intentionally moves through (0,0) and may re-enable
  // production mouse passthrough.
  if (selector === '#entity-hit') {
    var apiOk = await win.webContents.executeJavaScript(
      'typeof window.entityApi !== "undefined" && typeof window.entityApi.setMousePassthrough === "function"',
    ).catch(function () { return false; });
    if (!apiOk) {
      throw new Error('sendRealClick: #entity-hit click requires window.entityApi.setMousePassthrough');
    }
  }
  await sendMouseMove(win, center.x, center.y);
  // Hit-test check
  var hitTest = await win.webContents.executeJavaScript(
    '(function() { var el = document.elementFromPoint(' + JSON.stringify(Math.round(center.x)) + ', ' + JSON.stringify(Math.round(center.y)) + '); return el instanceof Element ? { tag: el.tagName, id: el.id || "", closest: !!el.closest(' + JSON.stringify(selector) + ') } : null; })()',
  ).catch(function () { return null; });
  if (hitTest && !hitTest.closest) {
    throw new Error('sendRealClick: hit-test at (' + Math.round(center.x) + ',' + Math.round(center.y) + ') found ' + hitTest.tag + '#' + hitTest.id + ', does not match selector ' + JSON.stringify(selector));
  }
  for (var attempt = 0; attempt < 2; attempt++) {
    // Synchronize the production sender-bound passthrough transition
    // immediately before input events — the preceding sendMouseMove
    // may have re-enabled passthrough by moving through (0,0).
    // Repeated on retry (attempt 1) for the same reason.
    if (selector === '#entity-hit') {
      await win.webContents.executeJavaScript(
        'window.entityApi.setMousePassthrough(false)',
      ).catch(function (err) {
        throw new Error('sendRealClick: entityApi.setMousePassthrough(false) failed: ' + (err ? err.message || err : 'unknown'));
      });
    }
    var probeOk = await win.webContents.executeJavaScript(
      '(function() { window.__taskgraphE2eRealClickCount = 0; window.__taskgraphE2eClickedTarget = null; window.__taskgraphE2eClickMatch = false; document.addEventListener("click", function __tgClickProbe(ev) { window.__taskgraphE2eRealClickCount++; window.__taskgraphE2eClickedTarget = ev.target ? { id: ev.target.id || "", tag: ev.target.tagName || "" } : null; window.__taskgraphE2eClickMatch = ev.target instanceof Element && !!ev.target.closest(' + JSON.stringify(selector) + '); document.removeEventListener("click", __tgClickProbe); }, { capture: true, once: true, passive: true }); return true; })()',
    ).catch(function () { return false; });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(center.x), y: Math.round(center.y), button: 'left', clickCount: 1, modifiers: [] });
    await delay(20);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(center.x), y: Math.round(center.y), button: 'left', clickCount: 1, modifiers: [] });
    if (probeOk) {
      // Poll __taskgraphE2eRealClickCount every ~20ms for up to 500ms,
      // to allow a queued genuine mouseUp event to reach the renderer
      // before giving up. Do not delay the production sendInputEvent.
      var result = null;
      for (var pollStart = Date.now(); ; ) {
        await delay(20);
        result = await win.webContents.executeJavaScript(
          '(function() { return { count: window.__taskgraphE2eRealClickCount || 0, target: window.__taskgraphE2eClickedTarget, match: !!window.__taskgraphE2eClickMatch }; })()',
        ).catch(function () { return null; });
        if (result && result.count > 0) {
          break;
        }
        if (Date.now() - pollStart >= 500) {
          break;
        }
      }
      if (result && result.count > 0) {
        if (!result.match) {
          throw new Error('sendRealClick: click target ' + JSON.stringify(result.target) + ' did not match selector ' + JSON.stringify(selector));
        }
        return;
      }
      if (attempt === 0) {
        win.webContents.focus();
        await delay(100);
        var hitTest2 = await win.webContents.executeJavaScript(
          '(function() { var el = document.elementFromPoint(' + JSON.stringify(Math.round(center.x)) + ', ' + JSON.stringify(Math.round(center.y)) + '); return el instanceof Element ? { tag: el.tagName, id: el.id || "", closest: !!el.closest(' + JSON.stringify(selector) + ') } : null; })()',
        ).catch(function () { return null; });
        if (hitTest2 && !hitTest2.closest) {
          throw new Error('sendRealClick: retry hit-test at (' + Math.round(center.x) + ',' + Math.round(center.y) + ') found ' + hitTest2.tag + '#' + hitTest2.id + ', does not match selector ' + JSON.stringify(selector));
        }
      } else {
        throw new Error('sendRealClick: Electron input event did not produce a real click after 2 attempts (selector=' + JSON.stringify(selector) + (result && result.target ? ', target=' + JSON.stringify(result.target) : '') + ')');
      }
    } else {
      break;
    }
  }
  await delay(50);
}

async function getElementCenter(win, selector) {
  var rect = await win.webContents.executeJavaScript(
    '(function() { var el = document.querySelector(' + JSON.stringify(selector) + '); if (!el) return null; var r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()',
  );
  if (!rect) throw new Error('Element not found: ' + selector);
  return rect;
}

async function sendMouseMove(win, x, y, waitSelector) {
  win.webContents.focus();
  await delay(150);
  var probeOk = await win.webContents.executeJavaScript(
    '(function() { window.__taskgraphE2eRealMoveCount = 0; document.addEventListener("mousemove", function __tgProbe() { window.__taskgraphE2eRealMoveCount++; document.removeEventListener("mousemove", __tgProbe); }, { capture: true, once: true, passive: true }); return true; })()',
  ).catch(function () { return false; });
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 0, y: 0 });
  await delay(20);
  win.webContents.sendInputEvent({ type: 'mouseEnter', x: Math.round(x), y: Math.round(y) });
  await delay(20);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
  if (probeOk) {
    var moveCount = await win.webContents.executeJavaScript(
      'window.__taskgraphE2eRealMoveCount || 0',
    ).catch(function () { return 0; });
    if (moveCount === 0) {
      throw new Error('sendMouseMove: Electron input event did not reach renderer (moveCount=0)');
    }
  }
  if (waitSelector) {
    var started = Date.now();
    while (Date.now() - started < 2000) {
      var visible = await win.webContents.executeJavaScript(
        '(function() { var el = document.querySelector(' + JSON.stringify(waitSelector) + '); return el && el.offsetParent !== null; })()',
      ).catch(function () { return false; });
      if (visible) return;
      await delay(POLL_MS);
    }
    throw new Error('sendMouseMove: timed out waiting for ' + waitSelector);
  } else {
    await delay(150);
  }
}

// ── Owner lifecycle helpers ────────────────────────────────────────────

var currentOwner = null;
var currentClient = null;

function createOwner(client) {
  destroyOwner();
  currentClient = client;
  currentOwner = new TaskGraphWindowOwner({
    foremanIpcClient: client,
    htmlDir: htmlDir,
    preloadDir: preloadDir,
    getHouseWindow: function () { return null; },
    stayHidden: true,
    logger: console,
  });
  return currentOwner;
}

function destroyOwner() {
  if (currentOwner) {
    try { currentOwner.destroy(); } catch (_) {}
    currentOwner = null;
  }
  currentClient = null;
  // Close any lingering windows from the owner
  var allWins = BrowserWindow.getAllWindows();
  for (var i = 0; i < allWins.length; i++) {
    var w = allWins[i];
    if (!w.isDestroyed()) { try { w.destroy(); } catch (_) {} }
  }
}

// ── Capture cases ──────────────────────────────────────────────────────

var capturedHashes = {};

async function captureCase(caseId, label, fn) {
  // Destroy previous owner/clean windows
  destroyOwner();
  await delay(200);
  var outFile = path.join(captureBase, caseId + '.png');
  console.log('[capture] ' + caseId + ' (' + label + ')');
  var failuresBefore = failures.length;
  try {
    await fn(outFile);
    // If fail() was added during this case, suppress OK and skip manifest
    if (failures.length > failuresBefore) {
      return;
    }
    var h = hashImage(outFile);
    var imgBuf = fs.readFileSync(outFile);
    var sha256 = crypto.createHash('sha256').update(imgBuf).digest('hex');
    var pngW = 0, pngH = 0;
    if (imgBuf.length >= 24 && imgBuf[0] === 0x89 && imgBuf[1] === 0x50) {
      pngW = imgBuf.readUInt32BE(16);
      pngH = imgBuf.readUInt32BE(20);
    }
    manifestEntries.push({
      id: caseId,
      file: caseId + '.png',
      sha256: sha256,
      md5: h,
      width: pngW,
      height: pngH,
    });
    if (capturedHashes[h] && capturedHashes[h] !== caseId) {
      throw new Error(caseId + ': screenshot identical to ' + capturedHashes[h] + ' (possible false-green)');
    }
    capturedHashes[h] = caseId;
    console.log('[capture] OK ' + caseId);
  } catch (e) {
    fail(caseId + ': ' + (e ? e.message || String(e) : 'unknown error'));
  }
}

// ── Entity cases ─────────────────────────────────────────────────────

async function captureWrenRunning(outFile) {
  var client = new FakeForemanIpcClient();
  var presence = applyBaseFixtures(client, 'tg-e2e-a', 'running');
  createOwner(client);
  applyActivity([presence]);
  var entityWin = await waitForEntity('tg-e2e-a', 8000);
  await captureMeaningfulEntityWindow(entityWin, outFile);
}

async function captureWrenPaused(outFile) {
  var client = new FakeForemanIpcClient();
  var presence = applyBaseFixtures(client, 'tg-e2e-a', 'paused');
  createOwner(client);
  applyActivity([presence]);
  var entityWin = await waitForEntity('tg-e2e-a', 8000);
  await captureMeaningfulEntityWindow(entityWin, outFile);
}

async function captureWrenMultipleLayout(outFile) {
  var client = new FakeForemanIpcClient();
  client.setFixture('taskgraph.inspect', function (params) {
    return baseInspect(params.taskgraph_id || 'tg-e2e-first');
  });
  client.setFixture('task.run.events', function (params) { return runEventsResponse(params.task_run_id, params.after_seq); });
  client.setFixture('task.run.status', function (params) { return runStatusResponse(params.task_run_id); });
  var first = baseGraphPresence('tg-e2e-first', 'running', { title: '展示任务图用途' });
  var second = baseGraphPresence('tg-e2e-second', 'paused');
  createOwner(client);
  applyActivity([first, second]);
  var win1 = await waitForEntity('tg-e2e-first', 8000);
  var win2 = await waitForEntity('tg-e2e-second', 8000);
  // Reposition side by side
  win1.setBounds({ x: 80, y: 80 });
  win2.setBounds({ x: 244, y: 80 });
  await delay(500);
  await waitForMarker(win1, 'entityReady');
  await waitForMarker(win2, 'entityReady');
  await sendMouseMove(win1, 42, 33, '#fact-slip.visible');
  await assertFactSlip(win1, '展示任务图用途 · 0/1');
  var image1 = await win1.capturePage(undefined, { stayHidden: true });
  if (image1.isEmpty()) fail('win1 capturePage returned empty image');
  await sendMouseMove(win2, 42, 33, '#fact-slip.visible');
  await assertFactSlip(win2, '未命名任务图 · 0/1');
  var image2 = await win2.capturePage(undefined, { stayHidden: true });
  if (image2.isEmpty()) fail('win2 capturePage returned empty image');
  var compositeWin = new BrowserWindow({
    width: 312, height: 84,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  var compositeDataUrl1 = 'data:image/png;base64,' + image1.toPNG().toString('base64');
  var compositeDataUrl2 = 'data:image/png;base64,' + image2.toPNG().toString('base64');
  var compositeHtml = '<html><head><style>html,body{width:312px;height:84px;margin:0;padding:0;overflow:hidden;background:transparent}</style></head>' +
    '<body><img src="' + compositeDataUrl1 + '" style="display:block;position:absolute;top:0;left:0;width:156px;height:84px">' +
    '<img src="' + compositeDataUrl2 + '" style="display:block;position:absolute;top:0;left:156px;width:156px;height:84px">' +
    '</body></html>';
  await compositeWin.loadURL('data:text/html,' + encodeURIComponent(compositeHtml));
  await delay(200);
  try {
    await captureWindow(compositeWin, outFile);
  } finally {
    if (!compositeWin.isDestroyed()) {
      try { compositeWin.close(); } catch (_) {}
    }
  }
  // Verify non-transparent pixel density on both halves
  var imgBuf = fs.readFileSync(outFile);
  var img = nativeImage.createFromBuffer(imgBuf);
  if (img.isEmpty()) throw new Error('Multi-entity composite decoded as empty image');
  var bitmap = img.getBitmap();
  var leftNonTransparent = 0;
  var rightNonTransparent = 0;
  for (var y = 0; y < 84; y++) {
    for (var x = 0; x < 156; x++) {
      var idx = (y * 312 + x) * 4;
      if (bitmap[idx + 3] > 0) leftNonTransparent++;
    }
    for (var x = 156; x < 312; x++) {
      var idx = (y * 312 + x) * 4;
      if (bitmap[idx + 3] > 0) rightNonTransparent++;
    }
  }
  if (leftNonTransparent < 100) throw new Error('Left half of composite has too few non-transparent pixels: ' + leftNonTransparent);
  if (rightNonTransparent < 100) throw new Error('Right half of composite has too few non-transparent pixels: ' + rightNonTransparent);
}

async function captureWrenHover(outFile) {
  var client = new FakeForemanIpcClient();
  var presence = applyBaseFixtures(client, 'tg-e2e-a', 'running');
  createOwner(client);
  applyActivity([presence]);
  var entityWin = await waitForEntity('tg-e2e-a', 8000);
  await delay(500);
  await sendMouseMove(entityWin, 42, 33, '#fact-slip.visible');
  await assertFactSlip(entityWin, '未命名任务图 · 0/1');
  await captureInteractiveWindow(entityWin, outFile);
}

async function captureWrenStale(outFile) {
  var client = new FakeForemanIpcClient();
  var presence = applyBaseFixtures(client, 'tg-e2e-a', 'running');
  createOwner(client);
  applyActivity([presence]);
  var entityWin = await waitForEntity('tg-e2e-a', 8000);
  await assertMarker(entityWin, 'entityReady', true);
  // Failed activity round: the owner keeps the entity and marks it stale.
  currentOwner.applyActivity({ sampledAt: TS, stale: true, tasks: [], taskgraphs: [] });
  await delay(300);
  await captureWindow(entityWin, outFile);
}

// Fact-slip content case: graph title 答疑 Agent 评估 with two done task
// nodes, one running task node and multiple done control nodes must render
// exactly 答疑 Agent 评估 · 2/3 with no lifecycle/control counts.
async function captureWrenContent(outFile) {
  var client = new FakeForemanIpcClient();
  client.setFixture('taskgraph.inspect', function (params) {
    return contentInspect(params.taskgraph_id);
  });
  client.setFixture('task.run.events', function (params) { return runEventsResponse(params.task_run_id, params.after_seq); });
  client.setFixture('task.run.status', function (params) { return runStatusResponse(params.task_run_id); });
  var presence = graphPresence('tg-e2e-content', 'running', {
    title: '答疑 Agent 评估',
    nodes: [
      nodePresence('node-t1', 'done'),
      nodePresence('node-t2', 'done'),
      nodePresence('node-t3', 'running', { taskRunId: 'run-e2e-t3', taskStatus: 'running' }),
      nodePresence('node-c1', 'done'),
      nodePresence('node-c2', 'done'),
      nodePresence('node-c3', 'done'),
    ],
  });
  createOwner(client);
  applyActivity([presence]);
  var entityWin = await waitForEntity('tg-e2e-content', 8000);
  await delay(500);
  await sendMouseMove(entityWin, 42, 33, '#fact-slip.visible');
  await assertFactSlip(entityWin, '答疑 Agent 评估 · 2/3');
  // Lifecycle prose and control-node counts must never leak into the label.
  var label = await entityWin.webContents.executeJavaScript(
    '(function() { var el = document.querySelector("#fact-slip.visible"); return el ? el.textContent : null; })()',
  ).catch(function () { return null; });
  if (label && /运行中|等待|已暂停|已完成|node_counts|任务数/.test(label)) {
    fail('captureWrenContent: lifecycle/control metadata leaked into fact slip: ' + JSON.stringify(label));
  }
  await captureInteractiveWindow(entityWin, outFile);
}

// Long-Chinese title: the centered tag stays one line with ellipsis inside
// the 156x84 window while title/aria keep the full untruncated string.
async function captureWrenLongTitle(outFile) {
  var client = new FakeForemanIpcClient();
  client.setFixture('taskgraph.inspect', function (params) {
    return baseInspect(params.taskgraph_id);
  });
  client.setFixture('task.run.events', function (params) { return runEventsResponse(params.task_run_id, params.after_seq); });
  client.setFixture('task.run.status', function (params) { return runStatusResponse(params.task_run_id); });
  var longTitle = '这是一个特别特别长的中文任务图标题用来验证省略号截断与完整提示保留';
  var presence = baseGraphPresence('tg-e2e-long', 'running', { title: longTitle });
  createOwner(client);
  applyActivity([presence]);
  var entityWin = await waitForEntity('tg-e2e-long', 8000);
  await delay(500);
  await sendMouseMove(entityWin, 42, 33, '#fact-slip.visible');
  await assertFactSlip(entityWin, longTitle + ' · 0/1');
  var geometry = await entityWin.webContents.executeJavaScript(
    '(function() { var el = document.querySelector("#fact-slip.visible"); if (!el) return null; var r = el.getBoundingClientRect(); var cs = getComputedStyle(el); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, overflow: cs.overflow, textOverflow: cs.textOverflow, whiteSpace: cs.whiteSpace, maxWidth: cs.maxWidth, vw: window.innerWidth, vh: window.innerHeight }; })()',
  ).catch(function () { return null; });
  if (!geometry) throw new Error('captureWrenLongTitle: no fact slip geometry');
  if (geometry.top < -0.5 || geometry.left < -0.5 || geometry.bottom > geometry.vh + 0.5 || geometry.right > geometry.vw + 0.5) {
    throw new Error('captureWrenLongTitle: paper tag escapes the 156x84 window: ' + JSON.stringify(geometry));
  }
  if (geometry.overflow !== 'hidden' || geometry.textOverflow !== 'ellipsis' || geometry.whiteSpace !== 'nowrap') {
    throw new Error('captureWrenLongTitle: tag is not one-line ellipsis: ' + JSON.stringify(geometry));
  }
  await captureInteractiveWindow(entityWin, outFile);
}

// ── Graph slip cases ─────────────────────────────────────────────────

async function captureGraphSlip(outFile) {
  var client = new FakeForemanIpcClient();
  var presence = applyBaseFixtures(client, 'tg-e2e-a', 'running', { title: '展示任务图用途' });
  createOwner(client);
  applyActivity([presence]);
  var entityWin = await waitForEntity('tg-e2e-a', 8000);
  await delay(500);
  // Click #entity-hit to open graph slip through production handler
  await sendRealClick(entityWin, '#entity-hit', 14, 11);
  var slipWin = await waitForGraphSlip('tg-e2e-a', 8000);
  await delay(1000);
  await assertMarker(slipWin, 'slipReady', true);
  await assertElementAbsent(slipWin, '#rack');
  await assertElementAbsent(slipWin, '#refresh-btn');
  await assertElementAbsent(slipWin, '.rack-item');
  await assertElementVisible(slipWin, '#dag-canvas');
  // Approved visual contract: the single task node shares the unified Agent
  // glyph, the llm_call/end controls keep distinct semantics, and there are
  // no transit nodes or solder dots in the base chain.
  await assertApprovedGraphSlipVisuals(slipWin, { tasks: 1, controls: ['llm_call', 'end'], junctions: 0 });
  // Orthogonal routing, no visible-node crossing, honest scroll size, solid
  // paper, and noninteractive start/end-style controls all hold for the base graph.
  await assertOrthogonalEdges(slipWin);
  await assertEdgesAvoidNodeRects(slipWin);
  await assertHonestContentSize(slipWin);
  await assertSolidPaperBackground(slipWin);
  await assertControlNoninteractive(slipWin);
  // Assert the redesigned drag header: leading green state dot + purpose title.
  await assertGraphSlipHeader(slipWin);
  // Park the pointer away from graph geometry so the baseline frame is tooltip-free.
  await sendMouseMove(slipWin, 480, 340);
  await captureWindow(slipWin, outFile);
}

// Semantic task-tip expectations for the base fixture's task node (node-a2):
// the structured Chinese heading (.dag-tip-title) — static task_title when a
// valid CJK node.name exists, else the activity display_label, else 任务 (the
// internal English description is never a heading) — then only the present
// rows in strict order (状态/任务 ID/运行配置/工具调用/输出速度 with exactly two
// decimals). Dynamic fields come from the one activity snapshot; runtimes are
// no longer projected, so 耗时 is absent. The 任务 ID row shows the Foreman
// task definition name (task_id), never the runtime task_run_id, and a
// resolved profile renders before completion. Absent rows are omitted —
// never placeholder.
var TASK_TIP_TITLE = '代码审查';
var TASK_TIP_ROWS = [
  { label: '状态', value: '运行中' },
  { label: '任务 ID', value: 'forge-deploy' },
  { label: '运行配置', value: 'codex-spark' },
  { label: '工具调用', value: '3' },
  { label: '输出速度', value: '12.50' },
];

// Parse the Chinese duration of the 耗时 row into comparable seconds; hours
// and minutes collapse to large sentinels so any growth is still detected.
function parseElapsedSeconds(value) {
  var m = /(\d+)秒/.exec(value || '');
  if (m) return parseInt(m[1], 10);
  if (/小时/.test(value || '')) return 3600;
  if (/分/.test(value || '')) return 60;
  return null;
}

// Snapshot-refresh counter exposed by the renderer (data-slip-updates); the
// harness uses it to prove a hover survived N consecutive 2s refreshes.
async function readSlipUpdateCount(win) {
  var n = await win.webContents.executeJavaScript(
    'Number(document.documentElement.dataset.slipUpdates || "0")',
  ).catch(function () { return 0; });
  return Number.isFinite(n) ? n : 0;
}

// ── Overflowing graph slip fixture (graph-slip-node-hover) ───────────
// A deliberately oversized production Graph Slip: an eight-task vertical
// chain whose natural canvas (8 x TASK_HEIGHT + ROW_GAP bands) is taller
// than #content's 500x336 viewport, so the last task (node-v8) is genuinely
// off-screen until the production scroller is driven. No renderer branch is
// added to force the geometry — the overflow is a pure fixture property.

function overflowSlipInspect(graphId, removed) {
  var nodes = {};
  for (var i = 1; i <= (removed ? 7 : 8); i++) {
    var id = 'node-v' + i;
    nodes[id] = {
      id: id,
      name: 'Stage ' + i,
      action: { type: 'task', params: {} },
      deps: i === 1 ? [] : ['node-v' + (i - 1)],
    };
  }
  // The removed round bumps structure_revision so the owner reloads the
  // cached structure and the projection actually drops node-v8.
  return { graph: { id: graphId, revision: removed ? 2 : 1, nodes: nodes } };
}

// The overflow graph's dynamic state comes from the one activity snapshot:
// every node runs, and node-v8 carries the structured Chinese display facts.
// With removed=true the target node vanishes from the snapshot entirely and
// the structure revision advances so the slip reloads without it.
function overflowPresence(graphId, removed) {
  var nodes = [];
  for (var i = 1; i <= (removed ? 7 : 8); i++) {
    var id = 'node-v' + i;
    var facts = {};
    if (id === 'node-v8') {
      facts = {
        taskRunId: 'run-node-v8',
        taskId: 'forge-deploy',
        taskStatus: 'running',
        taskCategoryId: 'code-review',
        taskCategoryLabel: '代码审查',
        description: '审查代码改动并输出审查结论',
        resolvedProfile: 'codex-spark',
        toolCallCount: 3,
        tps: 12.5,
      };
    }
    nodes.push(nodePresence(id, 'running', facts));
  }
  return graphPresence(graphId, 'running', { nodes: nodes, latestSeq: 8, structureRevision: removed ? 2 : 1 });
}

async function captureGraphSlipNodeHover(outFile) {
  var client = new FakeForemanIpcClient();
  var graphId = 'tg-e2e-node-hover';
  // Flipped later to drop node-v8 from the next activity round, exercising
  // production removed-node tip hiding while the pointer stays parked.
  var nodeRemoved = false;
  client.setFixture('taskgraph.inspect', function () { return overflowSlipInspect(graphId, nodeRemoved); });
  client.setFixture('task.run.events', function (params) { return runEventsResponse(params.task_run_id, params.after_seq); });
  client.setFixture('task.run.status', function (params) { return runStatusResponse(params.task_run_id); });
  createOwner(client);
  applyActivity([overflowPresence(graphId, nodeRemoved)]);
  // Simulate the production 2s activity poller: consecutive rounds re-project
  // the slip and rebuild its DOM while the pointer stays parked.
  var refreshTimer = setInterval(function () {
    try {
      currentOwner.applyActivity(presenceWith([overflowPresence(graphId, nodeRemoved)]));
    } catch (_) { /* owner may be destroyed mid-case */ }
  }, 2000);
  try {
  var entityWin = await waitForEntity(graphId, 8000);
  await delay(500);
  await sendRealClick(entityWin, '#entity-hit', 14, 11);
  var slipWin = await waitForGraphSlip(graphId, 8000);
  await delay(1000);
  if (slipWin.isDestroyed()) throw new Error('Graph slip window destroyed before node hover');
  await assertMarker(slipWin, 'slipReady', true);
  // The hover target must actually be rendered before its geometry is probed.
  var targetSelector = '[data-node-id="node-v8"]';
  var targetPresent = false;
  var started = Date.now();
  while (Date.now() - started < 8000) {
    targetPresent = await slipWin.webContents.executeJavaScript(
      '!!document.querySelector(' + JSON.stringify(targetSelector) + ')',
    ).catch(function () { return false; });
    if (targetPresent) break;
    await delay(POLL_MS);
  }
  if (!targetPresent) {
    throw new Error('graph-slip-node-hover: overflowing fixture target task never rendered');
  }
  // Precondition: before any scroll the target task lies entirely outside
  // #content's viewport. Failing this means the fixture no longer overflows,
  // so the case must fail rather than capture a false-green in-viewport hover.
  var pre = await slipWin.webContents.executeJavaScript(
    '(function() { var content = document.querySelector("#content"); var el = document.querySelector("[data-node-id=\\"node-v8\\"]"); if (!content || !el) return null; var cr = content.getBoundingClientRect(); var r = el.getBoundingClientRect(); return { clientH: cr.height, clientW: cr.width, top: r.top, bottom: r.bottom, left: r.left, right: r.right, outside: r.bottom < cr.top || r.top > cr.bottom || r.right < cr.left || r.left > cr.right }; })()',
  ).catch(function () { return null; });
  if (!pre || !pre.outside) {
    throw new Error('graph-slip-node-hover precondition failed: target task is not outside #content viewport before scrolling: ' + JSON.stringify(pre));
  }
  // Drive the production scroll path: instant/no-animation scrollIntoView on
  // the real node centers it in the slip scroller, then recompute the hover
  // point from the current post-scroll bounding box.
  var center = await slipWin.webContents.executeJavaScript(
    '(function() { var el = document.querySelector("[data-node-id=\\"node-v8\\"]"); if (!el) return null; try { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); } catch (_) { el.scrollIntoView(true); } document.body.offsetHeight; var r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()',
  ).catch(function () { return null; });
  if (!center) throw new Error('graph-slip-node-hover: target task not found after scroll');
  // Hover the node exactly once — the pointer is then parked for the whole
  // persistence window. No scroll or pointer re-hover happens afterwards.
  await sendMouseMove(slipWin, center.x, center.y);
  // Assert the structured task tip on the now-visible off-viewport task.
  await waitForSemanticTaskTip(slipWin, targetSelector, TASK_TIP_TITLE, TASK_TIP_ROWS, 8000, { noReHover: true });
  if (slipWin.isDestroyed()) throw new Error('Graph slip window destroyed before node-hover capture');
  // Prove the same semantic hover survives at least three 2s snapshot DOM
  // rebuilds without any synthetic re-hover while the pointer stays put.
  await assertHoverPersistsAcrossSnapshots(slipWin, targetSelector, TASK_TIP_TITLE, TASK_TIP_ROWS, 7500);
  if (slipWin.isDestroyed()) throw new Error('Graph slip window destroyed before node-hover capture');
  await captureInteractiveWindow(slipWin, outFile);
  // Real pointer leave: moving away from the node must hide the tip through
  // the production deferred-leave path — no synthetic re-hover re-shows it.
  await sendMouseMove(slipWin, 480, 340);
  await waitForTipHidden(slipWin, 'graph-slip-node-hover pointer leave');
  if (slipWin.isDestroyed()) throw new Error('Graph slip window destroyed before node-hover leave');
  // Fresh legitimate hover so removed-node hiding is exercised under a live
  // tip. The scroller is parked at a fixed position where node-v8's center
  // sits below where node-v7 lands once node-v8 is removed (the rebuild
  // clamps scrollTop and the next-up node replaces the old rect) — so the
  // stationary pointer rests on empty canvas after removal, and the hide is
  // caused by the node disappearing, never by a neighboring node.
  var rehover = await slipWin.webContents.executeJavaScript(
    '(function() { var content = document.querySelector("#content"); if (!content) return null; content.scrollTop = 120; document.body.offsetHeight; var el = document.querySelector("[data-node-id=\\"node-v8\\"]"); if (!el) return null; var r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()',
  ).catch(function () { return null; });
  if (!rehover || !rehover.x || !rehover.y) throw new Error('graph-slip-node-hover: target task not found after leave');
  await sendMouseMove(slipWin, rehover.x, rehover.y);
  await waitForSemanticTaskTip(slipWin, targetSelector, TASK_TIP_TITLE, TASK_TIP_ROWS, 5000, { noReHover: true });
  // Removed node: drop node-v8 from the next snapshot while the pointer
  // stays parked over it — the refresh must hide the tip purely because the
  // node disappeared (the pointer never moves again).
  nodeRemoved = true;
  await waitForTipHidden(slipWin, 'graph-slip-node-hover removed node');
  if (slipWin.isDestroyed()) throw new Error('Graph slip window destroyed before node-hover removal');
  } finally {
    clearInterval(refreshTimer);
  }
}

// ── Same-revision dynamic-field fixture (graph-slip-dynamic-fields) ────
// The structure revision stays fixed at 1 and the GRAPH state stays running
// (a done graph would exit the entity and close the slip) while node-a2's
// dynamic fields evolve across activity rounds: telemetry changes first
// (round 1), then node task status/state, display label and task run id
// (round 2). The renderer must update every dynamic field in place on the
// retained node — never rebuild it — and the retained click listener must
// act on the latest run id.
function dynamicPresence(graphId, round) {
  return graphPresence(graphId, 'running', {
    nodes: [
      nodePresence('node-a1', 'done'),
      nodePresence('node-a2', round >= 2 ? 'done' : 'running', {
        taskRunId: round >= 2 ? 'run-e2e-a2-new' : 'run-e2e-a2',
        taskId: 'forge-deploy',
        taskStatus: round >= 2 ? 'done' : 'running',
        taskCategoryId: 'code-review',
        taskCategoryLabel: round >= 2 ? '代码终审' : '代码审查',
        description: '审查代码改动并输出审查结论',
        resolvedProfile: 'fast',
        toolCallCount: round >= 1 ? 4 : 3,
        tps: round >= 1 ? 13.7 : 12.5,
        summary: round >= 2 ? '全部通过，可发布。' : undefined,
      }),
      nodePresence('node-a3', 'planned'),
    ],
    latestSeq: round + 3,
    title: '展示任务图用途',
  });
}

async function captureGraphSlipDynamicFields(outFile) {
  var client = new FakeForemanIpcClient();
  var graphId = 'tg-e2e-dynamic';
  client.setFixture('taskgraph.inspect', function () { return baseInspect(graphId); });
  client.setFixture('task.run.events', function (params) {
    if (params.task_run_id === 'run-e2e-a2-new') {
      if (params.after_seq !== undefined && params.after_seq >= 2) {
        return { task_run_id: 'run-e2e-a2-new', events: [], next_seq: params.after_seq, has_more: false };
      }
      return { task_run_id: 'run-e2e-a2-new', events: [{ seq: 1, type: 'message', timestamp: '2025-06-01T00:00:30Z', data: { message_summary: '复审后重新运行' } }], next_seq: 2, has_more: false };
    }
    return runEventsResponse(params.task_run_id, params.after_seq);
  });
  client.setFixture('task.run.status', function (params) { return runStatusResponse(params.task_run_id); });
  createOwner(client);
  var round = 0;
  applyActivity([dynamicPresence(graphId, round)]);
  var entityWin = await waitForEntity(graphId, 8000);
  await delay(500);
  await sendRealClick(entityWin, '#entity-hit', 14, 11);
  var slipWin = await waitForGraphSlip(graphId, 8000);
  await delay(1000);
  await assertMarker(slipWin, 'slipReady', true);
  var targetSelector = '[data-node-id="node-a2"]';
  // Hover the node exactly once — the pointer is then parked for the whole
  // dynamic-field window.
  var center = await getElementCenter(slipWin, targetSelector);
  await sendMouseMove(slipWin, center.x, center.y);
  await waitForSemanticTaskTip(slipWin, targetSelector, '代码审查', [
    { label: '状态', value: '运行中' },
    { label: '任务 ID', value: 'forge-deploy' },
    { label: '运行配置', value: 'fast' },
    { label: '工具调用', value: '3' },
    { label: '输出速度', value: '12.50' },
  ], 8000, { noReHover: true });
  // Pin the DOM-identity probe to the hovered element before any refresh.
  var probeOk = await slipWin.webContents.executeJavaScript(
    '(function() { var el = document.querySelector(' + JSON.stringify(targetSelector) + '); if (!el) return false; window.__slipHoverProbe = el; return true; })()',
  ).catch(function () { return false; });
  if (!probeOk) throw new Error('graph-slip-dynamic-fields: could not pin hover identity probe');
  // Start the production-style 2s poller only now so the rounds are
  // deterministic relative to the parked hover: same structure revision,
  // evolving dynamic fields. It keeps publishing (round caps at 2, no-op
  // repeats) so the window sees >=3 same-revision snapshot updates.
  var refreshTimer = setInterval(function () {
    try {
      round = Math.min(round + 1, 2);
      currentOwner.applyActivity(presenceWith([dynamicPresence(graphId, round)]));
    } catch (_) { /* owner may be destroyed mid-case */ }
  }, 2000);
  try {
  // Prove the same SVG hit element survives >=3 same-revision refreshes while
  // status/fill/ARIA/label/telemetry update in place and the tip re-converges.
  var fields = await assertHoverSurvivesDynamicFields(slipWin, targetSelector, '代码终审', [
    { label: '状态', value: '已完成' },
    { label: '任务 ID', value: 'forge-deploy' },
    { label: '运行配置', value: 'fast' },
    { label: '工具调用', value: '4' },
    { label: '输出速度', value: '13.70' },
  ], 7500);
  // The done node's summary lands as a separate full-width bordered region
  // with no 结果摘要 label while the same-revision poller keeps publishing.
  await assertTaskTipSummary(slipWin, '全部通过，可发布。');
  if (slipWin.isDestroyed()) throw new Error('Graph slip window destroyed during dynamic-field capture');
  // In-place dynamic fields on the SAME element: done fill, updated ARIA and
  // paper-tag label, no running hint left behind.
  if (fields.state !== 'done') throw new Error('graph-slip-dynamic-fields: data-state not updated in place: ' + JSON.stringify(fields));
  if (fields.tagFill !== '#FBF7EA') throw new Error('graph-slip-dynamic-fields: tag fill not updated for done: ' + JSON.stringify(fields));
  if (fields.aria !== '代码终审') throw new Error('graph-slip-dynamic-fields: aria-label not updated in place: ' + JSON.stringify(fields));
  if (fields.name !== '代码终审') throw new Error('graph-slip-dynamic-fields: paper-tag label not updated in place: ' + JSON.stringify(fields));
  if (fields.hintPresent) throw new Error('graph-slip-dynamic-fields: running hint not removed after done: ' + JSON.stringify(fields));
  await captureInteractiveWindow(slipWin, outFile);
  // The retained click listener reads the CURRENT snapshot: clicking after
  // the task_run_id changed must open the NEW run's transcript, never the
  // stale one the node was built with.
  await sendRealClick(slipWin, targetSelector);
  var transcriptWin = await waitForTranscript('run-e2e-a2-new', 8000);
  await delay(800);
  await assertMarker(transcriptWin, 'transcriptReady', true);
  var transcriptRunId = await transcriptWin.webContents.executeJavaScript(
    '(function() { return new URLSearchParams(location.search).get("task_run_id"); })()',
  ).catch(function () { return null; });
  if (transcriptRunId !== 'run-e2e-a2-new') {
    throw new Error('graph-slip-dynamic-fields: transcript opened for stale run id ' + JSON.stringify(transcriptRunId));
  }
  } finally {
    clearInterval(refreshTimer);
  }
}

async function captureGraphSlipLoading(outFile) {
  var client = new FakeForemanIpcClient();
  var presence = applyBaseFixtures(client, 'tg-e2e-loading', 'running');
  // Make inspect hang to show loading state
  client.setFixture('taskgraph.inspect', function () {
    return new Promise(function () { /* never resolves */ });
  });
  createOwner(client);
  applyActivity([presence]);
  var entityWin = await waitForEntity('tg-e2e-loading', 8000);
  await delay(500);
  await sendRealClick(entityWin, '#entity-hit', 14, 11);
  var slipWin = await waitForGraphSlip('tg-e2e-loading', 8000);
  await delay(500);
  await assertElementVisible(slipWin, '#loading-overlay');
  await captureWindow(slipWin, outFile);
}

async function captureGraphSlipError(outFile) {
  var client = new FakeForemanIpcClient();
  var presence = applyBaseFixtures(client, 'tg-e2e-error', 'running');
  // Make inspect throw to trigger error visual
  client.setFixture('taskgraph.inspect', function () {
    return Promise.reject(new Error('Fake inspect error'));
  });
  createOwner(client);
  applyActivity([presence]);
  var entityWin = await waitForEntity('tg-e2e-error', 8000);
  await delay(500);
  await sendRealClick(entityWin, '#entity-hit', 14, 11);
  var slipWin = await waitForGraphSlip('tg-e2e-error', 8000);
  await delay(1000);
  await assertElementVisible(slipWin, '#error-overlay');
  await captureWindow(slipWin, outFile);
}

// ── Approved complex graph fixtures ───────────────────────────────────
// The running complex graph is a 1→3→1 split/merge with explicit join
// (split) and fanout (merge) transit nodes, a Chinese graph title and
// Chinese per-task category/description. The done-summary graph carries
// Chinese done summaries and intentionally omits the graph title and one
// task's display_label so the '未命名任务图'/'任务' fallbacks are proven.

function complexRunningInspect(graphId) {
  return {
    graph: {
      id: graphId,
      revision: 1,
      nodes: {
        'ctrl-start': { id: 'ctrl-start', name: 'Start', action: { type: 'start', params: {} }, deps: [] },
        'join-split': { id: 'join-split', name: 'Fanout', action: { type: 'join', params: {} }, deps: ['ctrl-start'] },
        'task-receive': { id: 'task-receive', name: '接收订单', action: { type: 'task', params: {} }, deps: ['join-split'] },
        'task-check': { id: 'task-check', name: 'Check', action: { type: 'task', params: {} }, deps: ['join-split'] },
        'task-invoice': { id: 'task-invoice', name: 'Invoice', action: { type: 'task', params: {} }, deps: ['join-split'] },
        'fanout-merge': { id: 'fanout-merge', name: 'Merge', action: { type: 'fanout', params: {} }, deps: ['task-receive', 'task-check', 'task-invoice'] },
        'ctrl-end': { id: 'ctrl-end', name: 'End', action: { type: 'end', params: {} }, deps: ['fanout-merge'] },
      },
    },
  };
}

function complexRunningPresenceNodes() {
  return [
    nodePresence('ctrl-start', 'done'),
    nodePresence('join-split', 'done'),
    nodePresence('task-receive', 'running', {
      taskRunId: 'run-receive', taskId: 'order-receive', taskStatus: 'running',
      taskCategoryId: 'inbound', taskCategoryLabel: '订单接收',
      description: '接收并解析订单数据', resolvedProfile: 'batch', toolCallCount: 5, tps: 8.5,
    }),
    nodePresence('task-check', 'running', {
      taskRunId: 'run-check', taskId: 'inventory-check', taskStatus: 'running',
      taskCategoryId: 'validation', taskCategoryLabel: '库存校验',
      description: '校验库存与价格一致性', resolvedProfile: 'fast', toolCallCount: 2, tps: 15.2,
    }),
    nodePresence('task-invoice', 'running', {
      taskRunId: 'run-invoice', taskId: 'invoice-generate', taskStatus: 'running',
      taskCategoryId: 'billing', taskCategoryLabel: '开票处理',
      description: '生成发票并推送通知', resolvedProfile: 'precise', toolCallCount: 4, tps: 6.1,
    }),
    nodePresence('fanout-merge', 'done'),
    nodePresence('ctrl-end', 'planned'),
  ];
}

function applyComplexRunningFixtures(client, graphId) {
  client.setFixture('taskgraph.inspect', function () { return complexRunningInspect(graphId); });
  client.setFixture('task.run.events', function (params) { return { task_run_id: params.task_run_id, events: [], next_seq: 0, has_more: false }; });
  client.setFixture('task.run.status', function (params) { return runStatusResponse(params.task_run_id, 'running'); });
  return graphPresence(graphId, 'running', { nodes: complexRunningPresenceNodes(), latestSeq: 6, title: '电商订单处理流水线' });
}

function complexDoneInspect(graphId) {
  return {
    graph: {
      id: graphId,
      revision: 1,
      nodes: {
        'task-brief': { id: 'task-brief', name: 'Brief', action: { type: 'task', params: {} }, deps: [] },
        'task-review': { id: 'task-review', name: 'Review', action: { type: 'task', params: {} }, deps: ['task-brief'] },
        'ctrl-end': { id: 'ctrl-end', name: 'End', action: { type: 'end', params: {} }, deps: ['task-review'] },
      },
    },
  };
}

function applyComplexDoneFixtures(client, graphId) {
  client.setFixture('taskgraph.inspect', function () { return complexDoneInspect(graphId); });
  client.setFixture('task.run.events', function (params) { return { task_run_id: params.task_run_id, events: [], next_seq: 0, has_more: false }; });
  client.setFixture('task.run.status', function (params) { return runStatusResponse(params.task_run_id, 'done'); });
  // The graph stays running in the snapshot so the slip survives the capture.
  return graphPresence(graphId, 'running', {
    nodes: [
      nodePresence('task-brief', 'done', { taskRunId: 'run-brief', taskStatus: 'done' }),
      nodePresence('task-review', 'done', {
        taskRunId: 'run-review', taskId: 'review-final', taskStatus: 'done',
        taskCategoryId: 'review', taskCategoryLabel: '终审',
        description: '人工终审交付物',
        // Exactly 280 code units — the product's summary cap — so the bounded
        // Chinese text is retained whole yet wraps far beyond eight lines,
        // proving the line-clamp truncation rather than JS slicing.
        summary: '人工终审完成，全部交付物已按验收标准逐项核查，未发现阻塞性缺陷。功能实现与需求描述完全一致，界面交互符合预期，数据统计与导出结果正确，日志与回放记录完整且可追溯。安全性审查通过，未发现凭证泄露、越权访问或注入风险。性能全部达标，峰值耗时与内存占用均在允许范围内。回归测试已覆盖全部关键路径，所有用例均通过。文档已同步更新至最新版本，发布准备就绪，可以交付发布。补充说明：以上结论均基于当日实测数据与完整审计记录，无遗漏项。复核人已确认关键指标区间，异常样本全部复测通过。发布后观察四小时无问题即可转正式环境。建议后续发布后连续观察四小时，无问题即可转正式环境。',
      }),
      nodePresence('ctrl-end', 'done'),
    ],
    latestSeq: 4,
  });
}

async function captureGraphSlipComplexRunning(outFile) {
  var client = new FakeForemanIpcClient();
  var graphId = 'tg-e2e-complex';
  var presence = applyComplexRunningFixtures(client, graphId);
  createOwner(client);
  applyActivity([presence]);
  var entityWin = await waitForEntity(graphId, 8000);
  await delay(500);
  await sendRealClick(entityWin, '#entity-hit', 14, 11);
  var slipWin = await waitForGraphSlip(graphId, 8000);
  await delay(1200);
  await assertMarker(slipWin, 'slipReady', true);
  // Chinese graph title renders in the drag header with a running dot.
  await assertHeaderTitleAndState(slipWin, '电商订单处理流水线', 'running');
  // 1→3→1 with join/fanout transit: three unified-Agent tasks, start/end
  // controls only, and two solder dots replacing the collapsed junctions.
  await assertApprovedGraphSlipVisuals(slipWin, { tasks: 3, controls: ['start', 'end'], junctions: 2 });
  await assertOrthogonalEdges(slipWin);
  await assertEdgesAvoidNodeRects(slipWin);
  await assertHonestContentSize(slipWin);
  await assertSolidPaperBackground(slipWin);
  await assertControlNoninteractive(slipWin);
  // start/end are icon-only and titleless: hovering them never surfaces a tip.
  await assertNoTooltipAfterHover(slipWin, '[data-node-id="ctrl-start"]');
  await assertNoTooltipAfterHover(slipWin, '[data-node-id="ctrl-end"]');
  // Task tip: exact Chinese heading (the static CJK task_title '接收订单'
  // wins over the activity display_label '订单接收') plus 状态/任务 ID/运行配置/
  // 工具调用/输出速度 rows present in strict label/value order.
  await waitForSemanticTaskTip(slipWin, '[data-node-id="task-receive"]', '接收订单', [
    { label: '状态', value: '运行中' },
    { label: '任务 ID', value: 'order-receive' },
    { label: '运行配置', value: 'batch' },
    { label: '工具调用', value: '5' },
    { label: '输出速度', value: '8.50' },
  ]);
  await assertTaskNodeName(slipWin, '[data-node-id="task-check"]', '库存校验');
  // Park the pointer so the capture frame is tooltip-free.
  await sendMouseMove(slipWin, 480, 340);
  await captureWindow(slipWin, outFile);
}

async function captureGraphSlipComplexDone(outFile) {
  var client = new FakeForemanIpcClient();
  var graphId = 'tg-e2e-done';
  var presence = applyComplexDoneFixtures(client, graphId);
  createOwner(client);
  applyActivity([presence]);
  var entityWin = await waitForEntity(graphId, 8000);
  await delay(500);
  await sendRealClick(entityWin, '#entity-hit', 14, 11);
  var slipWin = await waitForGraphSlip(graphId, 8000);
  await delay(1200);
  await assertMarker(slipWin, 'slipReady', true);
  // No title in the done snapshot → the Chinese '未命名任务图' fallback.
  // The graph stays running in the list so the slip window survives the
  // capture (terminal done would schedule an immediate owner exit).
  await assertHeaderTitleAndState(slipWin, '未命名任务图', 'running');
  await assertApprovedGraphSlipVisuals(slipWin, { tasks: 2, controls: ['end'], junctions: 0 });
  await assertOrthogonalEdges(slipWin);
  await assertEdgesAvoidNodeRects(slipWin);
  await assertHonestContentSize(slipWin);
  // task-brief has no display_label → the '任务' fallback in the paper tag.
  await assertTaskNodeName(slipWin, '[data-node-id="task-brief"]', '任务');
  // The done task tip shows the Chinese display_label heading ('Review' is an
  // English-only static name, so task_title falls back) plus 状态 and 任务 ID
  // rows, and the summary as a separate full-width bordered region — never a
  // labeled 结果摘要 row.
  await waitForSemanticTaskTip(slipWin, '[data-node-id="task-review"]', '终审', [
    { label: '状态', value: '已完成' },
    { label: '任务 ID', value: 'review-final' },
  ]);
  // The bounded 280-unit Chinese summary really overflows: scrollHeight must
  // exceed clientHeight while the clamp keeps visible height at eight lines.
  await assertTaskTipSummary(slipWin, '人工终审完成，全部交付物已按验收标准逐项核查，未发现阻塞性缺陷。功能实现与需求描述完全一致，界面交互符合预期，数据统计与导出结果正确，日志与回放记录完整且可追溯。安全性审查通过，未发现凭证泄露、越权访问或注入风险。性能全部达标，峰值耗时与内存占用均在允许范围内。回归测试已覆盖全部关键路径，所有用例均通过。文档已同步更新至最新版本，发布准备就绪，可以交付发布。补充说明：以上结论均基于当日实测数据与完整审计记录，无遗漏项。复核人已确认关键指标区间，异常样本全部复测通过。发布后观察四小时无问题即可转正式环境。建议后续发布后连续观察四小时，无问题即可转正式环境。', { expectOverflow: true });
  if (slipWin.isDestroyed()) throw new Error('Graph slip window destroyed before done-summary capture');
  await captureInteractiveWindow(slipWin, outFile);
}

// Wait until the transcript poller reaches its task.run.status check and
// assert the intended polling outcome: a live run keeps polling (the call
// count grows across a poll window) while a terminal run stops (the count
// stabilizes). Protocol deviations recorded by the fake boundary fail the
// case here, so a broken task.run.status fixture can never be hidden by
// screenshot timing.
async function waitForRunStatusOutcome(client, expected, timeoutMs) {
  var failOnProtocol = function () {
    if (client._protocolIssues && client._protocolIssues.length > 0) {
      fail('task.run.status protocol violation: ' + client._protocolIssues.join(' | '));
      return true;
    }
    return false;
  };
  if (failOnProtocol()) return;
  var deadline = Date.now() + (timeoutMs || 6000);
  while (Date.now() < deadline && (client._callCounts.get('task.run.status') || 0) === 0) {
    await delay(POLL_MS);
  }
  var firstCount = client._callCounts.get('task.run.status') || 0;
  if (firstCount === 0) {
    fail('task.run.status was never polled; expected ' + expected + ' polling outcome');
    return;
  }
  if (failOnProtocol()) return;
  // Wait a full poll interval plus slack so a subsequent poll would have fired.
  await delay(3000);
  if (failOnProtocol()) return;
  var settledCount = client._callCounts.get('task.run.status') || 0;
  if (expected === 'live') {
    if (settledCount <= firstCount) {
      fail('task.run.status polling did not continue for a live run (calls ' + firstCount + ' -> ' + settledCount + ')');
    }
  } else if (expected === 'terminal') {
    if (settledCount !== firstCount) {
      fail('task.run.status polling did not stop after the terminal status (calls ' + firstCount + ' -> ' + settledCount + ')');
    }
  }
}

// ── Work slip (transcript) cases ─────────────────────────────────────

async function captureWorkSlipMessage(outFile) {
  var client = new FakeForemanIpcClient();
  var presence = applyBaseFixtures(client, 'tg-e2e-a', 'running');
  // Override: only one message event — semantically distinct from tool/tool-result case.
  // node-a2 is the only action.type=task node in the base graph and is the
  // transcript-clickable paper tag.
  client.setFixture('task.run.events', function (params) {
    if (params.task_run_id === 'run-e2e-a2') {
      if (params.after_seq !== undefined && params.after_seq >= 2) {
        return { task_run_id: 'run-e2e-a2', events: [], next_seq: params.after_seq, has_more: false };
      }
      return { task_run_id: 'run-e2e-a2', events: [{ seq: 1, type: 'message', timestamp: '2025-06-01T00:00:01Z', data: { message_summary: 'Task requirements analyzed' } }], next_seq: 2, has_more: false };
    }
    return runEventsResponse(params.task_run_id, params.after_seq);
  });
  createOwner(client);
  applyActivity([presence]);
  var entityWin = await waitForEntity('tg-e2e-a', 8000);
  await delay(500);
  await sendRealClick(entityWin, '#entity-hit', 14, 11);
  var slipWin = await waitForGraphSlip('tg-e2e-a', 8000);
  await delay(1000);
  await assertMarker(slipWin, 'slipReady', true);
  // Click the task node (running state, has transcript data)
  await assertElementVisible(slipWin, '[data-node-id="node-a2"]');
  await sendRealClick(slipWin, '[data-node-id="node-a2"]');
  var transcriptWin = await waitForTranscript('run-e2e-a2', 8000);
  await delay(1000);
  await assertMarker(transcriptWin, 'transcriptReady', true);
  await assertElementAbsent(transcriptWin, '#rack');
  await assertElementAbsent(transcriptWin, '#refresh-btn');
  await assertElementAbsent(transcriptWin, '.rack-item');
  await assertElementVisible(transcriptWin, '#stream');
  var eventCount = await transcriptWin.webContents.executeJavaScript(
    'document.querySelectorAll(".event").length',
  );
  if (eventCount === 0) fail('No events rendered in transcript');
  // The live run keeps polling task.run.status; any protocol deviation fails here.
  await waitForRunStatusOutcome(client, 'live');
  await captureWindow(transcriptWin, outFile);
}

async function captureWorkSlipTool(outFile) {
  var client = new FakeForemanIpcClient();
  var presence = applyBaseFixtures(client, 'tg-e2e-a', 'running');
  // Override: only tool_call + tool_result pair — semantically distinct from single-message case
  client.setFixture('task.run.events', function (params) {
    if (params.task_run_id === 'run-e2e-a2') {
      if (params.after_seq !== undefined && params.after_seq >= 3) {
        return { task_run_id: 'run-e2e-a2', events: [], next_seq: params.after_seq, has_more: false };
      }
      return { task_run_id: 'run-e2e-a2', events: [{ seq: 1, type: 'tool_call', timestamp: '2025-06-01T00:00:02Z', data: { tool_name: 'read_file', input_summary: 'Read config' } }, { seq: 2, type: 'tool_result', timestamp: '2025-06-01T00:00:03Z', data: { output_summary: 'Config read successfully', status: 'success' }, is_error: false }], next_seq: 3, has_more: false };
    }
    return runEventsResponse(params.task_run_id, params.after_seq);
  });
  createOwner(client);
  applyActivity([presence]);
  var entityWin = await waitForEntity('tg-e2e-a', 8000);
  await delay(500);
  await sendRealClick(entityWin, '#entity-hit', 14, 11);
  var slipWin = await waitForGraphSlip('tg-e2e-a', 8000);
  await delay(1000);
  await assertMarker(slipWin, 'slipReady', true);
  await assertElementVisible(slipWin, '[data-node-id="node-a2"]');
  await sendRealClick(slipWin, '[data-node-id="node-a2"]');
  var transcriptWin = await waitForTranscript('run-e2e-a2', 8000);
  await delay(1000);
  await assertMarker(transcriptWin, 'transcriptReady', true);
  await assertElementVisible(transcriptWin, '#stream');
  var toolCallCount = await transcriptWin.webContents.executeJavaScript(
    'document.querySelectorAll(".event-tool_call").length',
  );
  if (toolCallCount === 0) fail('No tool call events rendered');
  // The live run keeps polling task.run.status; any protocol deviation fails here.
  await waitForRunStatusOutcome(client, 'live');
  await captureWindow(transcriptWin, outFile);
}

async function captureWorkSlipUsageLifecycle(outFile) {
  var client = new FakeForemanIpcClient();
  // Custom fixture: node-combo task with usage+lifecycle events
  client.setFixture('taskgraph.inspect', {
    graph: {
      id: 'tg-e2e-combo',
      revision: 1,
      nodes: {
        'node-combo': { id: 'node-combo', name: 'Combo', action: { type: 'task', params: {} }, deps: [] },
      },
    },
  });
  client.setFixture('task.run.events', function (params) {
    if (params.after_seq !== undefined && params.after_seq >= 3) {
      return { task_run_id: params.task_run_id, events: [], next_seq: params.after_seq, has_more: false };
    }
    return {
      task_run_id: params.task_run_id,
      events: [
        { seq: 1, type: 'turn_usage', timestamp: '2025-06-01T00:20:00Z', data: { input_tokens: 1500, output_tokens: 800, total_tokens: 2300, duration_ms: 15000 } },
        { seq: 2, type: 'lifecycle', timestamp: '2025-06-01T00:20:01Z', data: { event: 'completed', status: 'success' } },
      ],
      next_seq: 3,
      has_more: false,
    };
  });
  // Terminal status: the fully-loaded live run polls task.run.status once,
  // detects 'done', and the poller stops.
  client.setFixture('task.run.status', function (params) { return runStatusResponse(params.task_run_id, 'done'); });
  var comboPresence = graphPresence('tg-e2e-combo', 'running', {
    nodes: [
      nodePresence('node-combo', 'running', {
        taskRunId: 'run-e2e-combo', taskStatus: 'running',
        taskCategoryId: 'combo', taskCategoryLabel: '组合任务',
      }),
    ],
    latestSeq: 1,
  });
  createOwner(client);
  applyActivity([comboPresence]);
  var entityWin = await waitForEntity('tg-e2e-combo', 8000);
  await delay(500);
  await sendRealClick(entityWin, '#entity-hit', 14, 11);
  var slipWin = await waitForGraphSlip('tg-e2e-combo', 8000);
  await delay(1000);
  await assertMarker(slipWin, 'slipReady', true);
  await sendRealClick(slipWin, '[data-node-id="node-combo"]');
  var transcriptWin = await waitForTranscript('run-e2e-combo', 8000);
  await delay(1000);
  await assertMarker(transcriptWin, 'transcriptReady', true);
  await assertElementAbsent(transcriptWin, '#rack');
  await assertElementAbsent(transcriptWin, '#refresh-btn');
  await assertElementAbsent(transcriptWin, '.rack-item');
  // The terminal status must stop the poller; any protocol deviation fails here.
  await waitForRunStatusOutcome(client, 'terminal');
  await captureInteractiveWindow(transcriptWin, outFile);
}

// ── Negative: foreign sender rejection ────────────────────────────────
// Removed — converted to runSecurityChecks() preflight in run()

// ── Negative: mismatched node/taskRun ─────────────────────────────────
// Removed — converted to runSecurityChecks() preflight in run()

// ── Entity → Slip → Work Slip click chain ────────────────────────────

async function captureEntityToSlipToWorkSlipChain(outFile) {
  var client = new FakeForemanIpcClient();
  var presence = applyBaseFixtures(client, 'tg-e2e-a', 'running');
  createOwner(client);
  applyActivity([presence]);
  var entityWin = await waitForEntity('tg-e2e-a', 8000);
  await delay(500);
  // Click entity to open graph slip
  await sendRealClick(entityWin, '#entity-hit', 14, 11);
  var slipWin = await waitForGraphSlip('tg-e2e-a', 8000);
  await delay(1000);
  await assertMarker(slipWin, 'slipReady', true);
  // Click task node to open transcript
  await sendRealClick(slipWin, '[data-node-id="node-a2"]');
  var transcriptWin = await waitForTranscript('run-e2e-a2', 8000);
  await delay(1000);
  await assertMarker(transcriptWin, 'transcriptReady', true);
  // The live run keeps polling task.run.status; any protocol deviation fails here.
  await waitForRunStatusOutcome(client, 'live');
  await captureWindow(transcriptWin, outFile);
}

// ── Assertions ─────────────────────────────────────────────────────────
// Security rejection checks moved to runSecurityChecks() preflight in run()

// ── Declared artifact filenames ────────────────────────────────────────

var DECLARED_FILES = [
  'wren-running.png',
  'wren-paused.png',
  'wren-multiple.png',
  'wren-hover.png',
  'wren-stale.png',
  'wren-content.png',
  'wren-long-title.png',
  'graph-slip.png',
  'graph-slip-node-hover.png',
  'graph-slip-dynamic-fields.png',
  'graph-slip-loading.png',
  'graph-slip-error.png',
  'work-slip-message.png',
  'work-slip-tool.png',
  'work-slip-usage-lifecycle.png',
  'entity-to-slip-to-work-slip-chain.png',
  'graph-slip-complex-running.png',
  'graph-slip-complex-done.png',
];
var MANIFEST_FILE = 'taskgraph-e2e-manifest.json';

// ── Process ownership & cleanup ────────────────────────────────────────
// The harness runs as its own Electron instance under a dedicated userData
// dir (artifacts/ui-review/electron-user-data), so every BrowserWindow,
// renderer and GPU/utility helper it spawns is capture-owned. The
// Foreman-managed Pet is the `npm start` tree rooted at
// scripts/run-foreground.mjs; it is recognized by an exact launcher
// signature and is NEVER terminated by the harness. When the Pet is
// observed running, capture pauses it only through the official management
// CLI (`foreman pet disable --json`) and restores it afterwards
// (`foreman pet enable --json`). Cleanup force-terminates only
// capture-owned Electron processes and always attempts the official Pet
// restoration.
//
// Ownership is scoped to the capture Electron instance only: the explicitly
// spawned Electron root (this process) and its descendant tree, plus the
// exact --user-data-dir argument this capture run uses (app.setPath(
// 'userData', electronDataDir)). The capture script argument is NEVER an
// ownership signal — the current Node/cmd launcher ancestry (cmd.exe,
// node.exe running the electron CLI) also carries
// scripts/taskgraph-e2e-capture.mjs in its command line, so a script-name
// match would terminate the harness's own launcher before the manifest can
// be published. A generic basename or substring match (e.g. the literal
// 'electron-user-data' basename) is equally rejected: an unrelated directory
// sharing the basename must never classify an unrelated Electron process as
// capture-owned.

var CAPTURE_SCRIPT_ARG = 'taskgraph-e2e-capture.mjs';
var MANAGED_PET_ARG = 'run-foreground.mjs';
var NORMALIZED_SCRIPTS_DIR = normalizeTokenPath(path.join(rootDir, 'scripts'));

// Normalize a path the way the exact --user-data-dir comparison needs:
// resolve to an absolute path, fold separators and strip trailing slashes,
// and lowercase on Windows (drive letters and separators are
// case-insensitive there). The same normalization is applied to both sides.
function normalizeCapturePath(p) {
  if (!p) return '';
  var resolved = path.resolve(String(p));
  var norm = resolved.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

// Parse the exact --user-data-dir argument value out of a process command
// line (quoted or bare). Returns null when the argument is absent.
function captureUserDataDirFromCmd(cmd) {
  var m = /(?:^|\s)--user-data-dir=(?:"([^"]*)"|(\S+))/.exec(String(cmd || ''));
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}

var NORMALIZED_CAPTURE_USER_DATA_DIR = normalizeCapturePath(electronDataDir);

function hasExactCaptureUserDataDir(proc) {
  var arg = captureUserDataDirFromCmd(proc && proc.cmd);
  if (arg === null || arg === undefined) return false;
  return normalizeCapturePath(arg) === NORMALIZED_CAPTURE_USER_DATA_DIR;
}

var captureOwnedPids = [];
var managedPetPids = [];
var petStoppedByHarness = false;
var managedPetWasRunning = false;

function enumerateProcessEvidence() {
  // Best-effort [{ pid, ppid, name, exe, cmd }] snapshot of every candidate
  // process; an unavailable process enumerator returns [] so cleanup
  // degrades safely.
  var out = [];
  try {
    var raw;
    if (process.platform === 'win32') {
      raw = execFileSync('wmic', ['process', 'get', 'ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine', '/format:list'], { encoding: 'utf8', windowsHide: true });
      var lines = raw.split(/\r?\n/);
      var pid = null, ppid = null, name = null, exe = null, cmd = null;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.indexOf('CommandLine=') === 0) cmd = line.slice('CommandLine='.length);
        else if (line.indexOf('ProcessId=') === 0) pid = line.slice('ProcessId='.length).trim();
        else if (line.indexOf('ParentProcessId=') === 0) ppid = line.slice('ParentProcessId='.length).trim();
        else if (line.indexOf('Name=') === 0) name = line.slice('Name='.length);
        else if (line.indexOf('ExecutablePath=') === 0) exe = line.slice('ExecutablePath='.length);
        if (pid && cmd) {
          out.push({ pid: pid, ppid: ppid, name: name, exe: exe, cmd: cmd });
          pid = null; ppid = null; name = null; exe = null; cmd = null;
        }
      }
    } else {
      raw = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm=,args='], { encoding: 'utf8' });
      var rows = raw.split(/\r?\n/);
      for (var j = 0; j < rows.length; j++) {
        var row = rows[j].trim();
        if (!row) continue;
        var m = /^(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(row);
        if (!m) continue;
        out.push({ pid: m[1].trim(), ppid: m[2].trim(), name: m[3].trim(), exe: m[3].trim(), cmd: m[4].trim() });
      }
    }
  } catch (_) { return []; }
  return out;
}

function collectDescendants(rootPid, procs) {
  // BFS over parent/child evidence: every process reachable from the given
  // root PID through repeated ParentProcessId hops is a descendant of it.
  var childrenByParent = {};
  for (var i = 0; i < procs.length; i++) {
    var proc = procs[i];
    if (proc.ppid === undefined || proc.ppid === null || proc.ppid === '') continue;
    var parent = String(proc.ppid);
    (childrenByParent[parent] = childrenByParent[parent] || []).push(String(proc.pid));
  }
  var seen = {};
  var queue = [String(rootPid)];
  while (queue.length > 0) {
    var cur = queue.shift();
    var kids = childrenByParent[cur] || [];
    for (var j = 0; j < kids.length; j++) {
      if (!seen[kids[j]]) {
        seen[kids[j]] = true;
        queue.push(kids[j]);
      }
    }
  }
  return seen;
}

function isElectronProcess(proc) {
  // Electron main/renderer/GPU/utility processes share the Electron binary;
  // the capture instance's own root is process.execPath.
  var name = String(proc.name || '').toLowerCase();
  var exe = String(proc.exe || '').toLowerCase();
  var currentExe = String(process.execPath || '').toLowerCase();
  var currentName = path.basename(currentExe);
  return (currentName !== '' && (name === currentName || exe === currentExe || exe.indexOf(currentName) !== -1)) ||
    name.indexOf('electron') !== -1;
}

function isCaptureOwnedProcess(proc, captureDescendants) {
  // Ownership NEVER comes from script-name or basename/substring matching:
  // the current Node/cmd launcher ancestry also carries the capture script
  // argument, and an unrelated directory sharing the electron-user-data
  // basename must never classify an unrelated Electron process as
  // capture-owned. A process is capture-owned only when it is an Electron
  // process AND either a descendant of the capture Electron root or carries
  // the exact --user-data-dir for this capture run.
  if (!isElectronProcess(proc)) return false;
  var pid = String(proc.pid);
  if (captureDescendants && captureDescendants[pid]) return true;
  return hasExactCaptureUserDataDir(proc);
}

// Normalize a command-line path token for the exact launcher-signature
// comparison: fold separators and lowercase on Windows, like
// normalizeCapturePath does for the --user-data-dir comparison.
function normalizeTokenPath(p) {
  var posix = String(p || '').replace(/\\/g, '/');
  var norm = path.posix.normalize(posix) || '/';
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

// Read-only, exact launcher signature for the Foreman-managed Pet. The
// command line must carry `run-foreground.mjs` as a COMPLETE path token
// whose directory part is the project `scripts` directory (the relative
// `scripts` segment, the normalized absolute rootDir/scripts path, or a
// bare `run-foreground.mjs` token) — a bare substring of a longer token
// (e.g. `my-run-foreground.mjs`) never matches. This signature is used
// only to observe whether the Pet is running and to exclude its processes
// from cleanup; it never defines a kill set.
function hasExactManagedPetSignature(cmd) {
  var tokens = String(cmd || '').split(/\s+/);
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i].replace(/^["']+|["']+$/g, '');
    if (!t) continue;
    var posix = t.replace(/\\/g, '/');
    if (path.posix.basename(posix) !== MANAGED_PET_ARG) continue;
    var dir = normalizeTokenPath(path.posix.dirname(posix));
    if (dir === '.' || dir === 'scripts' || dir === NORMALIZED_SCRIPTS_DIR) return true;
  }
  return false;
}

function isManagedPetProcess(proc) {
  return hasExactManagedPetSignature(proc && proc.cmd);
}

function isForemanDaemonProcess(proc) {
  // The Foreman daemon is recognized by its executable name so the
  // foreman-pet working directory in the capture command line is never
  // mistaken for a daemon process.
  var name = String(proc.name || '').toLowerCase();
  var exe = path.basename(String(proc.exe || '')).toLowerCase();
  return name.indexOf('foreman') !== -1 || exe.indexOf('foreman') !== -1;
}

function isForbiddenLauncherProcess(proc) {
  // Shell launchers and a node.exe carrying the capture script argument
  // must never be terminated: they are the harness's own launching chain
  // when a broad script-name signal would otherwise match them.
  var name = String(proc.name || '').toLowerCase();
  return name === 'cmd.exe' || name === 'powershell.exe' || name === 'pwsh.exe' ||
    (name === 'node.exe' && (proc.cmd || '').indexOf(CAPTURE_SCRIPT_ARG) !== -1);
}

function snapshotManagedPetTree() {
  var procs = enumerateProcessEvidence();
  // Read-only observation only: managedPetPids is an exclusion set for
  // cleanup, and managedPetWasRunning preserves whether the Pet was running
  // before capture. Neither ever authorizes terminating a Pet process.
  managedPetPids = procs.filter(isManagedPetProcess).map(function (p) { return p.pid; });
  managedPetWasRunning = procs.some(function (p) { return hasExactManagedPetSignature(p.cmd); });
}

function stopManagedPetForCapture() {
  // Never terminates a Foreman-managed Pet process. When the Pet was
  // observed running under its exact launcher signature, it is paused only
  // through the official management CLI; otherwise there is nothing to do.
  snapshotManagedPetTree();
  if (!managedPetWasRunning) return;
  try {
    runForemanPetCli('disable');
    petStoppedByHarness = true;
    console.log('[capture] paused the Foreman-managed Pet via `foreman pet disable --json` for deterministic captures');
  } catch (e) {
    fail('pause-managed-pet: ' + (e ? e.message || String(e) : 'unknown error'));
  }
}

function terminateProcess(pid) {
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (_) {}
  } else {
    try { process.kill(Number(pid), 'SIGKILL'); } catch (_) {}
  }
}

// The ONLY lifecycle surface for the Foreman-managed Pet: pause/restore go
// through the official management CLI, never through process termination.
// Synchronous with a bounded timeout, hidden on Windows, with the exit
// status checked and a descriptive error thrown when the command cannot run
// or exits nonzero.
//
// The action is validated against exactly `disable|enable`; the fixed
// argument shape `pet <action> --json` is never built from user-controlled
// input. On Windows the CLI is exposed through a PATH shim (foreman.cmd /
// foreman.ps1) rather than a native executable, so cmd.exe/ComSpec is invoked
// with `/d /s /c` and the fixed bare PATH-resolved command text
// `foreman pet <action> --json`; the action is internal enum data and no
// other interpolation or quoted shim path is ever constructed. On other
// platforms the command executes directly as an argument vector.
function runForemanPetCli(action) {
  if (action !== 'disable' && action !== 'enable') {
    throw new Error('unsupported foreman pet action: ' + String(action));
  }
  var res;
  if (process.platform === 'win32') {
    var shell = process.env.ComSpec || 'cmd.exe';
    res = spawnSync(shell, ['/d', '/s', '/c', 'foreman pet ' + action + ' --json'], {
      cwd: rootDir,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
  } else {
    res = spawnSync('foreman', ['pet', action, '--json'], {
      cwd: rootDir,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
  }
  if (res.error) {
    throw new Error('foreman pet ' + action + ' --json failed to run: ' + (res.error.message || String(res.error)));
  }
  if (res.status !== 0) {
    throw new Error('foreman pet ' + action + ' --json exited with status ' + res.status + ': ' + String((res.stderr || res.stdout || '').trim()));
  }
}

function restoreManagedPet() {
  // Restore only when the harness observed the Pet running before it paused
  // it — never start a Pet that was not running before capture.
  if (!petStoppedByHarness) return;
  try {
    runForemanPetCli('enable');
    console.log('[capture] restored the Foreman-managed Pet via `foreman pet enable --json`');
  } catch (e) {
    fail('restore-managed-pet: ' + (e ? e.message || String(e) : 'unknown error'));
  }
  petStoppedByHarness = false;
}

async function cleanupCaptureProcessTree() {
  // Await/close the owner windows, then force-terminate any remaining
  // capture-owned Electron processes so no capture temp/app process is left
  // after a run. Only explicit Electron roots/descendants of the capture
  // instance and the capture userData marker qualify; the current capture
  // Node process, its launcher ancestry (cmd.exe / node.exe / powershell),
  // the Foreman daemon and the managed Pet tree are excluded and can never
  // be terminated.
  try {
    destroyOwner();
    var allWins = BrowserWindow.getAllWindows();
    for (var i = 0; i < allWins.length; i++) {
      var w = allWins[i];
      if (!w.isDestroyed()) { try { w.destroy(); } catch (_) {} }
    }
    var procs = enumerateProcessEvidence();
    var ownPid = String(process.pid);
    var pidToPpid = {};
    for (var m = 0; m < procs.length; m++) pidToPpid[procs[m].pid] = procs[m].ppid;
    // The capture Electron root is this process; its descendants form the
    // capture-owned process tree that may still be force-terminated.
    var captureDescendants = collectDescendants(ownPid, procs);
    // Snapshot process.pid plus every ancestor of the current capture Node
    // process (the Node/cmd launcher chain) as untouchable before cleanup.
    var protectedPids = {};
    protectedPids[ownPid] = true;
    var cur = ownPid;
    var hop = 0;
    while (cur && pidToPpid[cur] && pidToPpid[cur] !== '0' && pidToPpid[cur] !== '1' && hop++ < 64) {
      var parent = String(pidToPpid[cur]);
      if (protectedPids[parent]) break;
      protectedPids[parent] = true;
      cur = parent;
    }
    captureOwnedPids = procs.filter(function (p) {
      if (protectedPids[p.pid]) return false;
      if (managedPetPids.indexOf(p.pid) !== -1) return false;
      if (isManagedPetProcess(p)) return false;
      if (isForemanDaemonProcess(p)) return false;
      if (isForbiddenLauncherProcess(p)) return false;
      return isCaptureOwnedProcess(p, captureDescendants);
    }).map(function (p) { return p.pid; });
    for (var k = 0; k < captureOwnedPids.length; k++) {
      terminateProcess(captureOwnedPids[k]);
    }
  } finally {
    // Always attempt the official Pet restoration — even when a cleanup step
    // threw — because the Pet was paused through the CLI and only the CLI
    // enable can bring it back.
    restoreManagedPet();
  }
}

// ── Run ────────────────────────────────────────────────────────────────

var CASES = [
  { id: 'wren-running',                 fn: captureWrenRunning },
  { id: 'wren-paused',                  fn: captureWrenPaused },
  { id: 'wren-multiple',                fn: captureWrenMultipleLayout },
  { id: 'wren-hover',                   fn: captureWrenHover },
  { id: 'wren-stale',                   fn: captureWrenStale },
  { id: 'wren-content',                 fn: captureWrenContent },
  { id: 'wren-long-title',              fn: captureWrenLongTitle },
  { id: 'graph-slip',                   fn: captureGraphSlip },
  { id: 'graph-slip-node-hover',        fn: captureGraphSlipNodeHover },
  { id: 'graph-slip-dynamic-fields',    fn: captureGraphSlipDynamicFields },
  { id: 'graph-slip-loading',           fn: captureGraphSlipLoading },
  { id: 'graph-slip-error',             fn: captureGraphSlipError },
  { id: 'work-slip-message',            fn: captureWorkSlipMessage },
  { id: 'work-slip-tool',               fn: captureWorkSlipTool },
  { id: 'work-slip-usage-lifecycle',    fn: captureWorkSlipUsageLifecycle },
  { id: 'entity-to-slip-to-work-slip-chain', fn: captureEntityToSlipToWorkSlipChain },
  { id: 'graph-slip-complex-running',   fn: captureGraphSlipComplexRunning },
  { id: 'graph-slip-complex-done',      fn: captureGraphSlipComplexDone },
];

// ── Security preflight ─────────────────────────────────────────────────

async function runSecurityChecks() {
  // 1. Foreign sender rejection — using a legitimate owner IPC context
  var legitimateClient = new FakeForemanIpcClient();
  var legitPresence = applyBaseFixtures(legitimateClient, 'tg-e2e-security', 'running');
  createOwner(legitimateClient);
  applyActivity([legitPresence]);
  var legitimateEntityWin = await waitForEntity('tg-e2e-security', 8000);
  await waitForMarker(legitimateEntityWin, 'entityReady', CASE_TIMEOUT_MS);

  // Foreign sender click occurs while production IPC handlers are registered
  var foreignWin = null;
  try {
    foreignWin = new BrowserWindow({
      width: 156,
      height: 84,
      transparent: true,
      frame: false,
      show: false,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(preloadDir, 'entity-preload.js'),
      },
    });
    foreignWin.setBounds({ x: 400, y: 400 });
    await foreignWin.loadFile(path.join(htmlDir, 'entity.html'));

    // Wait for full page load — entityReady must NOT be set since getState returns null for unowned
    var hasEntityReady = await foreignWin.webContents.executeJavaScript(
      '!!document.documentElement.dataset.entityReady',
    ).catch(function () { return false; });
    if (hasEntityReady) {
      throw new Error('runSecurityChecks: foreign window has entityReady (getState should return null for unowned)');
    }

    // Count graph slip windows before click
    function countGraphSlips() {
      return BrowserWindow.getAllWindows().filter(function(w) {
        if (w.isDestroyed()) return false;
        try { return w.webContents.getURL().includes('graph-slip.html'); }
        catch (_) { return false; }
      }).length;
    }

    var slipCountBefore = countGraphSlips();

    // Negative probe: call production entity:open-self API from foreign renderer
    var apiExists = await foreignWin.webContents.executeJavaScript(
      'typeof window.entityApi !== "undefined" && typeof window.entityApi.openSelf === "function"',
    ).catch(function () { return false; });
    if (!apiExists) {
      throw new Error('runSecurityChecks: window.entityApi.openSelf not found in foreign window');
    }

    await foreignWin.webContents.executeJavaScript(
      '(async function() { try { await window.entityApi.openSelf(); } catch (e) { /* authorization rejection expected */ } })()',
    );
    await delay(500);

    var slipCountAfter = countGraphSlips();
    if (slipCountAfter > slipCountBefore) {
      throw new Error('runSecurityChecks: foreign sender created a graph slip window via entityApi.openSelf (security check failed)');
    }
  } finally {
    if (foreignWin && !foreignWin.isDestroyed()) {
      try { foreignWin.destroy(); } catch (_) {}
    }
  }

  // Destroy the first legitimate owner
  destroyOwner();

  // 2. Mismatched node/task-run rejection — fresh legitimate owner
  var client = new FakeForemanIpcClient();
  var secPresence = applyBaseFixtures(client, 'tg-e2e-security', 'running');
  try {
    createOwner(client);
    applyActivity([secPresence]);
    var entityWin = await waitForEntity('tg-e2e-security', 8000);
    await waitForMarker(entityWin, 'entityReady', CASE_TIMEOUT_MS);
    await sendRealClick(entityWin, '#entity-hit', 14, 11);
    var slipWin = await waitForGraphSlip('tg-e2e-security', 8000);
    await delay(500);

    function countTranscripts() {
      return BrowserWindow.getAllWindows().filter(function(w) {
        if (w.isDestroyed()) return false;
        try { return w.webContents.getURL().includes('transcript.html'); }
        catch (_) { return false; }
      }).length;
    }

    var transcriptCountBefore = countTranscripts();

    var hasGraphSlipApi = await slipWin.webContents.executeJavaScript(
      'typeof window.graphSlipApi !== "undefined" && typeof window.graphSlipApi.openTranscript === "function"',
    ).catch(function () { return false; });

    if (hasGraphSlipApi) {
      await slipWin.webContents.executeJavaScript(
        'window.graphSlipApi.openTranscript("node-a1", "mismatched-run-id")',
      ).catch(function () { /* expected rejection */ });
      await delay(300);
    }

    var transcriptCountAfter = countTranscripts();
    if (transcriptCountAfter > transcriptCountBefore) {
      throw new Error('runSecurityChecks: mismatched node/taskRun created a transcript window (security check failed)');
    }
  } finally {
    destroyOwner();
  }
}

async function run() {
  // Clean stale artifacts: remove every screenshot in the capture dir that
  // is not part of the canonical 16-case declared list (including the legacy
  // graph-slip-edge-hover.png from the earlier edge-hover contract).
  var declaredSet = {};
  for (var i = 0; i < DECLARED_FILES.length; i++) declaredSet[DECLARED_FILES[i]] = true;
  if (fs.existsSync(captureBase)) {
    var staleEntries = fs.readdirSync(captureBase);
    for (var j = 0; j < staleEntries.length; j++) {
      var entry = staleEntries[j];
      if (entry === MANIFEST_FILE) continue;
      if (entry.slice(-4) === '.png' && !declaredSet[entry]) {
        try { fs.unlinkSync(path.join(captureBase, entry)); } catch (_) {}
      }
    }
  }
  try { fs.unlinkSync(path.join(captureBase, MANIFEST_FILE)); } catch (_) {}

  // Observe the Foreman-managed Pet's running state before any capture work
  // so cleanup never touches it, then pause it through the official CLI
  // (`foreman pet disable --json`) only when it was actually running — the
  // harness never terminates a managed Pet process.
  snapshotManagedPetTree();
  stopManagedPetForCapture();

  try {
    // Run security preflight before all capture cases. A rejected preflight
    // must not truncate the diagnostic run: record a named failure with the
    // error message, clean up the owner, and keep the unconditional CASES
    // loop reachable so every capture still executes.
    try {
      await runSecurityChecks();
    } catch (e) {
      fail('security-preflight: ' + (e ? e.message || String(e) : 'unknown error'));
      destroyOwner();
    }

    for (var i = 0; i < CASES.length; i++) {
      var c = CASES[i];
      await captureCase(c.id, c.id.replace(/-/g, ' '), c.fn);
    }
  } finally {
    // Publish the completed manifest while the capture Node process is
    // still alive — process-tree cleanup runs after publication on every
    // success/failure path and never preempts it. Then force-terminate any
    // remaining capture-owned Electron processes before the managed Pet
    // service is restored.
    if (failures.length === 0) {
      var manifestPath = path.join(captureBase, MANIFEST_FILE);
      fs.writeFileSync(manifestPath, JSON.stringify(manifestEntries, null, 2) + '\n');
      console.log('');
      console.log('[capture] all ' + CASES.length + ' taskgraph E2E captures passed');
      console.log('Manifest: ' + manifestPath);
      console.log('Artifacts in: ' + captureBase);
    } else {
      console.log('');
      console.log('[capture] ' + failures.length + ' failure(s):');
      for (var j = 0; j < failures.length; j++) {
        console.log('  FAIL: ' + failures[j]);
      }
      console.log('Partial artifacts in: ' + captureBase);
    }
    try {
      await cleanupCaptureProcessTree();
    } catch (e) {
      // Never mask the primary failure: a cleanup/restore exception is
      // recorded as an additional failure instead of replacing it.
      fail('cleanup-capture-process-tree: ' + (e ? e.message || String(e) : 'unknown error'));
    }
  }
}

app.whenReady().then(function () {
  run()
    .then(function () {
      if (failures.length > 0) app.exit(1);
      else app.quit();
    })
    .catch(function (error) {
      console.error('[capture] harness error:', error ? (error.message || error) : 'unknown');
      app.exit(1);
    });
});

app.on('window-all-closed', function () {
  // No-op: the run() promise owns app termination
});
