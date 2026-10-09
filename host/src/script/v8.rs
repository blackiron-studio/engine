//! V8 through the `v8` crate (Deno's rusty_v8): a JIT for desktops, where the platform allows
//! one. Prebuilt libraries exist for macOS, Linux and Windows; Android and iOS are not
//! covered, so those keep QuickJS and JavaScriptCore.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Once;

use super::{f32s_from_bytes, u32s_from_bytes, Engine, Native, Val};

static INIT: Once = Once::new();

thread_local! {
    /// Natives by index; callbacks find theirs through the External they were built with.
    static NATIVES: RefCell<Vec<Rc<Native>>> = const { RefCell::new(Vec::new()) };
}

pub struct V8Engine {
    isolate: v8::OwnedIsolate,
    context: v8::Global<v8::Context>,
}

impl V8Engine {
    pub fn new() -> V8Engine {
        INIT.call_once(|| {
            let platform = v8::new_default_platform(0, false).make_shared();
            v8::V8::initialize_platform(platform);
            v8::V8::initialize();
        });
        let mut isolate = v8::Isolate::new(Default::default());
        let context = {
            v8::scope!(let scope, &mut isolate);
            let context = v8::Context::new(scope, Default::default());
            v8::Global::new(scope, context)
        };
        V8Engine { isolate, context }
    }

    /// Run `f` inside the engine's context.
    fn with<R>(&mut self, f: impl FnOnce(&mut v8::PinScope<'_, '_>) -> R) -> R {
        v8::scope!(let scope, &mut self.isolate);
        let context = v8::Local::new(scope, &self.context);
        let mut cs = v8::ContextScope::new(scope, context);
        f(&mut cs)
    }
}

impl Default for V8Engine {
    fn default() -> Self {
        Self::new()
    }
}

fn from_v8<'s, 'v>(scope: &mut v8::PinScope<'s, '_>, v: v8::Local<'v, v8::Value>) -> Val {
    if v.is_undefined() {
        return Val::Undefined;
    }
    if v.is_null() {
        return Val::Null;
    }
    if v.is_boolean() {
        return Val::Bool(v.boolean_value(scope));
    }
    if v.is_number() {
        return Val::Num(v.number_value(scope).unwrap_or(0.0));
    }
    if v.is_string() {
        return Val::Str(v.to_rust_string_lossy(scope));
    }
    // A Vec<u8> is not 4-byte aligned in general; pod_collect_to_vec copies into an aligned Vec.
    if let Ok(t) = v8::Local::<v8::Float32Array>::try_from(v) {
        let mut bytes = vec![0u8; t.byte_length()];
        t.copy_contents(&mut bytes);
        return Val::F32s(f32s_from_bytes(&bytes));
    }
    if let Ok(t) = v8::Local::<v8::Uint8Array>::try_from(v) {
        let mut bytes = vec![0u8; t.byte_length()];
        t.copy_contents(&mut bytes);
        return Val::Bytes(bytes);
    }
    if let Ok(t) = v8::Local::<v8::Uint32Array>::try_from(v) {
        let mut bytes = vec![0u8; t.byte_length()];
        t.copy_contents(&mut bytes);
        return Val::U32s(u32s_from_bytes(&bytes));
    }
    if let Ok(a) = v8::Local::<v8::Array>::try_from(v) {
        let n = a.length();
        let mut out = Vec::with_capacity(n as usize);
        for i in 0..n {
            out.push(a.get_index(scope, i).and_then(|x| x.number_value(scope)).unwrap_or(0.0));
        }
        return Val::Nums(out);
    }
    Val::Str(v.to_rust_string_lossy(scope))
}

fn buffer<'s>(scope: &mut v8::PinScope<'s, '_>, bytes: Vec<u8>) -> v8::Local<'s, v8::ArrayBuffer> {
    let store = v8::ArrayBuffer::new_backing_store_from_vec(bytes).make_shared();
    v8::ArrayBuffer::with_backing_store(scope, &store)
}

fn to_v8<'s>(scope: &mut v8::PinScope<'s, '_>, v: Val) -> v8::Local<'s, v8::Value> {
    match v {
        Val::Undefined => v8::undefined(scope).into(),
        Val::Null => v8::null(scope).into(),
        Val::Bool(b) => v8::Boolean::new(scope, b).into(),
        Val::Num(n) => v8::Number::new(scope, n).into(),
        Val::Str(s) => match v8::String::new(scope, &s) {
            Some(s) => s.into(),
            None => v8::undefined(scope).into(),
        },
        Val::Bytes(b) => {
            let len = b.len();
            let buf = buffer(scope, b);
            match v8::Uint8Array::new(scope, buf, 0, len) {
                Some(t) => t.into(),
                None => v8::undefined(scope).into(),
            }
        }
        Val::F32s(f) => {
            let len = f.len();
            let buf = buffer(scope, bytemuck::cast_slice(&f).to_vec());
            match v8::Float32Array::new(scope, buf, 0, len) {
                Some(t) => t.into(),
                None => v8::undefined(scope).into(),
            }
        }
        Val::U32s(u) => {
            let len = u.len();
            let buf = buffer(scope, bytemuck::cast_slice(&u).to_vec());
            match v8::Uint32Array::new(scope, buf, 0, len) {
                Some(t) => t.into(),
                None => v8::undefined(scope).into(),
            }
        }
        Val::Nums(n) => {
            let items: Vec<v8::Local<v8::Value>> = n.iter().map(|x| v8::Number::new(scope, *x).into()).collect();
            v8::Array::new_with_elements(scope, &items).into()
        }
        Val::Obj(fields) => {
            let o = v8::Object::new(scope);
            for (k, v) in fields {
                let key = v8::String::new(scope, &k).unwrap();
                let val = to_v8(scope, v);
                o.set(scope, key.into(), val);
            }
            o.into()
        }
    }
}

fn native_callback(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Ok(ext) = v8::Local::<v8::External>::try_from(args.data()) else { return };
    let idx = ext.value() as usize;
    let Some(f) = NATIVES.with(|n| n.borrow().get(idx).cloned()) else { return };
    let mut vals = Vec::with_capacity(args.length() as usize);
    for i in 0..args.length() {
        let a = args.get(i);
        vals.push(from_v8(scope, a));
    }
    // A panic must not unwind through V8's frames: it would leave the isolate unusable.
    let out = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(&vals))) {
        Ok(v) => v,
        Err(e) => {
            let msg = e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_else(|| "panic".into());
            log::error!("[host] native function panicked: {msg}");
            Val::Undefined
        }
    };
    let v = to_v8(scope, out);
    rv.set(v);
}

fn ns_object<'s>(scope: &mut v8::PinScope<'s, '_>, ns: &str) -> v8::Local<'s, v8::Object> {
    let global = scope.get_current_context().global(scope);
    if ns.is_empty() {
        return global;
    }
    let key = v8::String::new(scope, ns).unwrap();
    if let Some(existing) = global.get(scope, key.into()).and_then(|v| v8::Local::<v8::Object>::try_from(v).ok()) {
        return existing;
    }
    let o = v8::Object::new(scope);
    global.set(scope, key.into(), o.into());
    o
}

fn report(tc: &mut v8::PinnedRef<'_, v8::TryCatch<v8::HandleScope>>) {
    let text = tc.stack_trace().or_else(|| tc.exception()).map(|e| e.to_rust_string_lossy(tc));
    log::error!("[js] {}", text.unwrap_or_else(|| "unknown error".into()));
}

impl Engine for V8Engine {
    fn name(&self) -> &'static str {
        "V8"
    }

    fn register(&mut self, ns: &str, name: &str, f: Native) {
        let idx = NATIVES.with(|n| {
            let mut n = n.borrow_mut();
            n.push(Rc::new(f));
            n.len() - 1
        });
        self.with(|scope| {
            let obj = ns_object(scope, ns);
            let ext = v8::External::new(scope, idx as *mut std::ffi::c_void);
            let ft = v8::FunctionTemplate::builder(native_callback).data(ext.into()).build(scope);
            let func = ft.get_function(scope).expect("function");
            let key = v8::String::new(scope, name).unwrap();
            obj.set(scope, key.into(), func.into());
        });
    }

    fn set(&mut self, ns: &str, name: &str, v: Val) {
        self.with(|scope| {
            let obj = ns_object(scope, ns);
            let key = v8::String::new(scope, name).unwrap();
            let val = to_v8(scope, v);
            obj.set(scope, key.into(), val);
        });
    }

    fn eval(&mut self, source: &str, _filename: &str) {
        self.with(|scope| {
            v8::tc_scope!(let tc, scope);
            let Some(code) = v8::String::new(tc, source) else { return };
            let ran = v8::Script::compile(tc, code, None).and_then(|s| s.run(tc));
            if ran.is_none() {
                report(tc);
            }
        });
    }

    fn call(&mut self, obj: &str, method: &str, args: &[Val]) {
        self.with(|scope| {
            let global = scope.get_current_context().global(scope);
            let target: v8::Local<v8::Object> = if obj.is_empty() {
                global
            } else {
                let key = v8::String::new(scope, obj).unwrap();
                match global.get(scope, key.into()).and_then(|v| v8::Local::<v8::Object>::try_from(v).ok()) {
                    Some(o) => o,
                    None => return,
                }
            };
            let key = v8::String::new(scope, method).unwrap();
            let Some(func) = target.get(scope, key.into()).and_then(|v| v8::Local::<v8::Function>::try_from(v).ok()) else { return };
            let argv: Vec<v8::Local<v8::Value>> = args.iter().map(|a| to_v8(scope, a.clone())).collect();
            v8::tc_scope!(let tc, scope);
            if func.call(tc, target.into(), &argv).is_none() {
                report(tc);
            }
        });
    }

    fn pump(&mut self) {
        self.isolate.perform_microtask_checkpoint();
    }
}
