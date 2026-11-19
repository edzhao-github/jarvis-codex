use serde_json::Value;
use std::{path::PathBuf, process::Stdio};
use tauri::{AppHandle, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::Mutex,
    time::{timeout, Duration},
};

#[derive(Default)]
pub struct Bridge(pub Mutex<Option<Child>>);

#[tauri::command]
pub async fn stop_qwen_bridge(state: State<'_, Bridge>) -> Result<(), String> {
    let mut guard = state.0.lock().await;
    if let Some(mut child) = guard.take() {
        drop(child.stdin.take()); // EOF requests graceful Harness cleanup.
        if timeout(Duration::from_secs(15), child.wait())
            .await
            .is_err()
        {
            *guard = Some(child);
            return Err("语音驱动停止尚未确认，请稍后重试".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn start_qwen_bridge(
    app: AppHandle,
    state: State<'_, Bridge>,
    cwd: String,
) -> Result<Value, String> {
    let workspace = PathBuf::from(cwd)
        .canonicalize()
        .map_err(|_| "工作目录不存在")?;
    if !workspace.is_dir() {
        return Err("工作目录必须是文件夹".into());
    }
    let mut guard = state.0.lock().await;
    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            return Err("语音驱动仍在运行，请先结束通话".into());
        }
    }
    *guard = None;
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("voice-runtime");
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runtime/desktop-voice");
    let root = if bundled.join("node").is_file() {
        bundled
    } else {
        development
    };
    if !root.join("node").is_file() {
        return Err("缺少语音运行时，请运行 npm run voice:prepare 后重新构建".into());
    }
    let home = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("deepseek");
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let personality = crate::user_profile::personality(&workspace.to_string_lossy())?;
    let mut child = Command::new(root.join("node"))
        .arg(root.join("server.mjs"))
        .current_dir(&workspace)
        .env("QWEN_DESKTOP", "1")
        .env(
            "QWEN_WIKI_BIN",
            std::env::current_exe().map_err(|e| e.to_string())?,
        )
        .env("QWEN_WORKSPACE", &workspace)
        .env("QWEN_HARNESS_HOME", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("语音驱动启动失败：{e}"))?;
    let stdout = child.stdout.take().ok_or("语音驱动输出不可用")?;
    let mut lines = BufReader::new(stdout).lines();
    let first = timeout(Duration::from_secs(10), lines.next_line()).await;
    let line = match first {
        Ok(Ok(Some(line))) => line,
        _ => {
            let _ = child.kill().await;
            return Err("语音驱动启动超时或退出".into());
        }
    };
    let mut result: Value = serde_json::from_str(&line).map_err(|_| "语音驱动启动响应无效")?;
    result["personality"] = Value::String(personality);
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    *guard = Some(child);
    Ok(result)
}
