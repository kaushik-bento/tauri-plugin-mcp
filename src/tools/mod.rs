use serde_json::Value;
use tauri::{AppHandle, Runtime};
use log::info;

use crate::shared::commands;
use crate::socket_server::SocketResponse;

// Export command modules
pub mod execute_js;
pub mod local_storage;
pub mod mouse_movement;
pub mod ping;
pub mod take_screenshot;
pub mod text_input;
pub mod webview;
pub mod window_manager;

// Re-export command handler functions
pub use execute_js::handle_execute_js;
pub use local_storage::handle_get_local_storage;
pub use mouse_movement::handle_simulate_mouse_movement;
pub use ping::handle_ping;
pub use take_screenshot::handle_take_screenshot;
pub use text_input::handle_simulate_text_input;
pub use webview::{
    handle_get_dom, handle_get_element_position, handle_get_page_map, handle_send_text_to_element,
    handle_get_page_state, handle_navigate_back, handle_scroll_page, handle_fill_form, handle_wait_for,
};
pub use window_manager::handle_manage_window;

/// Handle command routing for socket requests
pub async fn handle_command<R: Runtime>(
    app: &AppHandle<R>,
    command: &str,
    payload: Value,
) -> crate::Result<SocketResponse> {
    // Log the full request payload
    info!(
        "[TAURI_MCP] Received command: {} with payload: {}",
        command,
        serde_json::to_string_pretty(&payload)
            .unwrap_or_else(|_| "[failed to serialize]".to_string())
    );

    let result = match command {
        commands::PING => handle_ping(app, payload),
        commands::TAKE_SCREENSHOT => handle_take_screenshot(app, payload).await,
        commands::GET_DOM => handle_get_dom(app, payload).await,
        commands::MANAGE_LOCAL_STORAGE => handle_get_local_storage(app, payload).await,
        commands::EXECUTE_JS => handle_execute_js(app, payload).await,
        commands::MANAGE_WINDOW => handle_manage_window(app, payload).await,
        commands::SIMULATE_TEXT_INPUT => handle_simulate_text_input(app, payload).await,
        commands::SIMULATE_MOUSE_MOVEMENT => handle_simulate_mouse_movement(app, payload).await,
        commands::GET_ELEMENT_POSITION => handle_get_element_position(app, payload).await,
        commands::SEND_TEXT_TO_ELEMENT => handle_send_text_to_element(app, payload).await,
        commands::GET_PAGE_MAP => handle_get_page_map(app, payload).await,
        commands::GET_PAGE_STATE => handle_get_page_state(app, payload).await,
        commands::NAVIGATE_BACK => handle_navigate_back(app, payload).await,
        commands::SCROLL_PAGE => handle_scroll_page(app, payload).await,
        commands::FILL_FORM => handle_fill_form(app, payload).await,
        commands::WAIT_FOR => handle_wait_for(app, payload).await,
        _ => Ok(SocketResponse {
            success: false,
            data: None,
            error: Some(format!("Unknown command: {}", command)),
            id: None,
        }),
    };

    // Log the response before returning it
    if let Ok(ref response) = result {
        let success_str = if response.success {
            "SUCCESS"
        } else {
            "FAILURE"
        };
        info!(
            "[TAURI_MCP] Command {} completed with status: {}",
            command, success_str
        );

        if let Some(ref data) = response.data {
            // Only print a preview of the data for large responses
            let data_str =
                serde_json::to_string(data).unwrap_or_else(|_| "[failed to serialize]".to_string());
            if data_str.len() > 1000 {
                info!(
                    "[TAURI_MCP] Response data preview (first 1000 chars): {}",
                    &data_str[..1000.min(data_str.len())]
                );
                info!(
                    "[TAURI_MCP] ... (response data truncated, total length: {} bytes)",
                    data_str.len()
                );
            } else {
                info!("[TAURI_MCP] Response data: {}", data_str);
            }
        }

        if let Some(ref err) = response.error {
            info!("[TAURI_MCP] Error: {}", err);
        }
    } else if let Err(ref e) = result {
        info!(
            "[TAURI_MCP] Command {} failed with error: {}",
            command, e
        );
    }

    result
}
