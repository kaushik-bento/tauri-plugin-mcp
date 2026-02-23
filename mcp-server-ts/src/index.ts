import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools, initializeSocket } from "./tools/index.js";

// Create server instance
const server = new McpServer({
  name: "tauri-mcp",
  version: "1.0.0",
  instructions: "Workflow: Use get_page_map to get numbered refs for interactive elements, then use those refs with get_element_position, send_text_to_element, scroll_page, or fill_form. Use get_page_state for lightweight URL/readyState checks. Prefer get_page_map over get_dom for structured element access.",
  capabilities: {
    resources: {},
    tools: {},
  },
});

async function main() {
  try {
    // Connect to the Tauri socket server at startup
    await initializeSocket();
    
    // Register all tools with the server
    registerAllTools(server);
    
    // Connect the server to stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Tauri MCP Server running on stdio");
  } catch (error) {
    console.error("Fatal error in main():", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
