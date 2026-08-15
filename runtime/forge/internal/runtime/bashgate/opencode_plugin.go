package bashgate

const (
	// OpenCodeExecutableEnv is the raw absolute Forge executable used by the
	// isolated OpenCode plugin. It is separate from ExecutableEnv because the
	// Claude Windows adapter requires cmd.exe quoting around that value.
	OpenCodeExecutableEnv = "FORGE_INTERNAL_OPENCODE_BASH_GATE_EXECUTABLE"

	// OpenCodeBashPermissionEnv carries the registry-encoded Bash permission
	// object that the plugin installs only after its BashGate readiness check.
	OpenCodeBashPermissionEnv = "FORGE_INTERNAL_OPENCODE_BASH_PERMISSION"
)

// OpenCodePluginBytes returns the dependency-free per-run OpenCode plugin. It
// only adapts OpenCode's documented tool.execute.before payload to BashGate;
// all command parsing and authorization remain in the shared Go policy.
func OpenCodePluginBytes() []byte {
	return []byte(`import { spawnSync } from "node:child_process"
import { isAbsolute } from "node:path"

const executableEnv = "FORGE_INTERNAL_OPENCODE_BASH_GATE_EXECUTABLE"
const permissionEnv = "FORGE_INTERNAL_OPENCODE_BASH_PERMISSION"
const maxPayloadBytes = 1024 * 1024
const bashAliases = new Set([
  "Bash", "shell", "Shell", "sh", "zsh", "cmd", "powershell",
  "run_terminal_cmd", "run_terminal_command",
])

function deny(message) {
  throw new Error("Forge BashGate blocked OpenCode: " + message)
}

function activeBashPermission() {
  const raw = process.env[permissionEnv]
  if (typeof raw !== "string" || raw.length === 0) deny("missing active Bash permission")
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    deny("malformed active Bash permission")
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object" ||
      !Object.prototype.hasOwnProperty.call(parsed, "*") || parsed["*"] !== "allow") {
    deny("invalid active Bash permission")
  }
  for (const decision of Object.values(parsed)) {
    if (decision !== "allow") deny("invalid active Bash permission decision")
  }
  return parsed
}

function runGate(args, cwd) {
  const executable = process.env[executableEnv]
  if (typeof executable !== "string" || !isAbsolute(executable) || /[\0\r\n]/.test(executable)) {
    deny("invalid guard executable")
  }
  let payload
  try {
    payload = JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "bash",
      tool_input: args,
      tool_input_truncated: false,
      cwd,
    })
  } catch {
    deny("malformed tool payload")
  }
  if (typeof payload !== "string" || Buffer.byteLength(payload, "utf8") > maxPayloadBytes) {
    deny("truncated tool payload")
  }
  const child = spawnSync(executable, [], {
    input: payload,
    encoding: "utf8",
    env: process.env,
    timeout: 30000,
    maxBuffer: maxPayloadBytes,
    windowsHide: true,
  })
  if (child.error || child.signal !== null || child.status !== 0) deny("guard process rejected the command")
  let response
  try {
    response = JSON.parse(child.stdout)
  } catch {
    deny("malformed guard response")
  }
  if (response === null || typeof response !== "object" || response.decision !== "allow") {
    deny("invalid guard response")
  }
}

export const ForgeBashGatePlugin = async ({ directory }) => ({
  config: async (config) => {
    const active = activeBashPermission()
    runGate({ command: "pwd" }, directory)
    if (config === null || typeof config !== "object" || config.permission === null ||
        typeof config.permission !== "object" || Array.isArray(config.permission)) {
      deny("malformed OpenCode permission config")
    }
    config.permission.bash = active
  },
  "tool.execute.before": async (input, output) => {
    if (input === null || typeof input !== "object" || typeof input.tool !== "string") {
      deny("malformed tool identity")
    }
    if (input.tool !== "bash") {
      if (bashAliases.has(input.tool) || input.tool.toLowerCase() === "bash") {
        deny("unknown Bash alias")
      }
      return
    }
    if (output === null || typeof output !== "object" || output.args === null ||
        typeof output.args !== "object" || Array.isArray(output.args)) {
      deny("malformed Bash arguments")
    }
    runGate(output.args, directory)
  },
})
`)
}
