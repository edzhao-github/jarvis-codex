//! Bounded local lookup over manually published Markdown pages.

use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

use serde::Serialize;

const WIKI: &str = "记忆/wiki";
const MAX_PAGE_BYTES: u64 = 64 * 1024;
const MAX_QUERY_CHARS: usize = 100;
const MAX_EXCERPT_CHARS: usize = 150;

#[derive(Serialize)]
pub(crate) struct Match {
    pub source: String,
    pub excerpt: String,
}

pub(crate) fn search(workspace: &Path, query: &str) -> Result<Vec<Match>, String> {
    if !crate::user_profile::wiki_enabled(workspace)? {
        return Err("当前工作区未启用 Wiki 读取。".into());
    }
    let quantity = quantity_query(query);
    let query = query_key(query);
    if query.len() < 2 {
        return Ok(Vec::new());
    }
    let root = workspace.join(WIKI);
    let mut matches = Vec::new();
    scan(workspace, &root, &query, quantity, &mut matches)?;
    matches.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.source.cmp(&b.1.source)));
    Ok(matches
        .into_iter()
        .take(2)
        .map(|(_, result)| result)
        .collect())
}

fn scan(
    workspace: &Path,
    directory: &Path,
    query: &[char],
    quantity: Option<char>,
    matches: &mut Vec<(usize, Match)>,
) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(directory).map_err(|error| format!("无法打开 Wiki 目录：{error}"))?;
    if !metadata.is_dir() {
        return Err("Wiki 目录无效或使用了符号链接。".into());
    }
    for entry in fs::read_dir(directory).map_err(|error| format!("无法读取 Wiki 目录：{error}"))?
    {
        let entry = entry.map_err(|error| format!("无法浏览 Wiki 目录：{error}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "维护" {
            continue;
        }
        let path = entry.path();
        let kind = entry
            .file_type()
            .map_err(|error| format!("无法核对 Wiki 路径：{error}"))?;
        if kind.is_dir() {
            scan(workspace, &path, query, quantity, matches)?;
            continue;
        }
        if !kind.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        let relative = path
            .strip_prefix(workspace)
            .map_err(|_| "Wiki 路径超出当前工作区。")?;
        let source = relative.to_string_lossy();
        if source
            .strip_prefix("记忆/wiki/")
            .is_some_and(crate::user_profile::is_profile_page)
            || matches!(
                source.as_ref(),
                "记忆/wiki/index.md" | "记忆/wiki/喵维斯设定.md"
            )
        {
            continue;
        }
        let mut document = String::new();
        File::open(&path)
            .and_then(|file| file.take(MAX_PAGE_BYTES + 1).read_to_string(&mut document))
            .map_err(|error| format!("无法读取 Wiki 页面《{source}》：{error}"))?;
        if document.len() as u64 > MAX_PAGE_BYTES {
            continue;
        }
        if let Some((score, excerpt)) = best_match(&document, query, &name, quantity) {
            matches.push((
                score,
                Match {
                    source: source.into_owned(),
                    excerpt,
                },
            ));
        }
    }
    Ok(())
}

fn quantity_query(question: &str) -> Option<char> {
    ["多少", "几"].into_iter().find_map(|prefix| {
        question
            .split_once(prefix)?
            .1
            .chars()
            .next()
            .filter(|unit| "次回个件台只份趟本辆天".contains(*unit))
    })
}

fn quantity_rank(line: &str, unit: char) -> usize {
    let mut fields = line.split(unit).peekable();
    let mut rank = 0;
    while let Some(part) = fields.next() {
        if fields.peek().is_none() {
            break;
        }
        let ending = part.trim_end();
        let prefix = ending.trim_end_matches(|ch: char| {
            ch.is_ascii_digit() || "零一二两三四五六七八九十百千万".contains(ch)
        });
        if prefix.len() < ending.len() {
            rank = rank.max(if prefix.ends_with('第') { 1 } else { 2 });
        }
    }
    rank
}

fn title_rank(title: &str, query: &[char]) -> usize {
    let title = normalize(title);
    let exact = score(&title, query);
    if exact > 0 {
        return exact;
    }
    // Spoken questions sometimes invert the order of a title's key words.
    if query.windows(2).any(|pair| {
        let bigram = pair.iter().collect::<String>();
        title.contains(&bigram)
            && query
                .iter()
                .any(|ch| !pair.contains(ch) && title.contains(*ch))
    }) {
        32
    } else {
        0
    }
}

fn query_key(query: &str) -> Vec<char> {
    let mut question = query.to_owned();
    if let Some(unit) = quantity_query(query) {
        for prefix in ["过多少", "了多少", "过几", "了几", "多少", "几"] {
            question = question.replace(&format!("{prefix}{unit}"), "");
        }
    }
    for filler in [
        "你还记得",
        "你知道",
        "一共",
        "总共",
        "你记得",
        "请问",
        "能告诉我",
        "帮我查一下",
        "查一下",
        "是什么",
        "什么时候",
        "是哪天",
        "什么时间",
        "我们家的",
        "我家的",
        "家里的",
        "我们的",
        "我的",
        "我们家",
        "我家",
        "每周几",
        "哪天",
        "多久换一次",
        "吗",
    ] {
        question = question.replace(filler, "");
    }
    normalize(question.trim_start().trim_start_matches('我'))
        .chars()
        .take(MAX_QUERY_CHARS)
        .collect()
}

fn normalize(text: &str) -> String {
    text.chars()
        .filter(|ch| ch.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn best_match(
    document: &str,
    query: &[char],
    filename: &str,
    quantity: Option<char>,
) -> Option<(usize, String)> {
    let normalized = document.replace("\r\n", "\n");
    let (front, body) = normalized
        .strip_prefix("---\n")
        .and_then(|content| content.split_once("\n---\n"))
        .unwrap_or(("", normalized.as_str()));
    if front.lines().any(|line| {
        let Some((key, value)) = line.split_once(':') else {
            return false;
        };
        let value = value.trim().trim_matches(['\'', '"']);
        (key == "status"
            && matches!(
                value,
                "candidate" | "disputed" | "rejected" | "superseded" | "deleted"
            ))
            || (key == "type"
                && (value.starts_with("system-")
                    || matches!(value, "template" | "assistant-settings" | "profile-index")))
    }) {
        return None;
    }

    let mut heading = filename.trim_end_matches(".md");
    let mut page_rank = title_rank(heading, query);
    let topic_index = front.lines().any(|line| line.trim() == "type: topic-index");
    let mut in_topic_body = !topic_index;
    let mut best = None;
    let mut comment = false;
    let mut fence = false;
    for line in body.lines().map(str::trim) {
        if line.contains("<!--") {
            comment = !line.contains("-->");
            continue;
        }
        if comment {
            comment = !line.contains("-->");
            continue;
        }
        if line.starts_with("\x60\x60\x60") || line.starts_with("~~~") {
            fence = !fence;
            continue;
        }
        if fence
            || line.is_empty()
            || line.starts_with("- [")
                && !line.starts_with("- [ ]")
                && !line.starts_with("- [x]")
                && line.contains("](")
            || line.starts_with('>') && line.contains("](")
        {
            continue;
        }
        if let Some(title) = line.strip_prefix('#') {
            if line.starts_with("## ") {
                in_topic_body = true;
            }
            heading = title.trim_start_matches('#').trim();
            if line.starts_with("# ") {
                page_rank = page_rank.max(title_rank(heading, query));
            }
            continue;
        }
        if !in_topic_body {
            continue;
        }
        let heading_score = title_rank(heading, query);
        let body_score = score(&normalize(line), query);
        let count = quantity.map_or(0, |unit| quantity_rank(line, unit));
        if quantity.is_some() {
            if count > 0 && (body_score > 0 || heading_score > 0 || page_rank > 0) {
                let rank = count * 300 + 2 * body_score + heading_score + page_rank;
                if best.as_ref().is_none_or(|(best_rank, _)| rank > *best_rank) {
                    best = Some((rank, excerpt(line, query)));
                }
            }
            continue;
        }
        // Heading context may make a terse value relevant, but a weak title
        // match alone cannot select an arbitrary body line.
        if body_score == 0 && (heading_score == 0 || query.len() > 2 && heading_score < 45) {
            continue;
        }
        let rank = body_score.saturating_mul(2) + heading_score;
        if best.as_ref().is_none_or(|(best_rank, _)| rank > *best_rank) {
            let text = if body_score == 0 {
                format!("{heading}：{line}")
            } else {
                line.to_owned()
            };
            best = Some((rank, excerpt(&text, query)));
        }
    }
    best
}

fn score(haystack: &str, query: &[char]) -> usize {
    let pairs: std::collections::BTreeSet<_> = query
        .windows(2)
        .map(|pair| pair.iter().collect::<String>())
        .filter(|pair| haystack.contains(pair))
        .collect();
    if pairs.is_empty() || query.len() != 2 && pairs.len() == 1 {
        return 0;
    }
    let span = (3..=query.len().min(8))
        .rev()
        .find(|size| {
            query
                .windows(*size)
                .any(|part| haystack.contains(&part.iter().collect::<String>()))
        })
        .unwrap_or(2);
    span * 16 + pairs.len()
}

fn excerpt(text: &str, query: &[char]) -> String {
    let plain: String = text
        .chars()
        .filter(|ch| !matches!(ch, '*' | '\x60'))
        .collect();
    let plain = plain.trim_start_matches("- ").trim_start();
    if plain.chars().count() <= MAX_EXCERPT_CHARS {
        return plain.to_owned();
    }
    let needle = query
        .windows(2)
        .map(|pair| pair.iter().collect::<String>())
        .find_map(|pair| plain.find(&pair));
    let start = needle.map_or(0, |index| plain[..index].chars().count().saturating_sub(30));
    let piece: String = plain.chars().skip(start).take(MAX_EXCERPT_CHARS).collect();
    format!("{}{piece}…", if start == 0 { "" } else { "…" })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn write(root: &Path, path: &str, content: &str) {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn queries_live_wiki_markdown_without_raw_unpublished_pages_or_qmd() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let workspace =
            std::env::temp_dir().join(format!("jarvis-wiki-search-{}-{nonce}", std::process::id()));
        fs::create_dir(&workspace).unwrap();
        write(&workspace, "记忆/.wiki-read-mode", "wiki\n");
        write(
            &workspace,
            "记忆/wiki/管家记忆/植物养护.md",
            "# 家庭养护\n\n- 每周五给植物浇水。\n",
        );
        write(
            &workspace,
            "记忆/raw/聊天记录/原文.md",
            "# 原始资料\n\n仅 Raw 的蓝色测试植物。\n",
        );
        write(
            &workspace,
            "记忆/wiki/维护/测试.md",
            "# 维护\n\n维护隔离词每周操作。\n",
        );
        write(
            &workspace,
            "记忆/wiki/管家记忆/候选.md",
            "---\nstatus: candidate\n---\n\n# 候选\n\n候选隔离词。\n",
        );
        write(
            &workspace,
            "记忆/wiki/健康/index.md",
            "---\ntype: topic-index\n---\n\n# 健康\n\n记录体检和复诊资料。\n\n## 条目\n",
        );
        write(
            &workspace,
            "记忆/wiki/待办与维护.md",
            "# 待办\n\n- [ ] 周六更换净水器滤芯 [原件](../raw/说明.pdf)。\n",
        );
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            workspace.join("记忆/raw"),
            workspace.join("记忆/wiki/外部链接"),
        )
        .unwrap();

        let hits = search(&workspace, "我家的植物哪天浇水？").unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].source.ends_with("管家记忆/植物养护.md"));
        assert_eq!(hits[0].excerpt, "每周五给植物浇水。");
        write(&workspace, "记忆/wiki/工作/公司搬家经历.md",
            "# 公司搬家经历\n\n## 记录\n\n- 公司今天又搬了办公地点。\n- 测试档案回顾两次搬家，分别在春季和秋季。");
        write(
            &workspace,
            "记忆/wiki/家庭日常/搬家经历.md",
            "# 搬家经历\n\n- 家里曾三次搬家。",
        );
        let moves = search(&workspace, "你知道我一共搬过几次公司吗？").unwrap();
        assert_eq!(moves.len(), 1);
        assert!(moves[0].source.ends_with("工作/公司搬家经历.md"));
        assert!(moves[0].excerpt.contains("两次搬家"));
        write(
            &workspace,
            "记忆/wiki/学习/图书借阅.md",
            "# 图书借阅\n\n## 记录\n\n- 已经借了四本，仍在借阅期。",
        );
        let books = search(&workspace, "你知道我一共借过几本图书吗？").unwrap();
        assert!(books[0].source.ends_with("学习/图书借阅.md"));
        assert!(books[0].excerpt.contains("四本"));
        let task = search(&workspace, "我家净水器滤芯多久换一次").unwrap();
        assert_eq!(task.len(), 1);
        assert!(task[0].source.ends_with("待办与维护.md"));

        for excluded in [
            "蓝色测试植物",
            "维护隔离词",
            "候选隔离词",
            "复诊",
            "无关不存在内容",
        ] {
            assert!(
                search(&workspace, excluded).unwrap().is_empty(),
                "{excluded}"
            );
        }

        write(
            &workspace,
            "记忆/wiki/管家记忆/植物养护.md",
            "# 家庭养护\n\n- 每周二给植物浇水。\n",
        );
        assert_eq!(
            search(&workspace, "每周几给植物浇水？").unwrap()[0].excerpt,
            "每周二给植物浇水。"
        );
        fs::remove_file(workspace.join("记忆/wiki/管家记忆/植物养护.md")).unwrap();
        assert!(search(&workspace, "给植物浇水").unwrap().is_empty());
        assert!(!workspace.join("记忆/.qmd").exists());
        fs::remove_dir_all(workspace).unwrap();
    }
}
