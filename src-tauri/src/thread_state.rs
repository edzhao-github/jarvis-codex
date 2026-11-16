use std::{collections::HashMap, fs, io::ErrorKind, path::Path};

type ThreadIds = HashMap<String, String>;

pub fn load(path: &Path) -> Result<ThreadIds, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("无法读取已保存的会话 ID：{error}")),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(HashMap::new()),
        Err(error) => Err(format!("无法打开会话状态文件：{error}")),
    }
}

pub fn save(path: &Path, threads: &ThreadIds) -> Result<(), String> {
    let directory = path.parent().ok_or("会话状态目录无效")?;
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let write = || -> std::io::Result<()> {
        fs::create_dir_all(directory)?;
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        serde_json::to_writer(&mut file, threads)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    };
    write().map_err(|error| {
        let _ = fs::remove_file(temporary);
        format!("无法保存会话 ID：{error}")
    })
}
