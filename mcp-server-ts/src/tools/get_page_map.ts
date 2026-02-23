import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";

export function registerGetPageMapTool(server: McpServer) {
  server.tool(
    "get_page_map",
    "Returns a structured JSON map of all interactive elements on the page, each with a numbered ref. Use these refs with get_element_position, send_text_to_element, scroll_page, or fill_form for reliable element targeting. Prefer this over get_dom for structured element access. Options: scope to a CSS selector, limit depth, request only interactive elements, enable delta mode to get changes since last call, or wait for DOM mutations to settle before scanning.",
    {
      window_label: z.string().default("main").describe("The window to scan. Defaults to 'main'."),
      include_content: z.boolean().default(true).describe("Include page text content in the response. Set false to reduce payload size."),
      interactive_only: z.boolean().default(false).describe("Only return interactive elements (buttons, inputs, links, etc.). Skips text content."),
      scope_selector: z.union([z.string(), z.array(z.string())]).optional().describe("CSS selector(s) to limit the scan scope. Only elements within matching containers are included."),
      max_depth: z.number().int().nonnegative().optional().describe("Maximum DOM tree depth to recurse from the scope root."),
      delta: z.boolean().default(false).describe("Return only changes (added/removed/changed refs) since the previous get_page_map call."),
      wait_for_stable: z.boolean().default(false).describe("Wait for DOM mutations to settle before scanning. Useful after navigation or dynamic content loading."),
      quiet_ms: z.number().int().nonnegative().optional().describe("Milliseconds of mutation silence required before considering DOM stable. Default: 300."),
      max_wait_ms: z.number().int().nonnegative().optional().describe("Maximum milliseconds to wait for DOM stability. Default: 3000."),
      timeout_secs: z.number().int().positive().optional().describe("Rust-side timeout in seconds for the entire operation. Default: 10."),
    },
    {
      title: "Get Page Map",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async ({ window_label, include_content, interactive_only, scope_selector, max_depth, delta, wait_for_stable, quiet_ms, max_wait_ms, timeout_secs }) => {
      try {
        const payload: Record<string, unknown> = {
          window_label,
          include_content,
          interactive_only,
          delta,
          wait_for_stable,
        };
        if (scope_selector !== undefined) payload.scope_selector = scope_selector;
        if (max_depth !== undefined) payload.max_depth = max_depth;
        if (quiet_ms !== undefined) payload.quiet_ms = quiet_ms;
        if (max_wait_ms !== undefined) payload.max_wait_ms = max_wait_ms;
        if (timeout_secs !== undefined) payload.timeout_secs = timeout_secs;

        logCommandParams('get_page_map', payload);

        const result = await socketClient.sendCommand('get_page_map', payload);

        if (!result || typeof result !== 'object') {
          return createErrorResponse('Failed to get a valid response');
        }

        if ('success' in result && !result.success) {
          return createErrorResponse(result.error as string || 'get_page_map failed');
        }

        // The data may be nested under result.data or at top level
        const data = result.data ?? result;
        return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
      } catch (error) {
        console.error('get_page_map error:', error);
        return createErrorResponse(`Failed to get page map: ${(error as Error).message}`);
      }
    },
  );
}
