import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";

export function registerGetPageStateTool(server: McpServer) {
  server.tool(
    "get_page_state",
    "Returns lightweight page metadata: current URL, document title, readyState, scroll position, and viewport size. Use this for quick state checks (e.g., confirming navigation succeeded) without the overhead of get_dom or get_page_map.",
    {
      window_label: z.string().default("main").describe("The window to query. Defaults to 'main'."),
    },
    {
      title: "Get Page State",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ window_label }) => {
      try {
        const payload = { window_label };
        logCommandParams('get_page_state', payload);

        const result = await socketClient.sendCommand('get_page_state', payload);

        if (!result || typeof result !== 'object') {
          return createErrorResponse('Failed to get a valid response');
        }

        if ('success' in result && !result.success) {
          return createErrorResponse(result.error as string || 'get_page_state failed');
        }

        const data = result.data ?? result;
        return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
      } catch (error) {
        console.error('get_page_state error:', error);
        return createErrorResponse(`Failed to get page state: ${(error as Error).message}`);
      }
    },
  );
}
