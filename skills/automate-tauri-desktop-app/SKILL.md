---
name: automate-tauri-desktop-app
description: >
  Automate Tauri v2 desktop applications via MCP tools exposed by tauri-plugin-mcp.
  Use when an AI agent needs to interact with a Tauri app — take screenshots,
  click elements, type text, scroll, navigate, query the DOM, fill forms,
  manage windows, or execute JavaScript inside the webview. Covers the full
  workflow from discovering the page to performing multi-step UI automation.
---

# Automate Tauri Desktop Apps with tauri-plugin-mcp

## Available MCP Tools

| Tool | Purpose |
|------|---------|
| `query_page` | Inspect page: element map with refs, raw HTML, page state, find element coords, app info |
| `click` | Click at coordinates or by selector/ref |
| `type_text` | Type into focused element, targeted element, or batch-fill form fields |
| `take_screenshot` | Capture window screenshot (saves to disk + inline thumbnail by default) |
| `mouse_action` | Hover, scroll (direction/amount/ref/top/bottom), or drag |
| `navigate` | Go to URL, back, forward, reload |
| `wait_for` | Wait for text/element to appear or disappear |
| `execute_js` | Run arbitrary JS in the webview (escape hatch) |
| `manage_window` | List/focus/minimize/maximize/close windows, zoom, devtools |
| `manage_storage` | localStorage get/set/remove/clear, cookies get/clear |

## Standard Workflow

1. **Discover** — Start with `query_page(mode='app_info')` to learn the app name, windows, and environment.
2. **Map** — Call `query_page(mode='map')` to get a numbered element map. Each interactive element gets a `ref` number.
3. **Locate** — To get exact click coordinates for a ref, call `query_page(mode='find_element', selector_type='ref', selector_value='<ref>')`.
4. **Act** — Use `click`, `type_text`, or `mouse_action` with the coordinates or ref.
5. **Verify** — Call `take_screenshot` or `query_page(mode='state')` to confirm the result.
6. **Wait** — After async actions (navigation, form submit), use `wait_for` before the next step.

## Coordinate Warning

Screenshot pixel coordinates do NOT match CSS coordinates used by `click` and `type_text`. Never estimate click targets from a screenshot. Always use `query_page(mode='find_element')` to resolve exact CSS coordinates.

## query_page Modes

- **`map`** — Returns structured JSON with numbered `ref` elements. Supports `scope_selector` to narrow to a subtree, `interactive_only` to skip non-interactive elements, `delta` for incremental updates, `max_depth` to limit tree depth.
- **`html`** — Raw DOM HTML string.
- **`state`** — Lightweight: URL, title, readyState, scroll position, viewport size.
- **`find_element`** — Locate element by `selector_type` (ref/id/class/tag/text) + `selector_value`. Returns CSS pixel coordinates. Set `should_click: true` to click in one call.
- **`app_info`** — App name, version, window list with sizes and states.

## click

Accept `x`/`y` coordinates directly, OR provide `selector_type` + `selector_value` to auto-resolve. Supports `button` (left/right/middle) and `click_type` (single/double).

Preferred: resolve coordinates first with `query_page(mode='find_element')`, then pass them to `click`.

## type_text

Three input modes:

1. **Focused mode** — `type_text(text='hello')` types into the currently focused element. Use after clicking an input.
2. **Selector mode** — `type_text(text='hello', selector_type='ref', selector_value='5')` targets a specific element.
3. **Fields mode** — `type_text(fields=[{ref: 5, value: 'alice'}, {ref: 7, value: 'secret'}])` batch-fills a form. Add `submit_ref` to click a submit button after filling.

Supports standard inputs, textareas, contentEditable, React controlled components, Lexical editors, and Slate editors.

## mouse_action

- **`hover`** — Move cursor to `x`/`y` (triggers CSS hover effects). Set `relative: true` for offsets.
- **`scroll`** — Scroll by `direction` + `amount` (pixels, "page", or "half"), to an element `to_ref`, or `to_top`/`to_bottom`.
- **`drag`** — Move from (`x`, `y`) to (`end_x`, `end_y`) with mouse held down.

## take_screenshot

Default behavior saves a full image to disk and returns a small inline thumbnail (token-efficient). Set `inline: true` for full base64. Parameters: `quality` (1-100), `max_width`, `max_size_mb`, `output_dir`.

The screenshot captures the window without stealing focus (no window flash). If the capture is black (e.g. fullscreen window), it falls back automatically.

## Tips

- After scrolling, re-run `query_page(mode='map')` — refs from a previous map may be stale if new elements scrolled into view.
- Use `scope_selector` in `query_page(mode='map')` to limit results to a specific panel or component (e.g. `scope_selector='.sidebar'`).
- Use `wait_for(text='Success')` after submitting a form to confirm the action completed.
- Use `execute_js(code='...')` as a universal escape hatch for anything the other tools don't cover.
- `manage_window(action='list')` shows all open windows with their labels — use the label in `window_label` params to target a specific window.
