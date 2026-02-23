import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";

export function registerScrollPageTool(server: McpServer) {
  server.tool(
    "scroll_page",
    "Scrolls the page in the specified direction by one viewport height (default), half viewport, or a pixel amount. Can also scroll to a specific element ref from get_page_map, or jump to the top/bottom of the page. Returns the resulting scroll position and page dimensions.",
    {
      window_label: z.string().default("main").describe("The window to scroll. Defaults to 'main'."),
      direction: z.enum(["down", "up"]).default("down").describe("Scroll direction. Only used when scrolling by amount (ignored for to_ref/to_top/to_bottom)."),
      amount: z.union([z.number(), z.literal("page"), z.literal("half")]).optional().describe("Scroll amount: pixel count, 'page' (one viewport height), or 'half' (half viewport). Default: one full page."),
      to_ref: z.number().int().optional().describe("Scroll to bring the element with this ref number (from get_page_map) into view."),
      to_top: z.boolean().default(false).describe("Scroll to the top of the page."),
      to_bottom: z.boolean().default(false).describe("Scroll to the bottom of the page."),
    },
    {
      title: "Scroll Page",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async ({ window_label, direction, amount, to_ref, to_top, to_bottom }) => {
      try {
        const payload: Record<string, unknown> = { window_label, direction, to_top, to_bottom };
        if (amount !== undefined) payload.amount = amount;
        if (to_ref !== undefined) payload.to_ref = to_ref;

        logCommandParams('scroll_page', payload);

        const result = await socketClient.sendCommand('scroll_page', payload);

        if (!result || typeof result !== 'object') {
          return createErrorResponse('Failed to get a valid response');
        }

        if ('success' in result && !result.success) {
          return createErrorResponse(result.error as string || 'scroll_page failed');
        }

        const data = result.data ?? result;
        return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
      } catch (error) {
        console.error('scroll_page error:', error);
        return createErrorResponse(`Failed to scroll: ${(error as Error).message}`);
      }
    },
  );
}
