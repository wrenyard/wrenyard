package catalog

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestGrokEncodedToolsAreResolvedByInstalled02106ContractFixture(t *testing.T) {
	data, err := os.ReadFile("testdata/grok-0.2.106-builtins.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Package string   `json:"package"`
		Version string   `json:"version"`
		Build   string   `json:"build"`
		IDs     []string `json:"forge_encodable_builtin_ids"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Package != "@xai-official/grok" || fixture.Version != "0.2.106" || fixture.Build != "bde89716f6" {
		t.Fatalf("unexpected Grok contract fixture identity: %+v", fixture)
	}

	registry, err := BuiltinRegistry(PermissionAdapterGrok)
	if err != nil {
		t.Fatal(err)
	}
	var encodable []string
	for _, entry := range registry {
		if entry.Encodable {
			encodable = append(encodable, entry.ID)
		}
	}
	if !reflect.DeepEqual(encodable, fixture.IDs) {
		t.Fatalf("Grok encodable registry IDs = %v, installed 0.2.106 fixture IDs = %v", encodable, fixture.IDs)
	}
	for _, mode := range []PermissionMode{PermissionReadonly, PermissionEdit, PermissionYolo} {
		args, err := EncodeGrokPermissionArgs(PolicyFor(mode), nil, nil, "windows")
		if err != nil {
			t.Fatal(err)
		}
		for _, id := range strings.Split(flagValue(args, "--tools"), ",") {
			if !containsString(fixture.IDs, id) {
				t.Fatalf("Grok %s emitted unresolved builtin id %q in --tools: %v", mode, id, args)
			}
		}
		for _, id := range strings.Split(flagValue(args, "--disallowed-tools"), ",") {
			if id != "" && !containsString(fixture.IDs, id) {
				t.Fatalf("Grok %s emitted unresolved builtin id %q in restricted complement: %v", mode, id, args)
			}
		}
	}
}
