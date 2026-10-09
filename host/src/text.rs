//! Glyph rasterisation for the engine's glyph cache: bundled TrueType fonts matched by
//! family, weight and style through fontdue, with the system's sans-serif as fallback.

use std::collections::HashMap;
use std::sync::Arc;

use crate::bundle::Bundle;

pub struct Glyph {
    pub w: usize,
    pub h: usize,
    pub left: i32,
    pub top: i32,
    pub advance: f32,
    pub ascent: f32,
    pub descent: f32,
    pub data: Vec<u8>,
}

struct Face {
    family: String,
    weight: u16,
    italic: bool,
    font: Arc<fontdue::Font>,
}

pub struct TextSystem {
    faces: Vec<Face>,
    fallback: HashMap<(String, u16, bool), Option<Arc<fontdue::Font>>>,
}

impl TextSystem {
    pub fn new(bundle: &Bundle) -> TextSystem {
        let mut faces = Vec::new();
        for name in bundle.list("fonts") {
            let lower = name.to_lowercase();
            if !(lower.ends_with(".ttf") || lower.ends_with(".otf")) {
                continue;
            }
            let Some(bytes) = bundle.read(&format!("fonts/{name}")) else { continue };
            let Ok(parsed) = ttf_parser::Face::parse(&bytes, 0) else { continue };
            // Prefer the typographic family ("Instrument Sans") over the legacy one, which
            // carries the style for weights beyond bold ("Instrument Sans SemiBold").
            let name_of = |id: u16| parsed.names().into_iter().filter(|n| n.name_id == id).filter_map(|n| n.to_string()).next();
            let family = name_of(ttf_parser::name_id::TYPOGRAPHIC_FAMILY).or_else(|| name_of(ttf_parser::name_id::FAMILY)).unwrap_or_else(|| name.clone());
            let weight = parsed.weight().to_number();
            let italic = parsed.is_italic();
            if let Ok(font) = fontdue::Font::from_bytes(bytes, fontdue::FontSettings::default()) {
                faces.push(Face { family, weight, italic, font: Arc::new(font) });
            }
        }
        if !faces.is_empty() {
            let mut names: Vec<&str> = faces.iter().map(|f| f.family.as_str()).collect();
            names.sort();
            names.dedup();
            log::info!("fonts: {}", names.join(", "));
        }
        TextSystem { faces, fallback: HashMap::new() }
    }

    fn pick(&mut self, family: &str, weight: u16, italic: bool) -> Option<Arc<fontdue::Font>> {
        let mut best: Option<(&Face, i32)> = None;
        for f in &self.faces {
            if !f.family.eq_ignore_ascii_case(family) {
                continue;
            }
            let score = (f.weight as i32 - weight as i32).abs() + if f.italic == italic { 0 } else { 1000 };
            if best.map(|b| score < b.1).unwrap_or(true) {
                best = Some((f, score));
            }
        }
        if let Some((f, _)) = best {
            return Some(f.font.clone());
        }
        let key = (family.to_string(), weight, italic);
        if let Some(f) = self.fallback.get(&key) {
            return f.clone();
        }
        let font = system_font(family, weight, italic).map(Arc::new);
        self.fallback.insert(key, font.clone());
        font
    }

    pub fn rasterize(&mut self, family: &str, size: f32, weight: i32, italic: bool, ch: char) -> Option<Glyph> {
        let font = self.pick(family, weight.clamp(1, 1000) as u16, italic)?;
        let (m, data) = font.rasterize(ch, size);
        let line = font.horizontal_line_metrics(size)?;
        Some(Glyph {
            w: m.width,
            h: m.height,
            left: m.xmin,
            top: -(m.ymin + m.height as i32),
            advance: m.advance_width,
            ascent: line.ascent,
            descent: -line.descent,
            data,
        })
    }
}

/// The platform's font for a family, or its sans-serif when the family is unknown.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn system_font(family: &str, weight: u16, italic: bool) -> Option<fontdue::Font> {
    use font_kit::family_name::FamilyName;
    use font_kit::handle::Handle;
    use font_kit::properties::{Properties, Style, Weight};
    use font_kit::source::SystemSource;
    let source = SystemSource::new();
    let props = Properties { weight: Weight(weight as f32), style: if italic { Style::Italic } else { Style::Normal }, ..Properties::default() };
    let mut families = Vec::new();
    if !family.is_empty() && family != "system-ui" && family != "sans-serif" {
        families.push(FamilyName::Title(family.to_string()));
    }
    families.push(FamilyName::SansSerif);
    let handle = source.select_best_match(&families, &props).ok()?;
    let index = match &handle {
        Handle::Path { font_index, .. } => *font_index,
        Handle::Memory { font_index, .. } => *font_index,
    };
    let font = handle.load().ok()?;
    let data = font.copy_font_data()?;
    fontdue::Font::from_bytes(data.as_slice(), fontdue::FontSettings { collection_index: index, ..fontdue::FontSettings::default() }).ok()
}

/// Linux and Android: the usual font directories, preferring a well-known sans-serif.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn system_font(family: &str, weight: u16, italic: bool) -> Option<fontdue::Font> {
    let dirs = [
        "/system/fonts",
        "/usr/share/fonts",
        "/usr/local/share/fonts",
        "/usr/share/fonts/truetype",
        "/usr/share/fonts/TTF",
    ];
    let mut home_fonts = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        home_fonts.push(format!("{home}/.fonts"));
        home_fonts.push(format!("{home}/.local/share/fonts"));
    }
    let bold = weight >= 600;
    let wanted = family.to_lowercase().replace(' ', "");
    let preferred = ["roboto", "notosans", "dejavusans", "liberationsans", "ubuntu", "cantarell", "freesans", "opensans", "arial"];
    let mut candidates: Vec<(i32, std::path::PathBuf)> = Vec::new();
    let mut stack: Vec<std::path::PathBuf> = dirs.iter().map(std::path::PathBuf::from).chain(home_fonts.iter().map(std::path::PathBuf::from)).collect();
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let path = e.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
            if !(name.ends_with(".ttf") || name.ends_with(".otf")) {
                continue;
            }
            let stem = name.trim_end_matches(".ttf").trim_end_matches(".otf").replace(['-', '_', ' '], "");
            let is_bold = stem.contains("bold");
            let is_italic = stem.contains("italic") || stem.contains("oblique");
            let mut score = 0;
            if !wanted.is_empty() && stem.starts_with(&wanted) {
                score += 100;
            } else if let Some(i) = preferred.iter().position(|p| stem.starts_with(p)) {
                score += 50 - i as i32;
            } else {
                continue;
            }
            if is_bold == bold {
                score += 10;
            }
            if is_italic == italic {
                score += 5;
            }
            if stem.contains("mono") || stem.contains("condensed") || stem.contains("serif") && !stem.contains("sans") {
                score -= 20;
            }
            if stem.contains("flex") || stem.contains("-vf") || stem.contains("symbol") || stem.contains("emoji") {
                score -= 30;
            }
            candidates.push((score, path));
        }
    }
    // Try the best candidates in order and keep the first with real Latin coverage: Android
    // ships fonts such as RobotoFlex or symbol sets that a name match alone would pick.
    candidates.sort_by_key(|(score, _)| -*score);
    for (_, path) in candidates.into_iter().take(12) {
        let Ok(data) = std::fs::read(&path) else { continue };
        let Ok(font) = fontdue::Font::from_bytes(data, fontdue::FontSettings::default()) else { continue };
        if ['A', 'a', 'M', '0'].iter().all(|&c| font.lookup_glyph_index(c) != 0) {
            return Some(font);
        }
    }
    None
}
