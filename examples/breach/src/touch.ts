// The phone and tablet face of Signal Breach: the same HUD, title and menus laid out in the grown
// `ui` layer (`ui.minPoints` / `ui.tabletPoints`), with text of 11 points or more, 44-point tap
// targets and on-screen controls. Laptops and desktops never come here; they keep the 1280 × 720
// layout in main.ts.

import type { DrawContext } from "@blackiron-studio/engine/scene";
import type { BreachScene } from "./main.ts";
import { P } from "./presentation.ts";
import { RELAYS } from "./level.ts";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export const inBox = (b: Box, p: { x: number; y: number }): boolean => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

/** Every box of the touch layout, in `ui` units, for this screen. Drawing and tapping share it. */
export function touchLayout(g: BreachScene) {
  const W = g.uiWidth,
    H = g.uiHeight,
    [it, ir, ib, il] = g.uiInsets,
    info = g.screenInfo,
    // Points one `ui` unit shows at.
    u = Math.max(0.1, info.pointsPerUnit * info.uiScale),
    /** Smallest text, in units: 11 points or more. */
    F = Math.max(14, Math.ceil(11 / u)),
    /** Smallest tap target, in units: 44 points or more. */
    T = Math.max(56, Math.ceil(44 / u)),
    S = Math.max(72, T),
    L = il + 12,
    R = W - ir - 12,
    top = it + 10,
    B = H - ib - 10,
    cx = W / 2,
    safeH = H - it - ib;
  // Play.
  const pause: Box = { x: R - T, y: top, w: T, h: T },
    fire: Box = { x: R - 92, y: B - 92, w: 92, h: 92 },
    jump: Box = { x: fire.x - 8 - S, y: B - S, w: S, h: S },
    reload: Box = { x: R - S, y: fire.y - 8 - S, w: S, h: S },
    swap: Box = { x: reload.x - 8 - S, y: reload.y, w: S, h: S },
    integrity: Box = { x: cx - 5 - 176, y: B - 54, w: 176, h: 54 },
    ammo: Box = { x: cx + 5, y: B - 54, w: 176, h: 54 },
    use: Box = { x: cx - 190, y: integrity.y - 10 - T, w: 380, h: T },
    status: Box = { x: L, y: top, w: 196, h: 48 },
    response: Box = { x: pause.x - 8 - 200, y: top, w: 200, h: 48 },
    map: Box = { x: R - 116, y: top + T + 8, w: 116, h: 104 },
    notice: Box = { x: cx - 220, y: top + T + 10, w: 440, h: 36 };
  // Title.
  const cardH = Math.min(safeH - 24, 480),
    card: Box = { x: L + 4, y: it + (safeH - cardH) / 2, w: 380, h: cardH },
    titleSettings: Box = { x: card.x + 24, y: card.y + card.h - 18 - T, w: card.w - 48, h: T },
    start: Box = { x: card.x + 24, y: titleSettings.y - 10 - T, w: card.w - 48, h: T };
  // Pause, won and lost.
  const mw = Math.min(420, W - 32),
    mh = 140 + (g.state.phase === "paused" ? 3 : 2) * T + 16,
    modal: Box = { x: cx - mw / 2, y: it + (safeH - mh) / 2, w: mw, h: mh },
    row = (i: number): Box => ({ x: modal.x + 24, y: modal.y + 124 + i * (T + 8), w: mw - 48, h: T });
  // Settings.
  const sw = Math.min(460, W - 32),
    sh = 52 + 5 * (T + 8) + 8,
    panel: Box = { x: cx - sw / 2, y: it + (safeH - sh) / 2, w: sw, h: sh },
    line = (i: number): Box => ({ x: panel.x + 16, y: panel.y + 52 + i * (T + 8), w: sw - 32, h: T });
  return {
    W, H, F, T, L, R, top, B, cx,
    pause, fire, jump, reload, swap, integrity, ammo, use, status, response, map, notice,
    card, start, titleSettings,
    modal, resume: row(0), pauseSettings: row(1), restart: row(2), again: row(1),
    panel,
    sensitivity: line(0),
    less: { x: panel.x + 16, y: line(0).y, w: T, h: T } as Box,
    more: { x: panel.x + sw - 16 - T, y: line(0).y, w: T, h: T } as Box,
    invert: line(1), fov: line(2), sound: line(3), back: line(4),
  };
}
export type TouchLayout = ReturnType<typeof touchLayout>;

/** Draw the whole touch UI for the scene's current phase, and report its tap targets. */
export function renderTouchHud(ctx: DrawContext, g: BreachScene): void {
  const s = g.state,
    w = g.weapons[g.weaponIndex],
    l = touchLayout(g),
    { W, H, F, R, top, B, cx } = l,
    blink = Math.sin(g.app.time * 5) > 0;
  const text = (value: string, x: number, y: number, size = F, color = 0xe5ebdf, align: "left" | "center" | "right" = "left", weight = 600, alpha = 1) =>
    ctx.text(value, x, y, { font: { family: "Arial", size: Math.max(F, size), weight }, color, align, shadow: null, alpha });
  /** Text centred in a box, both ways. */
  const label = (value: string, b: Box, size = F, color = 0xe5ebdf, weight = 700, alpha = 1) =>
    text(value, b.x + b.w / 2, b.y + (b.h - Math.max(F, size)) / 2 - 1, size, color, "center", weight, alpha);
  const panel = (b: Box, accent: number = P.cyan, alpha = 0.78) => {
    ctx.rect(b.x, b.y, b.w, b.h, P.black, alpha);
    ctx.rect(b.x, b.y, b.w, Math.min(18, b.h / 3), 0x1d2a35, 0.35);
    ctx.frame(b.x, b.y, b.w, b.h, 0x8fa6b3, 0.16);
    const c = 9;
    ctx.rect(b.x - 1, b.y - 1, c, 2, accent);
    ctx.rect(b.x - 1, b.y - 1, 2, c, accent);
    ctx.rect(b.x + b.w - c + 1, b.y + b.h - 1, c, 2, accent);
    ctx.rect(b.x + b.w - 1, b.y + b.h - c + 1, 2, c, accent);
  };
  /** A menu button: filled cyan (the main choice) or dark. */
  const button = (name: string, value: string, b: Box, accent = true) => {
    if (accent) {
      ctx.rect(b.x - 3, b.y - 3, b.w + 6, b.h + 6, P.cyan, 0.12, true);
      ctx.rect(b.x, b.y, b.w, b.h, P.cyan, 0.97);
      ctx.rect(b.x, b.y + b.h - 4, b.w, 4, 0x2fb9a4, 1);
    } else {
      ctx.rect(b.x, b.y, b.w, b.h, P.dark, 0.96);
      ctx.frame(b.x, b.y, b.w, b.h, P.steel, 0.4);
    }
    label(value, b, 16, accent ? P.black : P.chalk);
    g.reportTarget(name, b.x, b.y, b.w, b.h);
  };
  /** An on-screen control over the 3D view. */
  const control = (name: string, value: string, b: Box, accent: number = P.cyan, held = false) => {
    ctx.rect(b.x, b.y, b.w, b.h, held ? accent : P.black, held ? 0.4 : 0.5);
    ctx.frame(b.x, b.y, b.w, b.h, accent, held ? 0.95 : 0.55);
    const c = 9;
    ctx.rect(b.x - 1, b.y - 1, c, 2, accent);
    ctx.rect(b.x - 1, b.y - 1, 2, c, accent);
    ctx.rect(b.x + b.w - c + 1, b.y + b.h - 1, c, 2, accent);
    ctx.rect(b.x + b.w - 1, b.y + b.h - c + 1, 2, c, accent);
    if (value) label(value, b, F, held ? 0xffffff : P.chalk);
    g.reportTarget(name, b.x, b.y, b.w, b.h);
  };

  if (s.phase === "title") {
    const c = l.card,
      x0 = c.x + 24;
    for (let k = 0; k < 8; k++) ctx.rect(0, 0, ((520 + k * 40) * W) / 1280, H, P.black, 0.07);
    ctx.rect(c.x, c.y, c.w, c.h, P.black, 0.86);
    ctx.rect(c.x, c.y, c.w, 96, 0x15212b, 0.5);
    ctx.frame(c.x, c.y, c.w, c.h, 0x8fa6b3, 0.18);
    ctx.rect(c.x, c.y, 4, c.h, P.cyan);
    ctx.rect(c.x + 4, c.y, 10, c.h, P.cyan, 0.08, true);
    ctx.rect(x0, c.y + 25, 28, 4, P.cyan);
    text("RELAY 07   /   OFFSHORE ARRAY", x0 + 40, c.y + 19, F, P.cyan);
    text("SIGNAL", x0 - 2, c.y + 46, 64, 0x000000, "left", 800, 0.5);
    text("SIGNAL", x0 - 4, c.y + 44, 64, 0xf3efe2, "left", 800);
    text("BREACH", x0 - 2, c.y + 104, 64, 0x000000, "left", 800, 0.5);
    text("BREACH", x0 - 4, c.y + 102, 64, 0xf3efe2, "left", 800);
    ctx.rect(x0, c.y + 176, 64, 3, P.orange);
    ctx.rect(x0 + 68, c.y + 176, 18, 3, P.orange, 0.5);
    ctx.rect(x0 + 90, c.y + 176, 6, 3, P.orange, 0.3);
    text("THE STATION IS NO LONGER OURS.", x0, c.y + 190, F, P.orange);
    text("Cut through security. Reboot three relays.", x0, c.y + 216, 15, 0xb9c8cc, "left", 400);
    text("Two weapons. Three response waves.", x0, c.y + 237, 15, 0xb9c8cc, "left", 400);
    text("One way to bring the signal back.", x0, c.y + 258, 15, 0xb9c8cc, "left", 400);
    if (!g.settingsOpen) {
      button("Enter the station", "ENTER THE STATION   →", l.start);
      button("Control settings", "CONTROL SETTINGS", l.titleSettings, false);
    }
    // Right column: status chips over the scene.
    panel({ x: R - 270, y: top, w: 270, h: 34 }, P.red, 0.7);
    ctx.rect(R - 256, top + 13, 8, 8, P.red, blink ? 1 : 0.3);
    text("SECURITY OVERRIDE REQUIRED", R - 12, top + 9, F, P.chalk, "right");
    text("STORM ADVISORY  ·  WIND 41 KN  ·  SEA STATE 6", R - 6, top + 46, F, P.steel, "right");
    text("07", R - 3, B - 115, 84, 0x000000, "right", 800, 0.45);
    text("07", R - 6, B - 118, 84, P.chalk, "right", 800, 0.92);
    ctx.rect(R - 128, B - 30, 122, 2, P.cyan);
    text("THE RELAY STATION", R - 6, B - 20, F, P.chalk, "right");
  } else {
    // Relays brought back.
    const st = l.status;
    panel(st);
    ctx.rect(st.x, st.y, 3, st.h, P.cyan);
    text(`${s.completed} / 3 RELAYS`, st.x + 14, st.y + 16, F, P.cyan, "left", 700);
    for (let i = 0; i < 3; i++) {
      const x = st.x + st.w - 14 - (3 - i) * 20 + 6;
      if (s.relays[i]) ctx.rect(x - 2, st.y + 12, 18, 24, P.cyan, 0.25, true);
      ctx.rect(x, st.y + 14, 14, 20, s.relays[i] ? P.cyan : P.steel, s.relays[i] ? 1 : 0.3);
    }
    // Compass strip.
    const heading = ((((g.look.yaw * 180) / Math.PI) % 360) + 360) % 360;
    ctx.rect(cx - 120, top, 240, 30, P.black, 0.55);
    ctx.rect(cx - 120, top + 30, 240, 1, P.steel, 0.35);
    for (let d = -165; d <= 180; d += 15) {
      const deg = Math.round(heading / 15) * 15 + d,
        x = cx + (deg - heading) * 1.3;
      if (x < cx - 112 || x > cx + 112) continue;
      const n = ((deg % 360) + 360) % 360,
        card = n % 90 === 0,
        fade = 1 - Math.abs(x - cx) / 125;
      ctx.rect(x, card ? top + 20 : top + 23, 1, card ? 10 : 7, P.chalk, 0.6 * fade);
      if (card) text(["N", "E", "S", "W"][n / 90], x, top + 2, F, n === 0 ? P.orange : P.chalk, "center", 700, fade);
    }
    ctx.rect(cx - 1, top + 30, 2, 6, P.cyan);
    text(`${Math.round(heading).toString().padStart(3, "0")}°`, cx, top + 38, F, P.cyan, "center");
    // Response wave, clock and contacts.
    const rp = l.response;
    panel(rp);
    text(`RESPONSE ${Math.min(3, s.wave + 1)} / 3`, rp.x + 12, rp.y + 7, F, P.chalk, "left", 700);
    text(`${String(Math.floor(s.time / 60)).padStart(2, "0")}:${String(Math.floor(s.time % 60)).padStart(2, "0")}`, rp.x + rp.w - 12, rp.y + 6, F + 2, P.cyan, "right", 700);
    text(`${g.enemies.filter((e) => e.health > 0).length} HOSTILES  /  ${s.kills} DOWN`, rp.x + 12, rp.y + 27, F, P.steel);
    // Relay scan: relays, contacts and the player.
    const m = l.map,
      mx = m.x + m.w / 2,
      my = m.y + m.h / 2 + 4.8,
      kx = 2,
      kz = 1.6;
    panel(m, P.cyan, 0.7);
    ctx.frame(m.x + 6, m.y + 5, m.w - 12, m.h - 10, P.steel, 0.25);
    ctx.rect(mx - 13 * kx, m.y + 5, 1, m.h - 10, P.steel, 0.15);
    ctx.rect(mx + 13 * kx, m.y + 5, 1, m.h - 10, P.steel, 0.15);
    for (let i = 0; i < 3; i++) {
      const p = RELAYS[i];
      ctx.rect(mx + p.x * kx - 3, my + p.z * kz - 3, 6, 6, s.relays[i] ? P.cyan : P.amber);
      ctx.rect(mx + p.x * kx - 5, my + p.z * kz - 5, 10, 10, s.relays[i] ? P.cyan : P.amber, 0.25, true);
    }
    for (const e of g.enemies)
      if (e.health > 0) {
        ctx.rect(mx + e.position.x * kx - 2, my + e.position.z * kz - 2, 4, 4, P.red);
        ctx.rect(mx + e.position.x * kx - 4, my + e.position.z * kz - 4, 8, 8, P.red, blink ? 0.3 : 0.1, true);
      }
    ctx.rect(mx + g.player.position.x * kx - 3, my + g.player.position.z * kz - 3, 6, 6, 0xffffff);
    // Crosshair.
    const gap = 5 + g.recoil * 40,
      color = s.hitMarker > 0 ? P.orange : P.cyan,
      cy = H / 2;
    ctx.rect(cx - gap - 9, cy - 2, 9, 4, P.black, 0.35);
    ctx.rect(cx + gap, cy - 2, 9, 4, P.black, 0.35);
    ctx.rect(cx - gap - 8, cy - 1, 7, 2, color);
    ctx.rect(cx + gap + 1, cy - 1, 7, 2, color);
    ctx.rect(cx - 1, cy - gap - 8, 2, 7, color);
    ctx.rect(cx - 1, cy + gap + 1, 2, 7, color);
    ctx.rect(cx - 1, cy - 1, 2, 2, 0xffffff);
    if (s.hitMarker > 0)
      for (const [x, y] of [
        [-12, -12],
        [9, 9],
        [-12, 9],
        [9, -12],
      ])
        ctx.rect(cx + x, cy + y, 4, 4, P.orange);
    // Integrity.
    const low = s.health < 30,
      hp = l.integrity,
      tone = low ? P.red : P.cyan;
    panel(hp, tone);
    ctx.rect(hp.x, hp.y, 3, hp.h, tone);
    text("INTEGRITY", hp.x + 13, hp.y + 6, F, P.steel, "left", 700);
    text(String(Math.ceil(s.health)).padStart(3, "0"), hp.x + 13, hp.y + 24, 23, low ? P.red : P.chalk, "left", 700);
    for (let i = 0; i < 10; i++) {
      const on = s.health > i * 10;
      ctx.rect(hp.x + 62 + i * 11, hp.y + 31, 8, 12, on ? tone : P.steel, on ? 1 : 0.18);
      if (on) ctx.rect(hp.x + 62 + i * 11, hp.y + 31, 8, 3, 0xffffff, 0.25);
    }
    if (low && blink) ctx.rect(hp.x + 62, hp.y + 47, 107, 2, P.red, 0.8);
    // Weapon and ammunition.
    const am = l.ammo,
      loading = w.reloadRemaining > 0;
    panel(am, P.orange);
    ctx.rect(am.x + am.w - 3, am.y, 3, am.h, P.orange);
    text(loading ? "RELOADING…" : g.weaponIndex === 0 ? "PULSE RIFLE" : "SCATTERGUN", am.x + 13, am.y + 6, F, loading ? P.orange : P.chalk, "left", 700);
    text(String(w.ammo).padStart(2, "0"), am.x + 13, am.y + 24, 23, w.ammo <= w.definition.magazine * 0.25 ? P.orange : P.chalk, "left", 700);
    text(`/ ${w.reserve}`, am.x + 48, am.y + 31, F, P.steel);
    for (let i = 0; i < 2; i++) ctx.rect(am.x + 106 + i * 32, am.y + 38, 26, 3, i === g.weaponIndex ? P.cyan : P.steel, i === g.weaponIndex ? 1 : 0.3);
    if (loading) ctx.rect(am.x + 13, am.y + am.h - 4, (am.w - 29) * (1 - w.reloadRemaining / w.definition.reloadSeconds), 2, P.orange);
    if (s.phase === "playing") {
      // The relay prompt is the button that reboots it.
      if (g.nearestRelay >= 0) {
        const locked = g.enemies.some((e) => e.health > 0),
          tint = locked ? P.red : P.amber;
        panel(l.use, tint, 0.88);
        label(locked ? "RELAY LOCKED  /  CLEAR SECURITY FIRST" : "TAP TO REBOOT RELAY  /  +30 INTEGRITY", l.use, F, tint);
        g.reportTarget("Reboot relay", l.use.x, l.use.y, l.use.w, l.use.h);
      }
      control("Fire", "FIRE", l.fire, P.orange, g.touchFiring);
      control("Jump", "JUMP", l.jump);
      control("Reload", "RELOAD", l.reload);
      control("Swap weapon", "SWAP", l.swap);
      const p = l.pause;
      control("Pause", "", p);
      ctx.rect(p.x + p.w / 2 - 9, p.y + p.h / 2 - 10, 6, 20, P.chalk, 0.9);
      ctx.rect(p.x + p.w / 2 + 3, p.y + p.h / 2 - 10, 6, 20, P.chalk, 0.9);
    }
    if (s.noticeTime > 0) {
      const a = Math.min(1, s.noticeTime * 3),
        n = l.notice;
      ctx.rect(n.x, n.y, n.w, n.h, P.black, 0.78 * a);
      ctx.rect(n.x, n.y, n.w, 1, P.cyan, 0.6 * a);
      ctx.rect(n.x, n.y + n.h - 1, n.w, 1, P.cyan, 0.6 * a);
      ctx.rect(n.x, n.y, 3, n.h, P.cyan, a);
      ctx.rect(n.x + n.w - 3, n.y, 3, n.h, P.cyan, a);
      label(s.notice, n, F, P.cyan, 700, a);
    }
    if (s.damageFlash > 0) {
      const a = s.damageFlash * 2;
      for (let k = 0; k < 4; k++) {
        const t = 8 + k * 14,
          al = a * (0.5 - k * 0.11);
        ctx.rect(0, 0, W, t, P.red, al);
        ctx.rect(0, H - t, W, t, P.red, al);
        ctx.rect(0, 0, t, H, P.red, al);
        ctx.rect(W - t, 0, t, H, P.red, al);
      }
    }
  }
  if ((s.phase === "paused" || s.phase === "won" || s.phase === "lost") && !g.settingsOpen) {
    const m = l.modal,
      accent = s.phase === "lost" ? P.orange : P.cyan;
    ctx.rect(0, 0, W, H, P.black, 0.62);
    ctx.rect(m.x, m.y, m.w, m.h, P.black, 0.95);
    ctx.rect(m.x, m.y, m.w, 80, 0x15212b, 0.6);
    ctx.frame(m.x, m.y, m.w, m.h, 0x8fa6b3, 0.2);
    ctx.rect(m.x, m.y, m.w, 3, accent);
    ctx.rect(m.x, m.y + 3, m.w, 8, accent, 0.08, true);
    text("RELAY 07 / OPERATOR STATUS", cx, m.y + 16, F, P.steel, "center");
    text(s.phase === "paused" ? "SIGNAL HELD" : s.phase === "won" ? "SIGNAL RESTORED" : "SIGNAL LOST", cx, m.y + 38, 32, s.phase === "lost" ? P.orange : P.chalk, "center", 800);
    ctx.rect(cx - 30, m.y + 80, 60, 2, accent);
    text(
      s.phase === "paused" ? "The station will wait." : s.phase === "won" ? "All three relays are back on the network." : "Security overwhelmed the uplink. Try another route.",
      cx,
      m.y + 92,
      F,
      0xa9b8bf,
      "center",
      400,
    );
    if (s.phase === "paused") {
      button("Resume", "RESUME OPERATION", l.resume);
      button("Control settings", "CONTROL SETTINGS", l.pauseSettings, false);
      button("Restart", "RESTART STATION", l.restart, false);
    } else {
      label(`${s.kills} CONTACTS   /   ${Math.floor(s.time)} SECONDS   /   ${s.completed} RELAYS`, l.resume, F, P.cyan);
      button("Deploy again", "DEPLOY AGAIN   →", l.again);
    }
  }
  if (g.settingsOpen) {
    const p = l.panel;
    ctx.rect(0, 0, W, H, P.black, 0.88);
    ctx.rect(p.x, p.y, p.w, p.h, P.dark, 0.98);
    ctx.frame(p.x, p.y, p.w, p.h, 0x8fa6b3, 0.2);
    ctx.rect(p.x, p.y, p.w, 3, P.cyan);
    text("OPERATOR CONTROLS", cx, p.y + 16, 22, P.chalk, "center", 700);
    ctx.rect(l.sensitivity.x, l.sensitivity.y, l.sensitivity.w, l.sensitivity.h, P.black, 0.35);
    label(`LOOK SENSITIVITY  ${(g.look.sensitivity * 1000).toFixed(1)}`, l.sensitivity, 15, P.cyan, 600);
    button("Less sensitive", "−", l.less, false);
    button("More sensitive", "+", l.more, false);
    button("Invert look", `INVERT VERTICAL LOOK    ${g.look.invertY ? "ON" : "OFF"}`, l.invert, false);
    button("Field of view", `FIELD OF VIEW    ${g.settings.fov}°`, l.fov, false);
    button("Sound", `SOUND    ${g.settings.muted ? "OFF" : "ON"}`, l.sound, false);
    button("Back", "BACK", l.back);
  }
  if (g.message) text(g.message, cx, s.phase === "title" ? B - 2 - F : l.notice.y + l.notice.h + 8, F, P.orange, "center");
}
