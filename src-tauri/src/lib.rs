pub mod credentials;
mod ingestion;
pub mod memory;
mod qwen;
mod system_stats;
mod user_profile;
mod wiki_search;
use serde::Serialize;
use serde_json::{json, Value};
use std::process::Stdio;
use std::{
    fs,
    io::{BufRead, Seek, SeekFrom},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    process::Command,
    sync::{oneshot, RwLock},
    time::{timeout, Duration},
};
struct AppState {
    chat_archive: Arc<memory::archive::ChatArchive>,
    cold_wake_pending: AtomicBool,
    background_start: bool,
    wake_enabled: AtomicBool,
    wake_ready: AtomicBool,
    wake_supervisor_running: AtomicBool,
    wake_pid: AtomicU32,
    wake_authorization: RwLock<String>,
}
#[tauri::command]
fn startup_is_background(state: State<'_, AppState>) -> bool {
    state.background_start
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn request_microphone_permission() -> Result<String, String> {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    use std::sync::Mutex as StdMutex;

    let media_type =
        unsafe { AVMediaTypeAudio }.ok_or_else(|| "macOS 未提供音频授权类型".to_owned())?;
    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) };
    match status {
        AVAuthorizationStatus::Authorized => return Ok("authorized".to_owned()),
        AVAuthorizationStatus::Denied => return Ok("denied".to_owned()),
        AVAuthorizationStatus::Restricted => return Ok("restricted".to_owned()),
        _ => {}
    }

    let (sender, receiver) = oneshot::channel::<bool>();
    let sender = Arc::new(StdMutex::new(Some(sender)));
    {
        let completion_sender = sender.clone();
        let completion = RcBlock::new(move |granted: Bool| {
            if let Ok(mut guard) = completion_sender.lock() {
                if let Some(sender) = guard.take() {
                    let _ = sender.send(granted.as_bool());
                }
            }
        });
        unsafe {
            AVCaptureDevice::requestAccessForMediaType_completionHandler(media_type, &completion);
        }
    }
    let granted = receiver
        .await
        .map_err(|_| "macOS 麦克风授权回调中断".to_owned())?;
    Ok(if granted { "authorized" } else { "denied" }.to_owned())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn request_microphone_permission() -> Result<String, String> {
    Ok("authorized".to_owned())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WakeStatus {
    enabled: bool,
    ready: bool,
    authorization: String,
}

fn raise_jarvis_window(app: &AppHandle) {
    let app_handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        {
            use objc2::MainThreadMarker;
            use objc2_app_kit::NSApplication;

            if let Some(mtm) = MainThreadMarker::new() {
                let application = NSApplication::sharedApplication(mtm);
                #[allow(deprecated)]
                application.activateIgnoringOtherApps(true);
            }
        }

        if let Some(window) = app_handle.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            // A short floating interval lets macOS finish switching the
            // active application before the window returns to normal level.
            let _ = window.set_always_on_top(true);
            let _ = window.set_focus();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(700)).await;
                let _ = window.set_always_on_top(false);
            });
        }
    });
}

fn wake_helper_path(app: &AppHandle) -> Result<PathBuf, String> {
    let relative = PathBuf::from("wake-helper/JarvisWakeListener.app");
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join(&relative);
        if bundled.exists() {
            return Ok(bundled);
        }
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative);
    if development.exists() {
        return Ok(development);
    }
    Err("Jarvis 唤醒监听器未找到".to_owned())
}

fn host_app_bundle_path(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let contents_dir = resource_dir.parent()?;
    let bundle = contents_dir.parent()?;
    (bundle.extension().and_then(|value| value.to_str()) == Some("app"))
        .then(|| bundle.to_path_buf())
}

async fn wake_status_value(state: &AppState) -> WakeStatus {
    WakeStatus {
        enabled: state.wake_enabled.load(Ordering::SeqCst),
        ready: state.wake_ready.load(Ordering::SeqCst),
        authorization: state.wake_authorization.read().await.clone(),
    }
}

fn start_wake_supervisor(app: AppHandle) {
    let state = app.state::<AppState>();
    if state.wake_supervisor_running.swap(true, Ordering::SeqCst) {
        return;
    }
    state.wake_enabled.store(true, Ordering::SeqCst);

    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let helper = match wake_helper_path(&app) {
            Ok(path) => path,
            Err(error) => {
                *state.wake_authorization.write().await = error.clone();
                state.wake_enabled.store(false, Ordering::SeqCst);
                state.wake_supervisor_running.store(false, Ordering::SeqCst);
                let _ = app.emit("jarvis-wake-status", wake_status_value(&state).await);
                return;
            }
        };
        // A previous host may have exited while its LaunchServices helper
        // remained alive. Keep exactly one microphone listener.
        let _ = Command::new("/usr/bin/pkill")
            .args(["-x", "JarvisWakeListener"])
            .status()
            .await;

        let mut woke = false;
        while state.wake_enabled.load(Ordering::SeqCst) {
            state.wake_ready.store(false, Ordering::SeqCst);
            let event_file =
                std::env::temp_dir().join(format!("jarvis-wake-{}.jsonl", std::process::id()));
            let _ = fs::remove_file(&event_file);
            if let Err(error) = fs::write(&event_file, "") {
                *state.wake_authorization.write().await = format!("无法创建唤醒事件通道：{error}");
                break;
            }
            if !state.wake_enabled.load(Ordering::SeqCst) {
                let _ = fs::remove_file(&event_file);
                break;
            }

            // LaunchServices is required so macOS attributes microphone and
            // speech-recognition permissions to the helper app bundle.
            let mut command = Command::new("/usr/bin/open");
            command
                .args(["-n", "-W"])
                .arg(&helper)
                .args(["--args", "--event-file"])
                .arg(&event_file);
            if let Some(host_app) = host_app_bundle_path(&app) {
                command.arg("--host-app").arg(host_app);
            }
            let mut child = match command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
            {
                Ok(child) => child,
                Err(error) => {
                    *state.wake_authorization.write().await =
                        format!("无法启动唤醒监听器：{error}");
                    break;
                }
            };
            state
                .wake_pid
                .store(child.id().unwrap_or(0), Ordering::SeqCst);
            let mut offset = 0;

            loop {
                let events = fs::File::open(&event_file).and_then(|file| {
                    let mut reader = std::io::BufReader::new(file);
                    reader.seek(SeekFrom::Start(offset))?;
                    Ok(reader)
                });
                if let Ok(mut events) = events {
                    let mut line = Vec::new();
                    while next_wake_event(&mut events, &mut line, &mut offset) {
                        let Ok(message) = serde_json::from_slice::<Value>(&line) else {
                            continue;
                        };
                        match message.get("type").and_then(Value::as_str) {
                            Some("authorization") => {
                                let authorization = message
                                    .get("status")
                                    .and_then(Value::as_str)
                                    .unwrap_or("unknown");
                                *state.wake_authorization.write().await = authorization.to_owned();
                                // `notDetermined` means the helper has just asked
                                // macOS for access. Keep it alive so the native
                                // permission sheet can complete its callback.
                                if matches!(authorization, "denied" | "restricted") {
                                    state.wake_enabled.store(false, Ordering::SeqCst);
                                }
                            }
                            Some("ready") => {
                                state.wake_ready.store(true, Ordering::SeqCst);
                            }
                            Some("wake") => {
                                woke = true;
                                state.wake_enabled.store(false, Ordering::SeqCst);
                                state.wake_ready.store(false, Ordering::SeqCst);
                                raise_jarvis_window(&app);
                            }
                            Some("error") => {
                                *state.wake_authorization.write().await = message
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("wake listener error")
                                    .to_owned();
                            }
                            _ => {}
                        }
                        let _ = app.emit("jarvis-wake-status", wake_status_value(&state).await);
                        if woke {
                            break;
                        }
                    }
                }
                if woke || !state.wake_enabled.load(Ordering::SeqCst) {
                    break;
                }
                if child.try_wait().ok().flatten().is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }

            if woke || !state.wake_enabled.load(Ordering::SeqCst) {
                let _ = Command::new("/usr/bin/pkill")
                    .args(["-x", "JarvisWakeListener"])
                    .status()
                    .await;
            }
            let _ = child.wait().await;
            let _ = fs::remove_file(&event_file);
            state.wake_pid.store(0, Ordering::SeqCst);
            if woke || !state.wake_enabled.load(Ordering::SeqCst) {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }

        state.wake_ready.store(false, Ordering::SeqCst);
        state.wake_supervisor_running.store(false, Ordering::SeqCst);
        if woke {
            // The WebView owns the audio connection, so wake only raises the
            // Jarvis surface and asks the renderer to begin the official DeepSeek
            // Qwen voice connection. No keypress or UI automation.
            let _ = app.emit("jarvis-wake", json!({"ok": true}));
        }
        let _ = app.emit("jarvis-wake-status", wake_status_value(&state).await);
    });
}

fn next_wake_event(reader: &mut impl BufRead, line: &mut Vec<u8>, offset: &mut u64) -> bool {
    line.clear();
    match reader.read_until(b'\n', line) {
        Ok(bytes) if line.ends_with(b"\n") => {
            *offset += bytes as u64;
            true
        }
        _ => false,
    }
}

#[tauri::command]
async fn arm_wake_listener(app: AppHandle) -> Result<WakeStatus, String> {
    start_wake_supervisor(app.clone());
    tokio::time::sleep(Duration::from_millis(80)).await;
    Ok(wake_status_value(&app.state::<AppState>()).await)
}

#[tauri::command]
async fn disarm_wake_listener(app: AppHandle) -> Result<WakeStatus, String> {
    let state = app.state::<AppState>();
    state.wake_enabled.store(false, Ordering::SeqCst);
    state.wake_ready.store(false, Ordering::SeqCst);
    let pid = state.wake_pid.swap(0, Ordering::SeqCst);
    if pid > 0 {
        let _ = Command::new("/bin/kill")
            .arg(pid.to_string())
            .status()
            .await;
    }
    // The supervisor starts asynchronously and can cross this command in
    // flight. Keep terminating until it has observed wake_enabled=false.
    for _ in 0..15 {
        let _ = Command::new("/usr/bin/pkill")
            .args(["-x", "JarvisWakeListener"])
            .status()
            .await;
        if !state.wake_supervisor_running.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // AVAudioEngine releases the input device asynchronously after SIGTERM.
    // Starting WebRTC in the same tick can otherwise fail with NotAllowedError.
    tokio::time::sleep(Duration::from_millis(350)).await;
    Ok(wake_status_value(&state).await)
}

#[tauri::command]
async fn wake_listener_status(app: AppHandle) -> WakeStatus {
    wake_status_value(&app.state::<AppState>()).await
}

#[tauri::command]
async fn consume_cold_wake(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    if !state.cold_wake_pending.swap(false, Ordering::SeqCst) {
        return Ok(false);
    }
    // Replay a cold launch through the same external event path as a normal
    // warm wake, but only after the newly spawned listener fully releases mic.
    state.wake_enabled.store(false, Ordering::SeqCst);
    state.wake_ready.store(false, Ordering::SeqCst);
    let pid = state.wake_pid.swap(0, Ordering::SeqCst);
    if pid > 0 {
        let _ = Command::new("/bin/kill")
            .arg(pid.to_string())
            .status()
            .await;
    }
    for _ in 0..15 {
        let _ = Command::new("/usr/bin/pkill")
            .args(["-x", "JarvisWakeListener"])
            .status()
            .await;
        if !state.wake_supervisor_running.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tokio::time::sleep(Duration::from_millis(350)).await;
    raise_jarvis_window(&app);
    let _ = app.emit("jarvis-wake", json!({"ok": true, "cold": true}));
    Ok(true)
}

#[tauri::command]
fn default_workspace() -> Result<String, String> {
    if let Ok(configured) = std::env::var("JARVIS_WORKSPACE") {
        let path = PathBuf::from(configured);
        if path.is_dir() {
            return path
                .canonicalize()
                .map(|value| value.to_string_lossy().into_owned())
                .map_err(|error| format!("无法读取 JARVIS_WORKSPACE：{error}"));
        }
    }
    // Prefer the checkout that owns this build so its existing Wiki and Raw
    // records remain available. Explicit configuration still takes precedence.
    if let Some(project) = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent() {
        if project.is_dir() {
            return project
                .canonicalize()
                .map(|value| value.to_string_lossy().into_owned())
                .map_err(|error| format!("无法读取项目工作目录：{error}"));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let path = PathBuf::from(home);
        if path.is_dir() {
            return Ok(path.to_string_lossy().into_owned());
        }
    }
    std::env::current_dir()
        .map(|value| value.to_string_lossy().into_owned())
        .map_err(|error| format!("无法确定默认工作目录：{error}"))
}

fn validated_workspace(cwd: &str) -> Result<String, String> {
    let path = PathBuf::from(cwd);
    if !path.is_dir() {
        return Err(format!("工作目录不存在或不是文件夹：{cwd}"));
    }
    path.canonicalize()
        .map(|value| value.to_string_lossy().into_owned())
        .map_err(|error| format!("无法读取工作目录：{error}"))
}

async fn archive_chat(
    archive: Arc<memory::archive::ChatArchive>,
    cwd: String,
    message: memory::archive::ChatMessage,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || archive.append(std::path::Path::new(&cwd), message))
        .await
        .map_err(|error| format!("聊天归档任务失败：{error}"))?
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn archive_local_chat(
    state: State<'_, AppState>,
    cwd: String,
    role: memory::Role,
    text: String,
    channel: Option<memory::archive::Channel>,
    thread: Option<String>,
) -> Result<(), String> {
    let cwd = validated_workspace(&cwd)?;
    archive_chat(
        Arc::clone(&state.chat_archive),
        cwd,
        memory::archive::ChatMessage::record(
            role,
            channel.unwrap_or(memory::archive::Channel::Local),
            text,
            thread,
            None,
        ),
    )
    .await
}

#[tauri::command]
fn save_raw_memory(
    cwd: String,
    request: String,
    channel: memory::raw::RawChannel,
) -> Result<memory::raw::RawReceipt, String> {
    let cwd = validated_workspace(&cwd)?;
    memory::raw::save(std::path::Path::new(&cwd), &request, channel)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn read_user_profile(
    cwd: String,
    section: Option<user_profile::ProfileSection>,
) -> Result<Option<String>, String> {
    let cwd = validated_workspace(&cwd)?;
    user_profile::read(&cwd, section)
}

#[tauri::command]
async fn speak_map_prompt(text: String) -> Result<(), String> {
    let mut command = Command::new("/usr/bin/say");
    command
        .args(["-v", "Tingting", "--", &text])
        .kill_on_drop(true);
    let status = timeout(Duration::from_secs(30), command.status())
        .await
        .map_err(|_| "本地播报超时")?
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("本地播报失败".into())
    }
}
#[tauri::command]
async fn speak_map_failure(text: String) -> Result<(), String> {
    speak_map_prompt(text).await
}
pub fn lookup_profile_from_cli(section: &str) -> Result<String, String> {
    let cwd = std::env::current_dir().map_err(|error| format!("无法定位当前工作目录：{error}"))?;
    let workspace = validated_workspace(&cwd.to_string_lossy())?;
    user_profile::lookup(&workspace, section)
}

pub fn read_wiki_from_cli(page: &str) -> Result<String, String> {
    let cwd = std::env::current_dir().map_err(|error| format!("无法定位当前工作目录：{error}"))?;
    user_profile::read_wiki_page(&cwd, page)
}

pub fn search_wiki_from_cli(query: &str) -> Result<String, String> {
    let cwd = std::env::current_dir().map_err(|error| format!("无法定位当前工作目录：{error}"))?;
    let cwd = validated_workspace(&cwd.to_string_lossy())?;
    let matches = wiki_search::search(std::path::Path::new(&cwd), query)?;
    if matches.is_empty() {
        return Ok("Wiki 里没有找到相关条目。".into());
    }
    Ok(matches
        .into_iter()
        .map(|entry| format!("来源：{}\n{}", entry.source, entry.excerpt))
        .collect::<Vec<_>>()
        .join("\n\n"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let arguments: Vec<String> = std::env::args().collect();
    let cold_wake_pending = arguments.iter().any(|argument| argument == "--jarvis-wake");
    // The login agent opts into a hidden launch. Opening the app is foreground.
    let background_start = arguments.iter().any(|argument| argument == "--background")
        && !cold_wake_pending
        && !arguments.iter().any(|argument| argument == "--show");
    tauri::Builder::default()
        .manage(qwen::Bridge::default())
        .manage(AppState {
            chat_archive: Arc::new(memory::archive::ChatArchive::new()),
            cold_wake_pending: AtomicBool::new(cold_wake_pending),
            background_start,
            wake_enabled: AtomicBool::new(false),
            wake_ready: AtomicBool::new(false),
            wake_supervisor_running: AtomicBool::new(false),
            wake_pid: AtomicU32::new(0),
            wake_authorization: RwLock::new("notDetermined".to_owned()),
        })
        .invoke_handler(tauri::generate_handler![
            system_stats::system_stats,
            credentials::load_api_keys,
            credentials::save_api_keys,
            qwen::start_qwen_bridge,
            ingestion::memory_import_action,
            qwen::stop_qwen_bridge,
            speak_map_prompt,
            speak_map_failure,
            arm_wake_listener,
            disarm_wake_listener,
            wake_listener_status,
            consume_cold_wake,
            default_workspace,
            startup_is_background,
            request_microphone_permission,
            read_user_profile,
            save_raw_memory,
            archive_local_chat,
        ])
        .setup(move |app| {
            use tauri_plugin_autostart::MacosLauncher;
            app.handle().plugin(tauri_plugin_autostart::init(
                MacosLauncher::LaunchAgent,
                Some(vec!["--background"]),
            ))?;
            // Login startup is not enabled automatically: credentials are session-only.
            if let Some(window) = app.get_webview_window("main") {
                if background_start {
                    let _ = window.hide();
                } else {
                    raise_jarvis_window(app.handle());
                }
            }
            if background_start {
                start_wake_supervisor(app.handle().clone());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Jarvis DeepSeek")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let _ = tauri::async_runtime::block_on(qwen::stop_qwen_bridge(app.state()));
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                raise_jarvis_window(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
