//! Key-value storage for the engine's saves: one JSON file per game.

use std::path::{Path, PathBuf};
use std::io::{self, Write};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_WRITE: AtomicU64 = AtomicU64::new(0);

pub struct Storage {
    path: PathBuf,
    map: serde_json::Map<String, serde_json::Value>,
}

impl Storage {
    /// One-time import of the previous desktop save. Existing new saves always win.
    /// Leave the original intact for rollback, and abort launch if importing fails.
    pub fn migrate_legacy(dir: &Path, legacy: &Path, slug: &str) -> io::Result<bool> {
        let destination = dir.join(format!("{slug}.json"));
        if destination.exists() { return Ok(false); }
        let source = legacy.join(format!("{slug}.json"));
        let bytes = match std::fs::read(&source) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        };
        let value: serde_json::Value = serde_json::from_slice(&bytes)?;
        if !value.is_object() { return Err(io::Error::new(io::ErrorKind::InvalidData, "Legacy save is not an object")); }
        std::fs::create_dir_all(dir)?;
        let mut file = match std::fs::OpenOptions::new().write(true).create_new(true).open(&destination) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(false),
            Err(error) => return Err(error),
        };
        let result = file.write_all(&bytes).and_then(|_| file.sync_all());
        drop(file);
        if result.is_err() { let _ = std::fs::remove_file(&destination); }
        result?;
        Ok(true)
    }

    pub fn open(dir: PathBuf, slug: &str) -> Storage {
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join(format!("{slug}.json"));
        let map = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        Storage { path, map }
    }

    pub fn get(&self, key: &str) -> Option<String> {
        self.map.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
    }

    pub fn set(&mut self, key: &str, value: String) -> io::Result<()> {
        let mut next = self.map.clone();
        next.insert(key.to_string(), serde_json::Value::String(value));
        self.flush(&next)?;
        self.map = next;
        Ok(())
    }

    pub fn remove(&mut self, key: &str) -> io::Result<()> {
        let mut next = self.map.clone();
        next.remove(key);
        self.flush(&next)?;
        self.map = next;
        Ok(())
    }

    fn flush(&self, next: &serde_json::Map<String, serde_json::Value>) -> io::Result<()> {
        // Keep the last good file and in-memory snapshot until a complete replacement exists.
        let text = serde_json::to_vec(next)?;
        let temp = self.path.with_extension(format!("json.{}.{}.tmp", std::process::id(), NEXT_WRITE.fetch_add(1, Ordering::Relaxed)));
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
        let written = file.write_all(&text).and_then(|_| file.sync_all());
        drop(file);
        let result = written.and_then(|_| std::fs::rename(&temp, &self.path));
        if result.is_err() { let _ = std::fs::remove_file(&temp); }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("blackiron-storage-{}-{}", std::process::id(), NEXT_WRITE.fetch_add(1, Ordering::Relaxed)));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    #[test]
    fn writes_replace_and_survive_reopening() {
        let dir = TestDir::new();
        let mut store = Storage::open(dir.0.clone(), "game");
        store.set("progress", "first".into()).unwrap();
        store.set("settings", "quiet".into()).unwrap();
        store.set("progress", "second".into()).unwrap();
        let mut reopened = Storage::open(dir.0.clone(), "game");
        assert_eq!(reopened.get("progress").as_deref(), Some("second"));
        reopened.remove("progress").unwrap();
        let last = Storage::open(dir.0.clone(), "game");
        assert_eq!(last.get("progress"), None);
        assert_eq!(last.get("settings").as_deref(), Some("quiet"));
        assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 1);
    }

    #[test]
    fn failed_replacement_preserves_snapshot_and_allows_retry() {
        let dir = TestDir::new();
        let mut store = Storage::open(dir.0.clone(), "game");
        store.set("progress", "good".into()).unwrap();
        let original = std::fs::read(&store.path).unwrap();
        let backup = dir.0.join("backup.json");
        std::fs::rename(&store.path, &backup).unwrap();
        std::fs::create_dir(&store.path).unwrap(); // Force rename failure, including when run as root.
        assert!(store.set("progress", "bad".into()).is_err());
        assert!(store.remove("progress").is_err());
        assert_eq!(store.get("progress").as_deref(), Some("good"));
        assert_eq!(std::fs::read(&backup).unwrap(), original);
        assert_eq!(std::fs::read_dir(&dir.0).unwrap().count(), 2); // No abandoned temp files.
        std::fs::remove_dir(&store.path).unwrap();
        std::fs::rename(&backup, &store.path).unwrap();
        store.set("progress", "retried".into()).unwrap();
        assert_eq!(Storage::open(dir.0.clone(), "game").get("progress").as_deref(), Some("retried"));
    }

    #[test]
    fn unwritable_location_reports_failure_without_in_memory_success() {
        let dir = TestDir::new();
        let blocker = dir.0.join("file");
        std::fs::write(&blocker, "not a directory").unwrap();
        let mut store = Storage::open(blocker, "game");
        assert!(store.set("progress", "unsaved".into()).is_err());
        assert_eq!(store.get("progress"), None);
    }

    #[test]
    fn migration_keeps_original_and_never_overwrites_new_progress() {
        let root = TestDir::new();
        let old = root.0.join("old");
        let new = root.0.join("new");
        let mut legacy = Storage::open(old.clone(), "game");
        legacy.set("game.meta", "progress".into()).unwrap();
        assert!(Storage::migrate_legacy(&new, &old, "game").unwrap());
        assert_eq!(Storage::open(new.clone(), "game").get("game.meta"), Some("progress".into()));
        assert_eq!(Storage::open(old.clone(), "game").get("game.meta"), Some("progress".into()));
        Storage::open(new.clone(), "game").set("game.meta", "newer".into()).unwrap();
        assert!(!Storage::migrate_legacy(&new, &old, "game").unwrap());
        assert_eq!(Storage::open(new, "game").get("game.meta"), Some("newer".into()));
    }

    #[test]
    fn corrupt_legacy_save_aborts_migration_without_creating_a_new_save() {
        let root = TestDir::new();
        let old = root.0.join("old");
        let new = root.0.join("new");
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("game.json"), "broken").unwrap();
        assert!(Storage::migrate_legacy(&new, &old, "game").is_err());
        assert!(!new.join("game.json").exists());
        assert_eq!(std::fs::read_to_string(old.join("game.json")).unwrap(), "broken");
    }
}
