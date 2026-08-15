package grok

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pelletier/go-toml/v2"
)

// DefaultModelID is the Forge-managed default for [models].default used by
// grok for interactive chat. It must match a projected model id (or be
// replaced by the first projection in grokExecCommand).
const DefaultModelID = "forge-zhipu-coding--glm-5-3"

// DefaultSessionSummaryModel is the Forge-managed default for
// [models].session_summary used by grok for session title generation. It must
// match a projected model id (or be replaced by the first projection in
// grokExecCommand).
const DefaultSessionSummaryModel = "forge-zhipu-coding--glm-5-3"

// MaterializeInput is the input to Materialize.
type MaterializeInput struct {
	// ConfigPath is the GROK_HOME/config.toml path to materialize.
	ConfigPath string
	// OverlayPath is the optional overlay.toml; absence is tolerated.
	OverlayPath string
	// Projections are the current eligible Forge projections.
	Projections []Projection
	// DefaultModel is the [models].default value to write when the overlay
	// does not provide one. Empty means no value is written from Forge.
	DefaultModel string
	// SessionSummaryModel is the [models].session_summary value to write when
	// the overlay does not provide one. Empty means no value is written from
	// Forge.
	SessionSummaryModel string
}

// Materialize incrementally merges the Grok config at ConfigPath:
//
//   - It preserves every non-managed key and every non-forge-* model entry.
//   - It upserts the current forge-* model entries from projections.
//   - It deletes stale forge-* model entries no longer projected.
//   - It recursively applies the optional overlay to non-managed keys only,
//     rejecting any overlay that defines an api_key (at any depth), attempts
//     to define/overwrite a forge-* model, or has a top-level model that is
//     not a TOML table.
//
// A Grok-owned cross-process lock guards the complete materialization. Live
// owners are never reclaimed because of elapsed time; crashed owners are
// recovered only after verified process death. The write is atomic (temp file
// + rename) and skipped entirely when canonical content is unchanged. The
// existing config and overlay are validated before any projection mutation or
// write. No API key is ever written and an unsafe existing config is rejected
// unchanged.
func Materialize(in MaterializeInput) error {
	grokHome := filepath.Dir(in.ConfigPath)
	if err := os.MkdirAll(grokHome, 0o700); err != nil {
		return fmt.Errorf("grok: create GROK_HOME: %w", err)
	}

	lock, err := acquireMaterializeLock(filepath.Join(grokHome, "materialize.lock"))
	if err != nil {
		return fmt.Errorf("grok: acquire materialize lock: %w", err)
	}
	defer lock.Release()

	tree, err := loadTOML(in.ConfigPath)
	if err != nil {
		return err
	}

	if err := validateExistingConfig(tree); err != nil {
		return err
	}

	overlay, err := loadOverlay(in.OverlayPath)
	if err != nil {
		return err
	}
	// Extract overlay-managed [models] values before the deep merge so the
	// managed write below is decided from the overlay alone, never from merged
	// or pre-existing config content.
	overlayModels := map[string]interface{}{}
	if overlay != nil {
		if err := validateOverlay(overlay); err != nil {
			return err
		}
		if m, ok := overlay["models"].(map[string]interface{}); ok {
			for _, key := range []string{"default", "session_summary"} {
				if v, has := m[key]; has {
					overlayModels[key] = v
				}
			}
		}
		deepMerge(tree, overlay)
	}

	modelTable := ensureMap(tree, "model")
	current := make(map[string]bool, len(in.Projections))
	for _, p := range in.Projections {
		current[p.ID] = true
		modelTable[p.ID] = projectionToMap(p)
	}
	// Delete stale forge-* models that are no longer projected.
	for key := range modelTable {
		if strings.HasPrefix(key, ModelIDPrefix) && !current[key] {
			delete(modelTable, key)
		}
	}
	if len(modelTable) == 0 {
		delete(tree, "model")
	} else {
		tree["model"] = modelTable
	}

	// Managed [models].default / [models].session_summary. The overlay value
	// wins when present; otherwise the input field is used when non-empty.
	// These are managed keys: whenever a value is available it overwrites any
	// existing value, and when neither source has a value the key is left
	// untouched.
	inputModels := map[string]string{
		"default":         in.DefaultModel,
		"session_summary": in.SessionSummaryModel,
	}
	modelsTable, hasModels := tree["models"].(map[string]interface{})
	wroteModels := false
	for _, key := range []string{"default", "session_summary"} {
		value, hasValue := overlayModels[key]
		if !hasValue {
			value, hasValue = inputModels[key], inputModels[key] != ""
		}
		if !hasValue {
			continue
		}
		if !hasModels {
			modelsTable = map[string]interface{}{}
			hasModels = true
		}
		modelsTable[key] = value
		wroteModels = true
	}
	if wroteModels {
		tree["models"] = modelsTable
	}

	data, err := toml.Marshal(tree)
	if err != nil {
		return fmt.Errorf("grok: encode config: %w", err)
	}

	// No-write skip when canonical content is unchanged.
	if existing, rerr := os.ReadFile(in.ConfigPath); rerr == nil && bytes.Equal(existing, data) {
		return nil
	}
	return writeGrokFileAtomically(in.ConfigPath, data, 0o600)
}

// CheckOverlay validates the optional overlay file without writing anything.
// It returns nil when the overlay is absent or valid, and an error describing
// the problem when it is missing, unparseable, contains an api_key, or
// attempts to define/overwrite a forge-* model.
func CheckOverlay(overlayPath string) error {
	overlay, err := loadOverlay(overlayPath)
	if err != nil {
		return err
	}
	if overlay == nil {
		return nil
	}
	return validateOverlay(overlay)
}

// ValidateConfig validates a Grok config.toml file without writing anything.
// It returns nil when the file is absent (will be created on first materialize),
// or when it is valid TOML and contains no forbidden keys. An error is returned
// if the file exists but cannot be read, parsed, or contains an api_key or a
// top-level model that is not a TOML table. Unsafe existing config is rejected
// unchanged with a redacted error.
func ValidateConfig(path string) error {
	tree, err := loadTOML(path)
	if err != nil {
		return err
	}
	return validateExistingConfig(tree)
}

// acquireMaterializeLock uses the Grok lifecycle lock with bounded retries.
// On success the caller MUST call Release.
func acquireMaterializeLock(lockPath string) (*grokLifecycleLock, error) {
	for i := 0; i < 10; i++ {
		lock, err := acquireGrokLifecycleLockOnce(lockPath)
		if err == nil {
			return lock, nil
		}
		// Sleep between failures only (not after last attempt).
		if i < 9 {
			time.Sleep(time.Duration(50*(i+1)) * time.Millisecond)
		}
	}
	return nil, fmt.Errorf("grok: materialize lock held by another process (gave up after 10 attempts)")
}

func writeGrokFileAtomically(target string, data []byte, perm os.FileMode) error {
	if info, err := os.Lstat(target); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing to write through symlink: %s", target)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(target), filepath.Base(target)+".*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(perm); err != nil {
		_ = temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempPath, target)
}

func loadTOML(path string) (map[string]interface{}, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]interface{}{}, nil
		}
		return nil, fmt.Errorf("grok: read config: %w", err)
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return map[string]interface{}{}, nil
	}
	tree := map[string]interface{}{}
	if err := toml.Unmarshal(data, &tree); err != nil {
		return nil, fmt.Errorf("grok: parse config %s: %w", path, err)
	}
	return tree, nil
}

// loadOverlay loads the optional overlay file. It returns (nil, nil) when the
// file is absent, and an error when it cannot be read or parsed.
func loadOverlay(path string) (map[string]interface{}, error) {
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("grok: read overlay: %w", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("grok: read overlay: %w", err)
	}
	if len(bytes.TrimSpace(data)) == 0 {
		return map[string]interface{}{}, nil
	}
	tree := map[string]interface{}{}
	if err := toml.Unmarshal(data, &tree); err != nil {
		return nil, fmt.Errorf("grok: parse overlay %s: %w", path, err)
	}
	return tree, nil
}

// validateNoAPIKey recursively walks node (map[string]any or []any) and
// rejects any key named api_key (case-insensitive) at any depth.
func validateNoAPIKey(node interface{}, path string) error {
	switch n := node.(type) {
	case map[string]interface{}:
		for key, val := range n {
			if strings.EqualFold(key, "api_key") {
				return fmt.Errorf("%s contains a forbidden key (api_key) - redacted", path)
			}
			subPath := path + "." + key
			if err := validateNoAPIKey(val, subPath); err != nil {
				return err
			}
		}
	case []interface{}:
		for i, elem := range n {
			subPath := fmt.Sprintf("%s[%d]", path, i)
			if err := validateNoAPIKey(elem, subPath); err != nil {
				return err
			}
		}
	}
	return nil
}

// validateExistingConfig validates an existing Grok config tree. It rejects
// api_key at any depth and a top-level model that is not a TOML table. Unsafe
// config is rejected unchanged with a redacted error.
func validateExistingConfig(tree map[string]interface{}) error {
	if err := validateNoAPIKey(tree, "config"); err != nil {
		return err
	}
	if modelVal, ok := tree["model"]; ok {
		if _, ok := modelVal.(map[string]interface{}); !ok {
			return fmt.Errorf("existing config [model] must be a TOML table, got %T", modelVal)
		}
	}
	return nil
}

// validateOverlay rejects any overlay that defines an api_key at any depth,
// attempts to define/overwrite a forge-* model (only at the top-level [model]
// table; unrelated nested keys named model are not treated as managed), or has
// a top-level model that is not a TOML table (which would structurally replace
// the managed model table on merge).
func validateOverlay(tree map[string]interface{}) error {
	if err := validateNoAPIKey(tree, "overlay"); err != nil {
		return err
	}
	// Reject top-level model if it exists but is not a TOML table: a scalar or
	// array value would replace the entire [model] section on merge, destroying
	// managed forge-* model entries.
	if modelVal, ok := tree["model"]; ok {
		if _, ok := modelVal.(map[string]interface{}); !ok {
			return fmt.Errorf("overlay [model] must be a TOML table, got %T", modelVal)
		}
		models := modelVal.(map[string]interface{})
		for modelKey := range models {
			if strings.HasPrefix(modelKey, ModelIDPrefix) {
				return fmt.Errorf("overlay must not define/overwrite forge-* model %q", modelKey)
			}
		}
	}
	return nil
}

// deepMerge merges src into dst recursively. Maps are merged key-by-key;
// scalars and slices from src overwrite dst.
func deepMerge(dst, src map[string]interface{}) {
	for key, sval := range src {
		if dval, ok := dst[key]; ok {
			dmap, dOk := dval.(map[string]interface{})
			smap, sOk := sval.(map[string]interface{})
			if dOk && sOk {
				deepMerge(dmap, smap)
				continue
			}
		}
		dst[key] = sval
	}
}

func ensureMap(tree map[string]interface{}, key string) map[string]interface{} {
	if existing, ok := tree[key].(map[string]interface{}); ok {
		return existing
	}
	m := map[string]interface{}{}
	tree[key] = m
	return m
}

func projectionToMap(p Projection) map[string]interface{} {
	return map[string]interface{}{
		"name":                    p.Name,
		"model":                   p.Model,
		"base_url":                p.BaseURL,
		"env_key":                 p.EnvKey,
		"api_backend":             p.APIBackend,
		"context_window":          p.ContextWindow,
		"supports_backend_search": p.SupportsBackendSearch,
	}
}
