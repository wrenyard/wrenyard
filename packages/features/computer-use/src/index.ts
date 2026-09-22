import type { ExecutionFeature, McpServer } from '@wrenyard/agent-client';

/** Stable feature id used to select and deduplicate this feature. */
export const COMPUTER_USE_FEATURE_ID = 'computer-use';

/**
 * Name the desktop-control MCP server is exposed under. Clients namespace their
 * MCP tools by this key, so the agent sees the desktop tools under a stable
 * name regardless of which transport the caller supplied.
 */
export const COMPUTER_USE_SERVER_NAME = 'computer';

/**
 * Concise operating instructions for the computer-use feature. They lead the
 * prompt and tell the agent how to drive the attached desktop-control tools:
 * observe the screen, act at coordinates, verify the result, and stay within
 * the task's window.
 */
const COMPUTER_USE_INSTRUCTIONS = [
    'A desktop-control MCP server is attached for this run.',
    'Use its tools to inspect the screen, move the pointer, click, type, and press keys, then verify each action by re-reading the screen before continuing.',
    'Limit interaction to the windows relevant to the task and describe any state you changed.',
].join(' ');

/**
 * Build the computer-use execution feature from an already-resolved MCP server.
 * The caller owns which server is attached (for example the Wrenyard MCP
 * endpoint); this feature only names it and supplies the usage instructions.
 */
export function createComputerUseFeature(server: McpServer): ExecutionFeature {
    return {
        id: COMPUTER_USE_FEATURE_ID,
        instructions: COMPUTER_USE_INSTRUCTIONS,
        mcpServers: { [COMPUTER_USE_SERVER_NAME]: server },
    };
}
