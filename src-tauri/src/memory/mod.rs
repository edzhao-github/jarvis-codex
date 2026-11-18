//! Local memory intake and an offline candidate lifecycle.

pub(crate) mod archive;
pub(crate) mod raw;
mod storage;
#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::{fmt, io, path::Path};

pub use storage::MemoryStore;

pub type Result<T> = std::result::Result<T, MemoryError>;

#[derive(Debug)]
pub enum MemoryError {
    Io(io::Error),
    InvalidStore(serde_json::Error),
    Invalid(&'static str),
    Stale,
    Conflict,
    Forgotten,
    NotFound,
}

impl fmt::Display for MemoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "记忆存储读写失败：{error}"),
            Self::InvalidStore(_) => f.write_str("记忆存储格式损坏"),
            Self::Invalid(reason) => f.write_str(reason),
            Self::Stale => f.write_str("记录或处理代次已变化，请重新读取"),
            Self::Conflict => f.write_str("需要明确确认将被替代的记录版本"),
            Self::Forgotten => f.write_str("这条来源或主题已遗忘"),
            Self::NotFound => f.write_str("找不到该记忆"),
        }
    }
}

impl std::error::Error for MemoryError {}

impl From<io::Error> for MemoryError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SourceRef {
    pub session_id: String,
    pub message_id: String,
    pub role: Role,
    /// Unix milliseconds, using the same clock as confirmation and deletion.
    pub occurred_at: u64,
}

impl SourceRef {
    fn validate(&self) -> Result<()> {
        if [&self.session_id, &self.message_id]
            .iter()
            .any(|id| id.trim().is_empty() || id.len() > 256 || id.chars().any(char::is_control))
        {
            return Err(MemoryError::Invalid("来源缺少有效的会话或消息标识"));
        }
        Ok(())
    }

    fn key(&self) -> String {
        digest(&format!("source\0{}\0{}", self.session_id, self.message_id))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Fact,
    Preference,
    Impression,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Sensitivity {
    Ordinary,
    Sensitive,
    Secret,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct Validity {
    pub from: Option<u64>,
    pub until: Option<u64>,
}

impl Validity {
    fn contains(self, at: u64) -> bool {
        self.from.is_none_or(|from| from <= at) && self.until.is_none_or(|until| at < until)
    }

    fn overlaps(self, other: Self) -> bool {
        self.until
            .is_none_or(|until| other.from.is_none_or(|from| from < until))
            && other
                .until
                .is_none_or(|until| self.from.is_none_or(|from| from < until))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Candidate,
    Disputed,
    Active,
    Superseded,
    Rejected,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub struct RecordVersion {
    pub id: u64,
    pub revision: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Record {
    pub version: RecordVersion,
    pub topic: String,
    pub kind: Kind,
    pub statement: String,
    pub status: Status,
    pub source_refs: Vec<SourceRef>,
    pub confirmation: Option<SourceRef>,
    pub created_at: u64,
    pub updated_at: u64,
    pub validity: Validity,
    pub sensitivity: Sensitivity,
    pub supersedes: Vec<RecordVersion>,
}

pub struct Message<'a> {
    pub source: SourceRef,
    pub complete: bool,
    pub text: &'a str,
}

pub struct Draft {
    generation: u64,
    source: SourceRef,
    topic: String,
    kind: Kind,
    statement: String,
    validity: Validity,
}

/// Extract only an explicit instruction from a completed user message. The
/// caller supplies the topic and classification; the message text stays in memory.
pub fn extract(
    generation: u64,
    message: Message<'_>,
    topic: &str,
    kind: Kind,
    sensitivity: Sensitivity,
    validity: Validity,
) -> Result<Option<Draft>> {
    if !message.complete || message.source.role != Role::User {
        return Ok(None);
    }
    let Some(statement) = explicit_statement(message.text) else {
        return Ok(None);
    };
    if sensitivity != Sensitivity::Ordinary || kind == Kind::Impression {
        return Err(MemoryError::Invalid(
            "该类别需要另行授权，当前离线策略不保存",
        ));
    }
    message.source.validate()?;
    if matches!((validity.from, validity.until), (Some(from), Some(until)) if from >= until) {
        return Err(MemoryError::Invalid("记忆的有效期无效"));
    }
    let statement = statement.trim().to_owned();
    if statement.is_empty() {
        return Err(MemoryError::Invalid("记忆正文为空"));
    }
    Ok(Some(Draft {
        generation,
        source: message.source,
        topic: topic_key(topic)?,
        kind,
        statement,
        validity,
    }))
}

fn explicit_statement(text: &str) -> Option<&str> {
    let body = text.trim();
    let body = body.strip_prefix("请").unwrap_or(body);
    let body = body.strip_prefix("帮我").unwrap_or(body);
    let rest = body.strip_prefix("记住")?.trim();
    if rest.starts_with(['了', '吗', '没']) {
        return None;
    }
    let rest = rest.strip_prefix("这件事").unwrap_or(rest).trim_start();
    Some(
        rest.strip_prefix(['：', ':', '，', ','])
            .unwrap_or(rest)
            .trim(),
    )
}

fn topic_key(topic: &str) -> Result<String> {
    let key = topic
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    if key.is_empty() || key.len() > 256 || key.chars().any(char::is_control) {
        return Err(MemoryError::Invalid("主题缺少有效标识"));
    }
    Ok(key)
}

fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum AuditAction {
    Proposed,
    Confirmed,
    Rejected,
    Forgotten,
    Cleared,
}

#[derive(Debug, Deserialize, Serialize)]
struct Audit {
    action: AuditAction,
    id: Option<u64>,
    occurred_at: u64,
}

#[derive(Debug, Deserialize, Serialize)]
struct TopicBarrier {
    forgotten_at: u64,
    reopened_at: Option<u64>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct Snapshot {
    generation: u64,
    next_id: u64,
    records: Vec<Record>,
    blocked_topics: BTreeMap<String, TopicBarrier>,
    blocked_sources: BTreeSet<String>,
    cleared_at: Option<u64>,
    audit: Vec<Audit>,
}

impl Snapshot {
    fn note(&mut self, action: AuditAction, id: Option<u64>, occurred_at: u64) {
        self.audit.push(Audit {
            action,
            id,
            occurred_at,
        });
    }

    fn position(&self, version: RecordVersion) -> Result<usize> {
        let index = self
            .records
            .iter()
            .position(|record| record.version.id == version.id)
            .ok_or(MemoryError::NotFound)?;
        if self.records[index].version != version {
            return Err(MemoryError::Stale);
        }
        Ok(index)
    }

    fn conflicts(&self, topic: &str, validity: Validity) -> Vec<RecordVersion> {
        self.records
            .iter()
            .filter(|record| {
                record.status == Status::Active
                    && record.topic == topic
                    && record.validity.overlaps(validity)
            })
            .map(|record| record.version)
            .collect()
    }

    fn propose(&mut self, draft: Draft, reopen: bool) -> Result<Record> {
        if draft.generation != self.generation {
            return Err(MemoryError::Stale);
        }
        let source_key = draft.source.key();
        let topic_digest = digest(&draft.topic);
        if self.blocked_sources.contains(&source_key)
            || self
                .cleared_at
                .is_some_and(|at| draft.source.occurred_at <= at)
            || self
                .blocked_topics
                .get(&topic_digest)
                .is_some_and(|barrier| {
                    draft.source.occurred_at <= barrier.forgotten_at
                        || barrier
                            .reopened_at
                            .map_or(!reopen, |at| draft.source.occurred_at < at)
                })
        {
            return Err(MemoryError::Forgotten);
        }
        if self.records.iter().any(|record| {
            record
                .confirmation
                .as_ref()
                .is_some_and(|source| source.key() == source_key)
        }) {
            return Err(MemoryError::Invalid("确认消息已用于确认记录"));
        }
        if let Some(used) = self.records.iter().find(|record| {
            record
                .source_refs
                .iter()
                .any(|source| source.key() == source_key)
        }) {
            if used.topic != draft.topic
                || used.statement != draft.statement
                || used.kind != draft.kind
                || used.validity != draft.validity
            {
                return Err(MemoryError::Invalid("同一来源已用于不同的候选"));
            }
            return Ok(used.clone());
        }
        if let Some(existing) = self.records.iter_mut().find(|record| {
            matches!(
                record.status,
                Status::Candidate | Status::Disputed | Status::Active
            ) && record.topic == draft.topic
                && record.statement == draft.statement
                && record.kind == draft.kind
                && record.validity == draft.validity
        }) {
            existing.updated_at = existing.updated_at.max(draft.source.occurred_at);
            existing.version.revision += 1;
            existing.source_refs.push(draft.source);
            return Ok(existing.clone());
        }
        let conflicts = self.conflicts(&draft.topic, draft.validity);
        self.next_id += 1;
        let now = draft.source.occurred_at;
        let record = Record {
            version: RecordVersion {
                id: self.next_id,
                revision: 1,
            },
            topic: draft.topic,
            kind: draft.kind,
            statement: draft.statement,
            status: if conflicts.is_empty() {
                Status::Candidate
            } else {
                Status::Disputed
            },
            source_refs: vec![draft.source],
            confirmation: None,
            created_at: now,
            updated_at: now,
            validity: draft.validity,
            sensitivity: Sensitivity::Ordinary,
            supersedes: Vec::new(),
        };
        if let Some(barrier) = self.blocked_topics.get_mut(&topic_digest) {
            barrier.reopened_at.get_or_insert(now);
        }
        self.note(AuditAction::Proposed, Some(self.next_id), now);
        self.records.push(record.clone());
        Ok(record)
    }

    fn confirm(
        &mut self,
        version: RecordVersion,
        mut replace: Vec<RecordVersion>,
        source: SourceRef,
    ) -> Result<Record> {
        source.validate()?;
        if source.role != Role::User {
            return Err(MemoryError::Invalid("候选须由用户确认"));
        }
        let key = source.key();
        if let Some(previous) = self.records.iter().find(|record| {
            record
                .confirmation
                .as_ref()
                .is_some_and(|confirmation| confirmation.key() == key)
        }) {
            return if previous.version.id == version.id && previous.status == Status::Active {
                Ok(previous.clone())
            } else {
                Err(MemoryError::Invalid("这条确认消息已使用"))
            };
        }
        if self.blocked_sources.contains(&key) {
            return Err(MemoryError::Forgotten);
        }
        let index = self.position(version)?;
        let candidate = &self.records[index];
        if !matches!(candidate.status, Status::Candidate | Status::Disputed)
            || source.occurred_at < candidate.updated_at
            || self
                .records
                .iter()
                .any(|record| record.source_refs.iter().any(|entry| entry.key() == key))
        {
            return Err(MemoryError::Invalid("使用独立的用户消息确认当前候选"));
        }
        let mut conflicts = self.conflicts(&candidate.topic, candidate.validity);
        replace.sort_unstable();
        conflicts.sort_unstable();
        if conflicts != replace {
            return Err(MemoryError::Conflict);
        }
        let now = source.occurred_at;
        if self
            .records
            .iter()
            .any(|record| conflicts.contains(&record.version) && record.updated_at > now)
        {
            return Err(MemoryError::Stale);
        }
        for record in &mut self.records {
            if conflicts.contains(&record.version) {
                record.status = Status::Superseded;
                record.version.revision += 1;
                record.updated_at = now;
            }
        }
        let candidate = &mut self.records[index];
        candidate.status = Status::Active;
        candidate.version.revision += 1;
        candidate.updated_at = now;
        candidate.confirmation = Some(source);
        candidate.supersedes = conflicts;
        let result = candidate.clone();
        self.note(AuditAction::Confirmed, Some(version.id), now);
        Ok(result)
    }

    fn forget(&mut self, topic: Option<&str>, now: u64) {
        let now = self
            .records
            .iter()
            .filter(|record| topic.is_none_or(|topic| record.topic == topic))
            .map(|record| record.updated_at)
            .fold(now, u64::max);
        self.generation += 1;
        if topic.is_none() {
            self.cleared_at = Some(self.cleared_at.map_or(now, |at| at.max(now)));
        }
        if let Some(topic) = topic {
            block_topic(&mut self.blocked_topics, topic, now);
        }
        self.records.retain(|record| {
            if topic.is_some_and(|topic| record.topic != topic) {
                return true;
            }
            block_topic(&mut self.blocked_topics, &record.topic, now);
            self.blocked_sources
                .extend(record.source_refs.iter().map(SourceRef::key));
            self.blocked_sources
                .extend(record.confirmation.iter().map(SourceRef::key));
            false
        });
        self.note(
            if topic.is_some() {
                AuditAction::Forgotten
            } else {
                AuditAction::Cleared
            },
            None,
            now,
        );
    }
}

fn block_topic(topics: &mut BTreeMap<String, TopicBarrier>, topic: &str, now: u64) {
    let barrier = topics.entry(digest(topic)).or_insert(TopicBarrier {
        forgotten_at: now,
        reopened_at: None,
    });
    barrier.forgotten_at = barrier.forgotten_at.max(now);
    barrier.reopened_at = None;
}

impl MemoryStore {
    pub fn open(workspace: &Path) -> Result<Self> {
        Self::in_workspace(workspace)
    }

    pub fn generation(&self) -> Result<u64> {
        self.read(|state| Ok(state.generation))
    }

    pub fn propose(&self, draft: Draft, reopen_forgotten_topic: bool) -> Result<Record> {
        self.update(|state| state.propose(draft, reopen_forgotten_topic))
    }

    pub fn confirm(
        &self,
        version: RecordVersion,
        replace: Vec<RecordVersion>,
        source: SourceRef,
    ) -> Result<Record> {
        self.update(|state| state.confirm(version, replace, source))
    }

    pub fn reject(&self, version: RecordVersion, now: u64) -> Result<()> {
        self.update(|state| {
            let index = state.position(version)?;
            let record = &mut state.records[index];
            if !matches!(record.status, Status::Candidate | Status::Disputed)
                || now < record.updated_at
            {
                return Err(MemoryError::Invalid("只能拒绝当前待确认候选"));
            }
            record.status = Status::Rejected;
            record.version.revision += 1;
            record.updated_at = now;
            state.note(AuditAction::Rejected, Some(version.id), now);
            Ok(())
        })
    }

    pub fn records(&self) -> Result<Vec<Record>> {
        self.read(|state| Ok(state.records))
    }

    pub fn recall(&self, topic: &str, at: u64, limit: usize) -> Result<Vec<Record>> {
        let topic = topic_key(topic)?;
        self.read(|state| {
            Ok(state
                .records
                .into_iter()
                .rev()
                .filter(|record| {
                    record.status == Status::Active
                        && record.kind != Kind::Impression
                        && record.topic == topic
                        && record.validity.contains(at)
                })
                .take(limit)
                .collect())
        })
    }

    /// Forget the logical topic, including its candidates and superseded versions.
    pub fn forget_topic(&self, topic: &str, expected_generation: u64, now: u64) -> Result<()> {
        let topic = topic_key(topic)?;
        self.forget(Some(&topic), expected_generation, now)
    }

    pub fn clear(&self, expected_generation: u64, now: u64) -> Result<()> {
        self.forget(None, expected_generation, now)
    }

    fn forget(&self, topic: Option<&str>, expected_generation: u64, now: u64) -> Result<()> {
        self.update(|state| {
            if state.generation != expected_generation {
                return Err(MemoryError::Stale);
            }
            state.forget(topic, now);
            Ok(())
        })
    }
}
