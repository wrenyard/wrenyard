import type { ExecutionFeature, McpServer } from '@wrenyard/agent-client';

/** Stable feature id used to select and deduplicate this feature. */
export const BROWSER_USE_FEATURE_ID = 'browser-use';

/**
 * Name the browser-control MCP server is exposed under. Clients namespace their
 * MCP tools by this key, so the agent sees the browser tools under a stable
 * name regardless of which transport the caller supplied.
 */
export const BROWSER_USE_SERVER_NAME = 'browser';

/**
 * Concise operating instructions for the browser-use feature. They lead the
 * prompt and tell the agent how to drive the attached browser tools: navigate,
 * inspect, interact, and report — without inventing a second browsing surface.
 */
const BROWSER_USE_INSTRUCTIONS = [
    'A browser-control MCP server is attached for this run.',
    'Use its tools to navigate pages, read the rendered DOM, click, type, and take screenshots as needed to complete the task.',
    'Prefer the attached browser tools over shelling out to a headless browser, and quote the exact URL you loaded when reporting results.',
].join(' ');

/**
 * Build the browser-use execution feature from an already-resolved MCP server.
 * The caller owns which server is attached (for example the Wrenyard MCP
 * endpoint); this feature only names it and supplies the usage instructions.
 */
export function createBrowserUseFeature(server: McpServer): ExecutionFeature {
    return {
        id: BROWSER_USE_FEATURE_ID,
        instructions: BROWSER_USE_INSTRUCTIONS,
        mcpServers: { [BROWSER_USE_SERVER_NAME]: server },
    };
}
