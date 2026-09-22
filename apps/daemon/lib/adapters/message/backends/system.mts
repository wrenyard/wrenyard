import type { MessageBackend } from '../../../message/delivery/hub.mts'
import type { MessageDeliveryResult, MessageEnvelope } from '../../../message/delivery/types.mts'
import { formatMessageDeliveryText, type MessageDeliveryFormatInput } from '../../../message/delivery/format.mts'
import { runCommandWithTimeout } from './openclaw.mts'

function inputFromEvent(event: MessageEnvelope): MessageDeliveryFormatInput {
  return {
    taskName: event.title,
    status: 'done',
    client: null,
    model: null,
    prUrl: null,
    duration: '',
    summary: event.body,
  }
}

export function createSystemBackend(): MessageBackend {
  return {
    name: 'system',
    async deliver(event, channel): Promise<MessageDeliveryResult> {
      const input = inputFromEvent(event)
      const message = formatMessageDeliveryText(input)
      try {
        if (process.platform === 'win32') {
          const esc = message.replace(/"/g, '""').replace(/\n/g, '`n')
          await runCommandWithTimeout('powershell', [
            '-NoProfile', '-Command',
            `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${esc}', 'Foreman', 'OK', 'Information') | Out-Null`,
          ], {
            timeoutMs: 30_000,
            errorPrefix: 'system message',
          })
        } else {
          await runCommandWithTimeout('osascript', [
            '-e', `display notification "${message.replace(/"/g, '\\"')}" with title "Foreman"`,
          ], {
            timeoutMs: 5_000,
            errorPrefix: 'system message',
          })
        }
        return { channel, backend: 'system', ok: true }
      } catch (error) {
        return {
          channel,
          backend: 'system',
          ok: false,
          error: (error as Error).message,
        }
      }
    },
  }
}
