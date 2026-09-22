import type { AgentClient } from '@wrenyard/agent-client';
export type { AgentClient, AgentRun, AgentProcess, AccountRequest, ClientOptions } from '@wrenyard/agent-client';
export { ClientError } from '@wrenyard/agent-client';
import { CodexClient } from '@wrenyard/client-codex';
export { CodexClient } from '@wrenyard/client-codex';
import { ClaudeClient } from '@wrenyard/client-claude';
export { ClaudeClient } from '@wrenyard/client-claude';
import { CursorClient } from '@wrenyard/client-cursor';
export { CursorClient } from '@wrenyard/client-cursor';
import { GrokClient } from '@wrenyard/client-grok';
export { GrokClient } from '@wrenyard/client-grok';
import { CodeBuddyClient } from '@wrenyard/client-codebuddy';
export { CodeBuddyClient } from '@wrenyard/client-codebuddy';
import { OpenCodeClient } from '@wrenyard/client-opencode';
export { OpenCodeClient } from '@wrenyard/client-opencode';
import { DshClient } from '@wrenyard/client-dsh';
export { DshClient } from '@wrenyard/client-dsh';
export function createAgentClients(): ReadonlyMap<string, AgentClient> {
    const clients: AgentClient[] = [new CodexClient(), new ClaudeClient(), new CursorClient(), new GrokClient(), new CodeBuddyClient(), new OpenCodeClient(), new DshClient()];
    return new Map(clients.map(client => [client.id, client]));
}
