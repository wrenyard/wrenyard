export type ConfigRecord = Record<string, unknown>

export interface ForemanServiceConfig {
  service: {
    enabled: boolean
    ipc?: {
      path?: string
    }
  }
  workspaceRoot: string
}
