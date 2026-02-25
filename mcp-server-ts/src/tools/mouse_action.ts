import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { socketClient } from "./client.js";
import { createErrorResponse, createSuccessResponse, logCommandParams } from "./response-helpers.js";

export function registerMouseActionTool(server: McpServer) {
  server.tool(
    "mouse_action",
    "Performs non-click mouse actions. 'hover' moves the cursor to coordinates (triggers hover effects). 'scroll' scrolls the page by direction/amount, to an element ref, or to top/bottom. 'drag' moves from start to end coordinates (best-effort, two sequential moves).",
    {
      action: z.enum(["hover", "scroll", "drag"]).describe("The mouse action: 'hover' to move cursor, 'scroll' to scroll page, 'drag' for drag gesture."),
      // hover / drag params
      x: z.number().optional().describe("(hover/drag) Target X coordinate in CSS pixels."),
      y: z.number().optional().describe("(hover/drag) Target Y coordinate in CSS pixels."),
      relative: z.boolean().optional().describe("(hover) If true, x/y are relative offsets from current position."),
      // drag end coordinates
      end_x: z.number().optional().describe("(drag) End X coordinate."),
      end_y: z.number().optional().describe("(drag) End Y coordinate."),
      // scroll params
      direction: z.enum(["down", "up"]).optional().describe("(scroll) Scroll direction. Default: 'down'."),
      amount: z.union([z.number(), z.literal("page"), z.literal("half")]).optional().describe("(scroll) Pixel count, 'page', or 'half'. Default: one full page."),
      to_ref: z.number().int().optional().describe("(scroll) Scroll to bring this element ref into view."),
      to_top: z.boolean().optional().describe("(scroll) Scroll to top of page."),
      to_bottom: z.boolean().optional().describe("(scroll) Scroll to bottom of page."),
      // common
      window_label: z.string().optional().describe("Target window. Defaults to 'main'."),
    },
    {
      title: "Mouse Action (Hover, Scroll, Drag)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async (params) => {
      try {
        const { action, window_label } = params;

        switch (action) {
          case "hover": {
            if (params.x === undefined || params.y === undefined) {
              return createErrorResponse("x and y are required for hover action");
            }

            const payload: Record<string, unknown> = {
              x: Math.round(params.x),
              y: Math.round(params.y),
              relative: params.relative,
              click: false,
              window_label,
            };

            logCommandParams('simulate_mouse_movement', payload);
            await socketClient.sendCommand('simulate_mouse_movement', payload);

            return createSuccessResponse(
              `Moved mouse to (${Math.round(params.x)}, ${Math.round(params.y)})${params.relative ? ' (relative)' : ''}`
            );
          }

          case "scroll": {
            const payload: Record<string, unknown> = {
              window_label: window_label ?? "main",
              direction: params.direction ?? "down",
              to_top: params.to_top ?? false,
              to_bottom: params.to_bottom ?? false,
            };
            if (params.amount !== undefined) payload.amount = params.amount;
            if (params.to_ref !== undefined) payload.to_ref = params.to_ref;

            logCommandParams('scroll_page', payload);
            const result = await socketClient.sendCommand('scroll_page', payload);

            if (!result || typeof result !== 'object') {
              return createErrorResponse('Failed to get a valid response');
            }
            if ('success' in result && !result.success) {
              return createErrorResponse(result.error as string || 'scroll failed');
            }

            const data = result.data ?? result;
            return createSuccessResponse(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
          }

          case "drag": {
            if (params.x === undefined || params.y === undefined ||
                params.end_x === undefined || params.end_y === undefined) {
              return createErrorResponse("x, y, end_x, and end_y are required for drag action");
            }

            const startX = Math.round(params.x);
            const startY = Math.round(params.y);
            const endX = Math.round(params.end_x);
            const endY = Math.round(params.end_y);

            // Step 1: Press mouse button at start position
            logCommandParams('simulate_mouse_movement (drag down)', { x: startX, y: startY, mouse_down: true, window_label });
            await socketClient.sendCommand('simulate_mouse_movement', {
              x: startX,
              y: startY,
              mouse_down: true,
              window_label,
            });

            // Step 2: Move to end position (button held)
            logCommandParams('simulate_mouse_movement (drag move)', { x: endX, y: endY, window_label });
            await socketClient.sendCommand('simulate_mouse_movement', {
              x: endX,
              y: endY,
              window_label,
            });

            // Step 3: Release mouse button at end position
            logCommandParams('simulate_mouse_movement (drag up)', { x: endX, y: endY, mouse_up: true, window_label });
            await socketClient.sendCommand('simulate_mouse_movement', {
              x: endX,
              y: endY,
              mouse_up: true,
              window_label,
            });

            return createSuccessResponse(
              `Dragged from (${startX}, ${startY}) to (${endX}, ${endY})`
            );
          }

          default:
            return createErrorResponse(`Unknown action: ${action}`);
        }
      } catch (error) {
        console.error('mouse_action error:', error);
        return createErrorResponse(`Failed to perform mouse action: ${(error as Error).message}`);
      }
    },
  );
}
