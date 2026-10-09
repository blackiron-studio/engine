//! Script engines behind one small interface. The host registers native functions that
//! take and return [`Val`]s, and each engine (QuickJS, V8) does the marshalling. Keeping the
//! host API engine-neutral is what lets desktops run V8 while phones keep QuickJS.

pub mod quickjs;
#[cfg(feature = "v8")]
pub mod v8;

/// A value crossing the script boundary. Typed arrays are copied both ways.
#[derive(Clone, Debug, PartialEq)]
pub enum Val {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    /// A Uint8Array.
    Bytes(Vec<u8>),
    /// A Float32Array.
    F32s(Vec<f32>),
    /// A Uint32Array.
    U32s(Vec<u32>),
    /// A plain array of numbers.
    Nums(Vec<f64>),
    Obj(Vec<(String, Val)>),
}

impl Val {
    pub fn num(&self) -> f64 {
        match self {
            Val::Num(n) => *n,
            Val::Bool(b) => *b as u8 as f64,
            _ => 0.0,
        }
    }

    pub fn int(&self) -> i32 {
        let n = self.num();
        if n.is_finite() { n as i32 } else { 0 }
    }

    pub fn truthy(&self) -> bool {
        match self {
            Val::Undefined | Val::Null => false,
            Val::Bool(b) => *b,
            Val::Num(n) => *n != 0.0 && !n.is_nan(),
            Val::Str(s) => !s.is_empty(),
            _ => true,
        }
    }

    pub fn text(&self) -> String {
        match self {
            Val::Str(s) => s.clone(),
            Val::Num(n) => format!("{n}"),
            Val::Bool(b) => b.to_string(),
            Val::Undefined => "undefined".into(),
            Val::Null => "null".into(),
            other => format!("{other:?}"),
        }
    }

    pub fn f32s(&self) -> &[f32] {
        match self {
            Val::F32s(v) => v,
            _ => &[],
        }
    }

    pub fn bytes(&self) -> &[u8] {
        match self {
            Val::Bytes(v) => v,
            _ => &[],
        }
    }

    pub fn nums(&self) -> Vec<f64> {
        match self {
            Val::Nums(v) => v.clone(),
            Val::F32s(v) => v.iter().map(|x| *x as f64).collect(),
            _ => Vec::new(),
        }
    }
}

/// Floats from a typed array's bytes; the byte buffer need not be aligned.
pub fn f32s_from_bytes(bytes: &[u8]) -> Vec<f32> {
    bytes.chunks_exact(4).map(|c| f32::from_ne_bytes([c[0], c[1], c[2], c[3]])).collect()
}

pub fn u32s_from_bytes(bytes: &[u8]) -> Vec<u32> {
    bytes.chunks_exact(4).map(|c| u32::from_ne_bytes([c[0], c[1], c[2], c[3]])).collect()
}

static UNDEFINED: Val = Val::Undefined;

/// The i-th argument, or undefined.
pub fn arg(args: &[Val], i: usize) -> &Val {
    args.get(i).unwrap_or(&UNDEFINED)
}

/// A native function the script can call.
pub type Native = Box<dyn Fn(&[Val]) -> Val>;

pub trait Engine {
    fn name(&self) -> &'static str;
    /// Define `globalThis.<ns>.<name>`; an empty `ns` means the global object.
    fn register(&mut self, ns: &str, name: &str, f: Native);
    /// Set `globalThis.<ns>.<name>` to a value.
    fn set(&mut self, ns: &str, name: &str, v: Val);
    /// Run a script; errors are logged.
    fn eval(&mut self, source: &str, filename: &str);
    /// Call `globalThis.<obj>.<method>(args)`, or a global function when `obj` is empty. Missing
    /// functions are ignored; exceptions are logged.
    fn call(&mut self, obj: &str, method: &str, args: &[Val]);
    /// Run pending promise jobs.
    fn pump(&mut self);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineKind {
    QuickJs,
    V8,
}

impl EngineKind {
    pub fn parse(s: &str) -> Option<EngineKind> {
        match s.to_ascii_lowercase().as_str() {
            "quickjs" | "qjs" => Some(EngineKind::QuickJs),
            "v8" => Some(EngineKind::V8),
            _ => None,
        }
    }

    /// V8 when this build has it (desktops), else QuickJS.
    pub fn default_for_build() -> EngineKind {
        if cfg!(feature = "v8") { EngineKind::V8 } else { EngineKind::QuickJs }
    }
}

/// Make an engine; asks for V8 in a build without it fall back to QuickJS with a warning.
pub fn create(kind: EngineKind) -> Box<dyn Engine> {
    match kind {
        EngineKind::QuickJs => Box::new(quickjs::QuickJs::new()),
        #[cfg(feature = "v8")]
        EngineKind::V8 => Box::new(v8::V8Engine::new()),
        #[cfg(not(feature = "v8"))]
        EngineKind::V8 => {
            log::warn!("this host was built without V8; using QuickJS");
            Box::new(quickjs::QuickJs::new())
        }
    }
}
