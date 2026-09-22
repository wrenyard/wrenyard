import type { AgentClient } from '@wrenyard/agent-client';
export type { AccountOptions, AccountSnapshot, AgentClient, AgentEvent, AgentRequest, AgentResult, AgentSession, ClientCapabilities, ClientStatus, ExecutionFeature, InspectOptions, McpServer, NativeClientReadiness, NativeModelAvailability, NativeModelAvailabilityReason, NativeModelAvailabilityStatus, OperationOptions, ReadinessOptions } from '@wrenyard/agent-client';
export { claudeFamilyMcpConfig, resolveMcpServers, requireHttpServer } from '@wrenyard/agent-client/mcp';
export type { ResolvedMcpServer } from '@wrenyard/agent-client/mcp';
export type { OperationOptions as ClientOptions } from '@wrenyard/agent-client';
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
export type { CodeBuddyAccountContext, CodeBuddyProductSnapshot } from '@wrenyard/client-codebuddy';
import { OpenCodeClient } from '@wrenyard/client-opencode';
export { OpenCodeClient } from '@wrenyard/client-opencode';
import { DshClient } from '@wrenyard/client-dsh';
export { DshClient } from '@wrenyard/client-dsh';
export function createAgentClients(): ReadonlyMap<string, AgentClient> {
    const clients: AgentClient[] = [new CodexClient(), new ClaudeClient(), new CursorClient(), new GrokClient(), new CodeBuddyClient(), new OpenCodeClient(), new DshClient()];
    return new Map(clients.map(client => [client.id, client]));
}
export function requireClient(id: string): AgentClient {
    const client = createAgentClients().get(id);
    if (!client)
        throw new Error(`Unknown agent client '${id}'`);
    return client;
}
