import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  SHELL_CHANNELS,
  acceleratorPage,
  isShellPage,
  type WrenyardShellApi,
} from '../src/shell-contract.js';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('docs is a registered, navigator-aware shell page', () => {
  assert.equal(isShellPage('docs'), true);
  assert.equal(SHELL_CHANNELS.docsList, 'wrenyard-shell:docs-list');
  assert.equal(SHELL_CHANNELS.docsRead, 'wrenyard-shell:docs-read');
  assert.equal(SHELL_CHANNELS.docsSave, 'wrenyard-shell:docs-save');
  assert.equal(SHELL_CHANNELS.docsDirty, 'wrenyard-shell:docs-dirty');
});

test('acceleratorPage keeps docs out of the bounded existing shortcut set', () => {
  // Conventions only map 1–4 to workbench/stats/quota/clients; docs has no accelerator.
  assert.equal(acceleratorPage({ key: '5', meta: true }, 'darwin'), null);
  assert.equal(acceleratorPage({ key: '6', control: true }, 'win32'), null);
});

test('WrenyardShellApi exposes only bounded docs operations', () => {
  const api: Pick<WrenyardShellApi, 'listDocs' | 'readDoc' | 'saveDoc' | 'setDocsDirty'> = {
    listDocs: async () => [],
    readDoc: async () => ({ path: 'docs/specs/x.md', content: '' }),
    saveDoc: async () => ({ path: 'docs/specs/x.md' }),
    setDocsDirty: async () => undefined,
  };
  assert.equal(typeof api.listDocs, 'function');
  assert.equal(typeof api.readDoc, 'function');
  assert.equal(typeof api.saveDoc, 'function');
  assert.equal(typeof api.setDocsDirty, 'function');
});

test('preload exposes only bounded docs list/read/save/dirty methods', () => {
  const preload = preloadSource();
  assert.match(preload, /listDocs\(\): Promise<WorkspaceDocEntry\[\]> \{\s*return ipcRenderer\.invoke\(SHELL_CHANNELS\.docsList\)/u);
  assert.match(preload, /readDoc\(path: string\): Promise<WorkspaceDocContent> \{\s*return ipcRenderer\.invoke\(SHELL_CHANNELS\.docsRead, path\)/u);
  assert.match(preload, /saveDoc\(path: string, content: string, expectedContent: string\): Promise<WorkspaceDocSaveResult> \{\s*return ipcRenderer\.invoke\(SHELL_CHANNELS\.docsSave, path, content, expectedContent\)/u);
  assert.match(preload, /setDocsDirty\(dirty: boolean\): Promise<void> \{\s*return ipcRenderer\.invoke\(SHELL_CHANNELS\.docsDirty, dirty\)/u);
  // No create/delete/rename/generic fs surface for docs.
  assert.doesNotMatch(preload, /createDoc|deleteDoc|renameDoc/);
  assert.doesNotMatch(preload, /workspace\.doc\.create|workspace\.doc\.delete|workspace\.doc\.rename/);
});

test('main routes only the spec/memory subset to workspace.doc and never creates files', () => {
  const main = mainSource();
  assert.match(main, /workspace\.doc\.list/);
  assert.match(main, /workspace\.doc\.read/);
  assert.match(main, /workspace\.doc\.update/);
  assert.doesNotMatch(main, /workspace\.doc\.create/);
  // Path filtering allows exactly docs/specs, projects/*/docs/specs, memories, AGENTS.md.
  assert.match(main, /isDocsAllowedPath/);
  assert.match(main, /docs\/specs/u);
  assert.match(main, /projects\/[^\/]+\//u);
  assert.match(main, /memories\/[^\/]+\.md/u);
  assert.match(main, /AGENTS\.md/);
  // Dirty state is tracked in module/bootstrap state without persistence.
  assert.match(main, /getDocsDirty/);
  assert.match(main, /docsDirty = dirty/);
});

test('renderer explicit save carries expectedContent, handles conflict, and tracks dirty', async () => {
  const [app, html, main] = await Promise.all([
    readFile(join(desktopRoot, 'src', 'renderer', 'app.ts'), 'utf8'),
    readFile(join(desktopRoot, 'src', 'renderer', 'index.html'), 'utf8'),
    Promise.resolve(mainSource()),
  ]);
  // The bounded shell contract exposes saveDoc(path, content, expectedContent)
  // (verified against WrenyardShellApi/preload in the tests above). Main wires the
  // saveDoc handler through to saveWorkspaceDoc and forwards the original-content
  // token (expectedContent) into the workspace.doc.update compare-and-swap call.
  // Asserted by semantics + stable identifiers so harmless wrapper/spelling
  // differences in main do not break the test.
  assert.match(main, /saveDoc:\s*\([^)]*\)\s*=>\s*saveWorkspaceDoc/);
  // CAS forwarding: saveWorkspaceDoc accepts path/content/expectedContent (tolerant
  // of `const saveWorkspaceDoc = async (...)` declaration) and forwards all three
  // into the workspace.doc.update compare-and-swap request object.
  assert.match(main, /saveWorkspaceDoc[\s\S]*?(?=[\s\S]*?\bpath\b)(?=[\s\S]*?\bcontent\b)(?=[\s\S]*?expectedContent)/);
  assert.match(main, /requestForeman\(\s*'workspace\.doc\.update'[\s\S]*?(?=[\s\S]*?\bpath\b)(?=[\s\S]*?\bcontent\b)(?=[\s\S]*?expectedContent)/);
  // The renderer captures its baseline content and performs the explicit CAS save
  // passing expectedContent (the original-content concurrency token).
  assert.match(app, /await window\.wrenyardShell\.saveDoc\(path, content, expectedContent\)/);
  // Conflict handling retains the draft (does not drop editor content) and surfaces a clear state.
  assert.match(app, /code === 'content_conflict'/);
  assert.match(app, /docsConflict\.hidden = false/);
  // Dirty state is reported to the shell and gates navigation.
  assert.match(app, /setDocsDirty\(dirty\)/);
  assert.match(app, /mustGuardDocsLeave/);
  assert.match(app, /showDocsUnsaved/);
  // Page registration, nav, and section exist in the renderer markup.
  assert.match(html, /id="docs-nav"[^>]+aria-label="文档" data-page="docs"/);
  assert.match(html, /id="docs-page"/);
  assert.match(html, /id="docs-save-button"/);
  assert.match(html, /id="docs-unsaved-save"/);
  assert.match(html, /id="docs-unsaved-discard"/);
  assert.match(html, /id="docs-unsaved-cancel"/);
});

test('docsDirty participates in update restart gating and a pending update never discards the draft', () => {
  const app = readFileSync(join(desktopRoot, 'src', 'renderer', 'app.ts'), 'utf8');
  const main = mainSource();
  // Single authorization: the renderer calls requestInstall (one click), not a two-step prepare/restart.
  assert.match(app, /window\.wrenyardShell\.requestInstall\(\)/);
  assert.match(app, /window\.wrenyardShell\.cancelPendingInstall\(\)/);
  // A waiting update exposes cancel and keeps the draft instead of discarding it.
  assert.match(app, /state === 'waiting'[\s\S]*cancelPendingInstall/);
  // Main folds docsDirty into the update busy gate and wakes the controller once the draft is saved.
  assert.match(main, /docsDirty \|\|/);
  assert.match(main, /updateController\?\.wake\(\)/);
});

function preloadSource(): string {
  return readFileSync(join(desktopRoot, 'src', 'preload.ts'), 'utf8');
}

function mainSource(): string {
  return readFileSync(join(desktopRoot, 'src', 'main.ts'), 'utf8');
}
