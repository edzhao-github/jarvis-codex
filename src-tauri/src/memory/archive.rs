//! The local Raw transcript archive. It is never a Wiki or recall data source.

use super::{storage, MemoryError, Result, Role};
use chrono::Local;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Channel {
    Text,
    Voice,
    Codex,
    Local,
}

pub(crate) struct ChatMessage {
    pub role: Role,
    pub channel: Channel,
    pub text: String,
    pub thread: Option<String>,
    id: Option<String>,
}

impl ChatMessage {
    pub(crate) fn local(role: Role, text: String) -> Self {
        Self {
            role,
            channel: if role == Role::User {
                Channel::Text
            } else {
                Channel::Local
            },
            text,
            thread: None,
            id: None,
        }
    }

    pub(crate) fn from_event(event: &Value) -> Option<Self> {
        let params = event.get("params")?;
        let thread = params.get("threadId")?.as_str()?.to_owned();
        let (role, channel, text, id) = match event.get("method")?.as_str()? {
            "thread/realtime/transcript/done" => {
                let role = match params.get("role")?.as_str()? {
                    "user" => Role::User,
                    "assistant" => Role::Assistant,
                    _ => return None,
                };
                let text = params.get("text")?.as_str()?;
                (role, Channel::Voice, text, None)
            }
            "item/completed" => {
                let item = params.get("item")?;
                if item.get("type")?.as_str()? != "agentMessage" {
                    return None;
                }
                let text = item.get("text")?.as_str()?;
                let id = item.get("id").and_then(Value::as_str).map(str::to_owned);
                (Role::Assistant, Channel::Codex, text, id)
            }
            _ => return None,
        };
        Some(Self {
            role,
            channel,
            text: text.to_owned(),
            thread: Some(thread),
            id,
        })
    }
}

pub(crate) struct ChatArchive {
    done: Mutex<BTreeSet<(PathBuf, String, String)>>,
}

impl ChatArchive {
    pub(crate) fn new() -> Self {
        Self {
            done: Mutex::new(BTreeSet::new()),
        }
    }

    pub(crate) fn append(&self, workspace: &Path, msg: ChatMessage) -> Result<()> {
        if msg.text.trim().is_empty() {
            return Ok(());
        }
        let captured_at = Local::now();
        let workspace = workspace.canonicalize()?;
        let key = msg
            .id
            .as_ref()
            .zip(msg.thread.as_ref())
            .map(|(id, thread)| (workspace.clone(), thread.clone(), id.clone()));
        let mut done = self
            .done
            .lock()
            .map_err(|_| MemoryError::Invalid("聊天归档锁不可用"))?;
        if key.as_ref().is_some_and(|key| done.contains(key)) {
            return Ok(());
        }

        let mut root = workspace;
        let day = captured_at.format("%Y-%m-%d").to_string();
        for part in ["记忆", "raw", "聊天记录"] {
            root.push(part);
            storage::ensure_directory(&root)?;
        }
        let day_path = root.join(format!("{day}.md"));
        let lock_path = root.join(".archive.lock");
        storage::regular_file_or_missing(&lock_path)?;
        let lock = storage::private_file_options()
            .read(true)
            .write(true)
            .create(true)
            .open(lock_path)?;
        lock.lock()?;

        let (role, label) = if msg.role == Role::User {
            ("user", "用户")
        } else {
            ("assistant", "贾维斯")
        };
        let channel = serde_json::to_string(&msg.channel).map_err(MemoryError::InvalidStore)?;
        let thread = serde_json::to_string(&msg.thread).map_err(MemoryError::InvalidStore)?;
        let now = captured_at.timestamp_millis();
        let time = captured_at.format("%H:%M:%S%.3f");
        let temporary = root.join(format!(
            ".chat-{}-{}.pending",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = storage::private_file_options()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let result = (|| -> Result<()> {
            if storage::regular_file_or_missing(&day_path)? {
                io::copy(&mut fs::File::open(&day_path)?, &mut file)?;
            } else {
                writeln!(file, "# {day} 聊天记录")?;
            }
            write!(file, "\n## {time} · {label}\n\n<!-- raw-chat role={role} channel={channel} thread={thread} captured_at_ms={now} bytes={} -->\n\n", msg.text.len())?;
            file.write_all(msg.text.as_bytes())?;
            file.write_all(b"\n")?;
            file.sync_all()?;
            fs::rename(&temporary, &day_path)?;
            Ok(())
        })();
        drop(file);
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result?;
        if let Some(key) = key {
            done.insert(key);
        }
        #[cfg(unix)]
        fs::File::open(&root)?.sync_all()?;
        Ok(())
    }
}
