//! Read personal context from the selected workspace, never from a global fallback.
use std::{fs, io::Read, path::Path};

const MAX_BYTES: u64 = 64 * 1024;

pub const CONSULT_PROFILE: &str = "回答涉及用户本人的信息、偏好、作息、长期背景或个性化建议时，先在当前工作目录读取《用户档案.md》中相关段落（使用 rg 等本地工具按主题定位），再回答。不要只凭对话历史或记忆判断档案里有什么；未经检查不能声称没有记录。通用问题无需读取。当前用户明确说明优先，档案地址或作息不代表实时位置。只使用任务所需的内容；不要全文复述或把档案发送给搜索、其他服务或写入公开产物。仅在用户明确要求时按文件内的记录规则更新。";

pub fn personality(workspace: &str) -> Result<String, String> {
    Ok(read_reference(workspace, "喵维斯设定.md")?
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| include_str!("personality.txt").to_owned()))
}

pub fn read(workspace: &str) -> Result<Option<String>, String> {
    read_reference(workspace, "用户档案.md")
}

fn read_reference(workspace: &str, name: &str) -> Result<Option<String>, String> {
    let path = Path::new(workspace).join(name);
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法打开当前工作目录中的《{name}》：{error}")),
    };
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| format!("读取《{name}》失败。"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(format!("《{name}》超过 64 KiB，请精简后重试。"));
    }
    let text = String::from_utf8(bytes).map_err(|_| format!("《{name}》必须使用 UTF-8 编码。"))?;
    Ok(Some(text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

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
        assert_eq!(read(workspace).unwrap(), None);
        let path = dir.join("用户档案.md");
        fs::write(&path, "示例档案").unwrap();
        assert_eq!(read(workspace).unwrap().as_deref(), Some("示例档案"));
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
        assert!(read(workspace).is_err());
        fs::write(&path, [0xff]).unwrap();
        assert!(read(workspace).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
