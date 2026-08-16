package shell

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/lifecycle/layout"
)

// --- path helpers ---

// DataHomeForHome computes the XDG_DATA_HOME for a given home directory.
func DataHomeForHome(home string) string {
	if configured := strings.TrimSpace(os.Getenv("XDG_DATA_HOME")); configured != "" {
		if abs, err := filepath.Abs(configured); err == nil {
			return abs
		}
		return configured
	}
	return filepath.Join(home, ".local", "share")
}

// CCRootForHome returns the shell-CC root for a given home directory.
func CCRootForHome(home string) string {
	return filepath.Join(layout.NewPaths(home).DataDir(), "claude", "shell-cc")
}

// CCConfigDirForHome returns the shell-CC config directory.
func CCConfigDirForHome(home string) string {
	return filepath.Join(CCRootForHome(home), "config")
}

// --- migration ---

// MigrateCCState copies Claude state from ~/.claude into the shell-CC
// config directory for a given home, avoiding overwriting existing files.
func MigrateCCState(home string) (MigrationResult, error) {
	source := filepath.Join(home, ".claude")
	target := CCConfigDirForHome(home)
	result := MigrationResult{}
	if err := os.MkdirAll(target, 0o755); err != nil {
		return result, err
	}

	for _, name := range []string{"projects", "sessions", "file-history", "plans", "tasks", "transcripts", "paste-cache"} {
		count, err := copyTreeMissing(filepath.Join(source, name), filepath.Join(target, name))
		if err != nil {
			return result, err
		}
		result.CopiedFiles += count
	}
	for _, name := range []string{"history.jsonl"} {
		copied, err := copyFileMissing(filepath.Join(source, name), filepath.Join(target, name))
		if err != nil {
			return result, err
		}
		if copied {
			result.CopiedFiles++
		}
	}

	seeded, err := mergeShellCCClaudeJSON(filepath.Join(source, ".claude.json"), filepath.Join(target, ".claude.json"))
	if err != nil {
		return result, err
	}
	result.SeededState = seeded
	return result, nil
}

// --- internal file operations ---

func copyTreeMissing(src, dst string) (int, error) {
	info, err := os.Stat(src)
	if os.IsNotExist(err) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if !info.IsDir() {
		return 0, nil
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return 0, err
	}
	copied := 0
	for _, entry := range entries {
		srcPath := filepath.Join(src, entry.Name())
		dstPath := filepath.Join(dst, entry.Name())
		entryInfo, err := entry.Info()
		if err != nil {
			return copied, err
		}
		if entryInfo.IsDir() {
			n, err := copyTreeMissing(srcPath, dstPath)
			copied += n
			if err != nil {
				return copied, err
			}
			continue
		}
		if !entryInfo.Mode().IsRegular() {
			continue
		}
		ok, err := copyFileMissing(srcPath, dstPath)
		if err != nil {
			return copied, err
		}
		if ok {
			copied++
		}
	}
	return copied, nil
}

func copyFileMissing(src, dst string) (bool, error) {
	info, err := os.Stat(src)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() || exists(dst) {
		return false, nil
	}
	content, err := os.ReadFile(src)
	if err != nil {
		return false, err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return false, err
	}
	mode := info.Mode().Perm()
	if mode == 0 {
		mode = 0o644
	}
	return true, os.WriteFile(dst, content, mode)
}

func mergeShellCCClaudeJSON(src, dst string) (bool, error) {
	source := readJSONMap(src)
	target := readJSONMap(dst)
	before, _ := json.Marshal(target)

	for _, key := range []string{"projects", "githubRepoPaths"} {
		mergeMapField(target, source, key)
	}
	mergeCustomAPIKeyResponses(target, source)
	target["hasCompletedOnboarding"] = true
	if strings.TrimSpace(stringValue(target["lastOnboardingVersion"])) == "" {
		if value := strings.TrimSpace(stringValue(source["lastOnboardingVersion"])); value != "" {
			target["lastOnboardingVersion"] = value
		} else {
			target["lastOnboardingVersion"] = claudeCodeVersionForOnboarding()
		}
	}
	if strings.TrimSpace(stringValue(target["lastOnboardingVersion"])) == "" {
		target["lastOnboardingVersion"] = "2.1.0"
	}

	after, _ := json.Marshal(target)
	if string(before) == string(after) && exists(dst) {
		return false, nil
	}
	return true, writeJSON(dst, target)
}

func mergeMapField(target, source map[string]interface{}, key string) {
	srcMap, ok := source[key].(map[string]interface{})
	if !ok || len(srcMap) == 0 {
		return
	}
	dstMap, ok := target[key].(map[string]interface{})
	if !ok {
		dstMap = map[string]interface{}{}
		target[key] = dstMap
	}
	for name, value := range srcMap {
		if _, exists := dstMap[name]; !exists {
			dstMap[name] = value
		}
	}
}

func mergeCustomAPIKeyResponses(target, source map[string]interface{}) {
	dst := map[string]interface{}{}
	if existing, ok := target["customApiKeyResponses"].(map[string]interface{}); ok {
		for key, value := range existing {
			dst[key] = value
		}
	}
	if existing, ok := source["customApiKeyResponses"].(map[string]interface{}); ok {
		for key, value := range existing {
			if _, present := dst[key]; !present {
				dst[key] = value
			}
		}
	}
	if _, ok := dst["rejected"]; !ok {
		dst["rejected"] = []string{}
	}
	target["customApiKeyResponses"] = dst
}

func unionInterfaceStrings(values ...interface{}) []string {
	seen := map[string]bool{}
	out := []string{}
	var visit func(interface{})
	visit = func(value interface{}) {
		switch v := value.(type) {
		case string:
			if v != "" && !seen[v] {
				seen[v] = true
				out = append(out, v)
			}
		case []interface{}:
			for _, item := range v {
				visit(item)
			}
		case []string:
			for _, item := range v {
				visit(item)
			}
		case map[string]interface{}:
			visit(v["approved"])
		}
	}
	for _, value := range values {
		visit(value)
	}
	sort.Strings(out)
	return out
}

func stringValue(value interface{}) string {
	if value == nil {
		return ""
	}
	if s, ok := value.(string); ok {
		return s
	}
	return ""
}

func claudeCodeVersionForOnboarding() string {
	version := strings.TrimPrefix(strings.TrimSpace(commandOutput("claude", "--version")), "v")
	if fields := strings.Fields(version); len(fields) > 0 {
		return fields[0]
	}
	return ""
}

func commandOutput(name string, args ...string) string {
	cmd := exec.Command(name, args...)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func readJSONMap(path string) map[string]interface{} {
	data := map[string]interface{}{}
	content, err := os.ReadFile(path)
	if err == nil {
		_ = json.Unmarshal(content, &data)
	}
	return data
}

func writeJSON(path string, value interface{}) error {
	content, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, append(content, '\n'), 0o644)
}
