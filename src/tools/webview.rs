use serde::{Deserialize, Serialize, Serializer}; // Add Deserialize for parsing payload
use serde_json::Value;
use std::fmt;
use std::sync::mpsc;
use tauri::{AppHandle, Error as TauriError, Listener, Manager, Runtime, WebviewWindow};

// Custom error enum for the get_dom_text command
#[derive(Debug)] // Add Serialize for the enum itself if it needs to be directly serialized
// For now, we serialize its string representation
pub enum GetDomError {
    WebviewOperation(String),
    JavaScriptError(String),
    DomIsEmpty,
}

// Implement Display for GetDomError to allow.to_string()
impl fmt::Display for GetDomError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GetDomError::WebviewOperation(s) => write!(f, "Webview operation error: {}", s),
            GetDomError::JavaScriptError(s) => write!(f, "JavaScript execution error: {}", s),
            GetDomError::DomIsEmpty => write!(f, "Retrieved DOM string is empty"),
        }
    }
}

// Implement Serialize for GetDomError so it can be returned to the frontend
impl Serialize for GetDomError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

// Automatically convert tauri::Error into GetDomError::WebviewOperation or JavaScriptError
impl From<TauriError> for GetDomError {
    fn from(err: TauriError) -> Self {
        // Basic differentiation, could be more sophisticated if TauriError variants allow
        match err {
            _ => GetDomError::JavaScriptError(err.to_string()), // Default to JS error as eval is involved
        }
    }
}

// Handler function for the getDom command, following the take_screenshot pattern
pub async fn handle_get_dom<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    // Parse the window label from the payload - handle both string and object formats
    let window_label = if payload.is_string() {
        // Direct string format
        payload
            .as_str()
            .ok_or_else(|| {
                crate::error::Error::Anyhow("Invalid string payload for getDom".to_string())
            })?
            .to_string()
    } else if payload.is_object() {
        // Object with window_label property
        payload
            .get("window_label")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| {
                crate::error::Error::Anyhow(
                    "Missing or invalid window_label in payload object".to_string(),
                )
            })?
    } else {
        return Err(crate::error::Error::Anyhow(format!(
            "Invalid payload format for getDom: expected string or object with window_label, got {}",
            payload
        )));
    };

    // Extract optional timeout_secs from payload (default: 10)
    let timeout_secs = payload
        .get("timeout_secs")
        .and_then(|v| v.as_u64())
        .unwrap_or(10);

    // Get the window by label using the Manager trait
    let window = app.get_webview_window(&window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Window not found: {}", window_label))
    })?;
    let result = get_dom_text(app.clone(), window, timeout_secs).await;
    match result {
        Ok(dom_text) => {
            let data = serde_json::to_value(dom_text).map_err(|e| {
                crate::error::Error::Anyhow(format!("Failed to serialize response: {}", e))
            })?;
            Ok(crate::socket_server::SocketResponse {
                success: true,
                data: Some(data),
                error: None,
                id: None,
            })
        }
        Err(e) => Ok(crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(e.to_string()),
            id: None,
        }),
    }
}
use tauri::Emitter;
#[tauri::command]
pub async fn get_dom_text<R: Runtime>(
    app: AppHandle<R>,
    _window: WebviewWindow<R>,
    timeout_secs: u64,
) -> Result<String, GetDomError> {
    let (tx, rx) = mpsc::channel();

    // Register listener FIRST to avoid race condition
    app.once("got-dom-content-response", move |event| {
        let payload = event.payload().to_string();
        let _ = tx.send(payload);
    });

    // THEN emit the request
    app.emit_to("main", "got-dom-content", "test").unwrap();

    // Wait for the content with configurable timeout
    match rx.recv_timeout(std::time::Duration::from_secs(timeout_secs)) {
        Ok(dom_string) => {
            if dom_string.is_empty() {
                Err(GetDomError::DomIsEmpty)
            } else {
                Ok(dom_string)
            }
        }
        Err(e) => {
            // This error (e: tauri::Error) could be from the eval call itself
            // or an error from the JavaScript execution (Promise rejection).
            Err(GetDomError::from(e))
        }
    }
}

/// Handler for get_page_map — returns a structured page map with numbered element refs
pub async fn handle_get_page_map<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    // Parse the window label from the payload
    let window_label = if payload.is_string() {
        payload
            .as_str()
            .ok_or_else(|| {
                crate::error::Error::Anyhow("Invalid string payload for getPageMap".to_string())
            })?
            .to_string()
    } else if payload.is_object() {
        payload
            .get("window_label")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| {
                crate::error::Error::Anyhow(
                    "Missing or invalid window_label in payload object".to_string(),
                )
            })?
    } else {
        return Err(crate::error::Error::Anyhow(format!(
            "Invalid payload format for getPageMap: expected string or object with window_label, got {}",
            payload
        )));
    };

    // Extract optional timeout_secs from payload
    let timeout_secs = payload
        .get("timeout_secs")
        .and_then(|v| v.as_u64())
        .unwrap_or(10);

    // Verify the window exists
    let _window = app.get_webview_window(&window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Window not found: {}", window_label))
    })?;

    let (tx, rx) = mpsc::channel();

    // Register listener FIRST
    app.once("get-page-map-response", move |event| {
        let payload = event.payload().to_string();
        let _ = tx.send(payload);
    });

    // Build the options to pass to the JS side
    let js_payload = serde_json::json!({
        "includeContent": payload.get("include_content").and_then(|v| v.as_bool()).unwrap_or(true),
        "waitForStable": payload.get("wait_for_stable").and_then(|v| v.as_bool()).unwrap_or(false),
        "quietMs": payload.get("quiet_ms").and_then(|v| v.as_u64()).unwrap_or(300),
        "maxWaitMs": payload.get("max_wait_ms").and_then(|v| v.as_u64()).unwrap_or(3000),
        "interactiveOnly": payload.get("interactive_only").and_then(|v| v.as_bool()).unwrap_or(false),
        "scopeSelector": payload.get("scope_selector"),
        "maxDepth": payload.get("max_depth").and_then(|v| v.as_u64()),
        "delta": payload.get("delta").and_then(|v| v.as_bool()).unwrap_or(false)
    });

    // THEN emit the request
    app.emit_to(&window_label, "get-page-map", js_payload)
        .map_err(|e| {
            crate::error::Error::Anyhow(format!("Failed to emit get-page-map event: {}", e))
        })?;

    match rx.recv_timeout(std::time::Duration::from_secs(timeout_secs)) {
        Ok(result_string) => {
            if result_string.is_empty() || result_string == "\"\"" {
                Ok(crate::socket_server::SocketResponse {
                    success: false,
                    data: None,
                    error: Some("Page map result is empty".to_string()),
                    id: None,
                })
            } else {
                // The JS side sends JSON.stringify(result), which gets wrapped in quotes by the event system
                // Try to parse as a JSON value
                let data: Value = serde_json::from_str(&result_string).unwrap_or_else(|_| {
                    Value::String(result_string)
                });

                // If data is a string (double-encoded), parse it again
                let data = if let Some(s) = data.as_str() {
                    serde_json::from_str(s).unwrap_or(Value::String(s.to_string()))
                } else {
                    data
                };

                // Surface JS-side page-map failures instead of reporting success with an error payload.
                let page_map_error = data
                    .get("error")
                    .and_then(|v| {
                        if v.is_null() {
                            None
                        } else if let Some(s) = v.as_str() {
                            Some(s.trim().to_string())
                        } else {
                            Some(v.to_string())
                        }
                    })
                    .filter(|s| !s.is_empty());

                if let Some(error_message) = page_map_error {
                    return Ok(crate::socket_server::SocketResponse {
                        success: false,
                        data: None,
                        error: Some(format!("Page map generation failed: {}", error_message)),
                        id: None,
                    });
                }

                Ok(crate::socket_server::SocketResponse {
                    success: true,
                    data: Some(data),
                    error: None,
                    id: None,
                })
            }
        }
        Err(e) => Ok(crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(format!("Timeout waiting for page map: {}", e)),
            id: None,
        }),
    }
}

// Second fix: add From implementation for RecvTimeoutError
impl From<mpsc::RecvTimeoutError> for GetDomError {
    fn from(err: mpsc::RecvTimeoutError) -> Self {
        GetDomError::WebviewOperation(format!("Timeout waiting for DOM: {}", err))
    }
}

// Define the structure for get_element_position payload
#[derive(Debug, Deserialize)]
struct GetElementPositionPayload {
    window_label: String,
    selector_type: String,
    selector_value: String,
    #[serde(default)]
    should_click: bool,
    #[serde(default)]
    raw_coordinates: bool,
}

// Handle getting element position
pub async fn handle_get_element_position<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    // Parse the payload
    let payload = serde_json::from_value::<GetElementPositionPayload>(payload).map_err(|e| {
        crate::error::Error::Anyhow(format!("Invalid payload for get_element_position: {}", e))
    })?;

    // Create a channel to receive the result
    let (tx, rx) = mpsc::channel();

    // Event name for the response
    let event_name = "get-element-position-response";

    // Set up the listener for the response
    app.once(event_name, move |event| {
        let payload = event.payload().to_string();
        let _ = tx.send(payload);
    });

    // Prepare the request payload with selector information
    let js_payload = serde_json::json!({
        "windowLabel": payload.window_label,
        "selectorType": payload.selector_type,
        "selectorValue": payload.selector_value,
        "shouldClick": payload.should_click,
        "rawCoordinates": payload.raw_coordinates
    });

    // Emit the event to the webview
    app.emit_to(&payload.window_label, "get-element-position", js_payload)
        .map_err(|e| {
            crate::error::Error::Anyhow(format!("Failed to emit get-element-position event: {}", e))
        })?;

    // Wait for the response with a timeout
    match rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(result) => {
            // Parse the result
            let result_value: Value = serde_json::from_str(&result).map_err(|e| {
                crate::error::Error::Anyhow(format!("Failed to parse result: {}", e))
            })?;

            let success = result_value
                .get("success")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            if success {
                Ok(crate::socket_server::SocketResponse {
                    success: true,
                    data: Some(result_value.get("data").cloned().unwrap_or(Value::Null)),
                    error: None,
                    id: None,
                })
            } else {
                let error = result_value
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown error occurred");

                Ok(crate::socket_server::SocketResponse {
                    success: false,
                    data: None,
                    error: Some(error.to_string()),
                    id: None,
                })
            }
        }
        Err(e) => Ok(crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(format!(
                "Timeout waiting for element position result: {}",
                e
            )),
            id: None,
        }),
    }
}

// Define the structure for send_text_to_element payload
#[derive(Debug, Deserialize)]
struct SendTextToElementPayload {
    window_label: String,
    selector_type: String,
    selector_value: String,
    text: String,
    #[serde(default = "default_delay_ms")]
    delay_ms: u32,
}

// Default delay_ms value
fn default_delay_ms() -> u32 {
    20
}

// Handle sending text to an element
pub async fn handle_send_text_to_element<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    // Parse the payload
    let payload = serde_json::from_value::<SendTextToElementPayload>(payload).map_err(|e| {
        crate::error::Error::Anyhow(format!("Invalid payload for send_text_to_element: {}", e))
    })?;


    // Create a channel to receive the result
    let (tx, rx) = mpsc::channel();

    // Event name for the response
    let event_name = "send-text-to-element-response";

    // Set up the listener for the response
    app.once(event_name, move |event| {
        let payload = event.payload().to_string();
        let _ = tx.send(payload);
    });

    // Prepare the request payload
    let js_payload = serde_json::json!({
        "selectorType": payload.selector_type,
        "selectorValue": payload.selector_value,
        "text": payload.text,
        "delayMs": payload.delay_ms
    });

    // Emit the event to the webview
    app.emit_to(&payload.window_label, "send-text-to-element", js_payload)
        .map_err(|e| {
            crate::error::Error::Anyhow(format!("Failed to emit send-text-to-element event: {}", e))
        })?;

    // Wait for the response with a timeout
    match rx.recv_timeout(std::time::Duration::from_secs(30)) {
        // Longer timeout for typing text
        Ok(result) => {
            // Parse the result
            let result_value: Value = serde_json::from_str(&result).map_err(|e| {
                crate::error::Error::Anyhow(format!("Failed to parse result: {}", e))
            })?;

            let success = result_value
                .get("success")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            if success {
                Ok(crate::socket_server::SocketResponse {
                    success: true,
                    data: Some(result_value.get("data").cloned().unwrap_or(Value::Null)),
                    error: None,
                    id: None,
                })
            } else {
                let error = result_value
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown error occurred");

                Ok(crate::socket_server::SocketResponse {
                    success: false,
                    data: None,
                    error: Some(error.to_string()),
                    id: None,
                })
            }
        }
        Err(e) => Ok(crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(format!("Timeout waiting for text input completion: {}", e)),
            id: None,
        }),
    }
}

// Helper to parse a JSON response string from the JS side into a SocketResponse
fn parse_js_response(result_string: &str) -> crate::socket_server::SocketResponse {
    // The JS side sends JSON.stringify(result), which may be double-encoded by the event system
    let data: Value = serde_json::from_str(result_string).unwrap_or_else(|_| {
        Value::String(result_string.to_string())
    });

    // If data is a string (double-encoded), parse it again
    let data = if let Some(s) = data.as_str() {
        serde_json::from_str(s).unwrap_or(Value::String(s.to_string()))
    } else {
        data
    };

    let success = data
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if success {
        crate::socket_server::SocketResponse {
            success: true,
            data: data.get("data").cloned(),
            error: None,
            id: None,
        }
    } else {
        crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(
                data.get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown error")
                    .to_string(),
            ),
            id: None,
        }
    }
}

// Helper to extract window_label from various payload formats
fn extract_window_label(payload: &Value) -> Result<String, crate::error::Error> {
    if payload.is_string() {
        payload
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| crate::error::Error::Anyhow("Invalid string payload".to_string()))
    } else if payload.is_object() {
        payload
            .get("window_label")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| {
                crate::error::Error::Anyhow(
                    "Missing or invalid window_label in payload".to_string(),
                )
            })
    } else {
        Err(crate::error::Error::Anyhow(format!(
            "Invalid payload format: expected string or object with window_label, got {}",
            payload
        )))
    }
}

/// Handler for get_page_state — lightweight URL/title/readyState check
pub async fn handle_get_page_state<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let window_label = extract_window_label(&payload)?;
    let _window = app.get_webview_window(&window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Window not found: {}", window_label))
    })?;

    let (tx, rx) = mpsc::channel();

    app.once("get-page-state-response", move |event| {
        let _ = tx.send(event.payload().to_string());
    });

    app.emit_to(&window_label, "get-page-state", serde_json::json!({}))
        .map_err(|e| {
            crate::error::Error::Anyhow(format!("Failed to emit get-page-state event: {}", e))
        })?;

    match rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(result) => Ok(parse_js_response(&result)),
        Err(e) => Ok(crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(format!("Timeout waiting for page state: {}", e)),
            id: None,
        }),
    }
}

/// Handler for navigate_back — browser history back/forward/go(n)
pub async fn handle_navigate_back<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let window_label = extract_window_label(&payload)?;
    let _window = app.get_webview_window(&window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Window not found: {}", window_label))
    })?;

    let (tx, rx) = mpsc::channel();

    app.once("navigate-back-response", move |event| {
        let _ = tx.send(event.payload().to_string());
    });

    let js_payload = serde_json::json!({
        "direction": payload.get("direction").and_then(|v| v.as_str()).unwrap_or("back"),
        "delta": payload.get("delta").and_then(|v| v.as_i64())
    });

    app.emit_to(&window_label, "navigate-back", js_payload)
        .map_err(|e| {
            crate::error::Error::Anyhow(format!("Failed to emit navigate-back event: {}", e))
        })?;

    match rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(result) => Ok(parse_js_response(&result)),
        Err(e) => Ok(crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(format!("Timeout waiting for navigation: {}", e)),
            id: None,
        }),
    }
}

/// Handler for scroll_page — scroll by page/half/pixels, to element ref, or to top/bottom
pub async fn handle_scroll_page<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let window_label = extract_window_label(&payload)?;
    let _window = app.get_webview_window(&window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Window not found: {}", window_label))
    })?;

    let (tx, rx) = mpsc::channel();

    app.once("scroll-page-response", move |event| {
        let _ = tx.send(event.payload().to_string());
    });

    let js_payload = serde_json::json!({
        "direction": payload.get("direction").and_then(|v| v.as_str()),
        "amount": payload.get("amount"),
        "toRef": payload.get("to_ref").and_then(|v| v.as_i64()),
        "toTop": payload.get("to_top").and_then(|v| v.as_bool()).unwrap_or(false),
        "toBottom": payload.get("to_bottom").and_then(|v| v.as_bool()).unwrap_or(false)
    });

    app.emit_to(&window_label, "scroll-page", js_payload)
        .map_err(|e| {
            crate::error::Error::Anyhow(format!("Failed to emit scroll-page event: {}", e))
        })?;

    match rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(result) => Ok(parse_js_response(&result)),
        Err(e) => Ok(crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(format!("Timeout waiting for scroll: {}", e)),
            id: None,
        }),
    }
}

/// Handler for fill_form — batch-fill multiple form fields by ref in one call
pub async fn handle_fill_form<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let window_label = extract_window_label(&payload)?;
    let _window = app.get_webview_window(&window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Window not found: {}", window_label))
    })?;

    let (tx, rx) = mpsc::channel();

    app.once("fill-form-response", move |event| {
        let _ = tx.send(event.payload().to_string());
    });

    // Convert snake_case field keys to camelCase for JS side
    let fields = payload.get("fields").cloned().unwrap_or(Value::Array(vec![]));
    let js_fields: Vec<Value> = if let Some(arr) = fields.as_array() {
        arr.iter().map(|f| {
            serde_json::json!({
                "ref": f.get("ref"),
                "selectorType": f.get("selector_type"),
                "selectorValue": f.get("selector_value"),
                "value": f.get("value"),
                "clear": f.get("clear")
            })
        }).collect()
    } else {
        vec![]
    };

    let js_payload = serde_json::json!({
        "fields": js_fields,
        "submitRef": payload.get("submit_ref").and_then(|v| v.as_i64())
    });

    app.emit_to(&window_label, "fill-form", js_payload)
        .map_err(|e| {
            crate::error::Error::Anyhow(format!("Failed to emit fill-form event: {}", e))
        })?;

    // Longer timeout for form filling (typing can take time)
    match rx.recv_timeout(std::time::Duration::from_secs(30)) {
        Ok(result) => Ok(parse_js_response(&result)),
        Err(e) => Ok(crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(format!("Timeout waiting for form fill: {}", e)),
            id: None,
        }),
    }
}

/// Handler for wait_for — wait for text/element to appear or disappear
pub async fn handle_wait_for<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<crate::socket_server::SocketResponse, crate::error::Error> {
    let window_label = extract_window_label(&payload)?;
    let _window = app.get_webview_window(&window_label).ok_or_else(|| {
        crate::error::Error::Anyhow(format!("Window not found: {}", window_label))
    })?;

    let timeout_ms = payload
        .get("timeout_ms")
        .and_then(|v| v.as_u64())
        .unwrap_or(10000);

    let (tx, rx) = mpsc::channel();

    app.once("wait-for-response", move |event| {
        let _ = tx.send(event.payload().to_string());
    });

    let js_payload = serde_json::json!({
        "text": payload.get("text"),
        "selector": payload.get("selector"),
        "ref": payload.get("ref"),
        "state": payload.get("state").and_then(|v| v.as_str()).unwrap_or("visible"),
        "timeoutMs": timeout_ms
    });

    app.emit_to(&window_label, "wait-for", js_payload)
        .map_err(|e| {
            crate::error::Error::Anyhow(format!("Failed to emit wait-for event: {}", e))
        })?;

    // Rust timeout = JS timeout + 2s buffer
    let rust_timeout_secs = (timeout_ms / 1000) + 2;

    match rx.recv_timeout(std::time::Duration::from_secs(rust_timeout_secs)) {
        Ok(result) => Ok(parse_js_response(&result)),
        Err(e) => Ok(crate::socket_server::SocketResponse {
            success: false,
            data: None,
            error: Some(format!("Timeout waiting for condition: {}", e)),
            id: None,
        }),
    }
}
