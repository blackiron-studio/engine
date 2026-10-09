//! Keyboard codes and game controllers, delivered to the engine as the same names the web
//! build uses (`KeyA`, `ArrowUp`, `GamepadA`, `GamepadLeftStickLeft`).
//!
//! Controller state comes from gilrs on desktops and from the Android input system (through
//! the JNI functions in `android.rs`) on phones; both feed the same [`PadState`], which is
//! turned into key edges once per frame.

use std::collections::{HashMap, HashSet};

use winit::keyboard::KeyCode;

/// winit's key codes are named after the W3C `KeyboardEvent.code` values the engine binds.
pub fn key_name(code: KeyCode) -> String {
    format!("{code:?}")
}

/// One controller's current state, in the engine's conventions: sticks are -1..1 with up
/// positive, triggers 0..1, and buttons carry their engine name without the `Gamepad` prefix.
#[derive(Default, Debug, Clone)]
pub struct PadState {
    pub buttons: HashSet<&'static str>,
    pub left: (f32, f32),
    pub right: (f32, f32),
    /// D-pad reported as a hat axis (most Android controllers): -1 left/up, 1 right/down.
    pub hat: (f32, f32),
    pub triggers: (f32, f32),
}

impl PadState {
    /// Every engine key this state holds down.
    pub fn active(&self, deadzone: f32) -> HashSet<String> {
        let mut now: HashSet<String> = self.buttons.iter().map(|b| format!("Gamepad{b}")).collect();
        for ((vx, vy), side) in [(self.left, "Left"), (self.right, "Right")] {
            if vx < -deadzone { now.insert(format!("Gamepad{side}StickLeft")); }
            if vx > deadzone { now.insert(format!("Gamepad{side}StickRight")); }
            if vy > deadzone { now.insert(format!("Gamepad{side}StickUp")); }
            if vy < -deadzone { now.insert(format!("Gamepad{side}StickDown")); }
        }
        if self.hat.0 < -0.5 { now.insert("GamepadDpadLeft".into()); }
        if self.hat.0 > 0.5 { now.insert("GamepadDpadRight".into()); }
        if self.hat.1 < -0.5 { now.insert("GamepadDpadUp".into()); }
        if self.hat.1 > 0.5 { now.insert("GamepadDpadDown".into()); }
        if self.triggers.0 > 0.5 { now.insert("GamepadL2".into()); }
        if self.triggers.1 > 0.5 { now.insert("GamepadR2".into()); }
        now
    }
}

/// A raw controller event from a platform that pushes (Android); polled platforms skip this.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PadEvent {
    /// Android `MotionEvent` axis id and value.
    Axis { device: i32, axis: i32, value: f32 },
    /// Android key code and whether it went down.
    Button { device: i32, key: i32, down: bool },
    /// The controller went away.
    Removed { device: i32 },
}

/// Android key codes for controller buttons, by engine name.
pub fn android_button_name(key: i32) -> Option<&'static str> {
    Some(match key {
        96 => "A",
        97 => "B",
        99 => "X",
        100 => "Y",
        102 => "L1",
        103 => "R1",
        104 => "L2",
        105 => "R2",
        106 => "L3",
        107 => "R3",
        108 => "Start",
        109 => "Select",
        110 => "Home",
        19 => "DpadUp",
        20 => "DpadDown",
        21 => "DpadLeft",
        22 => "DpadRight",
        _ => return None,
    })
}

/// Apply an Android event to a pad. Android's Y axes point down; the engine's point up.
pub fn apply_android(pad: &mut PadState, ev: PadEvent) {
    match ev {
        PadEvent::Axis { axis, value, .. } => match axis {
            0 => pad.left.0 = value,
            1 => pad.left.1 = -value,
            11 => pad.right.0 = value,
            14 => pad.right.1 = -value,
            15 => pad.hat.0 = value,
            16 => pad.hat.1 = value,
            17 | 23 => pad.triggers.0 = value,
            18 | 22 => pad.triggers.1 = value,
            _ => {}
        },
        PadEvent::Button { key, down, .. } => {
            if let Some(name) = android_button_name(key) {
                if down {
                    pad.buttons.insert(name);
                } else {
                    pad.buttons.remove(name);
                }
            }
        }
        PadEvent::Removed { .. } => *pad = PadState::default(),
    }
}

/// Edges between two sets of held keys: (code, down).
pub fn edges(before: &HashSet<String>, now: &HashSet<String>) -> Vec<(String, bool)> {
    let mut out: Vec<(String, bool)> = now.difference(before).map(|c| (c.clone(), true)).collect();
    out.extend(before.difference(now).map(|c| (c.clone(), false)));
    out.sort();
    out
}

#[cfg(target_os = "android")]
mod queue {
    use super::PadEvent;
    use std::sync::Mutex;

    static PENDING: Mutex<Vec<PadEvent>> = Mutex::new(Vec::new());

    /// Called from the JNI entry points on the UI thread.
    pub fn push(ev: PadEvent) {
        if let Ok(mut q) = PENDING.lock() {
            if q.len() < 4096 {
                q.push(ev);
            }
        }
    }

    pub fn drain() -> Vec<PadEvent> {
        PENDING.lock().map(|mut q| std::mem::take(&mut *q)).unwrap_or_default()
    }
}

#[cfg(target_os = "android")]
pub use queue::push as android_push;

pub struct Gamepads {
    #[cfg(not(target_os = "android"))]
    gilrs: Option<gilrs::Gilrs>,
    pads: HashMap<i32, PadState>,
    down: HashSet<String>,
    deadzone: f32,
}

impl Default for Gamepads {
    fn default() -> Self {
        Self::new()
    }
}

impl Gamepads {
    pub fn new() -> Gamepads {
        #[cfg(not(target_os = "android"))]
        let gilrs = match gilrs::Gilrs::new() {
            Ok(g) => Some(g),
            Err(e) => {
                log::warn!("controllers unavailable: {e}");
                None
            }
        };
        Gamepads {
            #[cfg(not(target_os = "android"))]
            gilrs,
            pads: HashMap::new(),
            down: HashSet::new(),
            deadzone: 0.5,
        }
    }

    /// Key edges since the last poll: (code, down).
    pub fn poll(&mut self) -> Vec<(String, bool)> {
        #[cfg(target_os = "android")]
        {
            // Event by event, so a press and release inside one frame still produce both edges.
            let mut out = Vec::new();
            for ev in queue::drain() {
                out.extend(self.apply(ev));
            }
            out
        }
        #[cfg(not(target_os = "android"))]
        {
            self.gather();
            self.settle()
        }
    }

    /// Apply one pushed event and return the edges it caused.
    pub fn apply(&mut self, ev: PadEvent) -> Vec<(String, bool)> {
        match ev {
            PadEvent::Removed { device } => {
                self.pads.remove(&device);
            }
            PadEvent::Axis { device, .. } | PadEvent::Button { device, .. } => apply_android(self.pads.entry(device).or_default(), ev),
        }
        self.settle()
    }

    /// Edges between the last reported key set and the current pad states.
    fn settle(&mut self) -> Vec<(String, bool)> {
        let mut now = HashSet::new();
        for pad in self.pads.values() {
            now.extend(pad.active(self.deadzone));
        }
        let out = edges(&self.down, &now);
        self.down = now;
        out
    }

    #[cfg(not(target_os = "android"))]
    fn gather(&mut self) {
        use gilrs::{Axis, Button};
        let Some(g) = &mut self.gilrs else { return };
        while g.next_event().is_some() {}
        let buttons = [
            (Button::South, "A"), (Button::East, "B"), (Button::West, "X"), (Button::North, "Y"),
            (Button::LeftTrigger, "L1"), (Button::RightTrigger, "R1"), (Button::LeftTrigger2, "L2"), (Button::RightTrigger2, "R2"),
            (Button::Select, "Select"), (Button::Start, "Start"), (Button::LeftThumb, "L3"), (Button::RightThumb, "R3"),
            (Button::DPadUp, "DpadUp"), (Button::DPadDown, "DpadDown"), (Button::DPadLeft, "DpadLeft"), (Button::DPadRight, "DpadRight"),
            (Button::Mode, "Home"),
        ];
        self.pads.clear();
        for (id, pad) in g.gamepads() {
            let mut state = PadState::default();
            for (b, name) in buttons {
                if pad.is_pressed(b) {
                    state.buttons.insert(name);
                }
            }
            state.left = (pad.value(Axis::LeftStickX), pad.value(Axis::LeftStickY));
            state.right = (pad.value(Axis::RightStickX), pad.value(Axis::RightStickY));
            self.pads.insert(usize::from(id) as i32, state);
        }
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    fn pads() -> Gamepads {
        Gamepads {
            #[cfg(not(target_os = "android"))]
            gilrs: None,
            pads: HashMap::new(),
            down: HashSet::new(),
            deadzone: 0.5,
        }
    }

    #[test]
    fn android_buttons_and_axes_become_engine_key_edges() {
        let mut g = pads();
        assert_eq!(g.apply(PadEvent::Button { device: 3, key: 96, down: true }), vec![("GamepadA".to_string(), true)]);
        assert_eq!(g.apply(PadEvent::Axis { device: 3, axis: 0, value: -0.9 }), vec![("GamepadLeftStickLeft".to_string(), true)]);
        // Android's Y axis points down; the engine's points up.
        assert_eq!(g.apply(PadEvent::Axis { device: 3, axis: 1, value: -0.9 }), vec![("GamepadLeftStickUp".to_string(), true)]);
        assert_eq!(g.apply(PadEvent::Axis { device: 3, axis: 16, value: 1.0 }), vec![("GamepadDpadDown".to_string(), true)]);
        assert_eq!(g.apply(PadEvent::Axis { device: 3, axis: 18, value: 0.8 }), vec![("GamepadR2".to_string(), true)]);
        // Releasing produces the matching up edges and nothing else.
        assert_eq!(g.apply(PadEvent::Button { device: 3, key: 96, down: false }), vec![("GamepadA".to_string(), false)]);
        assert_eq!(g.apply(PadEvent::Axis { device: 3, axis: 0, value: 0.0 }), vec![("GamepadLeftStickLeft".to_string(), false)]);
        assert_eq!(g.apply(PadEvent::Axis { device: 3, axis: 0, value: 0.0 }), vec![]);
        // Unplugging releases whatever the pad still held.
        let mut up = g.apply(PadEvent::Removed { device: 3 });
        up.sort();
        assert_eq!(up, vec![("GamepadDpadDown".to_string(), false), ("GamepadLeftStickUp".to_string(), false), ("GamepadR2".to_string(), false)]);
    }

    #[test]
    fn a_press_and_release_inside_one_frame_keeps_both_edges() {
        let mut g = pads();
        let mut out = g.apply(PadEvent::Button { device: 1, key: 100, down: true });
        out.extend(g.apply(PadEvent::Button { device: 1, key: 100, down: false }));
        assert_eq!(out, vec![("GamepadY".to_string(), true), ("GamepadY".to_string(), false)]);
    }

    #[test]
    fn small_stick_motion_stays_inside_the_deadzone() {
        let mut g = pads();
        assert_eq!(g.apply(PadEvent::Axis { device: 1, axis: 0, value: 0.3 }), vec![]);
        assert_eq!(g.apply(PadEvent::Axis { device: 1, axis: 11, value: 0.7 }), vec![("GamepadRightStickRight".to_string(), true)]);
    }

    #[test]
    fn unknown_keys_are_ignored_and_dpad_keys_map() {
        assert_eq!(android_button_name(4), None);
        assert_eq!(android_button_name(19), Some("DpadUp"));
        assert_eq!(android_button_name(108), Some("Start"));
        let mut g = pads();
        assert_eq!(g.apply(PadEvent::Button { device: 1, key: 4, down: true }), vec![]);
    }
}

/// Relative input also works through remote/synthetic cursors that supply no raw device events.
#[derive(Default)]
pub struct RelativeMouse {
    raw_seen: bool,
    anchor: Option<(f64,f64)>,
    pending: (f64,f64),
}
impl RelativeMouse {
    pub fn reset(&mut self) { *self=Self::default(); }
    pub fn raw(&mut self,x:f64,y:f64) {
        if !x.is_finite() || !y.is_finite() {return;}
        if !self.raw_seen {self.pending=(0.0,0.0);self.raw_seen=true;}
        self.pending.0+=x;self.pending.1+=y;
    }
    pub fn cursor(&mut self,x:f64,y:f64) {
        if !x.is_finite() || !y.is_finite() {return;}
        if let Some((a,b))=self.anchor {if !self.raw_seen {self.pending.0+=x-a;self.pending.1+=y-b;}}
        self.anchor=Some((x,y));
    }
    pub fn take(&mut self)->(f64,f64) {std::mem::take(&mut self.pending)}
}
#[cfg(test)]
mod relative_mouse_tests {
    use super::RelativeMouse;
    #[test]
    fn raw_events_override_cursor_fallback_without_double_counting() {
        let mut mouse=RelativeMouse::default();mouse.cursor(100.0,100.0);mouse.cursor(108.0,102.0);
        assert_eq!(mouse.take(),(8.0,2.0));assert_eq!(mouse.take(),(0.0,0.0));
        mouse.cursor(118.0,110.0);mouse.raw(3.0,4.0);mouse.cursor(130.0,120.0);
        assert_eq!(mouse.take(),(3.0,4.0));mouse.raw(2.0,-3.0);assert_eq!(mouse.take(),(2.0,-3.0));
        mouse.reset();mouse.cursor(500.0,500.0);assert_eq!(mouse.take(),(0.0,0.0));
    }
}
