package grok

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
	"github.com/pelletier/go-toml/v2"
)

func testProjections() []Projection {
	return []Projection{
		ProjectModel("kimi-coding", "https://api.kimi.com/coding/v1", catalog.ModelDef{ID: "k3", DisplayName: "Kimi K3", ContextWindow: 1048576}),
		ProjectModel("zhipu-coding", "https://open.bigmodel.cn/api/coding/paas/v4", catalog.ModelDef{ID: "glm-5.3", DisplayName: "GLM-5.3", ContextWindow: 1048576}),
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readTOML(t *testing.T, path string) map[string]interface{} {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	tree := map[string]interface{}{}
	if err := toml.Unmarshal(data, &tree); err != nil {
		t.Fatalf("parse %s: %v\n%s", path, err, string(data))
	}
	return tree
}

func TestMaterializeUpsertStaleDeletePreserve(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, "config.toml")
	overlay := filepath.Join(home, "overlay.toml")

	// Pre-existing config with non-managed keys, a user custom model, and a
	// stale forge-* model.
	writeFile(t, cfg, `
[models]
default = "old-default"
web_search = "auto"

[model.custom-user]
name = "Custom User"
model = "custom"
base_url = "https://custom.invalid"
env_key = "CUSTOM_API_KEY"
api_backend = "chat_completions"
context_window = 8000

[model.forge-stale--old]
name = "Stale"
model = "old"
base_url = "https://stale.invalid"
env_key = "FORGE_GROK_STALE_API_KEY"
api_backend = "chat_completions"
context_window = 1000
`)

	if err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()}); err != nil {
		t.Fatal(err)
	}

	tree := readTOML(t, cfg)

	// Non-managed models.default preserved.
	models, ok := tree["models"].(map[string]interface{})
	if !ok || models["default"] != "old-default" {
		t.Fatalf("models.default not preserved: %#v", tree["models"])
	}
	if models["web_search"] != "auto" {
		t.Fatalf("models.web_search not preserved: %#v", tree["models"])
	}

	// User custom model preserved.
	modelTable := tree["model"].(map[string]interface{})
	if _, ok := modelTable["custom-user"]; !ok {
		t.Fatalf("user custom model not preserved: %#v", modelTable)
	}

	// Stale forge-* model deleted.
	if _, ok := modelTable["forge-stale--old"]; ok {
		t.Fatalf("stale forge model should be deleted: %#v", modelTable)
	}

	// Current forge-* models upserted with correct fields.
	kimi, ok := modelTable["forge-kimi-coding--k3"].(map[string]interface{})
	if !ok {
		t.Fatalf("forge-kimi-coding--k3 missing: %#v", modelTable)
	}
	if kimi["model"] != "k3" || kimi["base_url"] != "https://api.kimi.com/coding/v1" ||
		kimi["env_key"] != "FORGE_GROK_KIMI_CODING_API_KEY" || kimi["api_backend"] != "chat_completions" ||
		int(kimi["context_window"].(int64)) != 1048576 || kimi["supports_backend_search"] != false {
		t.Fatalf("kimi projection incorrect: %#v", kimi)
	}
	if _, ok := kimi["api_key"]; ok {
		t.Fatalf("api_key must never be written: %#v", kimi)
	}
	if _, ok := kimi["OPENAI_API_KEY"]; ok {
		t.Fatalf("OPENAI_API_KEY must never be written: %#v", kimi)
	}

	// [models].default / web_search must not be written by Forge.
	if _, ok := models["default"]; !ok {
		t.Fatalf("Forge must not delete [models].default: %#v", models)
	}
}

func TestMaterializeRejectsOverlayApiKey(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, "config.toml")
	overlay := filepath.Join(home, "overlay.toml")
	writeFile(t, overlay, "api_key = \"leaked\"\n")
	err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()})
	if err == nil || !strings.Contains(err.Error(), "api_key") {
		t.Fatalf("expected overlay api_key rejection, got %v", err)
	}
	if _, statErr := os.Stat(cfg); statErr == nil {
		t.Fatalf("config must not be written when overlay is invalid")
	}
}

func TestMaterializeRejectsOverlayApiKeyInArrayTable(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, "config.toml")
	overlay := filepath.Join(home, "overlay.toml")
	// api_key nested inside a TOML array-of-tables.
	writeFile(t, overlay, "[[auth.endpoints]]\nurl = \"https://example.com\"\napi_key = \"leaked\"\n")
	err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()})
	if err == nil || !strings.Contains(err.Error(), "api_key") {
		t.Fatalf("expected api_key rejection in array table, got %v", err)
	}
	if _, statErr := os.Stat(cfg); statErr == nil {
		t.Fatalf("config must not be written when overlay has array-table api_key")
	}
}

func TestMaterializeRejectsOverlayForgeModel(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, "config.toml")
	overlay := filepath.Join(home, "overlay.toml")
	writeFile(t, overlay, "[model.forge-kimi-coding--k3]\nname = \"hijack\"\n")
	err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()})
	if err == nil || !strings.Contains(err.Error(), "forge-*") {
		t.Fatalf("expected forge-* model overlay rejection, got %v", err)
	}
}

func TestMaterializeRejectsScalarModelOverlay(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, "config.toml")
	overlay := filepath.Join(home, "overlay.toml")
	// Scalar top-level model would destroy the managed [model] table on merge.
	writeFile(t, overlay, "model = \"not-a-table\"\n")
	err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()})
	if err == nil || !strings.Contains(err.Error(), "must be a TOML table") {
		t.Fatalf("expected scalar model overlay rejection, got %v", err)
	}
	if _, statErr := os.Stat(cfg); statErr == nil {
		t.Fatalf("config must not be written when overlay has scalar model")
	}
}

func TestMaterializePreservesForgeModelsThroughOverlay(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, "config.toml")
	overlay := filepath.Join(home, "overlay.toml")
	// Overlay with a valid [model] section containing only non-forge entries.
	// Forge-* models from projections must survive the merge.
	writeFile(t, overlay, "[model.manual]\nname = \"Manual\"\nmodel = \"custom\"\n")
	if err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()}); err != nil {
		t.Fatal(err)
	}
	tree := readTOML(t, cfg)
	modelTable := tree["model"].(map[string]interface{})
	if _, ok := modelTable["forge-kimi-coding--k3"]; !ok {
		t.Fatalf("forge model must survive overlay merge: %#v", modelTable)
	}
	if _, ok := modelTable["forge-zhipu-coding--glm-5-3"]; !ok {
		t.Fatalf("zhipu forge model must survive overlay merge: %#v", modelTable)
	}
	if _, ok := modelTable["manual"]; !ok {
		t.Fatalf("overlay manual model must be present: %#v", modelTable)
	}
}

func TestMaterializeAppliesOverlayNonManaged(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, "config.toml")
	overlay := filepath.Join(home, "overlay.toml")
	// Overlay sets a non-managed [models].default and a user custom model.
	writeFile(t, overlay, `
[models]
default = "glm-5.3"

[model.user-overlay]
name = "User Overlay"
model = "user"
base_url = "https://user.invalid"
env_key = "USER_API_KEY"
api_backend = "chat_completions"
context_window = 4000
`)
	if err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()}); err != nil {
		t.Fatal(err)
	}
	tree := readTOML(t, cfg)
	models := tree["models"].(map[string]interface{})
	if models["default"] != "glm-5.3" {
		t.Fatalf("overlay [models].default not applied: %#v", models)
	}
	modelTable := tree["model"].(map[string]interface{})
	if _, ok := modelTable["user-overlay"]; !ok {
		t.Fatalf("overlay user model not applied: %#v", modelTable)
	}
	if _, ok := modelTable["forge-kimi-coding--k3"]; !ok {
		t.Fatalf("forge models must remain after overlay merge: %#v", modelTable)
	}
}

func TestMaterializeNoWriteSkipWhenUnchanged(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, "config.toml")
	overlay := filepath.Join(home, "overlay.toml")

	if err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()}); err != nil {
		t.Fatal(err)
	}
	info1, _ := os.Stat(cfg)

	// Second materialize with identical projections must not rewrite (mtime stable).
	if err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()}); err != nil {
		t.Fatal(err)
	}
	info2, _ := os.Stat(cfg)
	if !info1.ModTime().Equal(info2.ModTime()) {
		t.Fatalf("expected no rewrite when content unchanged (mtime changed)")
	}

	// Changing a projection triggers a rewrite.
	changed := testProjections()
	changed[1] = ProjectModel("zhipu-coding", "https://open.bigmodel.cn/api/coding/paas/v4", catalog.ModelDef{ID: "glm-5.3", DisplayName: "GLM-5.3", ContextWindow: 131072})
	if err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: changed}); err != nil {
		t.Fatal(err)
	}
	info3, _ := os.Stat(cfg)
	if info2.ModTime().Equal(info3.ModTime()) {
		t.Fatalf("expected rewrite when projections change (mtime unchanged)")
	}
}

func TestMaterializeConcurrentContention(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, "config.toml")
	overlay := filepath.Join(home, "overlay.toml")

	var wg sync.WaitGroup
	errs := make(chan error, 5)

	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()}); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		t.Fatalf("concurrent materialize failed: %v", err)
	}

	// Config must be valid and contain all projections.
	tree := readTOML(t, cfg)
	modelTable := tree["model"].(map[string]interface{})
	if _, ok := modelTable["forge-kimi-coding--k3"]; !ok {
		t.Fatalf("concurrent materialize must produce forge-kimi-coding--k3: %#v", modelTable)
	}
	if _, ok := modelTable["forge-zhipu-coding--glm-5-3"]; !ok {
		t.Fatalf("concurrent materialize must produce forge-zhipu-coding--glm-5-3: %#v", modelTable)
	}
}

func TestMaterializeWritesManagedModelDefaults(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, "config.toml")
	overlay := filepath.Join(home, "overlay.toml")

	if err := Materialize(MaterializeInput{
		ConfigPath:          cfg,
		OverlayPath:         overlay,
		Projections:         testProjections(),
		DefaultModel:        DefaultModelID,
		SessionSummaryModel: DefaultSessionSummaryModel,
	}); err != nil {
		t.Fatal(err)
	}
	tree := readTOML(t, cfg)
	models, ok := tree["models"].(map[string]interface{})
	if !ok {
		t.Fatalf("models table missing: %#v", tree)
	}
	if models["default"] != DefaultModelID {
		t.Fatalf("models.default not written: %#v", models)
	}
	if models["session_summary"] != DefaultSessionSummaryModel {
		t.Fatalf("models.session_summary not written: %#v", models)
	}
}

func TestMaterializeOverlayOverridesManagedSessionSummary(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, "config.toml")
	overlay := filepath.Join(home, "overlay.toml")
	writeFile(t, overlay, "[models]\nsession_summary = \"overlay-model\"\n")

	if err := Materialize(MaterializeInput{
		ConfigPath:          cfg,
		OverlayPath:         overlay,
		Projections:         testProjections(),
		DefaultModel:        DefaultModelID,
		SessionSummaryModel: DefaultSessionSummaryModel,
	}); err != nil {
		t.Fatal(err)
	}
	tree := readTOML(t, cfg)
	models := tree["models"].(map[string]interface{})
	if models["session_summary"] != "overlay-model" {
		t.Fatalf("overlay must win for session_summary: %#v", models)
	}
	// default has no overlay value, so the input field must be used.
	if models["default"] != DefaultModelID {
		t.Fatalf("models.default should come from input: %#v", models)
	}
}

func TestMaterializeEmptyManagedModelDefaultsSkipped(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, "config.toml")
	overlay := filepath.Join(home, "overlay.toml")

	if err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()}); err != nil {
		t.Fatal(err)
	}
	tree := readTOML(t, cfg)
	if models, ok := tree["models"].(map[string]interface{}); ok {
		if _, hasDefault := models["default"]; hasDefault {
			t.Fatalf("models.default must not be added when input is empty: %#v", models)
		}
		if _, hasSummary := models["session_summary"]; hasSummary {
			t.Fatalf("models.session_summary must not be added when input is empty: %#v", models)
		}
	}
}

func TestCheckOverlay(t *testing.T) {
	home := t.TempDir()
	overlay := filepath.Join(home, "overlay.toml")

	// Absent overlay is valid.
	if err := CheckOverlay(overlay); err != nil {
		t.Fatalf("absent overlay should be valid: %v", err)
	}
	// Invalid TOML.
	writeFile(t, overlay, "this is = = not toml\n")
	if err := CheckOverlay(overlay); err == nil {
		t.Fatalf("invalid TOML overlay should error")
	}
	// api_key nested.
	writeFile(t, overlay, "[models]\ndefault = \"x\"\n[auth]\napi_key = \"y\"\n")
	if err := CheckOverlay(overlay); err == nil || !strings.Contains(err.Error(), "api_key") {
		t.Fatalf("nested api_key should be rejected: %v", err)
	}
	// Valid overlay.
	writeFile(t, overlay, "[models]\ndefault = \"x\"\n")
	if err := CheckOverlay(overlay); err != nil {
		t.Fatalf("valid overlay should pass: %v", err)
	}
}

func TestBuildPlanDoesNotLeakSecrets(t *testing.T) {
	// resolve returns a fake secret value; BuildPlan must never surface it.
	resolve := func(string) (string, bool) { return "SUPER_SECRET_TOKEN", true }
	plan := BuildPlan(catalog.DefaultRegistry(), resolve)
	for _, p := range plan.Projections {
		if strings.Contains(p.EnvKey, "SUPER_SECRET_TOKEN") {
			t.Fatalf("env key leaked secret: %s", p.EnvKey)
		}
	}
	// Verify no projection/credential value is carried on the plan struct.
	if plan.OverlayValid != nil {
		if strings.Contains(plan.OverlayValid.Error(), "SUPER_SECRET_TOKEN") {
			t.Fatalf("overlay error leaked secret")
		}
	}
}

func TestValidateConfig(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "config.toml")

	// Absent config is valid.
	if err := ValidateConfig(path); err != nil {
		t.Fatalf("absent config should be valid: %v", err)
	}
	// Valid TOML.
	writeFile(t, path, "[model.test]\nname = \"test\"\n")
	if err := ValidateConfig(path); err != nil {
		t.Fatalf("valid config should pass: %v", err)
	}
	// Invalid TOML.
	writeFile(t, path, "this is = = not toml\n")
	if err := ValidateConfig(path); err == nil {
		t.Fatalf("invalid config should error")
	}
	// Empty file is valid (treated as empty map).
	writeFile(t, path, "")
	if err := ValidateConfig(path); err != nil {
		t.Fatalf("empty config should be valid: %v", err)
	}
}

func TestMaterializeLockContention(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, "config.toml")
	overlay := filepath.Join(home, "overlay.toml")
	lockPath := filepath.Join(home, "materialize.lock")

	// Pre-acquire the canonical lock as a competitor.
	held, err := acquireMaterializeLock(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Release()

	// Materialize must wait and succeed after Release.
	released := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		<-released
		err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()})
		done <- err
	}()
	time.Sleep(100 * time.Millisecond)
	close(released)
	held.Release()

	if err := <-done; err != nil {
		t.Fatalf("materialize should succeed after lock release: %v", err)
	}
	tree := readTOML(t, cfg)
	if _, ok := tree["model"].(map[string]interface{}); !ok {
		t.Fatalf("config should have been written after lock contention")
	}
}

func TestMaterializeCrashedOwnerReclaim(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, "config.toml")
	overlay := filepath.Join(home, "overlay.toml")
	lockPath := filepath.Join(home, "materialize.lock")

	// Create a lockfile owned by a process whose death is verified.
	if err := writeNativeSessionLockOwner(lockPath, nativeSessionLockOwner{PID: exitedProcessPID(t), Nonce: "0123456789abcdef"}); err != nil {
		t.Fatal(err)
	}

	// Materialize should reclaim the crashed owner and succeed.
	if err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()}); err != nil {
		t.Fatalf("materialize should reclaim crashed owner: %v", err)
	}

	// The lockfile should have been released after materialize.
	if _, err := os.Stat(lockPath); err == nil {
		t.Fatal("lockfile should be removed after materialize release")
	}
}

func TestMaterializeConfigApiKeyTopLevel(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, "config.toml")
	overlay := filepath.Join(home, "overlay.toml")

	original := "api_key = \"secret\"\n"
	writeFile(t, cfg, original)

	// Assert original bytes and mtime before Materialize.
	origInfo, _ := os.Stat(cfg)
	origBytes, _ := os.ReadFile(cfg)

	err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()})
	if err == nil || !strings.Contains(err.Error(), "api_key") || strings.Contains(err.Error(), "secret") {
		t.Fatalf("expected redacted api_key error without value leak, got: %v", err)
	}

	// Original data must remain unchanged.
	info2, _ := os.Stat(cfg)
	if !origInfo.ModTime().Equal(info2.ModTime()) {
		t.Fatal("config mtime must not change when api_key exists")
	}
	currentBytes, _ := os.ReadFile(cfg)
	if string(currentBytes) != string(origBytes) {
		t.Fatalf("config bytes must not change: got %q, want %q", string(currentBytes), string(origBytes))
	}
}

func TestMaterializeConfigApiKeyNested(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, "config.toml")
	overlay := filepath.Join(home, "overlay.toml")

	writeFile(t, cfg, "[auth]\napi_key = \"nested-secret\"\n[models]\ndefault = \"x\"\n")
	origInfo, _ := os.Stat(cfg)
	origBytes, _ := os.ReadFile(cfg)

	err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()})
	if err == nil || !strings.Contains(err.Error(), "api_key") || strings.Contains(err.Error(), "nested-secret") {
		t.Fatalf("expected redacted api_key error for nested: %v", err)
	}

	info2, _ := os.Stat(cfg)
	if !origInfo.ModTime().Equal(info2.ModTime()) {
		t.Fatal("config mtime must not change")
	}
	currentBytes, _ := os.ReadFile(cfg)
	if string(currentBytes) != string(origBytes) {
		t.Fatal("config bytes must not change")
	}
}

func TestMaterializeConfigApiKeyArrayOfTables(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, "config.toml")
	overlay := filepath.Join(home, "overlay.toml")

	writeFile(t, cfg, "[[endpoints]]\nurl = \"https://example.com\"\napi_key = \"arr-secret\"\n")
	origInfo, _ := os.Stat(cfg)
	origBytes, _ := os.ReadFile(cfg)

	err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()})
	if err == nil || !strings.Contains(err.Error(), "api_key") {
		t.Fatalf("expected api_key rejection in array of tables: %v", err)
	}
	info2, _ := os.Stat(cfg)
	if !origInfo.ModTime().Equal(info2.ModTime()) {
		t.Fatal("config mtime must not change")
	}
	currentBytes, _ := os.ReadFile(cfg)
	if string(currentBytes) != string(origBytes) {
		t.Fatal("config bytes must not change")
	}
}

func TestMaterializeConfigApiKeyNestedArray(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, "config.toml")
	overlay := filepath.Join(home, "overlay.toml")

	writeFile(t, cfg, "[items]\nlist = [{name = \"a\", api_key = \"nested-arr-val\"}]\n")
	origInfo, _ := os.Stat(cfg)
	origBytes, _ := os.ReadFile(cfg)

	err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()})
	if err == nil || !strings.Contains(err.Error(), "api_key") {
		t.Fatalf("expected api_key rejection in nested array: %v", err)
	}
	info2, _ := os.Stat(cfg)
	if !origInfo.ModTime().Equal(info2.ModTime()) {
		t.Fatal("config mtime must not change")
	}
	currentBytes, _ := os.ReadFile(cfg)
	if string(currentBytes) != string(origBytes) {
		t.Fatal("config bytes must not change")
	}
}

func TestMaterializeConfigApiKeyDottedTable(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, "config.toml")
	overlay := filepath.Join(home, "overlay.toml")

	// TOML dotted table with inline table that has Api_Key (case-insensitive).
	writeFile(t, cfg, "[server]\nendpoint = {url = \"x\", Api_Key = \"inline-secret\"}\n")
	origInfo, _ := os.Stat(cfg)
	origBytes, _ := os.ReadFile(cfg)

	err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()})
	if err == nil || !strings.Contains(err.Error(), "api_key") {
		t.Fatalf("expected api_key rejection in inline table: %v", err)
	}
	info2, _ := os.Stat(cfg)
	if !origInfo.ModTime().Equal(info2.ModTime()) {
		t.Fatal("config mtime must not change")
	}
	currentBytes, _ := os.ReadFile(cfg)
	if string(currentBytes) != string(origBytes) {
		t.Fatal("config bytes must not change")
	}
}

func TestMaterializeValidateOverlayApiKey(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, "config.toml")
	overlay := filepath.Join(home, "overlay.toml")

	// Valid config + overlay with api_key.
	writeFile(t, cfg, "[models]\ndefault = \"x\"\n")
	writeFile(t, overlay, "api_key = \"overlay-leak\"\n")
	origInfo, _ := os.Stat(cfg)

	err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()})
	if err == nil || !strings.Contains(err.Error(), "api_key") || strings.Contains(err.Error(), "overlay-leak") {
		t.Fatalf("expected redacted api_key error for overlay: %v", err)
	}
	// Config must not be written when overlay is invalid.
	info2, _ := os.Stat(cfg)
	if !origInfo.ModTime().Equal(info2.ModTime()) {
		t.Fatal("config must not change when overlay is invalid")
	}
}

func TestMaterializeLockReleasedOnValidationFailure(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, "config.toml")
	overlay := filepath.Join(home, "overlay.toml")

	writeFile(t, cfg, "api_key = \"bad\"\n")
	lockPath := filepath.Join(home, "materialize.lock")

	// First Materialize fails due to api_key in config.
	err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()})
	if err == nil {
		t.Fatal("expected error for api_key in config")
	}

	// Lock must be released after failure.
	lock, err := acquireMaterializeLock(lockPath)
	if err != nil {
		t.Fatalf("lock should be free after failed materialize: %v", err)
	}
	lock.Release()

	// Remove api_key and retry should succeed.
	writeFile(t, cfg, "[models]\ndefault = \"x\"\n")
	if err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()}); err != nil {
		t.Fatalf("materialize should succeed after removing api_key from config: %v", err)
	}
}

func TestValidateConfigRejectsApiKey(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "config.toml")

	writeFile(t, path, "[auth]\napi_key = \"secret\"\n[models]\ndefault = \"x\"\n")
	err := ValidateConfig(path)
	if err == nil || !strings.Contains(err.Error(), "api_key") || strings.Contains(err.Error(), "secret") {
		t.Fatalf("ValidateConfig must reject api_key with redacted error: %v", err)
	}
	// File must not be modified.
	info, _ := os.Stat(path)
	if info.Size() == 0 {
		t.Fatal("config file must remain unchanged")
	}
}

func TestValidateConfigValidNonForgeNested(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "config.toml")

	writeFile(t, path, "[model]\nforge-kimi = {name = \"Kimi\", model = \"k3\", base_url = \"https://kimi\", env_key = \"K\"}\n[custom]\nmodel = \"not-a-table\"\n[[arrays]]\nid = 1\n")
	if err := ValidateConfig(path); err != nil {
		t.Fatalf("valid config with non-forge nested model should pass: %v", err)
	}
}

func TestMaterializeOverlayOwnershipScope(t *testing.T) {
	home := t.TempDir()
	cfg := filepath.Join(home, "config.toml")
	overlay := filepath.Join(home, "overlay.toml")

	// Overlay with forge-* at top-level model must be rejected.
	writeFile(t, overlay, "[model.forge-kimi-coding--k3]\nname = \"hijack\"\n")
	err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()})
	if err == nil || !strings.Contains(err.Error(), "forge-*") {
		t.Fatalf("expected forge-* model overlay rejection: %v", err)
	}
	if _, statErr := os.Stat(cfg); statErr == nil {
		t.Fatalf("config must not be written when overlay has forge-* model")
	}

	// Overlay with non-table top-level model must be rejected.
	writeFile(t, overlay, "model = \"scalar\"\n")
	err = Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()})
	if err == nil || !strings.Contains(err.Error(), "must be a TOML table") {
		t.Fatalf("expected scalar model rejection: %v", err)
	}

	// Overlay with forge-* in a non-top-level model (nested model key unrelated to managed)
	// must NOT be rejected — ownership scope is only the top-level [model] table.
	writeFile(t, overlay, "[custom]\nmodel = {forge-x = \"y\"}\n")
	if err := Materialize(MaterializeInput{ConfigPath: cfg, OverlayPath: overlay, Projections: testProjections()}); err != nil {
		t.Fatalf("overlay with forge-* in nested model must be allowed: %v", err)
	}
}
