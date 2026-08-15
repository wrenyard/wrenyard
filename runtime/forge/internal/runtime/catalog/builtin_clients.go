package catalog

func registerClients(r *Registry) {
	r.RegisterDescriptor(claudeClient())
	r.RegisterDescriptor(codebuddyClient())
	r.RegisterDescriptor(codexClient())
	r.RegisterDescriptor(opencodeClient())
	r.RegisterDescriptor(grokClient())
	r.RegisterDescriptor(dshClient())
}

func dshClient() Client {
	return Client{
		Name:    "dsh",
		Dialect: DialectDSH,
		Binary:  BinarySpec{Name: "fdsh"},
		ConfigIsolation: ConfigIsolation{
			EnvVar: "DSH_HOME",
		},
		PermissionAdapter: PermissionAdapterDSH,
		DialectFlags: DialectFlags{
			SupportsVerbose:             false,
			SupportsBare:                false,
			SupportsReplayUserMessages:  false,
			SupportsDevelopmentChannels: false,
		},
		TranscriptFamily: TranscriptFamilyDSH,
		// DSH native resume is unsupported in this release.
		ResumeFlag: "",
	}
}

func grokClient() Client {
	return Client{
		Name:    "grok",
		Dialect: DialectGrok,
		Binary:  BinarySpec{Name: "grok"},
		ConfigIsolation: ConfigIsolation{
			EnvVar: "GROK_HOME",
		},
		PermissionAdapter: PermissionAdapterGrok,
		ResumeFlag:        ResumeFlagLong,
		DefaultProvider:   "xai",
	}
}

func claudeClient() Client {
	return Client{
		Name:    "claude",
		Dialect: DialectClaudeCode,
		Binary: BinarySpec{
			Name:       "claude",
			WindowsCmd: "",
		},
		ConfigIsolation: ConfigIsolation{
			EnvVar:        "CLAUDE_CONFIG_DIR",
			PersistentDir: "",
		},
		PermissionAdapter: PermissionAdapterClaude,
		DialectFlags: DialectFlags{
			SupportsVerbose:             true,
			SupportsBare:                true,
			SupportsReplayUserMessages:  true,
			SupportsDevelopmentChannels: true,
		},
		Hygiene:         nil,
		ResumeFlag:      ResumeFlagLong,
		DefaultProvider: "anthropic",
	}
}

func codebuddyClient() Client {
	return Client{
		Name:    "codebuddy",
		Dialect: DialectCodeBuddy,
		Binary: BinarySpec{
			Name:       "codebuddy",
			WindowsCmd: "codebuddy.cmd",
			NodeEntry:  "node_modules/@tencent-ai/codebuddy-code/bin/codebuddy",
		},
		ConfigIsolation: ConfigIsolation{
			EnvVar:        "CODEBUDDY_CONFIG_DIR",
			PersistentDir: "codebuddy/agent-config",
		},
		PermissionAdapter: PermissionAdapterCodeBuddy,
		DialectFlags: DialectFlags{
			SupportsVerbose:             false,
			SupportsBare:                false,
			SupportsReplayUserMessages:  true,
			SupportsDevelopmentChannels: true,
		},
		Hygiene: []string{
			"DISABLE_AUTOUPDATER=1",
			"DISABLE_TELEMETRY=1",
			"DISABLE_ERROR_REPORTING=1",
		},
		ResumeFlag:      ResumeFlagLong,
		DefaultProvider: "codebuddy",
	}
}

// codexClient and opencodeClient registers descriptors for the codex and
// opencode client binaries. Their config/hygiene/flag metadata are neutral and
// preserve the existing driver planners; they only expose the binary + dialect
// so catalog resolution and dialect dispatch work without changing behavior.
func codexClient() Client {
	return Client{
		Name:    "codex",
		Dialect: DialectCodex,
		Binary: BinarySpec{
			Name:       "codex",
			WindowsCmd: "",
		},
		ConfigIsolation:   ConfigIsolation{},
		PermissionAdapter: PermissionAdapterCodex,
		DialectFlags: DialectFlags{
			SupportsVerbose:             false,
			SupportsBare:                false,
			SupportsReplayUserMessages:  false,
			SupportsDevelopmentChannels: false,
		},
		Hygiene:         nil,
		ResumeFlag:      ResumeFlagLong,
		DefaultProvider: "codex",
	}
}

func opencodeClient() Client {
	return Client{
		Name:    "opencode",
		Dialect: DialectOpenCode,
		Binary: BinarySpec{
			Name:       "opencode",
			WindowsCmd: "",
		},
		ConfigIsolation:   ConfigIsolation{},
		PermissionAdapter: PermissionAdapterOpenCode,
		DialectFlags: DialectFlags{
			SupportsVerbose:             false,
			SupportsBare:                false,
			SupportsReplayUserMessages:  false,
			SupportsDevelopmentChannels: false,
		},
		Hygiene:         nil,
		ResumeFlag:      ResumeFlagLong,
		DefaultProvider: "opencode-native",
	}
}
