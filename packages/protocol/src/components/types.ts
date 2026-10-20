export type OperationComponentId = 'browser' | 'desktop'

export type OperationComponentState =
  | 'not-installed'
  | 'installing'
  | 'needs-authorization'
  | 'ready'
  | 'failed'
  | 'unsupported'
  | 'disabled'

export type OperationComponentAction =
  | 'refresh'
  | 'install'
  | 'update'
  | 'repair'
  | 'authorize'
  | 'uninstall'
  | 'enable'
  | 'disable'
  | 'login'
  | 'save-login'
  | 'clear-login'

export type OperationComponentHint =
  | 'legacy-browser-mcp'
  | 'shared-browser-runtime'
  | 'external-mcp'
  | 'existing-installation'
  | 'missing-accessibility'
  | 'missing-screen-recording'
  | 'screen-locked'
  | 'no-gui-session'

/** One component's observed status, as rendered by Desktop Settings. */
export interface OperationComponentSnapshot {
  id: OperationComponentId
  /** Executable identity shown to the user: `agent-browser` or `Cua Driver`. */
  name: string
  state: OperationComponentState
  /** `managed` when Wrenyard installed it; `external` for a pre-existing install. */
  source?: 'managed' | 'external'
  version?: string
  /** The release Wrenyard pins and installs for this component. */
  pinnedVersion: string
  /** Absolute executable path, or the URL of an external HTTP MCP server. */
  path?: string
  /** Hostname of the machine the component belongs to (this computer). */
  host: string
  platform: string
  arch: string
  /** ISO timestamp of the last completed check. */
  checkedAt?: string
  progress?: { phase: string; receivedBytes?: number; totalBytes?: number }
  error?: string
  /** True when the Chrome-for-Testing browser runtime was found; browser only. */
  runtimePresent?: boolean
  hints: OperationComponentHint[]
  actions: OperationComponentAction[]
  /**
   * Present only while a managed login store exists. Carries the saved cookie
   * domains and origin hostnames plus the store's save time; cookie and storage
   * values are never included.
   */
  loginState?: { domains: string[]; savedAt: string }
}

export type ComponentsListParams = Record<string, never>

export type ComponentsListResult = {
  components: OperationComponentSnapshot[]
}

export type ComponentsActionParams = {
  id: OperationComponentId
  action: OperationComponentAction
}

export type ComponentsActionResult = {
  component: OperationComponentSnapshot
}
