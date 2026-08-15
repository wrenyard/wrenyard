package forge

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSourceDoesNotContainLegacyAgentCommandSurface(t *testing.T) {
	forbiddenFile := "agent" + "_cmd.go"
	forbiddenSnippets := []string{
		"func " + "agent" + "Command(",
		"--ignore-" + "deprecated",
		"ignore" + "DeprecatedAgentFlag",
	}
	var offenders []string
	if err := filepath.WalkDir(".", func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		if filepath.Base(path) == forbiddenFile {
			offenders = append(offenders, path)
			return nil
		}
		if filepath.Ext(path) != ".go" {
			return nil
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		text := string(content)
		for _, forbidden := range forbiddenSnippets {
			if strings.Contains(text, forbidden) {
				offenders = append(offenders, path+":"+forbidden)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(offenders) > 0 {
		t.Fatalf("legacy agent command surface remains: %v", offenders)
	}
}

func TestSourceDoesNotReferenceRemovedForgeMCPServerCommand(t *testing.T) {
	removedCommand := "forge" + "-mcp"
	var offenders []string
	if err := filepath.WalkDir(".", func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || filepath.Ext(path) != ".go" {
			return nil
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if strings.Contains(string(content), removedCommand) {
			offenders = append(offenders, path)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(offenders) > 0 {
		t.Fatalf("removed Forge MCP server command %q still appears in source/test fixtures: %v", removedCommand, offenders)
	}
}
