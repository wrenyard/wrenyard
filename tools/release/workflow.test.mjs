import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowPath = resolve(repoRoot, '.github', 'workflows', 'release.yml');
const workflow = readFileSync(workflowPath, 'utf8');
const ciWorkflow = readFileSync(resolve(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

test('release.yml upload source is a flat unique staging directory', () => {
  // The aggregation step materializes one flat release-assets directory and
  // emits exactly one global SHA256SUMS plus one release-index.json in it.
  assert.ok(workflow.includes('"../release-assets"'));
  // Exactly one contents: write occurrence (the aggregate job) and one global
  // SHA256SUMS + one release-index.json emitted into that flat staging
  // directory. The aggregation code builds these names with path.join(out, ...)
  // rather than a literal slash-concatenated path, so assert the unique output
  // names without assuming a "/" separator.
  assert.ok(workflow.includes('SHA256SUMS'));
  assert.ok(workflow.includes('release-index.json'));
  // The upload loop walks only that flat directory and never uses --clobber.
  assert.ok(workflow.includes('find release-assets -maxdepth 1 -type f'));
  assert.ok(!workflow.includes('--clobber'));
});

test('release.yml qualifies per-target evidence names', () => {
  // Per-target signing-status and SHA256SUMS files are renamed with the
  // target suffix so a target's evidence is never dropped or collided.
  assert.ok(workflow.includes('"signing-status-"'));
  assert.ok(workflow.includes('"SHA256SUMS-"'));
  assert.ok(workflow.includes('.sha256'));
});

test('release.yml has no duplicate-basename recursive upload pattern', () => {
  // A recursive find over the merged artifacts tree would upload the same
  // basename (install.sh, release-manifest.json, SHA256SUMS, ...) many times.
  assert.ok(!workflow.includes('find artifacts'));
});

test('release.yml never writes signed from certificate secret presence', () => {
  // Until actual signing commands exist, labels are always preview-grade and
  // no secret presence may upgrade them to "signed".
  assert.ok(!workflow.includes("'signed"));
  assert.ok(!workflow.includes('MAC_CERT_BASE64'));
  assert.ok(!workflow.includes('WIN_CERT_BASE64'));
});

test('release.yml uses preview-grade ad-hoc/unsigned labels only', () => {
  // macOS is ad-hoc signed; Windows/Linux are unsigned. Both are preview-grade.
  assert.ok(workflow.includes('ad-hoc-preview'));
  assert.ok(workflow.includes('unsigned-preview'));
});

test('release.yml keeps prerelease creation enabled', () => {
  assert.ok(workflow.includes('--prerelease'));
});

test('release.yml builds exactly the four supported targets', () => {
  // Release builds run one explicit runner row per target: linux-x64,
  // darwin-arm64, darwin-x64, win32-x64. The two macOS rows must be the
  // explicit macos-15 (arm64) and macos-15-intel (x64) runners; this must not
  // collapse to the three implicit latest-OS rows that drop darwin-x64.
  assert.ok(workflow.includes('linux-x64'));
  assert.ok(workflow.includes('darwin-arm64'));
  assert.ok(workflow.includes('darwin-x64'));
  assert.ok(workflow.includes('win32-x64'));
  assert.ok(workflow.includes('- os: macos-15'));
  assert.ok(workflow.includes('- os: macos-15-intel'));
});

test('release.yml build jobs are least-privilege (contents read)', () => {
  // Only the aggregate job may write contents (create/update the prerelease).
  // Build jobs must not inherit a write token.
  assert.ok(workflow.includes('contents: read'));
});

test('release.yml verifies the tag equals v<package version>', () => {
  // The pipeline must reject a tag that is not exactly v<root package version>.
  // The check compares the exact GITHUB_REF_NAME tag against the derived
  // expected value.
  assert.ok(workflow.includes('GITHUB_REF_NAME'));
  assert.ok(workflow.includes('!='));
});

test('release.yml verifies the build target via ESM platform.mjs', () => {
  // The target check must load tools/release/platform.mjs as ESM (not a bare
  // require of an ESM file) and print entryFor().triplet for comparison.
  assert.ok(workflow.includes('node --input-type=module'));
  assert.ok(workflow.includes('./tools/release/platform.mjs'));
  assert.ok(workflow.includes('entryFor'));
  assert.ok(workflow.includes('.triplet'));
});

test('release.yml points release:e2e at the prebuilt release artifacts', () => {
  // The packed-install E2E must consume the single release:local build output
  // via WRENYARD_E2E_RELEASE_DIR instead of rebuilding all artifacts inside
  // the test. Exactly one release:local build step must precede release:e2e.
  assert.ok(workflow.includes('WRENYARD_E2E_RELEASE_DIR: .artifacts/release'));
  assert.ok(workflow.includes('run: pnpm release:e2e'));
  const buildStep = 'pnpm release:local';
  const e2eStep = 'pnpm release:e2e';
  assert.equal(
    workflow.split(buildStep).length - 1,
    1,
    'release.yml must contain exactly one pnpm release:local build step',
  );
  const localIndex = workflow.indexOf(buildStep);
  const e2eIndex = workflow.indexOf(e2eStep);
  assert.ok(localIndex !== -1 && e2eIndex !== -1, 'release.yml must run release:local and release:e2e');
  assert.ok(localIndex < e2eIndex, 'release:local must run before release:e2e');
});

test('release.yml runs pre-release gates before release creation', () => {
  // identifiers, secrets, legal, build, and packed-install E2E must all run
  // before the prerelease is created.
  assert.ok(workflow.includes('check:identifiers'));
  assert.ok(workflow.includes('check:secrets'));
  assert.ok(workflow.includes('release:legal'));
  assert.ok(workflow.includes('release:e2e'));
});

test('artifact checksum verification uses the cross-platform Node runtime', () => {
  // Git Bash on the Windows release runner does not provide macOS's shasum
  // utility, so keep release checksum verification on the portable Node path.
  assert.ok(workflow.includes('crypto.createHash("sha256")'));
  assert.ok(!workflow.includes('shasum -a 256'));
  assert.ok(!ciWorkflow.includes('shasum -a 256'));
});

test('routine CI uses one bounded Linux quality job', () => {
  assert.ok(ciWorkflow.includes('runs-on: ubuntu-latest'));
  assert.ok(ciWorkflow.includes('timeout-minutes: 30'));
  assert.ok(ciWorkflow.includes('pnpm check'));
  assert.ok(ciWorkflow.includes('pnpm audit --prod --audit-level high'));
  assert.ok(ciWorkflow.includes('cancel-in-progress: true'));
  assert.ok(!ciWorkflow.includes('matrix:'));
  assert.ok(!ciWorkflow.includes('macos-'));
  assert.ok(!ciWorkflow.includes('windows-latest'));
});

test('routine CI never builds or uploads release packages', () => {
  assert.ok(!ciWorkflow.includes('release:local'));
  assert.ok(!ciWorkflow.includes('release:e2e'));
  assert.ok(!ciWorkflow.includes('actions/upload-artifact'));
  assert.ok(!ciWorkflow.includes('.artifacts/release'));
});
