use super::{MemoryError, Result, Snapshot};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, BufWriter, ErrorKind, Write};
use std::path::{Path, PathBuf};

const SCHEMA: u32 = 1;
const STORE: &str = "state.json";
const PENDING: &str = "state.pending";

pub struct MemoryStore {
    directory: PathBuf,
}

#[derive(Serialize)]
struct StoreFileRef<'a> {
    schema: u32,
    state: &'a Snapshot,
}

#[derive(Deserialize)]
struct StoreFile {
    schema: u32,
    state: Snapshot,
}

impl MemoryStore {
    pub(super) fn in_workspace(workspace: &Path) -> Result<Self> {
        let root = workspace.canonicalize()?;
        let memory = root.join("记忆");
        ensure_directory(&memory)?;
        let directory = memory.join("记忆系统");
        ensure_directory(&directory)?;
        Ok(Self { directory })
    }

    pub(super) fn read<T>(&self, run: impl FnOnce(Snapshot) -> Result<T>) -> Result<T> {
        let _lock = self.lock()?;
        run(self.load()?)
    }

    pub(super) fn update<T>(&self, run: impl FnOnce(&mut Snapshot) -> Result<T>) -> Result<T> {
        let _lock = self.lock()?;
        let mut state = self.load()?;
        let result = run(&mut state)?;
        self.save(&state)?;
        Ok(result)
    }

    fn lock(&self) -> Result<File> {
        let path = self.directory.join("store.lock");
        regular_file_or_missing(&path)?;
        let mut options = private_file_options();
        let file = options.read(true).write(true).create(true).open(path)?;
        // Keep a stable lock inode. Only the JSON snapshot is replaced.
        file.lock()?;
        remove_pending(&self.directory.join(PENDING))?;
        Ok(file)
    }

    fn load(&self) -> Result<Snapshot> {
        let path = self.directory.join(STORE);
        if !regular_file_or_missing(&path)? {
            return Ok(Snapshot::default());
        }
        let reader = BufReader::new(File::open(path)?);
        let store: StoreFile =
            serde_json::from_reader(reader).map_err(MemoryError::InvalidStore)?;
        if store.schema != SCHEMA {
            return Err(MemoryError::Invalid("记忆存储版本不受支持"));
        }
        Ok(store.state)
    }

    fn save(&self, state: &Snapshot) -> Result<()> {
        let pending = self.directory.join(PENDING);
        let result = (|| {
            let file = private_file_options()
                .write(true)
                .create_new(true)
                .open(&pending)?;
            let mut writer = BufWriter::new(file);
            serde_json::to_writer(
                &mut writer,
                &StoreFileRef {
                    schema: SCHEMA,
                    state,
                },
            )
            .map_err(MemoryError::InvalidStore)?;
            writer.flush()?;
            writer.get_ref().sync_all()?;
            fs::rename(&pending, self.directory.join(STORE))?;
            #[cfg(unix)]
            File::open(&self.directory)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = remove_pending(&pending);
        }
        result
    }
}

pub(super) fn ensure_directory(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            if fs::symlink_metadata(path)?.is_dir() {
                Ok(())
            } else {
                Err(MemoryError::Invalid("记忆目录必须是工作区内的普通目录"))
            }
        }
        Err(error) => Err(error.into()),
    }
}

pub(super) fn private_file_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}

pub(super) fn regular_file_or_missing(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err(MemoryError::Invalid("记忆数据必须存放在普通文件中")),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn remove_pending(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
