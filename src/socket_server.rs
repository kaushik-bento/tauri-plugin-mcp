use interprocess::TryClone;
use interprocess::local_socket::{
    GenericFilePath, GenericNamespaced, Listener as IpcListener, ListenerOptions, Name, Stream as IpcStream, ToFsName,
    ToNsName, prelude::*,
};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Runtime};
use log::{info, warn, error, trace};

use serde::{Deserialize, Serialize};

use crate::error::Error;
use crate::tools;
use crate::SocketType;

/// A wrapper stream that logs all reads and writes for debugging
struct LoggingStream<S: Write + Read> {
    inner: S,
}

impl<S: Write + Read> LoggingStream<S> {
    fn new(inner: S) -> Self {
        Self { inner }
    }
}

impl<S: Write + Read> Write for LoggingStream<S> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        trace!("[TAURI_MCP] Writing: {}", String::from_utf8_lossy(buf));
        self.inner.write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

impl<S: Write + Read> Read for LoggingStream<S> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        trace!(
            "[TAURI_MCP] Read: {}",
            String::from_utf8_lossy(&buf[..n])
        );
        Ok(n)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SocketRequest {
    command: String,
    payload: Value,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    auth_token: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SocketResponse {
    pub success: bool,
    pub data: Option<Value>,
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

/// Unified stream type that can handle both IPC and TCP
enum UnifiedStream {
    Ipc(IpcStream),
    Tcp(TcpStream),
}

impl Read for UnifiedStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            UnifiedStream::Ipc(stream) => stream.read(buf),
            UnifiedStream::Tcp(stream) => stream.read(buf),
        }
    }
}

impl Write for UnifiedStream {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            UnifiedStream::Ipc(stream) => stream.write(buf),
            UnifiedStream::Tcp(stream) => stream.write(buf),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            UnifiedStream::Ipc(stream) => stream.flush(),
            UnifiedStream::Tcp(stream) => stream.flush(),
        }
    }
}

impl UnifiedStream {
    fn try_clone(&self) -> std::io::Result<Self> {
        match self {
            UnifiedStream::Ipc(stream) => Ok(UnifiedStream::Ipc(stream.try_clone()?)),
            UnifiedStream::Tcp(stream) => Ok(UnifiedStream::Tcp(stream.try_clone()?)),
        }
    }
}

/// Unified listener type that can handle both IPC and TCP
enum UnifiedListener {
    Ipc(IpcListener),
    Tcp(TcpListener),
}

pub struct SocketServer<R: Runtime> {
    listener: Option<Arc<Mutex<UnifiedListener>>>,
    socket_type: SocketType,
    app: AppHandle<R>,
    running: Arc<Mutex<bool>>,
    auth_token: Option<String>,
    token_file_path: Option<String>,
}

impl<R: Runtime> SocketServer<R> {
    pub fn new(app: AppHandle<R>, socket_type: SocketType, auth_token: Option<String>) -> Self {
        match &socket_type {
            SocketType::Ipc { path } => {
                let socket_path = if let Some(path) = path {
                    path.to_string_lossy().to_string()
                } else {
                    let temp_dir = std::env::temp_dir();
                    temp_dir
                        .join("tauri-mcp.sock")
                        .to_string_lossy()
                        .to_string()
                };
                info!(
                    "[TAURI_MCP] Initializing IPC socket server at: {}",
                    socket_path
                );
            }
            SocketType::Tcp { host, port } => {
                info!(
                    "[TAURI_MCP] Initializing TCP socket server at: {}:{}",
                    host, port
                );
            }
        }

        SocketServer {
            listener: None,
            socket_type,
            app,
            running: Arc::new(Mutex::new(false)),
            auth_token,
            token_file_path: None,
        }
    }

    pub fn start(&mut self) -> crate::Result<()> {
        info!("[TAURI_MCP] Starting socket server...");

        let listener = match &self.socket_type {
            SocketType::Ipc { path } => {
                // Create a name for our socket based on the platform
                let socket_name = self.get_socket_name(path)?;

                // Stale socket cleanup: try connecting to see if another instance is running
                #[cfg(unix)]
                {
                    let socket_path = if let Some(p) = path {
                        p.to_string_lossy().to_string()
                    } else {
                        std::env::temp_dir().join("tauri-mcp.sock").to_string_lossy().to_string()
                    };
                    if let Ok(metadata) = std::fs::symlink_metadata(&socket_path) {
                        use std::os::unix::fs::FileTypeExt;
                        if !metadata.file_type().is_socket() {
                            return Err(Error::Io(format!(
                                "Path {} exists but is not a Unix socket — refusing to remove",
                                socket_path
                            )));
                        }
                        match std::os::unix::net::UnixStream::connect(&socket_path) {
                            Ok(_) => {
                                return Err(Error::Io(format!(
                                    "Socket {} is in use by another instance",
                                    socket_path
                                )));
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
                                info!("[TAURI_MCP] Removing stale socket file: {}", socket_path);
                                let _ = std::fs::remove_file(&socket_path);
                            }
                            Err(e) => {
                                return Err(Error::Io(format!(
                                    "Cannot connect to socket {} and cannot determine if it is stale: {}",
                                    socket_path, e
                                )));
                            }
                        }
                    }
                }

                // Configure and create the IPC listener
                let opts = ListenerOptions::new().name(socket_name);
                let ipc_listener = opts.create_sync()
                    .map_err(|e| {
                        info!("[TAURI_MCP] Error creating IPC socket listener: {}", e);
                        if e.kind() == std::io::ErrorKind::AddrInUse {
                            Error::Io(format!("Socket address already in use. Another instance may be running."))
                        } else {
                            Error::Io(format!("Failed to create local socket: {}", e))
                        }
                    })?;
                UnifiedListener::Ipc(ipc_listener)
            }
            SocketType::Tcp { host, port } => {
                // TCP host validation: reject non-loopback without auth token
                if let Ok(ip) = host.parse::<std::net::IpAddr>() {
                    if !ip.is_loopback() {
                        if self.auth_token.is_none() {
                            return Err(Error::Io(format!(
                                "Binding to non-loopback address {} without an auth token is not allowed. \
                                 Set an auth token or use a loopback address (127.0.0.1 / ::1).",
                                host
                            )));
                        }
                        warn!(
                            "[TAURI_MCP] WARNING: Binding to non-loopback address {}:{}. \
                             Ensure auth token is configured and network is trusted.",
                            host, port
                        );
                    }
                } else {
                    warn!("[TAURI_MCP] Could not parse host '{}' as IP address", host);
                }

                // Create TCP listener
                let addr = format!("{}:{}", host, port);
                let tcp_listener = TcpListener::bind(&addr)
                    .map_err(|e| {
                        info!("[TAURI_MCP] Error creating TCP socket listener: {}", e);
                        Error::Io(format!("Failed to bind to {}: {}", addr, e))
                    })?;
                UnifiedListener::Tcp(tcp_listener)
            }
        };

        let listener = Arc::new(Mutex::new(listener));
        self.listener = Some(listener.clone());

        // Write auth token to a file so the MCP server can read it
        if let Some(ref token) = self.auth_token {
            let token_path = match &self.socket_type {
                SocketType::Ipc { path } => {
                    let socket_path = path.clone().unwrap_or_else(|| {
                        std::env::temp_dir().join("tauri-mcp.sock")
                    });
                    format!("{}.token", socket_path.display())
                }
                SocketType::Tcp { port, .. } => {
                    format!("{}/tauri-mcp-{}.token", std::env::temp_dir().display(), port)
                }
            };

            // Write with restrictive permissions on Unix (owner-only read/write)
            let write_result = {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    std::fs::OpenOptions::new()
                        .write(true)
                        .create(true)
                        .truncate(true)
                        .mode(0o600)
                        .open(&token_path)
                        .and_then(|mut f| {
                            use std::io::Write;
                            f.write_all(token.as_bytes())
                        })
                }
                #[cfg(not(unix))]
                {
                    std::fs::write(&token_path, token)
                }
            };

            match write_result {
                Ok(_) => {
                    info!("[TAURI_MCP] Auth token written to {}", token_path);
                    self.token_file_path = Some(token_path);
                }
                Err(e) => {
                    error!("[TAURI_MCP] Failed to write auth token file {}: {}", token_path, e);
                }
            }
        }

        *self.running.lock().unwrap_or_else(|e| e.into_inner()) = true;
        info!("[TAURI_MCP] Set running flag to true");

        let app = self.app.clone();
        let running = self.running.clone();
        let socket_type = self.socket_type.clone();
        let rt_handle = tauri::async_runtime::handle().inner().clone();
        let auth_token: Option<Arc<str>> = self.auth_token.as_deref().map(Into::into);

        // Spawn a thread to handle socket connections
        info!("[TAURI_MCP] Spawning listener thread");
        thread::spawn(move || {
            match &socket_type {
                SocketType::Ipc { .. } => {
                    info!("[TAURI_MCP] Listener thread started for IPC socket");
                }
                SocketType::Tcp { host, port } => {
                    info!("[TAURI_MCP] Listener thread started for TCP socket at {}:{}", host, port);
                }
            }

            let listener_guard = listener.lock().unwrap_or_else(|e| e.into_inner());

            loop {
                if !*running.lock().unwrap_or_else(|e| e.into_inner()) {
                    break;
                }

                match &*listener_guard {
                    UnifiedListener::Ipc(ipc_listener) => {
                        // Handle IPC connections
                        for conn in ipc_listener.incoming() {
                            if !*running.lock().unwrap_or_else(|e| e.into_inner()) {
                                break;
                            }

                            match conn {
                                Ok(stream) => {
                                    info!("[TAURI_MCP] Accepted new IPC connection");
                                    let app_clone = app.clone();
                                    let rt_handle_clone = rt_handle.clone();
                                    let auth_token_clone = auth_token.clone();
                                    let unified_stream = UnifiedStream::Ipc(stream);

                                    thread::spawn(move || {
                                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                            if let Err(e) = handle_client(unified_stream, app_clone, rt_handle_clone, auth_token_clone) {
                                                if e.to_string()
                                                    .contains("No process is on the other end of the pipe")
                                                {
                                                    info!("[TAURI_MCP] Client disconnected normally");
                                                } else {
                                                    error!("[TAURI_MCP] Error handling client: {}", e);
                                                }
                                            }
                                        }));
                                        if let Err(panic) = result {
                                            error!("[TAURI_MCP] Client handler panicked: {:?}", panic);
                                        }
                                    });
                                }
                                Err(e) => {
                                    error!("[TAURI_MCP] Error accepting IPC connection: {}", e);
                                    // Short sleep to avoid busy waiting in case of persistent errors
                                    std::thread::sleep(std::time::Duration::from_millis(100));
                                }
                            }

                            // Check the running flag after each connection
                            if !*running.lock().unwrap_or_else(|e| e.into_inner()) {
                                break;
                            }
                        }
                    }
                    UnifiedListener::Tcp(tcp_listener) => {
                        // Handle TCP connections
                        // Set non-blocking mode to allow checking the running flag
                        tcp_listener.set_nonblocking(true).ok();
                        
                        loop {
                            if !*running.lock().unwrap_or_else(|e| e.into_inner()) {
                                break;
                            }

                            match tcp_listener.accept() {
                                Ok((stream, addr)) => {
                                    info!("[TAURI_MCP] Accepted new TCP connection from: {}", addr);
                                    
                                    // Set the stream back to blocking mode for normal I/O operations
                                    if let Err(e) = stream.set_nonblocking(false) {
                                        error!("[TAURI_MCP] Failed to set stream to blocking mode: {}", e);
                                        continue;
                                    }
                                    
                                    let app_clone = app.clone();
                                    let rt_handle_clone = rt_handle.clone();
                                    let auth_token_clone = auth_token.clone();
                                    let unified_stream = UnifiedStream::Tcp(stream);

                                    thread::spawn(move || {
                                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                            if let Err(e) = handle_client(unified_stream, app_clone, rt_handle_clone, auth_token_clone) {
                                                error!("[TAURI_MCP] Error handling TCP client: {}", e);
                                            }
                                        }));
                                        if let Err(panic) = result {
                                            error!("[TAURI_MCP] TCP client handler panicked: {:?}", panic);
                                        }
                                    });
                                }
                                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                    // No connection available, sleep briefly
                                    std::thread::sleep(std::time::Duration::from_millis(100));
                                }
                                Err(e) => {
                                    error!("[TAURI_MCP] Error accepting TCP connection: {}", e);
                                    std::thread::sleep(std::time::Duration::from_millis(100));
                                }
                            }
                        }
                    }
                }
            }
            info!("[TAURI_MCP] Listener thread ending");
        });

        match &self.socket_type {
            SocketType::Ipc { path } => {
                let display_path = if let Some(p) = path {
                    p.to_string_lossy().to_string()
                } else {
                    std::env::temp_dir().join("tauri-mcp.sock").to_string_lossy().to_string()
                };
                info!(
                    "[TAURI_MCP] Socket server started successfully at {}",
                    display_path
                );
            }
            SocketType::Tcp { host, port } => {
                info!(
                    "[TAURI_MCP] Socket server started successfully at {}:{}",
                    host, port
                );
            }
        }
        Ok(())
    }

    pub fn stop(&self) -> crate::Result<()> {
        info!("[TAURI_MCP] Stopping socket server");
        // Set running flag to false to stop the server thread
        *self.running.lock().unwrap_or_else(|e| e.into_inner()) = false;

        // Delete the auth token file if we created one
        if let Some(ref path) = self.token_file_path {
            match std::fs::remove_file(path) {
                Ok(_) => info!("[TAURI_MCP] Deleted auth token file: {}", path),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    // Already gone — not an error
                }
                Err(e) => {
                    error!("[TAURI_MCP] Failed to delete auth token file {}: {}", path, e);
                }
            }
        }

        // The interprocess crate automatically cleans up the socket file on drop for Unix platforms
        info!("[TAURI_MCP] Socket server stopped");
        Ok(())
    }

    #[cfg(desktop)]
    fn get_socket_name(&self, path: &Option<std::path::PathBuf>) -> Result<Name<'_>, Error> {
        let socket_path = if let Some(p) = path {
            p.to_string_lossy().to_string()
        } else {
            let temp_dir = std::env::temp_dir();
            temp_dir.join("tauri-mcp.sock").to_string_lossy().to_string()
        };

        if cfg!(target_os = "windows") {
            // Use named pipe on Windows
            socket_path
                .to_ns_name::<GenericNamespaced>()
                .map_err(|e| Error::Io(format!("Failed to create pipe name: {}", e)))
        } else {
            // Use file-based socket on Unix platforms
            socket_path
                .clone()
                .to_fs_name::<GenericFilePath>()
                .map_err(|e| Error::Io(format!("Failed to create file socket name: {}", e)))
        }
    }
}

fn handle_client<R: Runtime>(stream: UnifiedStream, app: AppHandle<R>, rt_handle: tokio::runtime::Handle, auth_token: Option<Arc<str>>) -> crate::Result<()> {
    info!("[TAURI_MCP] Handling new client connection");

    rt_handle.block_on(async {
        // Create a buffered reader and separate writer for the socket
        let stream_clone = match stream.try_clone() {
            Ok(clone) => clone,
            Err(e) => {
                // This might be a disconnection error on Windows
                if e.to_string()
                    .contains("No process is on the other end of the pipe")
                {
                    info!("[TAURI_MCP] Client already disconnected (pipe error)");
                    return Ok(());
                }
                return Err(Error::Io(format!("Failed to clone stream: {}", e)));
            }
        };

        // Wrap the streams with our logging wrapper
        let logging_reader = LoggingStream::new(stream_clone);
        let mut reader = BufReader::new(logging_reader);
        let mut writer = LoggingStream::new(stream);

        // Keep handling requests until the client disconnects
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    // End of stream, client disconnected
                    info!("[TAURI_MCP] Client disconnected cleanly");
                    return Ok(());
                }
                Ok(_) => {
                    info!("[TAURI_MCP] Received command: {}", line.trim());
                }
                Err(e) => {
                    // Check if this is a pipe disconnection error
                    if e.to_string()
                        .contains("No process is on the other end of the pipe")
                        || e.kind() == std::io::ErrorKind::BrokenPipe
                    {
                        info!("[TAURI_MCP] Client disconnected during read (pipe error)");
                        return Ok(());
                    }
                    return Err(Error::Io(format!("Error reading from socket: {}", e)));
                }
            };

        // Parse and process the request
        let request: SocketRequest = match serde_json::from_str(&line) {
            Ok(req) => req,
            Err(e) => {
                let error_msg = format!("Invalid request format: {}", e);
                info!("[TAURI_MCP] {}", error_msg);

                // Create and send an error response
                let error_response = SocketResponse {
                    success: false,
                    data: None,
                    error: Some(error_msg),
                    id: None,
                };

                let error_json = match serde_json::to_string(&error_response) {
                    Ok(json) => json + "\n",
                    Err(_) => {
                        return Err(Error::Anyhow(
                            "Failed to serialize error response".to_string(),
                        ));
                    }
                };

                match writer.write_all(error_json.as_bytes()) {
                    Ok(_) => {
                        if let Err(e) = writer.flush() {
                            return Err(Error::Io(format!("Error flushing error response: {}", e)));
                        }
                    }
                    Err(e) => {
                        return Err(Error::Io(format!("Error writing error response: {}", e)));
                    }
                }

                // Clear the line and continue to the next iteration
                line.clear();
                continue;
            }
        };

        // Validate auth token if configured
        if let Some(ref expected_token) = auth_token {
            match &request.auth_token {
                Some(provided_token) if provided_token == expected_token.as_ref() => {
                    // Token matches, proceed
                }
                _ => {
                    let request_id = request.id.clone();
                    let mut error_response = SocketResponse {
                        success: false,
                        data: None,
                        error: Some("Authentication failed: invalid or missing auth token".to_string()),
                        id: None,
                    };
                    error_response.id = request_id;
                    let error_json = serde_json::to_string(&error_response)
                        .map_err(|e| Error::Anyhow(format!("Failed to serialize auth error: {}", e)))?
                        + "\n";
                    writer.write_all(error_json.as_bytes())
                        .map_err(|e| Error::Io(format!("Error writing auth error: {}", e)))?;
                    writer.flush()
                        .map_err(|e| Error::Io(format!("Error flushing auth error: {}", e)))?;
                    line.clear();
                    continue;
                }
            }
        }

        info!("[TAURI_MCP] Processing command: {}", request.command);

        // Capture request ID for response correlation
        let request_id = request.id.clone();

        // Use the centralized command handler from tools module
        let mut response = match tools::handle_command(&app, &request.command, request.payload).await {
            Ok(resp) => resp,
            Err(e) => {
                // Convert the error into a response structure
                info!("[TAURI_MCP] Command error: {}", e);
                SocketResponse {
                    success: false,
                    data: None,
                    error: Some(e.to_string()),
                    id: None,
                }
            }
        };

        // Correlate response with request ID
        response.id = request_id;

        // When writing the response, handle pipe errors gracefully
        let response_json = serde_json::to_string(&response)
            .map_err(|e| Error::Anyhow(format!("Failed to serialize response: {}", e)))?
            + "\n";
        info!(
            "[TAURI_MCP] Sending response: length = {} bytes",
            response_json.len()
        );

        // Write the response directly without chunking
        match writer.write_all(response_json.as_bytes()) {
            Ok(_) => {
                match writer.flush() {
                    Ok(_) => {
                        info!("[TAURI_MCP] Response sent successfully");
                        // Continue to the next iteration of the loop
                    }
                    Err(e) => {
                        if e.to_string()
                            .contains("No process is on the other end of the pipe")
                            || e.kind() == std::io::ErrorKind::BrokenPipe
                        {
                            info!(
                                "[TAURI_MCP] Client disconnected during flush (pipe error)"
                            );
                            return Ok(()); // Return success for expected client disconnect
                        } else {
                            return Err(Error::Io(format!("Error flushing response: {}", e)));
                        }
                    }
                }
            }
            Err(e) => {
                if e.to_string()
                    .contains("No process is on the other end of the pipe")
                    || e.kind() == std::io::ErrorKind::BrokenPipe
                {
                    info!("[TAURI_MCP] Client disconnected during write (pipe error)");
                    return Ok(()); // Return success for expected client disconnect
                } else {
                    return Err(Error::Io(format!("Error writing response: {}", e)));
                }
            }
        }
        
        // Clear the line for the next command
        line.clear();
        } // End of loop
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_socket_request_deserialization() {
        let json = r#"{"command":"ping","payload":{"value":"hello"}}"#;
        let req: SocketRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.command, "ping");
        assert!(req.id.is_none());
        assert!(req.auth_token.is_none());
    }

    #[test]
    fn test_socket_request_with_id_and_auth() {
        let json = r#"{"command":"get_dom","payload":{},"id":"req-123","authToken":"secret"}"#;
        let req: SocketRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.command, "get_dom");
        assert_eq!(req.id.as_deref(), Some("req-123"));
        assert_eq!(req.auth_token.as_deref(), Some("secret"));
    }

    #[test]
    fn test_socket_response_serialization_success() {
        let resp = SocketResponse {
            success: true,
            data: Some(serde_json::json!({"key": "value"})),
            error: None,
            id: Some("req-1".to_string()),
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"success\":true"));
        assert!(json.contains("\"id\":\"req-1\""));
        assert!(json.contains("\"error\":null"));
    }

    #[test]
    fn test_socket_response_serialization_error() {
        let resp = SocketResponse {
            success: false,
            data: None,
            error: Some("something failed".to_string()),
            id: None,
        };
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"success\":false"));
        assert!(json.contains("something failed"));
    }

    #[test]
    fn test_auth_token_matching() {
        let expected: Arc<str> = Arc::from("my-secret-token");
        let provided = "my-secret-token";
        assert_eq!(provided, expected.as_ref());

        let wrong = "wrong-token";
        assert_ne!(wrong, expected.as_ref());
    }
}
