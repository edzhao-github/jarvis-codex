//! Read personal context from the selected workspace, never from a global fallback.
use std::{
    fs,
    io::{ErrorKind, Read},
    path::Path,
    time::UNIX_EPOCH,
};

const MAX_BYTES: u64 = 64 * 1024;

const MODE: &str = "记忆/.wiki-read-mode";
const HOME: &str = "记忆/wiki/index.md";
const SETTINGS: &str = "记忆/wiki/喵维斯设定.md";
const PROFILE_INDEX: &str = "记忆/wiki/用户档案索引.md";
const HOUSEHOLD: &str = "家庭日常/个人与家庭档案.md";
const PREFERENCES: &str = "管家记忆/已确认偏好.md";
const WORK: &str = "工作/工作档案.md";
const LEGACY_PROFILE: &str = "用户档案.md";

pub const CONSULT_PROFILE: &str = "回答涉及用户本人、偏好、作息、长期背景或个性化建议时，先在当前线程工作目录用 Jarvis 的本地档案命令查阅相关章节。通用问题无需读取。当前用户明确说明优先，地址或作息不代表实时位置。只查任务所需章节，不全文复述，不把资料交给搜索或其他服务，也不写入公开产物。读取失败就说明问题，不能当作没有记录。仅在用户明确要求时按档案记录规则更新。";

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProfileSection {
    About,
    Pets,
    Preferences,
    Living,
    Work,
    Rules,
}

impl ProfileSection {
    const ALL: [Self; 6] = [
        Self::About,
        Self::Pets,
        Self::Preferences,
        Self::Living,
        Self::Work,
        Self::Rules,
    ];

    fn title(self) -> &'static str {
        match self {
            Self::About => "关于我",
            Self::Pets => "我的宠物",
            Self::Preferences => "我的偏好",
            Self::Living => "生活",
            Self::Work => "工作",
            Self::Rules => "记录规则",
        }
    }

    fn wiki_page(self) -> &'static str {
        match self {
            Self::About | Self::Pets | Self::Living => HOUSEHOLD,
            Self::Preferences => PREFERENCES,
            Self::Work => WORK,
            Self::Rules => "用户档案索引.md",
        }
    }
}

pub fn personality(workspace: &str) -> Result<String, String> {
    let root = Path::new(workspace);
    if wiki_enabled(root)? {
        check_home(root)?;
        return Ok(wiki_page(root, SETTINGS, "assistant-settings")?.body);
    }
    Ok(read_reference(root, "喵维斯设定.md")?
        .filter(|page| !page.body.trim().is_empty())
        .map_or_else(
            || include_str!("personality.txt").to_owned(),
            |page| page.body,
        ))
}

pub fn read(workspace: &str, section: Option<ProfileSection>) -> Result<Option<String>, String> {
    let root = Path::new(workspace);
    if !wiki_enabled(root)? {
        return Ok(
            read_reference(root, LEGACY_PROFILE)?.map(|page| match section {
                Some(section @ (ProfileSection::About | ProfileSection::Pets)) => {
                    chapter(&page.body, section.title())
                }
                _ => page.body,
            }),
        );
    }
    let index = checked_profile_index(root)?;
    if let Some(section) = section {
        let (_, page) = section_page(root, section, index)?;
        return Ok(Some(chapter(&page.body, section.title())));
    }
    // Compatibility for the existing local map input. It needs only address pages.
    let household = wiki_page(root, &format!("记忆/wiki/{HOUSEHOLD}"), "user-profile")?;
    let work = wiki_page(root, &format!("记忆/wiki/{WORK}"), "user-profile")?;
    Ok(Some(format!("{}\n{}", household.body, work.body)))
}

pub fn lookup(workspace: &str, query: &str) -> Result<String, String> {
    let root = Path::new(workspace);
    if !wiki_enabled(root)? {
        let Some(page) = read_reference(root, LEGACY_PROFILE)? else {
            return Ok("当前工作区没有用户档案。".into());
        };
        if query == "--list" {
            return Ok(page
                .body
                .lines()
                .filter_map(|line| line.strip_prefix("## "))
                .collect::<Vec<_>>()
                .join("\n"));
        }
        return Ok(format_chapter(LEGACY_PROFILE, query, &page));
    }

    let index = checked_profile_index(root)?;
    if query == "--list" {
        return Ok(ProfileSection::ALL.map(ProfileSection::title).join("\n"));
    }
    let section = ProfileSection::ALL
        .into_iter()
        .find(|section| section.title() == query)
        .ok_or_else(|| "未知档案章节。请使用 --list 查看可查章节。".to_owned())?;
    let (path, page) = section_page(root, section, index)?;
    Ok(format_chapter(&path, section.title(), &page))
}

fn format_chapter(path: &str, title: &str, page: &Page) -> String {
    let body = chapter(&page.body, title);
    let timestamp = page
        .modified
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map_or_else(
            || "未知".to_owned(),
            |duration| duration.as_secs().to_string(),
        );
    format!(
        "来源：{path} · {title}（修改时间 Unix 秒：{timestamp}）\n\n{}",
        if body.is_empty() {
            "该章节没有记录。"
        } else {
            &body
        }
    )
}

fn chapter(text: &str, title: &str) -> String {
    text.lines()
        .skip_while(|line| line.strip_prefix("## ") != Some(title))
        .skip(1)
        .take_while(|line| !line.starts_with("## ") && !line.starts_with("# "))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

fn section_page(
    root: &Path,
    section: ProfileSection,
    index: Page,
) -> Result<(String, Page), String> {
    let path = format!("记忆/wiki/{}", section.wiki_page());
    let page = if matches!(section, ProfileSection::Rules) {
        index
    } else {
        wiki_page(root, &path, "user-profile")?
    };
    Ok((path, page))
}

fn wiki_enabled(root: &Path) -> Result<bool, String> {
    match read_reference(root, MODE)?
        .as_ref()
        .map(|page| page.body.trim())
    {
        Some("wiki") => Ok(true),
        Some("legacy") | None => Ok(false),
        _ => Err(format!("Wiki 读取标记无效：{MODE}")),
    }
}

fn check_home(root: &Path) -> Result<(), String> {
    let home = wiki_page(root, HOME, "wiki-index")?;
    check_links(
        HOME,
        &home.body,
        "设定与档案",
        &["喵维斯设定.md", "用户档案索引.md"],
    )
}

fn checked_profile_index(root: &Path) -> Result<Page, String> {
    check_home(root)?;
    let index = wiki_page(root, PROFILE_INDEX, "profile-index")?;
    check_links(
        PROFILE_INDEX,
        &index.body,
        "Wiki 查阅入口",
        &[HOUSEHOLD, PREFERENCES, WORK],
    )?;
    Ok(index)
}

fn check_links(path: &str, text: &str, section: &str, expected: &[&str]) -> Result<(), String> {
    let body = chapter(text, section);
    let links: Vec<_> = body
        .lines()
        .filter(|line| line.trim_start().starts_with("- ["))
        .filter_map(|line| line.split_once("](")?.1.strip_suffix(')'))
        .collect();
    if links.len() == expected.len() && expected.iter().all(|target| links.contains(target)) {
        Ok(())
    } else {
        Err(format!("Wiki 索引链接缺失或无效：{path} · {section}"))
    }
}

struct Page {
    body: String,
    modified: Option<std::time::SystemTime>,
}

fn wiki_page(root: &Path, name: &str, kind: &str) -> Result<Page, String> {
    let mut page = read_reference(root, name)?.ok_or_else(|| format!("Wiki 页面缺失：{name}"))?;
    let normalized = page.body.replace("\r\n", "\n");
    let (front, body) = normalized
        .strip_prefix("---\n")
        .and_then(|document| document.split_once("\n---\n"))
        .ok_or_else(|| format!("Wiki 页面缺少有效的 Markdown 元数据：{name}"))?;
    let declared_kind = front.lines().find_map(|line| line.strip_prefix("type:"));
    if declared_kind.map(str::trim) != Some(kind)
        || !body.trim_start().starts_with("# ")
        || !body
            .lines()
            .any(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
    {
        return Err(format!("Wiki 页面类型无效或正文为空：{name}"));
    }
    page.body = body.trim_start_matches('\n').to_owned();
    Ok(page)
}

fn read_reference(root: &Path, name: &str) -> Result<Option<Page>, String> {
    // Walk fixed paths without following symbolic links, including directory links.
    let mut path = root.to_path_buf();
    for component in Path::new(name).components() {
        let std::path::Component::Normal(part) = component else {
            return Err(format!("资料路径越界：{name}"));
        };
        path.push(part);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_symlink() => {
                return Err(format!("资料路径含符号链接：{name}"))
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("无法检查《{name}》：{error}")),
        }
    }
    if !path.is_file() {
        return Err(format!("资料路径不是普通文件：{name}"));
    }
    let file = fs::File::open(&path).map_err(|error| format!("无法打开《{name}》：{error}"))?;
    let modified = file.metadata().and_then(|meta| meta.modified()).ok();
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| format!("读取《{name}》失败。"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(format!("《{name}》超过 64 KiB，请精简后重试。"));
    }
    let body = String::from_utf8(bytes).map_err(|_| format!("《{name}》必须使用 UTF-8 编码。"))?;
    Ok(Some(Page { body, modified }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn write_page(root: &Path, path: &str, kind: &str, body: &str) {
        let file = root.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, format!("---\ntype: {kind}\n---\n\n{body}\n")).unwrap();
    }

    #[test]
    fn reads_separate_wiki_topics_and_reports_corrupt_migrations() {
        let dir = std::env::temp_dir().join(format!("jarvis-wiki-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        let workspace = dir.to_str().unwrap();
        let legacy = "# 合成旧档案\n\n## 旧章节\n旧资料。";
        fs::write(dir.join(LEGACY_PROFILE), legacy).unwrap();

        let home = "# Wiki\n\n## 设定与档案\n\n- [设定](喵维斯设定.md)\n- [索引](用户档案索引.md)";
        let index = format!("# 档案索引\n\n## Wiki 查阅入口\n\n- [家庭]({HOUSEHOLD})\n- [偏好]({PREFERENCES})\n- [工作]({WORK})\n\n## 记录规则\n仅明确请求时记录。");
        write_page(&dir, HOME, "wiki-index", home);
        write_page(&dir, PROFILE_INDEX, "profile-index", &index);
        write_page(
            &dir,
            SETTINGS,
            "assistant-settings",
            "# 合成角色\n\n说话简短。",
        );

        assert_eq!(
            read(workspace, Some(ProfileSection::Work))
                .unwrap()
                .as_deref(),
            Some(legacy)
        );
        assert!(lookup(workspace, "旧章节").unwrap().contains("旧资料"));
        fs::write(dir.join(MODE), "wiki").unwrap();
        assert_eq!(
            personality(workspace).unwrap(),
            "# 合成角色\n\n说话简短。\n"
        );

        let work = format!("记忆/wiki/{WORK}");
        let preferences = format!("记忆/wiki/{PREFERENCES}");
        write_page(
            &dir,
            &work,
            "user-profile",
            "# 工作档案\n\n## 工作\n示例公司。",
        );
        assert_eq!(
            read(workspace, Some(ProfileSection::Work))
                .unwrap()
                .as_deref(),
            Some("示例公司。")
        );
        assert!(read(workspace, Some(ProfileSection::Preferences))
            .unwrap_err()
            .contains("缺失"));
        write_page(
            &dir,
            &preferences,
            "user-profile",
            "# 偏好档案\n\n## 我的偏好\n示例茶。",
        );
        let result = lookup(workspace, "我的偏好").unwrap();
        assert!(
            result.contains(PREFERENCES)
                && result.contains("示例茶")
                && !result.contains("示例公司")
        );
        assert!(lookup(workspace, "记录规则")
            .unwrap()
            .contains("仅明确请求"));
        assert!(!lookup(workspace, "--list").unwrap().contains("示例茶"));

        write_page(
            &dir,
            &preferences,
            "user-profile",
            "# 偏好档案\n\n## 我的偏好\n改过的茶。",
        );
        let latest = read(workspace, Some(ProfileSection::Preferences))
            .unwrap()
            .unwrap();
        assert_eq!(latest, "改过的茶。");
        assert!(!personality(workspace).unwrap().contains("改过的茶"));
        fs::remove_file(dir.join(LEGACY_PROFILE)).unwrap();
        assert_eq!(
            read(workspace, Some(ProfileSection::Preferences))
                .unwrap()
                .as_deref(),
            Some("改过的茶。")
        );
        assert_eq!(
            personality(workspace).unwrap(),
            "# 合成角色\n\n说话简短。\n"
        );
        fs::write(dir.join(LEGACY_PROFILE), legacy).unwrap();

        write_page(
            &dir,
            PROFILE_INDEX,
            "profile-index",
            &index.replace(WORK, "../../用户档案.md"),
        );
        assert!(read(workspace, Some(ProfileSection::Work))
            .unwrap_err()
            .contains("索引"));
        write_page(&dir, PROFILE_INDEX, "profile-index", &index);

        fs::write(dir.join(&work), "").unwrap();
        assert!(read(workspace, Some(ProfileSection::Work)).is_err());
        fs::remove_file(dir.join(&work)).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join(LEGACY_PROFILE), dir.join(&work)).unwrap();
            assert!(read(workspace, Some(ProfileSection::Work))
                .unwrap_err()
                .contains("符号链接"));
        }

        let other = dir.join("other-workspace");
        fs::create_dir(&other).unwrap();
        assert_eq!(read(other.to_str().unwrap(), None).unwrap(), None);
        fs::remove_file(dir.join(SETTINGS)).unwrap();
        assert!(personality(workspace).unwrap_err().contains("缺失"));
        fs::write(dir.join(MODE), "legacy").unwrap();
        assert_eq!(read(workspace, None).unwrap().as_deref(), Some(legacy));
        assert_eq!(
            personality(workspace).unwrap(),
            include_str!("personality.txt")
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn profile_is_read_fresh_and_missing_is_not_an_error() {
        let dir = std::env::temp_dir().join(format!(
            "jarvis-profile-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&dir).unwrap();
        let workspace = dir.to_str().unwrap();
        assert_eq!(read(workspace, None).unwrap(), None);
        let path = dir.join("用户档案.md");
        fs::write(&path, "示例档案").unwrap();
        assert_eq!(read(workspace, None).unwrap().as_deref(), Some("示例档案"));
        assert_eq!(
            personality(workspace).unwrap(),
            include_str!("personality.txt")
        );
        let settings = dir.join("喵维斯设定.md");
        fs::write(&settings, "临时角色设定 A").unwrap();
        assert_eq!(personality(workspace).unwrap(), "临时角色设定 A");
        fs::write(&settings, "临时角色设定 B").unwrap();
        assert_eq!(personality(workspace).unwrap(), "临时角色设定 B");
        fs::write(&settings, "  ").unwrap();
        assert_eq!(
            personality(workspace).unwrap(),
            include_str!("personality.txt")
        );
        fs::write(&path, vec![b'x'; MAX_BYTES as usize + 1]).unwrap();
        assert!(read(workspace, None).is_err());
        fs::write(&path, [0xff]).unwrap();
        assert!(read(workspace, None).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
