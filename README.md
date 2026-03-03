# automate-tauri-desktop-app

A Tauri v2 plugin and MCP server that let AI agents (Claude Code, Cursor, etc.) interact with your desktop app — screenshots, DOM access, clicking, typing, scrolling, and more.

Forked from [P3GLEG/tauri-plugin-mcp](https://github.com/P3GLEG/tauri-plugin-mcp) with reliability fixes for real-world Claude Code usage.

## What's fixed in this fork

- Smart screenshot capture without stealing window focus (macOS)
- Fullscreen/maximized window screenshot support
- Auto-focus before interactive tools (click, type, scroll)
- Auto-initialization of plugin listeners on import
- Vite HMR support (listeners re-register on hot reload)
- Adaptive scroll wait (replaces fixed 350ms timeout)
- Page map budgets to prevent runaway DOM walks on large pages
- `querySelectorAll` for scope selectors (returns all matches, not just first)
- Shebang in MCP server build output for direct CLI execution

## Install

### npm (guest-js bindings)
```bash
npm install @bento/automate-tauri-desktop-app
```

### MCP Server CLI
```bash
npm install -g @bento/automate-tauri-desktop-app-server
# or run directly
npx @bento/automate-tauri-desktop-app-server
```

### Rust (Cargo)
```toml
[dependencies]
tauri-plugin-mcp = { git = "https://github.com/kaushik-bento/tauri-plugin-mcp" }
```

## Tools

The MCP server exposes 10 tools to AI agents:

| Tool | Description |
|------|-------------|
| **take_screenshot** | Captures window screenshot. Saves full image to disk with small thumbnail inline (token-efficient). No focus steal on macOS. |
| **query_page** | Inspect page. Modes: `map` (numbered element refs), `html` (raw DOM), `state` (URL/title/scroll), `find_element` (CSS pixel coords), `app_info` (app metadata). |
| **click** | Click at x/y or by selector (ref, id, class, tag, text). Auto-resolves element position. |
| **type_text** | Type into focused element, target by selector, or batch-fill forms via `fields` array. Works with inputs, textareas, contentEditable, React, Lexical, Slate. |
| **mouse_action** | Hover, scroll (direction/amount/ref/top/bottom), or drag. |
| **navigate** | `goto` URL, `back`/`forward` with optional delta, `reload`. |
| **execute_js** | Run arbitrary JS in the webview. Universal escape hatch. |
| **manage_storage** | localStorage get/set/remove/clear/keys. Cookies get/clear. |
| **manage_window** | List/focus/minimize/maximize/close windows, zoom, devtools, webview state. |
| **wait_for** | Wait for text/element to appear or disappear. Use after async actions. |

## Setup

### 1. Register the plugin in your Tauri app

Only include in development builds:

```rust
#[cfg(debug_assertions)]
{
    builder = builder.plugin(tauri_plugin_mcp::init_with_config(
        tauri_plugin_mcp::PluginConfig::new("YOUR_APP_NAME".to_string())
            .start_socket_server(true)
            // IPC socket (default — recommended)
            .socket_path("/tmp/tauri-mcp.sock")
            // Or TCP: .tcp_localhost(4000)
            // Multi-webview: .default_webview_label("preview".to_string())
            // Auth for TCP: .auth_token("my-secret-token".to_string())
    ));
}
```

### 2. Import guest-js (auto-initializes)

```ts
import '@bento/automate-tauri-desktop-app';
// Listeners register automatically on import — no setup call needed.
// HMR is handled automatically if using Vite.
```

### 3. Configure your AI agent

#### IPC Mode (default, recommended)

```json
{
  "mcpServers": {
    "tauri-mcp": {
      "command": "npx",
      "args": ["@bento/automate-tauri-desktop-app-server"]
    }
  }
}
```

Custom socket path:
```json
{
  "mcpServers": {
    "tauri-mcp": {
      "command": "npx",
      "args": ["@bento/automate-tauri-desktop-app-server"],
      "env": {
        "TAURI_MCP_IPC_PATH": "/custom/path/to/socket"
      }
    }
  }
}
```

#### TCP Mode

For Docker, remote debugging, or when IPC doesn't work:

```json
{
  "mcpServers": {
    "tauri-mcp": {
      "command": "npx",
      "args": ["@bento/automate-tauri-desktop-app-server"],
      "env": {
        "TAURI_MCP_CONNECTION_TYPE": "tcp",
        "TAURI_MCP_TCP_HOST": "127.0.0.1",
        "TAURI_MCP_TCP_PORT": "4000"
      }
    }
  }
}
```

## Building from source

```bash
npm install
npm run build            # JS guest bindings
cargo build --release    # Rust plugin

# MCP server
cd mcp-server-ts
npm install && npm run build
```

## Architecture

```
AI Agent (Claude Code, Cursor, etc.)
    ↕ MCP protocol (stdio)
MCP Server (@bento/automate-tauri-desktop-app-server)
    ↕ IPC socket or TCP
Tauri Plugin (Rust)
    ↕ Tauri events with correlation IDs
Guest JS (webview)
    ↕ DOM APIs
Your Application
```

### Security

- Auth token support for TCP connections (constant-time comparison)
- Token file written with `0o600` permissions, deleted on shutdown
- Non-loopback TCP without auth token is rejected

### Platform notes

- **macOS**: Native `NSEvent` injection — no Accessibility permissions needed. Smart window capture without focus steal.
- **Windows/Linux**: JS-based input fallback (`isTrusted=false`, ~80% coverage)
- **Screenshots**: macOS uses Core Graphics per-window capture; Windows uses native capture; Linux uses `xcap`

## Troubleshooting

1. **"Connection refused"** — Ensure your Tauri app is running and the socket server started. Check both sides use the same connection mode (IPC or TCP).

2. **"Socket file not found" (IPC)** — Check socket path exists (`/tmp` on macOS/Linux). Try TCP mode as alternative.

3. **"Permission denied"** — On Unix, check file permissions for the socket. TCP mode avoids this.

4. **Testing your setup:**
   ```bash
   npx @modelcontextprotocol/inspector npx @bento/automate-tauri-desktop-app-server
   ```

## License

MIT
