export interface MessageSender {
  role?: string
}

export interface NormalizedMessageSender {
  role: string
}

export const MESSAGE_SENDER_REQUIRED_MESSAGE =
  'send_message requires a sender principal. MCP clients connect with ?sender=<principal>, for example ?sender=codex; CLI clients pass --sender <principal>.'

export function normalizeMessageSender(sender?: MessageSender): NormalizedMessageSender | null {
  const role = sender?.role?.trim()
  if (!role) return null
  return {
    role,
  }
}
