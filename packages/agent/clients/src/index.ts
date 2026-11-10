import type { AgentClient } from '@wrenyard/agent';
import { CodexClient } from '@wrenyard/client-codex';
export { readCodexGatewayCredential, refreshCodexGatewayCredential } from '@wrenyard/client-codex';
export type { CodexGatewayAuthOptions, CodexGatewayCredential } from '@wrenyard/client-codex';
export { readCodexModels } from '@wrenyard/client-codex';
export type { CodexModelDiscovery } from '@wrenyard/client-codex';
import { ClaudeClient } from '@wrenyard/client-claude';
import { CursorClient } from '@wrenyard/client-cursor';
import { GrokClient } from '@wrenyard/client-grok';
import { CodeBuddyClient } from '@wrenyard/client-codebuddy';
export { CodeBuddyClient } from '@wrenyard/client-codebuddy';
import { OpenCodeClient } from '@wrenyard/client-opencode';
import { DshClient } from '@wrenyard/client-dsh';
import { PiClient } from '@wrenyard/client-pi';
import { KimiClient } from '@wrenyard/client-kimi';
export function createAgentClients(): ReadonlyMap<string, AgentClient> {
    const clients: AgentClient[] = [new CodexClient(), new ClaudeClient(), new CursorClient(), new GrokClient(), new CodeBuddyClient(), new OpenCodeClient(), new DshClient(), new PiClient(), new KimiClient()];
    return new Map(clients.map(client => [client.id, client]));
}
export function requireClient(id: string): AgentClient {
    const client = createAgentClients().get(id);
    if (!client)
        throw new Error(`Unknown agent client '${id}'`);
    return client;
}
