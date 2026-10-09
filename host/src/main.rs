//! `blackiron-host <bundle dir>`: run a game built with `blackiron build --target native`.
//! Options: `--snapshot <png> [--snapshot-frame N] [--exit]` write a frame and optionally quit,
//! `--fullscreen`, `--size WxH`, `--js quickjs|v8` (or BLACKIRON_JS) to pick the script engine,
//! `--fixed-dt MS` for a synthetic clock so screenshots are reproducible.

use std::path::PathBuf;

use blackiron_host::bundle::Bundle;
use blackiron_host::script::EngineKind;

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut dir: Option<PathBuf> = None;
    let mut snapshot = std::env::var("BLACKIRON_SNAPSHOT").ok().map(PathBuf::from);
    let mut snapshot_frame: u64 = std::env::var("BLACKIRON_SNAPSHOT_FRAME").ok().and_then(|v| v.parse().ok()).unwrap_or(30);
    let mut exit_after = std::env::var("BLACKIRON_EXIT_AFTER_SNAPSHOT").is_ok();
    let mut fullscreen = false;
    let mut size = (1280.0, 720.0);
    let mut taps: Vec<(f64, f64, u64)> = Vec::new();
    let mut fixed_dt: Option<f64> = std::env::var("BLACKIRON_FIXED_DT").ok().and_then(|v| v.parse().ok());
    let mut engine = std::env::var("BLACKIRON_JS").ok().and_then(|v| EngineKind::parse(&v)).unwrap_or_else(EngineKind::default_for_build);
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--snapshot" => {
                snapshot = args.get(i + 1).map(PathBuf::from);
                i += 1;
            }
            "--snapshot-frame" => {
                snapshot_frame = args.get(i + 1).and_then(|v| v.parse().ok()).unwrap_or(30);
                i += 1;
            }
            "--exit" => exit_after = true,
            "--tap" => {
                if let Some(spec) = args.get(i + 1) {
                    if let Some((xy, frame)) = spec.split_once(':') {
                        if let Some((x, y)) = xy.split_once(',') {
                            taps.push((x.parse().unwrap_or(0.0), y.parse().unwrap_or(0.0), frame.parse().unwrap_or(0)));
                        }
                    }
                }
                i += 1;
            }
            "--js" => {
                if let Some(kind) = args.get(i + 1).and_then(|v| EngineKind::parse(v)) {
                    engine = kind;
                }
                i += 1;
            }
            "--fixed-dt" => {
                fixed_dt = args.get(i + 1).and_then(|v| v.parse().ok());
                i += 1;
            }
            "--fullscreen" => fullscreen = true,
            "--size" => {
                if let Some((w, h)) = args.get(i + 1).and_then(|v| v.split_once('x')) {
                    size = (w.parse().unwrap_or(1280.0), h.parse().unwrap_or(720.0));
                }
                i += 1;
            }
            other => dir = Some(PathBuf::from(other)),
        }
        i += 1;
    }
    // Without an argument, look next to the executable: Contents/Resources/Blackiron in a macOS
    // app bundle, or a Blackiron folder beside the binary elsewhere.
    let dir = dir.or_else(|| {
        let exe = std::env::current_exe().ok()?;
        let here = exe.parent()?;
        [here.join("../Resources/Blackiron"), here.join("Blackiron")].into_iter().find(|p| p.join("game.js").exists())
    });
    let Some(dir) = dir else {
        eprintln!("usage: blackiron-host <bundle dir> [--snapshot out.png --snapshot-frame N --exit] [--tap X,Y:FRAME] [--fullscreen] [--size WxH] [--js quickjs|v8] [--fixed-dt MS]");
        std::process::exit(2);
    };
    let bundle = Bundle::Dir(dir);
    let title = bundle.name();
    let config_dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    let data_dir = config_dir.join("Blackiron");
    let slug = title.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect::<String>();
    if let Err(error) = blackiron_host::storage::Storage::migrate_legacy(&data_dir, &config_dir.join("Kiln"), &slug) {
        eprintln!("Blackiron: cannot migrate existing progress: {error}");
        std::process::exit(1);
    }
    let event_loop = winit::event_loop::EventLoop::new().expect("event loop");
    blackiron_host::run(event_loop, blackiron_host::RunOptions { bundle, data_dir, title, size, fullscreen, snapshot, snapshot_frame, exit_after_snapshot: exit_after, taps, engine, fixed_dt });
}
