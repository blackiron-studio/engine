//! Where the game's files come from: a directory on desktop (the output of
//! `blackiron build --target native`), the APK's assets on Android.

use std::path::{Path, PathBuf};

pub enum Bundle {
    Dir(PathBuf),
    #[cfg(target_os = "android")]
    Assets(ndk::asset::AssetManager),
}

impl Bundle {
    pub fn read(&self, rel: &str) -> Option<Vec<u8>> {
        match self {
            Bundle::Dir(dir) => std::fs::read(dir.join(rel)).ok(),
            #[cfg(target_os = "android")]
            Bundle::Assets(am) => {
                use std::io::Read;
                let name = std::ffi::CString::new(format!("Blackiron/{rel}")).ok()?;
                let mut asset = am.open(&name)?;
                let mut out = Vec::new();
                asset.read_to_end(&mut out).ok()?;
                Some(out)
            }
        }
    }

    pub fn read_text(&self, rel: &str) -> Option<String> {
        self.read(rel).and_then(|b| String::from_utf8(b).ok())
    }

    /// File names directly under `rel` (a directory).
    pub fn list(&self, rel: &str) -> Vec<String> {
        match self {
            Bundle::Dir(dir) => std::fs::read_dir(dir.join(rel))
                .map(|it| it.flatten().filter_map(|e| e.file_name().into_string().ok()).collect())
                .unwrap_or_default(),
            #[cfg(target_os = "android")]
            Bundle::Assets(am) => {
                let name = match std::ffi::CString::new(format!("Blackiron/{rel}")) {
                    Ok(n) => n,
                    Err(_) => return Vec::new(),
                };
                match am.open_dir(&name) {
                    Some(dir) => dir.filter_map(|c| c.to_str().ok().map(|s| s.to_string())).collect(),
                    None => Vec::new(),
                }
            }
        }
    }

    pub fn manifest(&self) -> serde_json::Value {
        self.read_text("manifest.json").and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(serde_json::Value::Null)
    }

    pub fn name(&self) -> String {
        self.manifest().get("name").and_then(|v| v.as_str()).unwrap_or("Blackiron").to_string()
    }

    pub fn dir(&self) -> Option<&Path> {
        match self {
            Bundle::Dir(d) => Some(d),
            #[cfg(target_os = "android")]
            _ => None,
        }
    }
}
