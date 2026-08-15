package auth

// ResolveCredential resolves a credential for a provider id exclusively from
// Forge's auth store. Legacy secrets may be imported by setup, but are never a
// runtime credential source. For native providers (Codex, Claude), use
// ProviderAuthStatusResolver.Credential instead.
func ResolveCredential(path, providerID string, _ func(keys ...string) string) (string, bool) {
	if providerID == "" {
		return "", false
	}

	if auth, err := Read(path); err == nil {
		if entry, ok := auth[providerID]; ok && entry.Key != "" {
			return entry.Key, true
		}
		if entry, ok := auth[providerID]; ok && entry.Type == "oauth" && entry.Access != "" {
			return entry.Access, true
		}
	}

	return "", false
}

// MigrateAuthFromSecrets copies old secrets.json entries into auth.json at the
// given path (idempotent — never overwrites existing auth entries). The lookup
// callback resolves user secrets first, then repo secrets.
func MigrateAuthFromSecrets(path string, lookup func(keys ...string) string) ([]string, error) {
	migrated := []string{}
	auth, err := Read(path)
	if err != nil {
		return nil, err
	}
	if auth == nil {
		auth = map[string]Entry{}
	}

	// Ordered slice of old secret key -> provider id + type.
	// The first legacy key found for a provider wins.
	type migrationMapping struct {
		secretKey string
		provider  string
		keyType   string
	}
	ordered := []migrationMapping{
		{"glm-anthropic-auth-token", "zhipu-coding", "api"},
		{"glm-Tencent-auth-token", "zhipu-coding", "api"},
		{"glm-api-key", "zhipu-coding", "api"},
		{"zhipu-api-key", "zhipu-coding", "api"},
		{"kimi-coding-api-key", "kimi-coding", "api"},
		{"kimi-api-key", "kimi-coding", "api"},
		{"moonshot-api-key", "kimi-coding", "api"},
		{"FORGE_KIMI_CODING_API_KEY", "kimi-coding", "api"},
		{"KIMI_CODING_API_KEY", "kimi-coding", "api"},
		{"MOONSHOT_API_KEY", "kimi-coding", "api"},
		{"deepseek-anthropic-auth-token", "deepseek", "api"},
	}

	for _, m := range ordered {
		// Never clobber a user-set auth entry.
		if _, exists := auth[m.provider]; exists {
			continue
		}
		value := lookup(m.secretKey)
		if value == "" {
			continue
		}
		auth[m.provider] = Entry{
			Type: m.keyType,
			Key:  value,
		}
		migrated = append(migrated, m.provider)
	}

	if len(migrated) == 0 {
		return nil, nil
	}

	if err := Write(path, auth); err != nil {
		return nil, err
	}
	return migrated, nil
}
