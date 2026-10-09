//! QuickJS through rquickjs: small, portable, no JIT. The fallback on every platform and the
//! only engine on Android, where V8 has no prebuilt library.

use rquickjs::function::{Args, IntoJsFunc, ParamRequirement, Params};
use rquickjs::{Coerced, Context, Ctx, FromJs, Function, IntoJs, Object, Runtime, TypedArray, Value};

use super::{f32s_from_bytes, u32s_from_bytes, Engine, Native, Val};

pub struct QuickJs {
    rt: Runtime,
    ctx: Context,
}

impl QuickJs {
    pub fn new() -> QuickJs {
        let rt = Runtime::new().expect("QuickJS runtime");
        let ctx = Context::full(&rt).expect("QuickJS context");
        QuickJs { rt, ctx }
    }
}

impl Default for QuickJs {
    fn default() -> Self {
        Self::new()
    }
}

fn report(ctx: &Ctx<'_>, e: rquickjs::Error) {
    if e.is_exception() {
        let v = ctx.catch();
        let text = v
            .as_object()
            .and_then(|o| o.get::<_, String>("stack").ok())
            .or_else(|| v.as_string().and_then(|s| s.to_string().ok()))
            .unwrap_or_else(|| format!("{v:?}"));
        log::error!("[js] {text}");
    } else {
        log::error!("[js] {e}");
    }
}

/// `globalThis[ns]`, created when missing; the global object itself for an empty name.
fn ns_object<'js>(ctx: &Ctx<'js>, ns: &str) -> rquickjs::Result<Object<'js>> {
    let g = ctx.globals();
    if ns.is_empty() {
        return Ok(g);
    }
    if let Ok(o) = g.get::<_, Object>(ns) {
        return Ok(o);
    }
    let o = Object::new(ctx.clone())?;
    g.set(ns, o.clone())?;
    Ok(o)
}

fn from_js<'js>(ctx: &Ctx<'js>, v: Value<'js>) -> Val {
    if v.is_undefined() {
        return Val::Undefined;
    }
    if v.is_null() {
        return Val::Null;
    }
    if let Some(b) = v.as_bool() {
        return Val::Bool(b);
    }
    if let Some(n) = v.as_int() {
        return Val::Num(n as f64);
    }
    if let Some(n) = v.as_float() {
        return Val::Num(n);
    }
    if let Some(s) = v.as_string() {
        return Val::Str(s.to_string().unwrap_or_default());
    }
    if let Ok(t) = TypedArray::<f32>::from_js(ctx, v.clone()) {
        return Val::F32s(t.as_bytes().map(f32s_from_bytes).unwrap_or_default());
    }
    if let Ok(t) = TypedArray::<u8>::from_js(ctx, v.clone()) {
        return Val::Bytes(t.as_bytes().map(|b| b.to_vec()).unwrap_or_default());
    }
    if let Ok(t) = TypedArray::<u32>::from_js(ctx, v.clone()) {
        return Val::U32s(t.as_bytes().map(u32s_from_bytes).unwrap_or_default());
    }
    if let Some(a) = v.as_array() {
        return Val::Nums(a.iter::<Coerced<f64>>().map(|x| x.map(|c| c.0).unwrap_or(0.0)).collect());
    }
    // Objects (an Error, say) become their string form, which is what console callers want.
    match Coerced::<String>::from_js(ctx, v) {
        Ok(s) => Val::Str(s.0),
        Err(_) => Val::Undefined,
    }
}

fn to_js<'js>(ctx: &Ctx<'js>, v: Val) -> rquickjs::Result<Value<'js>> {
    Ok(match v {
        Val::Undefined => Value::new_undefined(ctx.clone()),
        Val::Null => Value::new_null(ctx.clone()),
        Val::Bool(b) => Value::new_bool(ctx.clone(), b),
        Val::Num(n) => n.into_js(ctx)?,
        Val::Str(s) => s.into_js(ctx)?,
        Val::Bytes(b) => TypedArray::<u8>::new(ctx.clone(), b)?.into_value(),
        Val::F32s(f) => TypedArray::<f32>::new(ctx.clone(), f)?.into_value(),
        Val::U32s(u) => TypedArray::<u32>::new(ctx.clone(), u)?.into_value(),
        Val::Nums(n) => n.into_js(ctx)?,
        Val::Obj(fields) => {
            let o = Object::new(ctx.clone())?;
            for (k, v) in fields {
                o.set(k, to_js(ctx, v)?)?;
            }
            o.into_value()
        }
    })
}

/// A native behind rquickjs's function trait, so arguments and the result share the call's
/// context lifetime (a closure cannot express that).
struct NativeFn(Native);

impl<'js> IntoJsFunc<'js, ()> for NativeFn {
    fn param_requirements() -> ParamRequirement {
        ParamRequirement::any()
    }

    fn call<'a>(&self, params: Params<'a, 'js>) -> rquickjs::Result<Value<'js>> {
        let ctx = params.ctx().clone();
        let vals: Vec<Val> = (0..params.len()).map(|i| params.arg(i).map(|v| from_js(&ctx, v)).unwrap_or(Val::Undefined)).collect();
        // A panic must not unwind through QuickJS's frames.
        let out = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.0)(&vals))) {
            Ok(v) => v,
            Err(e) => {
                let msg = e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_else(|| "panic".into());
                log::error!("[host] native function panicked: {msg}");
                Val::Undefined
            }
        };
        to_js(&ctx, out)
    }
}

impl Engine for QuickJs {
    fn name(&self) -> &'static str {
        "QuickJS"
    }

    fn register(&mut self, ns: &str, name: &str, f: Native) {
        self.ctx.with(|ctx| {
            let r: rquickjs::Result<()> = (|| {
                let obj = ns_object(&ctx, ns)?;
                let func = Function::new(ctx.clone(), NativeFn(f))?;
                obj.set(name, func)?;
                Ok(())
            })();
            if let Err(e) = r {
                report(&ctx, e);
            }
        });
    }

    fn set(&mut self, ns: &str, name: &str, v: Val) {
        self.ctx.with(|ctx| {
            let r: rquickjs::Result<()> = (|| {
                let obj = ns_object(&ctx, ns)?;
                obj.set(name, to_js(&ctx, v)?)
            })();
            if let Err(e) = r {
                report(&ctx, e);
            }
        });
    }

    fn eval(&mut self, source: &str, _filename: &str) {
        self.ctx.with(|ctx| {
            if let Err(e) = ctx.eval::<(), _>(source) {
                report(&ctx, e);
            }
        });
    }

    fn call(&mut self, obj: &str, method: &str, args: &[Val]) {
        self.ctx.with(|ctx| {
            let func: Option<Function> = if obj.is_empty() {
                ctx.globals().get::<_, Function>(method).ok()
            } else {
                ctx.globals().get::<_, Object>(obj).ok().and_then(|o| o.get::<_, Function>(method).ok())
            };
            let Some(func) = func else { return };
            let r: rquickjs::Result<()> = (|| {
                let mut a = Args::new(ctx.clone(), args.len());
                for v in args {
                    a.push_arg(to_js(&ctx, v.clone())?)?;
                }
                func.call_arg::<()>(a)
            })();
            if let Err(e) = r {
                report(&ctx, e);
            }
        });
    }

    fn pump(&mut self) {
        loop {
            match self.rt.execute_pending_job() {
                Ok(true) => continue,
                Ok(false) => break,
                Err(e) => {
                    e.0.with(|ctx| {
                        let v = ctx.catch();
                        log::error!("[js] job failed: {:?}", v.as_object().and_then(|o| o.get::<_, String>("stack").ok()).unwrap_or_default());
                    });
                }
            }
        }
    }
}
