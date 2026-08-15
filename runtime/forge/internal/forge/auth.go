package forge

import (
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/providers/auth"
	"github.com/wrenyard/wrenyard/runtime/forge/internal/usage/quota"
	"golang.org/x/term"
)

type AuthEntry = auth.Entry

func init() {
	auth.SafeAtomicWrite = quota.SafeAtomicWrite
}

func authPath() string { return auth.Path(forgeDataDir()) }

func readAuth() (map[string]AuthEntry, error) { return auth.Read(authPath()) }

func writeAuth(entries map[string]AuthEntry) error { return auth.Write(authPath(), entries) }

func ResolveCredential(providerID string) (string, bool) {
	if overrides, err := configuredProviderOverrides(); err == nil {
		if value, ok, keyErr := providers.EffectiveAPIKey(providerID, overrides, os.LookupEnv); keyErr == nil && ok {
			return value, true
		}
	}
	return auth.ResolveCredential(authPath(), providerID, firstRepoSecret)
}

func IsManagedProvider(providerID string) bool { return providers.IsManaged(providerID) }

func MigrateAuthFromSecrets() ([]string, error) {
	return auth.MigrateAuthFromSecrets(authPath(), firstRepoSecret)
}

func AuthPermsOK(path string) bool { return auth.PermsOK(path) }

func resolveSecret(ref *string) (*string, error) {
	return auth.ResolveSecret(ref, secretDeps())
}

func secretDeps() auth.SecretDeps {
	return auth.SecretDeps{ResolveCredential: ResolveCredential, RepoDir: repoDir, UserSecretsPath: userSecretsPath}
}

func legacyKeyToProviderID(key string) string { return auth.LegacyKeyToProviderID(key) }

func resolveByProviderAuth(legacyKey string) (string, bool) {
	providerID := legacyKeyToProviderID(legacyKey)
	if providerID == "" {
		return "", false
	}
	return ResolveCredential(providerID)
}

func firstRepoSecret(keys ...string) string { return auth.FirstSecret(keys, secretDeps()) }

func repoSecret(name string) string { return auth.RepoSecret(name, secretDeps()) }

func userSecret(name string) string { return auth.UserSecret(name, secretDeps()) }

func readSecret(path, name string) string {
	if value, ok := auth.ReadSecretsFile(path)[name].(string); ok {
		return value
	}
	return ""
}

func readSecretsFile(path string) map[string]interface{} { return auth.ReadSecretsFile(path) }

func wiredAuthDeps() auth.CommandDeps {
	return auth.CommandDeps{
		StoreRead:        func(_ string) (map[string]auth.Entry, error) { return readAuth() },
		StoreWrite:       func(_ string, entries map[string]auth.Entry) error { return writeAuth(entries) },
		StorePath:        authPath(),
		KnownProviderIDs: knownProviderIDs,
		ProviderConfig: func(id string) (auth.ProviderCfg, bool) {
			pc, ok := providerConfigForAuth(id)
			return pc, ok
		},
		DataDir:     forgeDataDir(),
		Stdin:       os.Stdin,
		Stdout:      os.Stdout,
		Stderr:      os.Stderr,
		IsTerminal:  term.IsTerminal,
		StdinFd:     int(os.Stdin.Fd()),
		QuotaVerify: func(w io.Writer, key string) { auth.VerifyQuota(w, key) },
	}
}

// providerLogin is the callback for providers auth login.
func providerLogin(providerID string) error {
	return auth.Login(wiredAuthDeps(), providerID)
}

// providerLogout is the callback for providers auth logout.
func providerLogout(providerID string) error {
	return auth.Logout(wiredAuthDeps(), providerID)
}

func printAuthHelp() { auth.PrintHelp(os.Stdout) }

func authCommand(args []string) int {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" || args[0] == "help" {
		printAuthHelp()
		return 0
	}
	switch args[0] {
	case "login":
		if len(args) != 2 {
			fmt.Fprintln(os.Stderr, "forge auth login: provider id is required")
			return 2
		}
		if err := providerLogin(args[1]); err != nil {
			fmt.Fprintf(os.Stderr, "forge auth login: %v\n", err)
			return 1
		}
		return 0
	case "logout":
		if len(args) != 2 {
			fmt.Fprintln(os.Stderr, "forge auth logout: expected exactly one provider id")
			return 2
		}
		if err := providerLogout(args[1]); err != nil {
			fmt.Fprintf(os.Stderr, "forge auth logout: %v\n", err)
			return 1
		}
		return 0
	case "list":
		if len(args) != 1 {
			fmt.Fprintln(os.Stderr, "forge auth list: unexpected arguments")
			return 2
		}
		if err := auth.List(wiredAuthDeps()); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return 0
	case "set":
		return auth.Set(wiredAuthDeps(), args[1:])
	case "claude-token":
		return auth.ClaudeToken(wiredAuthDeps(), args[1:])
	default:
		fmt.Fprintf(os.Stderr, "forge auth: unknown command %q\n", args[0])
		return 2
	}
}

func knownProviderIDs() []string {
	ids := []string{}
	for _, module := range providers.Modules() {
		if module.Auth().Login {
			ids = append(ids, module.ID())
		}
	}
	sort.Strings(ids)
	return ids
}

// providerConfigForAuth returns a narrow canonical ProviderCfg sufficient for
// auth login/logout quota verification. It does not reintroduce user-level
// provider definitions.
func providerConfigForAuth(id string) (auth.ProviderCfg, bool) {
	module, ok := providers.Lookup(id)
	if !ok || !module.Auth().Login {
		return auth.ProviderCfg{}, false
	}
	binding := module.Binding()
	if binding.Inference == nil {
		return auth.ProviderCfg{}, false
	}
	apiKind := ""
	if strings.HasPrefix(binding.Inference.Protocol, "anthropic-") {
		apiKind = "anthropic"
	} else if strings.HasPrefix(binding.Inference.Protocol, "openai-") {
		apiKind = "openai"
	}
	return auth.ProviderCfg{Name: id, APIKind: apiKind, BaseURL: binding.Inference.Endpoint}, true
}

func maskKey(key string) string { return auth.MaskKey(key) }

func secretsFilePermsOK(path string) bool { return auth.PermsOK(path) }

func redact(value interface{}) interface{} { return auth.Redact(value) }
