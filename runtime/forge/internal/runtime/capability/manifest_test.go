package capability

import (
	"reflect"
	"strings"
	"testing"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/runtime/catalog"
)

func TestGitHistoryPackResolvesToExactlyNarrowBashGateScope(t *testing.T) {
	result, err := ResolvePacks([]string{"git-history"}, "", EmbeddedData())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Tools.Cap) != 0 || len(result.Tools.MCP) != 0 {
		t.Fatalf("git-history must not contribute tool or MCP entries: %+v", result.Tools)
	}
	want := []catalog.BashRule{
		{Pattern: "git --no-optional-locks log --oneline *"},
		{Pattern: "git --no-optional-locks show --name-only *"},
		{Pattern: "git --no-optional-locks show --stat *"},
	}
	if !reflect.DeepEqual(result.BashGate.Cap, want) {
		t.Fatalf("git-history Bash capability = %+v, want exactly %+v", result.BashGate.Cap, want)
	}
}

func TestGitHistoryPackPatternsSurviveGrammarValidation(t *testing.T) {
	for _, rule := range []catalog.BashRule{
		{Pattern: "git --no-optional-locks log --oneline *"},
		{Pattern: "git --no-optional-locks show --name-only *"},
		{Pattern: "git --no-optional-locks show --stat *"},
	} {
		if err := catalog.ValidateCapabilityBashRule(rule); err != nil {
			t.Fatalf("git-history pattern %q failed capability grammar validation: %v", rule.Pattern, err)
		}
	}
}

func TestGitHistoryPackIsPresentInEmbeddedRegistry(t *testing.T) {
	manifest, err := LoadManifest("", EmbeddedData())
	if err != nil {
		t.Fatal(err)
	}
	pack, ok := manifest["git-history"]
	if !ok {
		t.Fatalf("git-history pack missing from embedded registry: %v", sortedKeys(manifest))
	}
	if !strings.Contains(pack.Description, "git") {
		t.Fatalf("git-history description does not mention git: %q", pack.Description)
	}
}
