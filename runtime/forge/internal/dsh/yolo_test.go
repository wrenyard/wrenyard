package dsh

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// yoloHarness exercises the embedded plugin source through the installed Node
// runtime. It appends a restrictive sandbox/mode + approval/policy pair after
// the normalization pass, then reports the effective fold values and the
// resolver's forced mode. The script prints one "key=value" line per fact so the
// assertion stays structural rather than depending on formatting.
const yoloHarness = `
import { pathToFileURL } from 'node:url';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = process.env.YOLO_SOURCE;
const dir = mkdtempSync(join(tmpdir(), 'yolo-'));
const modPath = join(dir, 'plugin.mjs');
writeFileSync(modPath, source);
const plugin = await import(pathToFileURL(modPath).href);

function effective(events, type, field) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && event.type === type && event.data && typeof event.data === 'object') {
      return event.data[field];
    }
  }
  return undefined;
}

// Session double mirroring the installed append contract.
const session = {
  events: [],
  append(type, data, ...opts) {
    const event = { type, data, ...(opts[0] ?? {}) };
    this.events.push(event);
    return event;
  },
};
session.append('sandbox/mode', { mode: 'read-only' });
session.append('approval/policy', { policy: 'ask' });

plugin.normalizeSession(session);
session.append('sandbox/mode', { mode: 'read-only' });
session.append('approval/policy', { policy: 'ask' });

const service = {
  resolve(request = {}) {
    return { mode: request.mode ?? 'read-only', workspaceRoot: '/fallback-root', sessionId: 'abc', extra: 7 };
  },
};
plugin.wrapPolicyResolver(service);

console.log('mode=' + effective(session.events, 'sandbox/mode', 'mode'));
console.log('policy=' + effective(session.events, 'approval/policy', 'policy'));
console.log('seedMode=' + session.events[0].data.mode);
const resolved = service.resolve({ mode: 'read-only' });
console.log('resolvedMode=' + resolved.mode);
console.log('resolvedRoot=' + resolved.workspaceRoot);
console.log('resolvedSession=' + resolved.sessionId);
console.log('resolvedExtra=' + resolved.extra);
`

func runYoloHarness(t *testing.T) map[string]string {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node runtime not available")
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "harness.mjs")
	if err := os.WriteFile(script, []byte(yoloHarness), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(node, script)
	cmd.Env = append(os.Environ(), "YOLO_SOURCE="+YoloPluginSource)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("yolo harness failed: %v\n%s", err, output)
	}
	facts := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if ok {
			facts[key] = value
		}
	}
	return facts
}

// TestYoloPluginSourceNeutralizesRestrictions loads the embedded plugin source
// and proves that restrictive writes after normalization cannot restore a
// restriction, while seed history, workspace metadata, and extra resolved
// fields survive.
func TestYoloPluginSourceNeutralizesRestrictions(t *testing.T) {
	facts := runYoloHarness(t)
	for key, want := range map[string]string{
		"mode":            "danger-full-access",
		"policy":          "never",
		"seedMode":        "read-only",
		"resolvedMode":    "danger-full-access",
		"resolvedRoot":    "/fallback-root",
		"resolvedSession": "abc",
		"resolvedExtra":   "7",
	} {
		if got := facts[key]; got != want {
			t.Fatalf("yolo fact %s=%q want %q", key, got, want)
		}
	}
}

// TestYoloPluginSourceHasNoTemplateLiteralBacktick guards the Go raw string
// literal: a backtick inside the plugin body would silently truncate it.
func TestYoloPluginSourceHasNoTemplateLiteralBacktick(t *testing.T) {
	if strings.Contains(YoloPluginSource, "`") {
		t.Fatal("YoloPluginSource must not contain a backtick")
	}
	if !strings.Contains(YoloPluginSource, "export const name = '"+YoloPluginName+"';") {
		t.Fatalf("embedded plugin must keep the %q plugin name", YoloPluginName)
	}
	if !strings.Contains(YoloPluginSource, "export default { name, inject, apply };") {
		t.Fatal("embedded plugin must keep its default export")
	}
}

// stripBlockComments removes /* ... */ blocks and // line comments so a parity
// comparison ignores documentation that does not affect plugin behavior.
func stripBlockComments(source string) string {
	var out strings.Builder
	for i := 0; i < len(source); {
		if strings.HasPrefix(source[i:], "/*") {
			end := strings.Index(source[i+2:], "*/")
			if end < 0 {
				break
			}
			i += 2 + end + 2
			continue
		}
		if strings.HasPrefix(source[i:], "//") {
			end := strings.IndexByte(source[i:], '\n')
			if end < 0 {
				break
			}
			out.WriteByte('\n')
			i += end
			continue
		}
		out.WriteByte(source[i])
		i++
	}
	return out.String()
}

// TestYoloPluginSourceMatchesShippedBundle keeps the embedded CLI plugin and the
// Desktop-shipped package plugin identical. Both carry the same exported
// functions; only the plugin name, the error prefix, and the symbol registry
// namespace may differ. Any divergence would let the CLI runtime and Desktop
// enforce different effective modes.
func TestYoloPluginSourceMatchesShippedBundle(t *testing.T) {
	shipped, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "packages", "dsh-shell", "src", "yolo-mode.mjs"))
	if err != nil {
		t.Skipf("shipped dsh-shell plugin not reachable: %v", err)
	}
	for _, marker := range []string{
		"export function normalizeSession(session) {",
		"export function wrapSessionAppend(session) {",
		"export function wrapPolicyResolver(service) {",
		"export function apply(ctx) {",
		"export default { name, inject, apply };",
	} {
		if !strings.Contains(string(shipped), marker) {
			t.Fatalf("shipped yolo-mode.mjs missing marker %q", marker)
		}
		if !strings.Contains(YoloPluginSource, marker) {
			t.Fatalf("embedded YoloPluginSource missing marker %q", marker)
		}
	}
	normalize := func(source string) string {
		// Comments are not behavior, and the embedded copy cannot carry a
		// backtick-bearing JSDoc comment inside its Go raw string literal.
		source = stripBlockComments(source)
		source = strings.ReplaceAll(source, "wrenyard-yolo-mode", "PLUGIN")
		source = strings.ReplaceAll(source, YoloPluginName, "PLUGIN")
		source = strings.ReplaceAll(source, "Wrenyard: DSH", "ERR")
		source = strings.ReplaceAll(source, "forge dsh yolo:", "ERR")
		source = strings.ReplaceAll(source, "wrenyard.dsh.yolo", "SYM")
		source = strings.ReplaceAll(source, "forge.dsh.yolo", "SYM")
		return strings.Join(strings.Fields(source), " ")
	}
	body := func(source string) string {
		start := strings.Index(source, "export function normalizeSession(session) {")
		end := strings.Index(source, "export default { name, inject, apply };")
		if start < 0 || end < 0 || end < start {
			return ""
		}
		return source[start : end+len("export default { name, inject, apply };")]
	}
	embedded := normalize(body(YoloPluginSource))
	shippedBody := normalize(body(string(shipped)))
	if embedded == "" || shippedBody == "" {
		t.Fatal("could not extract comparable plugin bodies")
	}
	if embedded != shippedBody {
		t.Fatalf("embedded and shipped yolo plugin bodies diverged:\nembedded: %s\nshipped:  %s", embedded, shippedBody)
	}
}
