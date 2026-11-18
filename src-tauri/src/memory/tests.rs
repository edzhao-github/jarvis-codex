use super::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Barrier,
};
use std::time::{SystemTime, UNIX_EPOCH};

struct Workspace(PathBuf);

impl Workspace {
    fn new() -> Self {
        static ID: AtomicU64 = AtomicU64::new(0);
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "jarvis-memory-{}-{nonce}-{}",
            std::process::id(),
            ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn store(&self) -> MemoryStore {
        MemoryStore::open(&self.0).unwrap()
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn snapshot(&self) -> PathBuf {
        self.0.join("记忆/记忆系统/state.json")
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn source(id: &str, occurred_at: u64) -> SourceRef {
    SourceRef {
        session_id: "合成对话".into(),
        message_id: id.into(),
        role: Role::User,
        occurred_at,
    }
}

fn draft(
    store: &MemoryStore,
    source: SourceRef,
    topic: &str,
    statement: &str,
    validity: Validity,
) -> Draft {
    extract(
        store.generation().unwrap(),
        Message {
            source,
            complete: true,
            text: &format!("请记住：{statement}"),
        },
        topic,
        Kind::Preference,
        Sensitivity::Ordinary,
        validity,
    )
    .unwrap()
    .unwrap()
}

fn propose(store: &MemoryStore, id: &str, at: u64, topic: &str, statement: &str) -> Record {
    store
        .propose(
            draft(store, source(id, at), topic, statement, Validity::default()),
            false,
        )
        .unwrap()
}

#[test]
fn explicit_completed_user_messages_require_individual_confirmation() {
    let workspace = Workspace::new();
    let store = workspace.store();
    let mut assistant = source("assistant", 1);
    assistant.role = Role::Assistant;
    for message in [
        Message {
            source: source("casual", 1),
            complete: true,
            text: "今天在喝合成茶",
        },
        Message {
            source: source("partial", 1),
            complete: false,
            text: "记住：测试前缀",
        },
        Message {
            source: assistant,
            complete: true,
            text: "记住：助手猜测",
        },
    ] {
        assert!(extract(
            0,
            message,
            "饮品",
            Kind::Preference,
            Sensitivity::Ordinary,
            Validity::default()
        )
        .unwrap()
        .is_none());
    }
    for (kind, sensitivity) in [
        (Kind::Preference, Sensitivity::Sensitive),
        (Kind::Fact, Sensitivity::Secret),
        (Kind::Impression, Sensitivity::Ordinary),
    ] {
        let message = Message {
            source: source("blocked", 1),
            complete: true,
            text: "记住：合成值",
        };
        assert!(extract(
            0,
            message,
            "合成主题",
            kind,
            sensitivity,
            Validity::default()
        )
        .is_err());
    }
    assert!(!workspace.snapshot().exists());

    let natural = extract(
        0,
        Message {
            source: source("natural", 1),
            complete: true,
            text: "请记住我偏好合成茶",
        },
        "饮品",
        Kind::Preference,
        Sensitivity::Ordinary,
        Validity::default(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(natural.statement, "我偏好合成茶");

    let event = source("stable-event", 10);
    let candidate = store
        .propose(
            draft(
                &store,
                event.clone(),
                "饮品",
                "合成桂花茶",
                Validity::default(),
            ),
            false,
        )
        .unwrap();
    assert_eq!(candidate.status, Status::Candidate);
    assert!(store.recall("饮品", 10, 2).unwrap().is_empty());
    assert!(store
        .confirm(candidate.version, vec![], event.clone())
        .is_err());
    let approval = source("approve-one", 11);
    let approved = store
        .confirm(candidate.version, vec![], approval.clone())
        .unwrap();
    assert_eq!(
        store
            .confirm(candidate.version, vec![], approval)
            .unwrap()
            .version,
        approved.version
    );
    drop(store);

    let reopened = workspace.store();
    let records = reopened.recall("饮品", 12, 1).unwrap();
    assert_eq!(records[0].source_refs, vec![event]);
    assert_eq!(records[0].status, Status::Active);
    assert_eq!(records[0].statement, "合成桂花茶");
    assert!(reopened.recall("无关主题", 12, 1).unwrap().is_empty());
    let serialized = fs::read_to_string(workspace.snapshot()).unwrap();
    assert!(!serialized.contains("请记住"));
    assert!(!serialized.contains("今天在喝"));
    let audit = serde_json::from_str::<serde_json::Value>(&serialized).unwrap()["state"]["audit"]
        .to_string();
    assert!(!audit.contains("合成桂花茶"));
    assert!(!audit.contains("stable-event"));
}

#[test]
fn deduplicates_replays_and_merges_new_sources_without_new_records() {
    let workspace = Workspace::new();
    let store = workspace.store();
    let first = propose(&store, "source", 1, "A   Topic", "合成值");
    let retry = propose(&store, "source", 1, "a topic", "合成值");
    assert_eq!(first.version, retry.version);
    assert!(matches!(
        store.propose(
            draft(
                &store,
                source("source", 1),
                "新主题",
                "改写值",
                Validity::default()
            ),
            false
        ),
        Err(MemoryError::Invalid(_))
    ));
    let added = propose(&store, "other-source", 2, "A Topic", "合成值");
    assert_eq!(first.version.id, added.version.id);
    assert_eq!(added.source_refs.len(), 2);
    assert!(matches!(
        store.confirm(first.version, vec![], source("stale", 3)),
        Err(MemoryError::Stale)
    ));
    store.reject(added.version, 3).unwrap();
    assert_eq!(store.records().unwrap()[0].status, Status::Rejected);
    assert!(store.recall("a topic", 3, 1).unwrap().is_empty());
}

#[test]
fn replacement_requires_current_conflict_versions_and_preserves_time_ranges() {
    let workspace = Workspace::new();
    let store = workspace.store();
    let old = store
        .propose(
            draft(
                &store,
                source("initial", 1),
                "例行提醒",
                "早上",
                Validity {
                    from: Some(10),
                    until: Some(20),
                },
            ),
            false,
        )
        .unwrap();
    let old = store
        .confirm(old.version, vec![], source("confirm", 2))
        .unwrap();
    let future = store
        .propose(
            draft(
                &store,
                source("future", 3),
                "例行提醒",
                "下午",
                Validity {
                    from: Some(20),
                    until: None,
                },
            ),
            false,
        )
        .unwrap();
    let future = store
        .confirm(future.version, vec![], source("confirm-future", 4))
        .unwrap();
    assert_eq!(
        store.recall("例行提醒", 19, 2).unwrap()[0].statement,
        "早上"
    );
    assert_eq!(
        store.recall("例行提醒", 20, 2).unwrap()[0].statement,
        "下午"
    );
    assert!(store.recall("例行提醒", 9, 2).unwrap().is_empty());

    let correction = store
        .propose(
            draft(
                &store,
                source("correction", 5),
                "例行提醒",
                "傍晚",
                Validity {
                    from: Some(20),
                    until: None,
                },
            ),
            false,
        )
        .unwrap();
    assert_eq!(correction.status, Status::Disputed);
    assert!(matches!(
        store.confirm(correction.version, vec![], source("choose", 6)),
        Err(MemoryError::Conflict)
    ));
    assert!(matches!(
        store.confirm(correction.version, vec![old.version], source("choose", 6)),
        Err(MemoryError::Conflict)
    ));
    assert_eq!(
        store.recall("例行提醒", 25, 1).unwrap()[0].statement,
        "下午"
    );
    let chosen = store
        .confirm(
            correction.version,
            vec![future.version],
            source("choose", 6),
        )
        .unwrap();
    assert_eq!(chosen.supersedes, vec![future.version]);
    assert_eq!(
        store.recall("例行提醒", 25, 1).unwrap()[0].statement,
        "傍晚"
    );
    assert!(!store
        .recall("例行提醒", 19, 2)
        .unwrap()
        .iter()
        .any(|entry| entry.status == Status::Superseded));
}

#[test]
fn forgetting_removes_history_and_prevents_replay_across_reopens_and_clear() {
    let workspace = Workspace::new();
    let store = workspace.store();
    let candidate = propose(&store, "old-body-one", 2, "手动示例", "待删除的合成记录");
    store
        .confirm(candidate.version, vec![], source("old-body-two", 3))
        .unwrap();
    let pending = draft(
        &store,
        source("pending", 4),
        "手动示例",
        "在途合成候选",
        Validity::default(),
    );
    let other = propose(&store, "other-entry", 4, "独立主题", "独立合成值");
    store
        .confirm(other.version, vec![], source("other-confirm", 5))
        .unwrap();

    store
        .forget_topic("手动示例", store.generation().unwrap(), 10)
        .unwrap();
    drop(store);
    let store = workspace.store();
    assert!(store.recall("手动示例", 11, 1).unwrap().is_empty());
    assert_eq!(store.recall("独立主题", 11, 1).unwrap().len(), 1);
    assert!(matches!(
        store.propose(pending, true),
        Err(MemoryError::Stale)
    ));
    for (event, reopen) in [
        (source("old-body-one", 2), true),
        (source("old-unseen", 8), true),
        (source("new-without-authorization", 11), false),
    ] {
        assert!(matches!(
            store.propose(
                draft(&store, event, "手动示例", "合成重放", Validity::default()),
                reopen
            ),
            Err(MemoryError::Forgotten)
        ));
    }
    let fresh = store
        .propose(
            draft(
                &store,
                source("authorized", 12),
                "手动示例",
                "重新授权的合成值",
                Validity::default(),
            ),
            true,
        )
        .unwrap();
    assert_eq!(fresh.status, Status::Candidate);
    assert!(matches!(
        store.propose(
            draft(
                &store,
                source("pre-reopen", 11),
                "手动示例",
                "待定值",
                Validity::default()
            ),
            false
        ),
        Err(MemoryError::Forgotten)
    ));
    let before_clear = fs::read_to_string(workspace.snapshot()).unwrap();
    for absent in [
        "待删除的合成记录",
        "old-body-one",
        "old-body-two",
        "在途合成候选",
    ] {
        assert!(!before_clear.contains(absent));
    }
    let generation = store.generation().unwrap();
    store.clear(generation, 20).unwrap();
    assert!(matches!(
        store.clear(generation, 21),
        Err(MemoryError::Stale)
    ));
    assert!(store.records().unwrap().is_empty());
    assert!(matches!(
        store.propose(
            draft(
                &store,
                source("unseen-before-clear", 19),
                "全新主题",
                "合成重放",
                Validity::default()
            ),
            false
        ),
        Err(MemoryError::Forgotten)
    ));
    assert!(!fs::read_to_string(workspace.snapshot())
        .unwrap()
        .contains("重新授权的合成值"));
}

#[test]
fn concurrent_handles_keep_all_writes_and_ignore_an_interrupted_snapshot() {
    let workspace = Workspace::new();
    let store = workspace.store();
    let workers = 8;
    let barrier = Barrier::new(workers);
    std::thread::scope(|scope| {
        for index in 0..workers {
            let barrier = &barrier;
            let workspace = workspace.path();
            scope.spawn(move || {
                let store = MemoryStore::open(workspace).unwrap();
                barrier.wait();
                propose(
                    &store,
                    &format!("source-{index}"),
                    1,
                    &format!("主题-{index}"),
                    "合成记录",
                );
                propose(&store, "shared-source", 1, "共同主题", "同一条消息");
            });
        }
    });
    assert_eq!(store.records().unwrap().len(), workers + 1);
    let pending = workspace.snapshot().with_file_name("state.pending");
    fs::write(&pending, "partial interrupted JSON").unwrap();
    let reopened = workspace.store();
    assert_eq!(reopened.records().unwrap().len(), workers + 1);
    assert!(!pending.exists());
    assert!(Workspace::new().store().records().unwrap().is_empty());

    fs::write(workspace.snapshot(), "{invalid").unwrap();
    assert!(matches!(
        reopened.records(),
        Err(MemoryError::InvalidStore(_))
    ));
    assert_eq!(
        fs::read_to_string(workspace.snapshot()).unwrap(),
        "{invalid"
    );
}

#[cfg(unix)]
#[test]
fn rejects_symbolic_links_and_sets_private_storage_permissions() {
    use std::os::unix::{fs::symlink, fs::PermissionsExt};
    let elsewhere = Workspace::new();
    let workspace = Workspace::new();
    symlink(elsewhere.path(), workspace.path().join("记忆")).unwrap();
    assert!(matches!(
        MemoryStore::open(workspace.path()),
        Err(MemoryError::Invalid(_))
    ));
    fs::remove_file(workspace.path().join("记忆")).unwrap();
    let store = workspace.store();
    propose(&store, "permissions", 1, "合成主题", "合成值");
    assert_eq!(
        fs::metadata(workspace.snapshot())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(workspace.snapshot().parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
}

#[test]
fn explicit_raw_requests_store_only_selected_contents_and_leave_wiki_alone() {
    use super::raw::{save, RawChannel};
    let workspace = Workspace::new();
    let raw = workspace.path().join("记忆/raw");
    fs::create_dir_all(&raw).unwrap();
    for denied in [
        "今天下雨了",
        "记住了吗？",
        "记住：",
        "记住我的验证码是合成示例",
        "记住我的身份证号是合成示例",
    ] {
        assert!(save(workspace.path(), denied, RawChannel::Text).is_err());
    }
    assert_eq!(fs::read_dir(&raw).unwrap().count(), 0);

    let statement = "每周五给测试植物浇水。";
    let receipt = serde_json::to_value(
        save(
            workspace.path(),
            &format!("记住：{statement}"),
            RawChannel::Text,
        )
        .unwrap(),
    )
    .unwrap();
    let retry = serde_json::to_value(
        save(
            workspace.path(),
            &format!("帮我记住{statement}"),
            RawChannel::Voice,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(receipt["created"], true);
    assert_eq!(retry["created"], false);
    assert_eq!(receipt["path"], retry["path"]);
    let path = workspace.path().join(receipt["path"].as_str().unwrap());
    assert!(path.starts_with(raw.join("记忆条目")));
    let contents = fs::read_to_string(&path).unwrap();
    assert!(contents.contains("channel: text"));
    assert!(contents.contains("source: explicit-user-request"));
    assert!(contents.ends_with(&format!("\n{statement}\n")));
    assert!(!contents.contains("记住："));
    assert!(!contents.contains("验证码"));
    assert_eq!(fs::read_dir(raw.join("记忆条目")).unwrap().count(), 1);
    assert!(!workspace.snapshot().exists());
    assert!(!workspace.path().join("记忆/wiki").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[cfg(unix)]
#[test]
fn raw_requests_do_not_follow_links_or_overwrite_altered_entries() {
    use super::raw::{save, RawChannel};
    use std::os::unix::fs::symlink;
    let workspace = Workspace::new();
    let outside = Workspace::new();
    let raw = workspace.path().join("记忆/raw");
    fs::create_dir(raw.parent().unwrap()).unwrap();
    symlink(outside.path(), &raw).unwrap();
    assert!(save(workspace.path(), "记住测试植物浇水", RawChannel::Voice,).is_err());
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    fs::remove_file(&raw).unwrap();
    fs::create_dir(&raw).unwrap();

    let request = "记住测试植物浇水";
    let receipt =
        serde_json::to_value(save(workspace.path(), request, RawChannel::Voice).unwrap()).unwrap();
    let path = workspace.path().join(receipt["path"].as_str().unwrap());
    fs::write(&path, "保留人工编辑").unwrap();
    assert!(save(workspace.path(), request, RawChannel::Text).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "保留人工编辑");
}

#[test]
fn chat_archive_preserves_completed_text_voice_and_local_replies_verbatim() {
    use super::archive::{ChatArchive, ChatMessage};
    use serde_json::json;

    let workspace = Workspace::new();
    let other = Workspace::new();
    let archive = ChatArchive::new();
    let user = " 两边空格  \n记下来就好。 ";
    let local = "明确操作完成。";
    archive
        .append(
            workspace.path(),
            ChatMessage::local(Role::User, user.into()),
        )
        .unwrap();

    let draft = json!({"method":"thread/realtime/transcript/delta","params":{"threadId":"fixture","role":"user","delta":"片段"}});
    assert!(ChatMessage::from_event(&draft).is_none());

    let voice_user = " 每周五给合成植物浇水。 ";
    let voice_assistant = "好的。\n\u{2022} 合成回复";
    for (role, text) in [("user", voice_user), ("assistant", voice_assistant)] {
        let event = json!({"method":"thread/realtime/transcript/done","params":{"threadId":"fixture","role":role,"text":text}});
        archive
            .append(workspace.path(), ChatMessage::from_event(&event).unwrap())
            .unwrap();
    }
    let answer = "合成 Codex 回复\n  原样换行和缩进。  ";
    let provider = json!({"method":"item/completed","params":{"threadId":"fixture","item":{"type":"agentMessage","id":"stable-item","text":answer}}});
    for _ in 0..2 {
        archive
            .append(
                workspace.path(),
                ChatMessage::from_event(&provider).unwrap(),
            )
            .unwrap();
    }
    archive
        .append(
            workspace.path(),
            ChatMessage::local(Role::Assistant, local.into()),
        )
        .unwrap();
    archive
        .append(other.path(), ChatMessage::from_event(&provider).unwrap())
        .unwrap();

    let archive_root = workspace.path().join("记忆/raw/聊天记录");
    let mut daily: Vec<_> = fs::read_dir(&archive_root)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "md"))
        .collect();
    daily.sort();
    assert!((1..=2).contains(&daily.len())); // May cross local midnight.
    let document = daily
        .iter()
        .map(|path| fs::read_to_string(path).unwrap())
        .collect::<String>();
    assert_eq!(document.matches("<!-- raw-chat ").count(), 5);
    for (expected, channel, speaker) in [
        (user, "text", "用户"),
        (voice_user, "voice", "用户"),
        (voice_assistant, "voice", "贾维斯"),
        (answer, "codex", "贾维斯"),
        (local, "local", "贾维斯"),
    ] {
        let offset = document
            .find(&format!("bytes={} -->\n\n{expected}\n", expected.len()))
            .unwrap();
        let prefix = &document[..offset];
        let header = prefix.rsplit_once("\n## ").unwrap().1;
        assert!(header.contains(&format!(" · {speaker}\n")));
        assert!(header.contains(&format!("channel=\"{channel}\"")));
    }
    assert!(!workspace.path().join("记忆/wiki").exists());
    assert!(other.path().join("记忆/raw/聊天记录").is_dir());
    assert!(!workspace.snapshot().exists());
}
