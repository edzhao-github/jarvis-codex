use super::{digest, explicit_statement, storage, MemoryError, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const INBOX: &str = "记忆条目";
const MAX_STATEMENT_BYTES: usize = 64 * 1024;
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RawChannel {
    Text,
    Voice,
}

impl RawChannel {
    fn label(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Voice => "voice",
        }
    }
}

#[derive(Serialize)]
pub(crate) struct RawReceipt {
    path: String,
    created: bool,
}

/// Save only the requested statement. Raw records are outside the Wiki and the
/// recall index. Filenames derive from content so a retried request is harmless.
pub(crate) fn save(workspace: &Path, request: &str, channel: RawChannel) -> Result<RawReceipt> {
    let statement = explicit_statement(request)
        .filter(|statement| !statement.is_empty())
        .ok_or(MemoryError::Invalid(
            "请说清楚要记住的内容，例如「记住：每周五给植物浇水」。",
        ))?;
    if statement.len() > MAX_STATEMENT_BYTES || statement.contains('\0') {
        return Err(MemoryError::Invalid("要保存的内容过长或包含无效字符"));
    }
    let lower = statement.to_ascii_lowercase();
    if [
        "密码",
        "验证码",
        "密钥",
        "私钥",
        "password",
        "api key",
        "access token",
    ]
    .iter()
    .any(|label| lower.contains(label))
    {
        return Err(MemoryError::Invalid(
            "密码、验证码和密钥等秘密不会写入 Raw。",
        ));
    }
    if ["身份证号", "身份证号码", "银行卡号", "病历", "诊断报告"]
        .iter()
        .any(|label| lower.contains(label))
    {
        return Err(MemoryError::Invalid(
            "这条内容可能涉及敏感资料，请先在本机手动确认和保存。",
        ));
    }

    let workspace = workspace.canonicalize()?;
    let memory = workspace.join("记忆");
    let raw = memory.join("raw");
    for directory in [&memory, &raw] {
        if !fs::symlink_metadata(directory).is_ok_and(|metadata| metadata.is_dir()) {
            return Err(MemoryError::Invalid(
                "当前工作区缺少本地「记忆/raw」目录，或路径含符号链接。",
            ));
        }
    }
    let inbox = raw.join(INBOX);
    storage::ensure_directory(&inbox)?;

    let hash = digest(statement);
    let name = format!("条目-{hash}.md");
    let path = inbox.join(&name);
    let temporary = inbox.join(format!(
        ".raw-{}-{}.pending",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| MemoryError::Invalid("系统时间无效"))?
        .as_millis();
    let document = format!(
        "---\ntype: raw-memory\nsource: explicit-user-request\nchannel: {}\ncaptured_at_ms: {time}\n---\n\n# 待入库记忆\n\n{statement}\n",
        channel.label()
    );

    let mut file = storage::private_file_options()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(document.as_bytes())?;
        file.sync_all()?;
        match fs::hard_link(&temporary, &path) {
            Ok(()) => {
                #[cfg(unix)]
                fs::File::open(&inbox)?.sync_all()?;
                Ok(true)
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                let metadata = fs::symlink_metadata(&path)?;
                if !metadata.is_file() || metadata.len() > (MAX_STATEMENT_BYTES + 512) as u64 {
                    return Err(MemoryError::Invalid("已有 Raw 条目路径不是可核对的文件。"));
                }
                let existing = fs::read_to_string(&path)?;
                let body = existing
                    .split_once("\n# 待入库记忆\n\n")
                    .map(|(_, body)| body);
                if body.and_then(|body| body.strip_suffix('\n')) != Some(statement) {
                    return Err(MemoryError::Invalid(
                        "已有 Raw 条目内容不同，文件未被覆盖。",
                    ));
                }
                Ok(false)
            }
            Err(error) => Err(error.into()),
        }
    })();
    drop(file);
    let cleanup = fs::remove_file(&temporary);
    let created = result?;
    cleanup?;
    Ok(RawReceipt {
        path: format!("记忆/raw/{INBOX}/{name}"),
        created,
    })
}
