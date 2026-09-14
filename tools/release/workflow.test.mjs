import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowPath = resolve(repoRoot, '.github', 'workflows', 'release.yml');
const workflow = readFileSync(workflowPath, 'utf8');
const ciWorkflow = readFileSync(resolve(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

test('release.yml publishes exactly the four suite and Desktop archives', () => {
  assert.ok(workflow.includes('for target in darwin-arm64 win32-x64'));
  assert.ok(workflow.includes('wrenyard-$version-$target-suite.zip'));
  assert.ok(workflow.includes('wrenyard-desktop-$version-$target.zip'));
  assert.ok(workflow.includes('expected_count=4'));
  assert.ok(workflow.includes('find release-assets -maxdepth 1 -type f'));
  assert.ok(!workflow.includes('--clobber'));
  assert.ok(!workflow.includes('release-index.json'));
  assert.ok(!workflow.includes('path.join(out'));
});

test('release.yml has no dev21 legacy special case', () => {
  assert.ok(!workflow.includes('1.0.0-dev.21'));
  assert.ok(!workflow.includes('expected_count=8'));
  assert.ok(!workflow.includes('cp "$suite.sha256" "$desktop.sha256" release-assets/'));
  assert.ok(!workflow.includes('migration sidecars'));
});

test('release.yml keeps build evidence internal and verifies it before selection', () => {
  assert.ok(workflow.includes("find artifacts -type f -name '*.sha256'"));
  assert.ok(workflow.includes('crypto.createHash("sha256")'));
  assert.ok(workflow.includes('transient CI evidence'));
  assert.ok(!workflow.includes('cp "$source_dir/install.sh"'));
  assert.ok(!workflow.includes('cp "$source_dir/install.ps1"'));
});

test('release.yml never writes signed from certificate secret presence', () => {
  // Until actual signing commands exist, labels are always preview-grade and
  // no secret presence may upgrade them to "signed".
  assert.ok(!workflow.includes("'signed"));
  assert.ok(!workflow.includes('MAC_CERT_BASE64'));
  assert.ok(!workflow.includes('WIN_CERT_BASE64'));
});

test('workflow_dispatch runs preflight without publishing', () => {
  // Manual dispatch is the preflight path: it validates the real packages but
  // must never create a tag or a release.
  assert.ok(/^  workflow_dispatch:/m.test(workflow));
  assert.ok(workflow.includes("if: github.event_name == 'push'"));
  assert.ok(!workflow.includes('gh release delete'));
});

test('release.yml keeps the tag-version check on tag push only', () => {
  // The guard compares GITHUB_REF_NAME against v<package version> and is
  // limited to the push event, since a manual dispatch has no tag.
  assert.ok(workflow.includes('GITHUB_REF_NAME'));
  assert.ok(workflow.includes('!='));
  assert.ok(workflow.includes('if: github.event_name == \'push\''));
});

test('release.yml uses preview-grade ad-hoc/unsigned labels only', () => {
  // macOS is ad-hoc signed; Windows is unsigned. Both are preview-grade.
  assert.ok(workflow.includes('ad-hoc-preview'));
  assert.ok(workflow.includes('unsigned-preview'));
});

test('release.yml keeps prerelease creation enabled', () => {
  assert.ok(workflow.includes('--prerelease'));
});

test('release.yml stages a draft and only publishes after a complete upload', () => {
  // The draft release is created first, every public archive is uploaded to
  // it, and only then is the draft flipped to a published prerelease.
  assert.ok(workflow.includes('--draft'));
  assert.ok(workflow.includes('gh release create "$TAG"'));
  assert.ok(workflow.includes('gh release upload "$TAG"'));
  assert.ok(workflow.includes('gh release edit "$TAG" --draft=false --prerelease'));
});

test('release.yml never deletes or overwrites an existing published release', () => {
  // A tag that already has a release must fail safely rather than being
  // deleted and recreated.
  assert.ok(!workflow.includes('gh release delete'));
  assert.ok(workflow.includes('if gh release view "$TAG"'));
  assert.ok(workflow.includes('refusing to delete or overwrite it'));
});

test('release.yml builds exactly the two maintained targets', () => {
  assert.ok(workflow.includes('darwin-arm64'));
  assert.ok(workflow.includes('win32-x64'));
  assert.ok(workflow.includes('- os: macos-15'));
  assert.ok(workflow.includes('- os: windows-latest'));
  assert.ok(!workflow.includes('linux-x64'));
  assert.ok(!workflow.includes('darwin-x64'));
  assert.ok(!workflow.includes('macos-15-intel'));
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
  assert.ok(workflow.includes('Validate tag matches the root package version'));
});

test('release.yml verifies the build target via ESM platform.mjs', () => {
  // The target check must load tools/release/platform.mjs as ESM (not a bare
  // require of an ESM file) and print entryFor().triplet for comparison.
  assert.ok(workflow.includes('node --input-type=module'));
  assert.ok(workflow.includes('./tools/release/platform.mjs'));
  assert.ok(workflow.includes('entryFor'));
  assert.ok(workflow.includes('.triplet'));
});

test('release.yml runs required native checks, Desktop smoke and packed-install E2E', () => {
  // Publish must assemble one release:local tree, verify its manifests and
  // checksums, smoke the Desktop build, then run the packed-install release
  // E2E against the staged release directory before anything is published.
  assert.ok(workflow.includes('run: pnpm check'));
  assert.ok(!workflow.includes('run: pnpm build'));
  assert.ok(workflow.includes('pnpm audit --prod --audit-level high'));
  assert.ok(workflow.includes('run: pnpm desktop:smoke'));
  assert.ok(workflow.includes('run: pnpm release:local'));
  assert.ok(workflow.includes('run: pnpm release:e2e'));
  assert.ok(workflow.includes('WRENYARD_E2E_RELEASE_DIR: ${{ github.workspace }}/.artifacts/release'));
  assert.ok(workflow.includes('node tools/release/verify-manifest.mjs'));
  assert.equal(
    workflow.split('pnpm release:local').length - 1,
    1,
    'release.yml must contain exactly one pnpm release:local build step',
  );
});

test('release.yml runs packaging gates before release creation', () => {
  // identifiers, secrets, legal, the native check, audit, release:local,
  // Desktop smoke and release:e2e must all run before the draft is created.
  assert.ok(workflow.includes('check:identifiers'));
  assert.ok(workflow.includes('check:secrets'));
  assert.ok(workflow.includes('release:legal'));
  assert.ok(workflow.includes('run: pnpm check'));
  assert.ok(workflow.includes('pnpm audit --prod --audit-level high'));
  assert.ok(workflow.includes('pnpm desktop:smoke'));
  assert.ok(workflow.includes('pnpm release:local'));
  assert.ok(workflow.includes('pnpm release:e2e'));
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
  assert.ok(!ciWorkflow.includes('run: pnpm release:e2e'));
  assert.ok(!ciWorkflow.includes('actions/upload-artifact'));
  assert.ok(!ciWorkflow.includes('.artifacts/release'));
});

test('release hop artifacts are short-lived and deleted after staging/publication', () => {
  // Actions artifacts are only a job-to-job hop. Durable product is the
  // GitHub Release. Free-org included artifact storage is 500 MB and is
  // shared with Packages; the two large platform packs must not linger, and a
  // successful manual preflight must clean them up too.
  assert.ok(workflow.includes('retention-days: 1'));
  assert.ok(!workflow.includes('retention-days: 7'));
  assert.ok(workflow.includes('actions: write'));
  assert.ok(workflow.includes(`actions/runs/\${GITHUB_RUN_ID}/artifacts`));
  assert.ok(workflow.includes('actions/artifacts/${id}'));
  assert.ok(workflow.includes('Drop hop artifacts after staging/publication'));
});

test('release.yml does not write tag-scoped dependency caches', () => {
  // setup-node/setup-go caches are stored per ref. Each v1.0.0-dev.* tag
  // otherwise leaves ~1.5 GB that is never reused by a later tag.
  assert.ok(!workflow.includes('cache: pnpm'));
  assert.ok(workflow.includes('cache: false'));
});

test('release.yml publishes the static update feed only after a successful release', () => {
  // The feed is written to a dedicated metadata branch, never to the product
  // branch, and only once the draft has been flipped to a published prerelease
  // so a manifest never points at a draft or a partial upload.
  assert.ok(workflow.includes('Publish static update feed on the updates branch'));
  assert.ok(workflow.includes('tools/release/update-feed.mjs'));
  assert.ok(workflow.includes('git push origin HEAD:updates'));
  assert.ok(workflow.includes('git fetch --depth 1 origin updates'));
  assert.ok(workflow.includes('git checkout -q --orphan updates'));
  // Metadata only: no product source or binary assets on the feed branch.
  assert.ok(workflow.includes('release-assets'));
  // Ordering: feed publication follows the draft->published flip.
  assert.ok(
    workflow.indexOf('gh release edit "$TAG" --draft=false --prerelease') <
      workflow.indexOf('Publish static update feed on the updates branch'),
    'the update feed must be published after the release is published',
  );
});

test('release.yml update feed publication is conflict-safe and credential-free', () => {
  // Concurrent releases are serialized by normal pushes and a bounded
  // fetch/reset/regenerate retry, never a force push and never a rebase of
  // conflicting channel pointers. The temp publication repo inherits the
  // checkout credentials via include.path rather than a token in a URL.
  assert.ok(workflow.includes('for attempt in 1 2 3 4 5'));
  assert.ok(workflow.includes('git reset --hard FETCH_HEAD'));
  assert.ok(!workflow.includes('git rebase'));
  assert.ok(!workflow.includes('git push --force'));
  assert.ok(!workflow.includes('push --force'));
  assert.ok(!workflow.includes('git push -f'));
  assert.ok(workflow.includes('git config include.path "$GITHUB_WORKSPACE/.git/config"'));
  assert.ok(!/\$\{\{\s*secrets\./.test(workflow.split('Publish static update feed on the updates branch')[1].split('Drop hop artifacts')[0].replace("GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}", '')));
  assert.ok(!/https:\/\/[^"'\s]*\$\{\{\s*secrets\./.test(workflow));
});

test('release.yml distinguishes a missing updates branch from transport failures', () => {
  // ls-remote --exit-code --heads returns 2 only when the branch is absent;
  // every other failure is a transport/auth error and must fail closed rather
  // than silently creating a second orphan branch.
  assert.ok(workflow.includes('git ls-remote --exit-code --heads origin updates'));
  assert.ok(workflow.includes('branch_status=$?'));
  const feed = workflow.slice(
    workflow.indexOf('Publish static update feed on the updates branch'),
    workflow.indexOf('Drop hop artifacts'),
  );
  assert.ok(feed.includes('refusing to publish a feed'));
});

test('release.yml feed generation failure cannot become a nothing-to-publish success', () => {
  // publish_feed ran inside an errexit-disabled if-condition, so a node or git
  // failure was reported as "nothing to publish" and the step exited 0. The
  // generation/stage/commit now runs at top level under errexit.
  const feed = workflow.slice(
    workflow.indexOf('Publish static update feed on the updates branch'),
    workflow.indexOf('Drop hop artifacts'),
  );
  assert.ok(!workflow.includes('publish_feed'));
  assert.ok(!feed.includes('nothing to publish for $VERSION'));
  assert.ok(feed.includes('node "$GITHUB_WORKSPACE/tools/release/update-feed.mjs"'));
  assert.ok(feed.includes('git commit -q -m "chore(updates): publish $VERSION feed"'));
  assert.ok(feed.includes('update feed already current for $VERSION'));
});

test('release.yml pins the published-at timestamp and its release lookup', () => {
  // The timestamp comes from the already-published release so retries stay
  // deterministic, and the lookup names its repository explicitly.
  const feed = workflow.slice(
    workflow.indexOf('Publish static update feed on the updates branch'),
    workflow.indexOf('Drop hop artifacts'),
  );
  assert.ok(feed.includes('gh release view "$TAG" -R "$GITHUB_REPOSITORY" --json publishedAt'));
  assert.ok(feed.includes('--published-at "$PUBLISHED_AT"'));
});

test('release.yml validates feed generation on workflow_dispatch without publishing', () => {
  // The manual preflight exercises the real generator against the real staged
  // archives into a temporary directory, but must never publish a feed.
  assert.ok(workflow.includes('Validate static update feed generation (preflight only)'));
  assert.ok(workflow.includes('updates-preflight'));
  assert.ok(workflow.includes("github.event_name == 'push'"));
  const preflight = workflow.slice(
    workflow.indexOf('Validate static update feed generation (preflight only)'),
    workflow.indexOf('Create draft prerelease and upload all public archives'),
  );
  assert.ok(preflight.includes('tools/release/update-feed.mjs'));
  assert.ok(!preflight.includes('git push'));
});
