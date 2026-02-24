// JS fallback is used on Windows/Linux where native injection isn't implemented yet.
// On macOS, the macos backend handles everything natively.
#![allow(dead_code)]

use tauri::{Runtime, Webview};
use crate::error::Error;
use super::{MouseParams, TextParams, MouseButton, InputResult, TextResult};

/// Inject mouse events via JS synthetic event dispatch.
/// Note: isTrusted=false — some frameworks may ignore these events,
/// and CSS :hover will not be triggered.
pub fn inject_mouse_via_js<R: Runtime>(
    webview: &Webview<R>,
    params: &MouseParams,
) -> Result<InputResult, Error> {
    let x = params.x;
    let y = params.y;

    // Always dispatch mousemove
    let mut js = format!(
        r#"(function() {{
            var el = document.elementFromPoint({x}, {y}) || document.body;
            el.dispatchEvent(new MouseEvent('mousemove', {{
                clientX: {x}, clientY: {y}, bubbles: true, cancelable: true
            }}));
        "#,
        x = x, y = y
    );

    if params.click {
        let button_num = match params.button {
            MouseButton::Left => 0,
            MouseButton::Right => 2,
            MouseButton::Middle => 1,
        };
        js.push_str(&format!(
            r#"
            el.dispatchEvent(new MouseEvent('mousedown', {{
                clientX: {x}, clientY: {y}, button: {btn}, bubbles: true, cancelable: true
            }}));
            el.dispatchEvent(new MouseEvent('mouseup', {{
                clientX: {x}, clientY: {y}, button: {btn}, bubbles: true, cancelable: true
            }}));
            el.dispatchEvent(new MouseEvent('click', {{
                clientX: {x}, clientY: {y}, button: {btn}, bubbles: true, cancelable: true
            }}));
            "#,
            x = x, y = y, btn = button_num
        ));

        // Focus the element if it's focusable
        js.push_str("if (el.focus) { el.focus(); }\n");
    }

    js.push_str("})();");

    webview.eval(&js).map_err(|e| {
        Error::Anyhow(format!("Failed to inject mouse event via JS: {}", e))
    })?;

    Ok(InputResult {
        success: true,
        position: (x, y),
        error: None,
    })
}

/// Inject text via JS synthetic events.
/// Uses React-compatible nativeInputValueSetter for <input>/<textarea>,
/// and document.execCommand('insertText') for contenteditable.
pub fn inject_text_via_js<R: Runtime>(
    webview: &Webview<R>,
    params: &TextParams,
) -> Result<TextResult, Error> {
    let text_escaped = params.text
        .replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('\n', "\\n")
        .replace('\r', "\\r");

    let js = format!(
        r#"(function() {{
            var text = '{text}';
            var el = document.activeElement;
            if (!el) return;

            // For input/textarea elements
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {{
                // Try React-compatible value setter
                var nativeSetter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype, 'value'
                ) || Object.getOwnPropertyDescriptor(
                    window.HTMLTextAreaElement.prototype, 'value'
                );
                if (nativeSetter && nativeSetter.set) {{
                    nativeSetter.set.call(el, el.value + text);
                }} else {{
                    el.value += text;
                }}
                el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                el.dispatchEvent(new Event('change', {{ bubbles: true }}));
            }} else if (el.isContentEditable) {{
                // For contenteditable elements
                document.execCommand('insertText', false, text);
            }} else {{
                // Generic fallback: try typing via keyboard events
                for (var i = 0; i < text.length; i++) {{
                    var ch = text[i];
                    el.dispatchEvent(new KeyboardEvent('keydown', {{
                        key: ch, code: 'Key' + ch.toUpperCase(), bubbles: true
                    }}));
                    el.dispatchEvent(new KeyboardEvent('keypress', {{
                        key: ch, code: 'Key' + ch.toUpperCase(), bubbles: true
                    }}));
                    el.dispatchEvent(new KeyboardEvent('keyup', {{
                        key: ch, code: 'Key' + ch.toUpperCase(), bubbles: true
                    }}));
                }}
            }}
        }})();"#,
        text = text_escaped
    );

    webview.eval(&js).map_err(|e| {
        Error::Anyhow(format!("Failed to inject text via JS: {}", e))
    })?;

    let chars_typed = params.text.chars().count() as u32;
    Ok(TextResult {
        success: true,
        chars_typed,
        error: None,
    })
}
