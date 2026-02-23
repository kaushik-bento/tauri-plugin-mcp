import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";

export function registerFillFormTool(server: McpServer) {
  server.tool(
    "fill_form",
    "Fills multiple form fields in a single call. Each field is targeted by ref (from get_page_map) or by selector. Supports inputs, textareas, selects, and contentEditable elements. Optionally clicks a submit button ref after filling. Call get_page_map first to obtain refs for the form fields.",
    {
      window_label: z.string().default("main").describe("The window containing the form. Defaults to 'main'."),
      fields: z.array(z.object({
        ref: z.number().int().optional().describe("Element ref number from get_page_map."),
        selector_type: z.enum(["id", "class", "css", "tag", "text"]).optional().describe("Selector type to find the element. Used when ref is not provided."),
        selector_value: z.string().optional().describe("Selector value to find the element. Used when ref is not provided."),
        value: z.string().describe("The value to enter into the field."),
        clear: z.boolean().default(true).describe("Whether to clear the field before entering text. Default: true."),
      })).describe("Array of fields to fill. Each field must have either a ref or selector_type + selector_value."),
      submit_ref: z.number().int().optional().describe("Ref number of a submit button to click after all fields are filled."),
    },
    {
      title: "Fill Form",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    async ({ window_label, fields, submit_ref }) => {
      try {
        const payload: Record<string, unknown> = { window_label, fields };
        if (submit_ref !== undefined) payload.submit_ref = submit_ref;

        logCommandParams('fill_form', payload);

        const result = await socketClient.sendCommand('fill_form', payload);

        if (!result || typeof result !== 'object') {
          return createErrorResponse('Failed to get a valid response');
        }

        if ('success' in result && !result.success) {
          return createErrorResponse(result.error as string || 'fill_form failed');
        }

        const data = result.data ?? result;
        return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
      } catch (error) {
        console.error('fill_form error:', error);
        return createErrorResponse(`Failed to fill form: ${(error as Error).message}`);
      }
    },
  );
}
