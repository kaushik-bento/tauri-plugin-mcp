# Source Code Review: tauri-plugin-mcp

**Review Date:** 2026-02-24
**Reviewer:** Claude (automated)
**Scope:** Full repository — Rust plugin core, TypeScript MCP server, guest JS, build configuration, security model

---

## Executive Summary

`tauri-plugin-mcp` is a Tauri v2 plugin that exposes GUI interaction capabilities (screenshots, DOM access, input simulation, window management) to AI agents via the Model Context Protocol (MCP). The architecture is sound: a Rust socket server inside the Tauri app routes commands to tool handlers, a TypeScript MCP server bridges stdio to the socket, and guest JavaScript handles DOM-side operations via Tauri events.

The project is functional and well-structured for its stage of development. This review identifies **security concerns, correctness bugs, robustness gaps, code quality issues, and architectural suggestions** organized by severity.

---

## Critical Issues

### 1. Arbitrary JavaScript Execution Without Sandboxing
**Files:** `guest-js/index.ts:499-508`, `mcp-server-ts/src/tools/execute_js.ts`

The `executeJavaScript` function uses `new Function()` to run arbitrary code supplied over the socket:

```typescript
function executeJavaScript(code: string): any {
    try {
        return new Function(`return (${code})`)();
    } catch {
        return new Function(code)();
    }
}
```

Any client that can connect to the IPC/TCP socket can execute arbitrary JavaScript in the webview context. This is the plugin's intended functionality, but:
- There is **no authentication** on socket connections.
- There is **no allowlist/blocklist** for JS operations.
- TCP mode (`0.0.0.0`) would expose this to the network.

**Recommendation:** Add authentication tokens to socket connections. At minimum, document the security implications prominently. Consider restricting TCP binding to `127.0.0.1` by default and requiring an explicit opt-in for non-loopback addresses.

### 2. TCP Socket Can Bind to All Interfaces
**File:** `src/socket_server.rs:176-184`

When configured with `SocketType::Tcp`, the server will bind to whatever host is provided, including `0.0.0.0`. Combined with the lack of authentication, this creates a remote code execution vector.

**Recommendation:** Default TCP to `127.0.0.1`. If a user passes `0.0.0.0`, log a warning about the security implications. Ideally require an authentication token for TCP connections.

### 3. Mobile Module Compiles but Panics Unconditionally
**File:** `src/lib.rs:165`

```rust
#[cfg(mobile)]
panic!("Mobile is not supported");
```

This will crash the application at runtime rather than providing a graceful error. Additionally, `src/mobile.rs` imports `crate::commands::SocketInfoResponse` which doesn't exist (the `commands.rs` file is empty), so the mobile build likely fails at compile time too.

**Recommendation:** Return an error from the setup function instead of panicking. Remove or fix the mobile module's dead imports.

---

## High Severity Issues

### 4. Stale Socket File Prevents Startup (Unix/macOS)
**File:** `src/socket_server.rs:166-173`

If the application crashes or is killed, the Unix domain socket file at `/tmp/tauri-mcp.sock` persists. On next startup, `create_sync()` fails with `AddrInUse`. The error message tells the user to "remove it manually" but the code doesn't attempt cleanup.

**Recommendation:** Before creating the listener, check if the socket file exists and try to remove it (or connect to verify it's live). This is standard practice for Unix domain sockets:

```rust
if path.exists() {
    std::fs::remove_file(&path).ok();
}
```

### 5. Panic Hook Replacement is Unsafe for Multi-threaded Programs
**File:** `src/socket_server.rs:211-231, 257-277`

The listener thread and each client handler thread call `std::panic::take_hook()` and `std::panic::set_hook()`. This is a global operation that is **not thread-safe** — if multiple client threads do this concurrently, hooks can be lost. Furthermore, the original hook captured in the listener thread is moved into the closure and is never restored.

**Recommendation:** Instead of replacing the global panic hook, use `std::panic::catch_unwind()` around the specific operations that may panic due to Windows pipe errors. This is local and thread-safe.

### 6. Listener Thread Holds Mutex Lock Forever
**File:** `src/socket_server.rs:233`

```rust
let listener_guard = listener.lock().unwrap();
```

The listener thread acquires the mutex and never releases it (the guard lives until the loop exits). This means `stop()` cannot signal the thread to exit via the listener, and any other code trying to access the listener will deadlock.

**Recommendation:** The listener doesn't need to be behind a `Mutex` since only the listener thread uses it after initialization. Consider passing ownership to the thread directly, or using an `Arc` without a `Mutex`.

### 7. `thread::sleep` Blocking in Async Context
**Files:** `src/desktop.rs:399-401, 411-417`

`simulate_text_input_async` uses `thread::sleep` for delays between keystrokes. Despite being an `async fn`, it blocks the entire tokio thread. This is already somewhat mitigated by `spawn_blocking` usage in some paths, but the text input function itself is called directly in async context.

**Recommendation:** Use `tokio::time::sleep` instead, or ensure this code always runs inside `spawn_blocking`.

### 8. New Tokio Runtime Created Per Request in Multiple Places
**Files:** `src/socket_server.rs:410-411`, `src/desktop.rs:512-513`, `src/tools/mouse_movement.rs:174-175`

Several functions create a brand-new `tokio::runtime::Runtime` per invocation:

```rust
let rt = tokio::runtime::Runtime::new()...
```

Creating a runtime is expensive and can fail under resource pressure. The `handle_client` function creates one per client connection, which means each concurrent client gets its own runtime with its own thread pool.

**Recommendation:** Share a single runtime across the plugin. The Tauri app already has a tokio runtime — use `tokio::runtime::Handle::current()` where possible (already done in `manage_window_shared` at `desktop.rs:498`). For consistency, do the same everywhere, or create one runtime at plugin initialization and share it.

---

## Medium Severity Issues

### 9. `base64::encode` Is Deprecated
**File:** `src/tools/take_screenshot.rs:121, 180`

The `base64` crate v0.13.0 is used with the deprecated `base64::encode()` function. The current `base64` crate (v0.22+) uses `base64::engine::general_purpose::STANDARD.encode()`.

**Recommendation:** Update `base64` to a modern version and use the `Engine` API.

### 10. `image` Crate Version Is Outdated
**File:** `Cargo.toml:15`

`image = "0.24.7"` — the current version is 0.25.x. The code uses `image::ImageOutputFormat::Jpeg` which was renamed in 0.25.

**Recommendation:** Consider updating, though this will require adapting the API calls.

### 11. Race Condition in Event-Based Communication Pattern
**Files:** `src/tools/execute_js.rs:131-137`, `src/tools/local_storage.rs:148-154`, `src/tools/webview.rs:116-121`

The pattern used throughout is:
1. Emit an event to the webview
2. Register a `once` listener for the response
3. Wait on a channel with timeout

If two commands of the same type are sent concurrently, the `once` listener for the second command could receive the first command's response (event names like `"execute-js-response"` are not unique per request).

**Recommendation:** Include a unique request ID in the emitted event and filter responses by that ID. Alternatively, serialize access to each command type.

### 12. Hardcoded Default Socket Path
**Files:** `src/socket_server.rs:128-133`, `mcp-server-ts/src/tools/client.ts:7-8`

The socket path defaults to `/tmp/tauri-mcp.sock` (Rust) and `/private/tmp/tauri-mcp.sock` (TypeScript). If multiple Tauri apps using this plugin run simultaneously, they'll conflict on the same socket path.

**Recommendation:** Include the application name in the default socket path, e.g., `/tmp/tauri-mcp-{app_name}.sock`. The `application_name` field already exists in `PluginConfig` but isn't used for path generation.

### 13. Unix Screenshot Returns Hardcoded Placeholder Image
**File:** `src/platform/unix.rs:72-81`

The Unix (Linux) screenshot implementation calls `webview_window.eval()` with a canvas-based approach, but `eval()` in Tauri v2 doesn't return a value. The code returns a hardcoded 1x1 pixel JPEG regardless of what's on screen.

**Recommendation:** Either implement a real screenshot mechanism for Linux (e.g., using X11/Wayland APIs, or a headless browser approach) or clearly document that screenshots are not supported on Linux and return an error.

### 14. `WindowManagerRequest` Missing `Serialize` Derive
**File:** `src/models.rs:204`

```rust
#[derive(Debug, Deserialize)]
pub struct WindowManagerRequest {
```

This struct derives `Deserialize` but not `Serialize`. While this doesn't cause a compile error currently, it's inconsistent with all other models and prevents this type from being used in contexts that require serialization.

### 15. Inconsistent Serde Naming Conventions
**File:** `src/models.rs`

Most models use `#[serde(rename_all = "camelCase")]` but `ScreenshotRequest` uses `#[serde(rename_all = "snake_case")]` (line 117), and `WindowManagerRequest`/`WindowManagerResponse` have no rename attribute at all. This creates an inconsistent wire format.

**Recommendation:** Pick one naming convention (snake_case is more idiomatic for Rust IPC, camelCase for JS interop) and apply it consistently.

---

## Low Severity Issues

### 16. Empty `commands.rs` File
**File:** `src/commands.rs`

This file is empty but still imported. The `build.rs` generates permission files for commands that don't correspond to actual Tauri command handlers (the invoke_handler in `lib.rs:159-161` is empty).

**Recommendation:** Either remove the file and its module declaration, or add the commands if they're planned.

### 17. `mobile.rs` References Non-existent Type
**File:** `src/mobile.rs:8`

```rust
use crate::commands::SocketInfoResponse;
```

`SocketInfoResponse` doesn't exist in the empty `commands.rs`. This import would cause a compile error on mobile targets.

### 18. Excessive Logging
**Files:** Throughout, especially `src/socket_server.rs`, `src/tools/mouse_movement.rs`

The `LoggingStream` wrapper logs every byte read/written on the socket. The mouse_movement handler logs 15+ info-level messages per movement. This creates significant log noise in production.

**Recommendation:** Move verbose logging to `debug!` or `trace!` level. Remove the `LoggingStream` wrapper or make it opt-in behind a feature flag.

### 19. `get_dom_text` Has Unnecessary `#[tauri::command]` Attribute
**File:** `src/tools/webview.rs:109`

```rust
#[tauri::command]
pub async fn get_dom_text<R: Runtime>(...)
```

This function is called internally, not as a Tauri command. The attribute is dead code.

### 20. No Request Timeout on IPC Listener
**File:** `src/socket_server.rs:243`

The IPC listener loop (`ipc_listener.incoming()`) blocks indefinitely. Unlike TCP which uses `set_nonblocking(true)` + polling, the IPC path has no way to check the `running` flag between connections, so `stop()` won't take effect until the next client connects.

**Recommendation:** Use non-blocking mode or a timeout for the IPC listener as well.

### 21. `findElementByText` Performance
**File:** `guest-js/index.ts:207-263`

This function iterates all DOM elements (`document.querySelectorAll('*')`) twice — once for exact match and once for partial match. On large DOMs this could be slow.

**Recommendation:** Combine into a single pass, or use `TreeWalker` for text content matching which is more efficient.

### 22. Duplicate Element-Finding Logic
**File:** `guest-js/index.ts`

The switch statement for finding elements by selector type (id, class, tag, text) is duplicated between `handleGetElementPositionRequest` (lines 54-122) and `handleSendTextToElementRequest` (lines 521-557).

**Recommendation:** Extract into a shared helper function (e.g., `findElementBySelector(type, value)`).

### 23. `document.execCommand` Is Deprecated
**File:** `guest-js/index.ts:862, 933-934, 952`

The Lexical and Slate editor typing helpers use `document.execCommand('insertText', ...)` which is deprecated and may be removed from browsers.

**Recommendation:** Use `InputEvent` with `inputType: 'insertText'` dispatched on the target element, or use the `Clipboard` API as a fallback mechanism.

---

## Architectural Observations

### Positive Aspects
- **Clean separation of concerns:** Rust plugin core, TypeScript MCP server, and guest JS are well-separated with clear boundaries.
- **Multi-webview support:** The `WebviewFallbackConfig` and `get_webview_for_eval`/`get_emit_target` helpers handle both simple and complex Tauri window architectures.
- **Platform abstraction:** The `platform/` module with compile-time selection is clean and extensible.
- **Graceful error handling on Windows:** The pipe disconnection handling is thorough.
- **MCP tool metadata:** Tool descriptions, hints (`readOnlyHint`, `destructiveHint`, etc.), and Zod schema documentation are well-crafted for AI agent consumption.

### Areas for Improvement
- **No tests:** There are zero unit tests, integration tests, or end-to-end tests in the repository. This is the single biggest gap for reliability.
- **No CI/CD:** No GitHub Actions or similar CI configuration exists.
- **Error handling inconsistency:** Some functions return `Result<SocketResponse, Error>` with error data inside the response (success=false), while others return `Err(...)`. The socket layer converts all errors to response-level errors, but the inconsistency makes the tool handlers harder to reason about.
- **Event-based RPC is fragile:** The emit/listen/channel pattern for webview communication has inherent race conditions (see issue #11). A request-ID-based correlation would be more robust.
- **Default permissions are empty:** `permissions/default.toml` grants no permissions. Users must explicitly enable each capability, which is secure but should be documented more clearly.

---

## Dependency Audit

| Crate/Package | Version | Status |
|---|---|---|
| `base64` | 0.13.0 | **Outdated** — current is 0.22.x |
| `image` | 0.24.7 | **Outdated** — current is 0.25.x |
| `enigo` | 0.3.0 | Current for 0.x series |
| `interprocess` | 2.2.3 | Current |
| `tauri` | 2.5.0 | Current |
| `xcap` | 0.0.4 | Early/unstable |
| `@modelcontextprotocol/sdk` | 1.11.1 | Current |
| `zod` | 3.24.4 | Current |

---

## Summary of Recommendations by Priority

1. **Add socket authentication** for both IPC and TCP connections
2. **Restrict TCP binding** to loopback by default
3. **Clean up stale socket files** on startup
4. **Fix the event-based RPC race condition** with request IDs
5. **Share the tokio runtime** instead of creating new ones per request
6. **Replace panic hook manipulation** with `catch_unwind`
7. **Add tests** — at minimum for the tool command routing and socket protocol
8. **Update outdated dependencies** (`base64`, `image`)
9. **Fix mobile compilation** (remove dead imports, replace `panic!` with error)
10. **Use `application_name`** in default socket path to avoid conflicts
