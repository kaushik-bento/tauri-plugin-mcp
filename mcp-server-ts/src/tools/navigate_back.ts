import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";

export function registerNavigateBackTool(server: McpServer) {
  server.tool(
    "navigate_back",
    "Navigates the webview through browser history. Goes back or forward one step by default, or jumps multiple steps with the delta parameter (negative = back, positive = forward). Returns the resulting URL and title. Use get_page_state afterward to confirm the page loaded.",
    {
      window_label: z.string().default("main").describe("The window to navigate. Defaults to 'main'."),
      direction: z.enum(["back", "forward"]).default("back").describe("Direction to navigate in history. Ignored if delta is provided."),
      delta: z.number().int().optional().describe("Number of history steps to jump. Negative goes back, positive goes forward. Overrides direction when provided."),
    },
    {
      title: "Navigate Back/Forward",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async ({ window_label, direction, delta }) => {
      try {
        const payload: Record<string, unknown> = { window_label, direction };
        if (delta !== undefined) payload.delta = delta;

        logCommandParams('navigate_back', payload);

        const result = await socketClient.sendCommand('navigate_back', payload);

        if (!result || typeof result !== 'object') {
          return createErrorResponse('Failed to get a valid response');
        }

        if ('success' in result && !result.success) {
          return createErrorResponse(result.error as string || 'navigate_back failed');
        }

        const data = result.data ?? result;
        return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
      } catch (error) {
        console.error('navigate_back error:', error);
        return createErrorResponse(`Failed to navigate: ${(error as Error).message}`);
      }
    },
  );
}
