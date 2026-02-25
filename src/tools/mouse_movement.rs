use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use crate::error::Error;
use crate::models::MouseMovementRequest;
use crate::native_input::{self, MouseButton, MouseParams};
use crate::native_input::state::VirtualCursorState;
use crate::shared::{MouseMovementParams, MouseMovementResult};
use crate::socket_server::SocketResponse;
use std::time::Instant;
use log::info;

pub async fn simulate_mouse_movement_async<R: Runtime>(
    app: &AppHandle<R>,
    params: MouseMovementRequest,
) -> crate::Result<crate::models::MouseMovementResponse> {
    info!(
        "[MOUSE_MOVEMENT] Starting mouse movement with params: {:?}",
        params
    );

    let window_label = params.window_label.as_deref().unwrap_or("main");

    // Resolve webview for native event injection
    let webview = crate::desktop::get_webview_for_eval(app, window_label)
        .ok_or_else(|| Error::Anyhow(format!("Webview not found: {}", window_label)))?;

    // Get virtual cursor state
    let cursor_state = app.state::<VirtualCursorState>();

    let x = params.x;
    let y = params.y;
    let relative = params.relative.unwrap_or(false);
    let click = params.click.unwrap_or(false);
    let button = MouseButton::from_str_opt(params.button.as_deref());

    // Calculate target coordinates
    let (target_x, target_y) = if relative {
        let (cur_x, cur_y) = cursor_state.get();
        (cur_x + x, cur_y + y)
    } else {
        (x, y)
    };

    info!(
        "[MOUSE_MOVEMENT] Target coordinates: ({}, {}), click={}, button={:?}",
        target_x, target_y, click, button
    );

    let start_time = Instant::now();

    let mouse_params = MouseParams {
        x: target_x,
        y: target_y,
        click,
        button,
        mouse_down: params.mouse_down.unwrap_or(false),
        mouse_up: params.mouse_up.unwrap_or(false),
    };

    let result = native_input::backend::inject_mouse(&webview, &mouse_params)
        .map_err(|e| Error::Anyhow(format!("Native mouse injection failed: {}", e)))?;

    // Update virtual cursor state
    cursor_state.set(result.position.0, result.position.1);

    let duration_ms = start_time.elapsed().as_millis() as u64;

    info!(
        "[MOUSE_MOVEMENT] Completed in {}ms, position=({}, {})",
        duration_ms, result.position.0, result.position.1
    );

    Ok(crate::models::MouseMovementResponse {
        success: true,
        duration_ms,
        position: Some(result.position),
    })
}

pub fn simulate_mouse_movement_shared<R: Runtime>(
    app: &AppHandle<R>,
    params: MouseMovementParams,
) -> std::result::Result<MouseMovementResult, String> {
    // Convert shared params to internal type
    let request = MouseMovementRequest {
        x: params.x,
        y: params.y,
        relative: params.relative,
        click: params.click,
        button: params.button,
        window_label: params.window_label,
        mouse_down: params.mouse_down,
        mouse_up: params.mouse_up,
    };

    // Run async method using existing Tokio runtime
    let result = tokio::runtime::Handle::current()
        .block_on(simulate_mouse_movement_async(app, request));

    // Convert result to shared type
    match result {
        Ok(response) => Ok(MouseMovementResult {
            success: true,
            duration_ms: response.duration_ms,
            position: response.position,
            error: None,
        }),
        Err(e) => Ok(MouseMovementResult {
            success: false,
            duration_ms: 0,
            position: None,
            error: Some(e.to_string()),
        }),
    }
}

pub async fn handle_simulate_mouse_movement<R: Runtime>(
    app: &AppHandle<R>,
    payload: Value,
) -> Result<SocketResponse, Error> {
    // Parse the payload
    let params: MouseMovementRequest = serde_json::from_value(payload)
        .map_err(|e| Error::Anyhow(format!("Invalid payload for simulateMouseMovement: {}", e)))?;

    // Call the async method
    let result = simulate_mouse_movement_async(app, params).await;

    match result {
        Ok(response) => {
            let data = serde_json::to_value(response)
                .map_err(|e| Error::Anyhow(format!("Failed to serialize response: {}", e)))?;
            Ok(SocketResponse {
                success: true,
                data: Some(data),
                error: None,
                id: None,
            })
        }
        Err(e) => Ok(SocketResponse {
            success: false,
            data: None,
            error: Some(e.to_string()),
            id: None,
        }),
    }
}
