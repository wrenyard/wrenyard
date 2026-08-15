package driver

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func TestResolveBinaryNodeEntry(t *testing.T) {
	tempDir := t.TempDir()
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)

	npmPrefix := filepath.Join(homeDir, ".npm")
	if runtime.GOOS == "windows" {
		t.Setenv("APPDATA", tempDir)
		npmPrefix = filepath.Join(tempDir, "npm")
	}
	entryPath := filepath.Join(npmPrefix, "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy")
	if err := os.MkdirAll(filepath.Dir(entryPath), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(entryPath, []byte("#!/usr/bin/env node"), 0o755); err != nil {
		t.Fatalf("write entry: %v", err)
	}

	// Isolate PATH so we don't fall back to a real binary.
	t.Setenv("PATH", tempDir)

	spec := catalog.BinarySpec{
		Name:       "forge-test-shim",
		WindowsCmd: "forge-test-shim.cmd",
		NodeEntry:  "node_modules/@tencent-ai/codebuddy-code/bin/codebuddy",
	}

	cmd, err := ResolveBinary(spec)
	if err != nil {
		t.Fatalf("ResolveBinary: %v", err)
	}
	if len(cmd) != 2 || cmd[0] != "node" {
		t.Fatalf("expected [node, <script>], got %v", cmd)
	}
	if !strings.Contains(cmd[1], filepath.Join("node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy")) {
		t.Fatalf("expected script path in result, got %q", cmd[1])
	}
}

func TestResolveBinaryNodeEntryMissingFile(t *testing.T) {
	tempDir := t.TempDir()
	if runtime.GOOS == "windows" {
		t.Setenv("APPDATA", tempDir)
	}
	// Isolate PATH so LookPath doesn't find ambient agent shims.
	t.Setenv("PATH", tempDir)

	spec := catalog.BinarySpec{
		Name:       "forge-test-shim",
		WindowsCmd: "forge-test-shim.cmd",
		NodeEntry:  "node_modules/@tencent-ai/codebuddy-code/bin/codebuddy",
	}

	_, err := ResolveBinary(spec)
	if err == nil {
		t.Fatal("expected error when NodeEntry file is missing and LookPath fails")
	}
}

func TestResolveBinaryCorruptCmdShim(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("corrupt .cmd detection is Windows-only")
	}

	binDir := t.TempDir()
	// Neutral fixture name: do not materialize real agent CLI shims like codebuddy.cmd.
	cmdPath := filepath.Join(binDir, "forge-test-shim.cmd")
	if err := os.WriteFile(cmdPath, []byte("#!/bin/sh\nexit 0\n"), 0o644); err != nil {
		t.Fatalf("write corrupt cmd: %v", err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	spec := catalog.BinarySpec{
		Name:       "forge-test-shim",
		WindowsCmd: "forge-test-shim.cmd",
		NodeEntry:  "",
	}

	_, err := ResolveBinary(spec)
	if err == nil {
		t.Fatal("expected error for corrupt .cmd shim")
	}
	if !strings.Contains(err.Error(), "corrupt") {
		t.Fatalf("expected corrupt shim error, got: %v", err)
	}
	if !strings.Contains(err.Error(), "npm install -g @tencent-ai/codebuddy-code") {
		t.Fatalf("expected npm install hint, got: %v", err)
	}
}

func TestResolveBinaryCleanCmdShim(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("clean .cmd test is Windows-only")
	}

	binDir := t.TempDir()
	cmdPath := filepath.Join(binDir, "forge-test-shim.cmd")
	if err := os.WriteFile(cmdPath, []byte("@ECHO off\r\nGOTO start\r\n"), 0o644); err != nil {
		t.Fatalf("write clean cmd: %v", err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	spec := catalog.BinarySpec{
		Name:       "forge-test-shim",
		WindowsCmd: "forge-test-shim.cmd",
		NodeEntry:  "",
	}

	cmd, err := ResolveBinary(spec)
	if err != nil {
		t.Fatalf("ResolveBinary for clean shim: %v", err)
	}
	if len(cmd) != 1 {
		t.Fatalf("expected [path], got %v", cmd)
	}
	if !strings.HasSuffix(cmd[0], "forge-test-shim.cmd") {
		t.Fatalf("expected forge-test-shim.cmd path, got %q", cmd[0])
	}
}

func TestNpmGlobalPrefixWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("npmGlobalPrefix Windows test")
	}
	appData := "C:\\Users\\test\\AppData\\Roaming"
	t.Setenv("APPDATA", appData)
	prefix, err := npmGlobalPrefix()
	if err != nil {
		t.Fatalf("npmGlobalPrefix: %v", err)
	}
	want := filepath.Join(appData, "npm")
	if prefix != want {
		t.Fatalf("expected %q, got %q", want, prefix)
	}
}
