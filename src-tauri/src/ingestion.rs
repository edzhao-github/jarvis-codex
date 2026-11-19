use serde_json::{json, Value};
use std::{path::PathBuf, process::Stdio};
use tauri::{AppHandle, Manager};
use tokio::{
    io::AsyncWriteExt,
    process::Command,
    time::{timeout, Duration},
};

#[tauri::command]
pub async fn memory_import_action(
    app: AppHandle,
    cwd: String,
    action: String,
    payload: Value,
) -> Result<Value, String> {
    if ![
        "auto", "resolve", "sources", "batches", "snapshot", "load", "generate", "edit", "commit",
        "skip", "revoke", "refresh",
    ]
    .contains(&action.as_str())
    {
        return Err("不支持的入库动作".into());
    }
    let workspace = PathBuf::from(cwd)
        .canonicalize()
        .map_err(|_| "工作目录不存在")?;
    if !workspace.is_dir() {
        return Err("工作目录必须是文件夹".into());
    }
    // OS lock survives process races and is released automatically on a crash.
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    workspace.hash(&mut hasher);
    let locks = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("import-locks");
    std::fs::create_dir_all(&locks).map_err(|_| "无法创建入库锁目录")?;
    let operation_lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(locks.join(format!("{:x}.lock", hasher.finish())))
        .map_err(|_| "无法打开入库锁")?;
    operation_lock
        .try_lock()
        .map_err(|_| "该工作区正在整理或提交，请稍后重试")?;
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("voice-runtime");
    let root = if bundled.join("node").is_file() {
        bundled
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runtime/desktop-voice")
    };
    let mut request = json!({"root":workspace,"action":action,"payload":payload});
    if action == "generate" || action == "auto" {
        if payload["consent"] != true {
            return Err("请先确认本次模型处理授权".into());
        }
        let keys = tokio::task::spawn_blocking(crate::credentials::load)
            .await
            .map_err(|_| "密钥读取失败")??;
        request["key"] = Value::String(keys.deepseek);
    }
    let input = serde_json::to_vec(&request).map_err(|_| "入库请求编码失败")?;
    if input.len() > 256 * 1024 {
        return Err("请求过大，请缩小范围".into());
    }
    let mut child = Command::new(root.join("node"))
        .arg(root.join("import-cli.mjs"))
        .current_dir(&workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "入库运行时启动失败，请重新构建应用")?;
    let mut stdin = child.stdin.take().ok_or("入库输入不可用")?;
    stdin
        .write_all(&input)
        .await
        .map_err(|_| "入库请求发送失败")?;
    drop(stdin);
    let output = timeout(
        Duration::from_secs(if action == "auto" { 900 } else { 240 }),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| "入库处理超时；提交可从原批次重试")?
    .map_err(|_| "入库进程失败")?;
    if output.stdout.len() > 16 * 1024 * 1024 {
        return Err("入库响应过大".into());
    }
    let response: Value = serde_json::from_slice(&output.stdout).map_err(|_| "入库返回格式无效")?;
    if response["ok"] != true {
        return Err(response["error"].as_str().unwrap_or("入库失败").to_owned());
    }
    Ok(response["result"].clone())
}
