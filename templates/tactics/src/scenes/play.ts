import { grid } from "@kiln/engine/core";
import { Anchor, Bar, Button, type DrawContext, Label, Node2D, Panel, ParticleEmitter, Scene, Sprite, TileMap } from "@kiln/engine/scene";
import { BUTTON, DISPLAY_SMALL, UI, UI_SMALL } from "../fonts.ts";
import {
  type AttackResult,
  GRID,
  type GameState,
  TERRAIN_SPRITE,
  TYPES,
  type Unit,
  allActed,
  attack,
  createGame,
  endTurn,
  enemyStep,
  moveUnit,
  reachable,
  select,
  targets,
  unitAt,
  unitById,
} from "../game.ts";
import { OverScene } from "./over.ts";

const T = GRID.tile;
/** Where the board sits on screen; the info panel takes the right side. */
const ORIGIN = { x: 56, y: 104 };
const PANEL_W = 400;

class UnitNode extends Node2D {
  readonly sprite: Sprite;
  readonly bar: Bar;
  constructor(readonly unit: Unit) {
    super();
    this.sprite = this.add(new Sprite(`${unit.kind}.${unit.team}`, T / 2, T - 1));
    this.bar = this.add(new Bar(4, T - 5, T - 8, 5));
    this.bar.fill = unit.team === 0 ? 0x7fd0ff : 0xff8a7a;
    this.bar.border = null;
  }
}

/** Draws move range, attack targets and the cursor under the units. */
class Highlights extends Node2D {
  reach = new Map<number, number>();
  targetCells: grid.Cell[] = [];
  selectedCell: grid.Cell | null = null;
  hover: grid.Cell | null = null;
  t = 0;

  override update(dt: number): void {
    this.t += dt;
  }

  override render(ctx: DrawContext): void {
    const pulse = 0.32 + Math.sin(this.t * 4) * 0.08;
    for (const k of this.reach.keys()) {
      const { x, y } = grid.unkey(k);
      ctx.rect(x * T + 2, y * T + 2, T - 4, T - 4, 0x7fd0ff, pulse);
    }
    for (const c of this.targetCells) ctx.rect(c.x * T + 2, c.y * T + 2, T - 4, T - 4, 0xff5a4a, pulse + 0.15);
    if (this.hover) ctx.frame(this.hover.x * T, this.hover.y * T, T, T, 0xffffff, 0.35, 2);
    if (this.selectedCell) ctx.sprite("cursor", this.selectedCell.x * T + T / 2, this.selectedCell.y * T + T / 2);
  }
}

export class PlayScene extends Scene {
  state!: GameState;
  private board!: Node2D;
  private highlights!: Highlights;
  private unitsLayer!: Node2D;
  private nodes = new Map<number, UnitNode>();
  private hits!: ParticleEmitter;
  private phaseLabel!: Label;
  private infoLabel!: Label;
  private endButton!: Button;
  private busy = 0;
  private enemyTimer = 0;
  private ending = false;

  constructor() {
    super();
    this.name = "play";
  }

  override ready(): void {
    const s = (this.state = createGame(Date.now()));
    this.camera.followRate = 0;
    this.camera.x = this.width / 2;
    this.camera.y = this.height / 2;
    this.background = 0x15121f;

    this.board = this.world.add(new Node2D(ORIGIN.x, ORIGIN.y));
    const tiles: Record<number, string> = {};
    TERRAIN_SPRITE.forEach((name, i) => (tiles[i] = name));
    this.board.add(new TileMap({ data: s.map, tileSize: T, tiles }));
    this.highlights = this.board.add(new Highlights());
    this.unitsLayer = this.board.add(new Node2D());
    this.unitsLayer.ySort = true;
    for (const u of s.units) this.addUnit(u);
    this.hits = this.board.add(new ParticleEmitter({ life: [0.2, 0.5], speed: [40, 120], gravity: 200, size: [2, 4], colors: [0xffffff, 0xff8a7a, 0xffe08a], alpha: [1, 0], additive: true }));
    this.hits.emitting = false;

    const panel = this.ui.add(new Anchor({ x: "right", y: "top", dy: ORIGIN.y, w: PANEL_W, safe: 56 }));
    const ph = GRID.rows * T;
    panel.add(new Panel(0, 0, PANEL_W, ph));
    this.phaseLabel = panel.add(new Label("", 20, 18, { font: UI, color: 0xffe08a, shadow: 0x000000 }));
    this.infoLabel = panel.add(new Label("", 20, 90, { font: UI_SMALL, color: 0xd9d6ec, shadow: 0x000000, wrap: PANEL_W - 40 }));
    this.endButton = panel.add(new Button("END TURN", 20, ph - 66, PANEL_W - 40, 46, { action: "endTurn", style: { font: BUTTON } }));
    const head = this.ui.add(new Anchor({ x: "left", y: "top", dx: ORIGIN.x, dy: 24 }));
    head.add(new Label("SKIRMISH", 0, 0, { font: DISPLAY_SMALL, color: 0xffe08a, shadow: 0x3a1c0a }));
    const foot = this.ui.add(new Anchor({ x: "left", y: "bottom", dx: ORIGIN.x, safe: 24 }));
    foot.add(new Label("Click a unit, then a tile to move or an enemy to attack. E ends the turn.", 0, 0, { font: UI_SMALL, color: 0xaaa6c8, shadow: 0x000000 }));
    this.refresh();
  }

  private addUnit(u: Unit): void {
    const n = this.unitsLayer.add(new UnitNode(u));
    n.setPosition(u.col * T, u.row * T);
    this.nodes.set(u.id, n);
  }

  private cellAt(sx: number, sy: number): grid.Cell | null {
    const [wx, wy] = this.screenToWorld(sx, sy);
    const c = Math.floor((wx - ORIGIN.x) / T);
    const r = Math.floor((wy - ORIGIN.y) / T);
    return c >= 0 && r >= 0 && c < GRID.cols && r < GRID.rows ? { x: c, y: r } : null;
  }

  private refresh(): void {
    const s = this.state;
    const sel = s.selected !== null ? unitById(s, s.selected) : undefined;
    this.highlights.reach = sel && s.phase === "player" && !sel.acted ? reachable(s, sel) : new Map();
    this.highlights.reach.delete(sel ? grid.key(sel.col, sel.row) : -1);
    this.highlights.targetCells = sel && s.phase === "player" ? targets(s, sel).map((u) => ({ x: u.col, y: u.row })) : [];
    this.highlights.selectedCell = sel ? { x: sel.col, y: sel.row } : null;
    this.phaseLabel.text = s.phase === "player" ? `ROUND ${s.round}\nYOUR TURN` : s.phase === "enemy" ? `ROUND ${s.round}\nENEMY TURN` : "BATTLE OVER";
    if (sel) {
      const t = TYPES[sel.kind];
      this.infoLabel.text = `${t.name}\nHP ${sel.hp} / ${t.hp}\nATK ${t.atk}   MOVE ${t.move}\nRANGE ${t.rangeMin}–${t.rangeMax}\n\n${sel.acted ? "Done for this round" : sel.moved ? "Moved. Can still attack." : "Ready"}`;
    } else this.infoLabel.text = "Select a unit.\n\nBlue tiles show where it can move, red marks who it can hit. Forest gives cover, water and rock block.";
    this.endButton.disabled = s.phase !== "player" || this.busy > 0;
    for (const [id, n] of this.nodes) {
      const u = unitById(s, id);
      if (!u) continue;
      n.bar.value = u.hp / TYPES[u.kind].hp;
      n.sprite.alpha = u.acted && s.phase === "player" && u.team === 0 ? 0.55 : 1;
    }
  }

  override onPointerMove(x: number, y: number): void {
    this.highlights.hover = this.cellAt(x, y);
  }

  override onPointerDown(x: number, y: number): void {
    const s = this.state;
    if (s.phase !== "player" || this.busy > 0) return;
    const cell = this.cellAt(x, y);
    if (!cell) return;
    const clicked = unitAt(s, cell.x, cell.y);
    const sel = s.selected !== null ? unitById(s, s.selected) : undefined;
    if (sel && clicked && clicked.team !== sel.team && targets(s, sel).some((t) => t.id === clicked.id)) {
      const result = attack(s, sel.id, clicked.id);
      if (result) this.animateAttack(result);
      select(s, null);
    } else if (clicked && clicked.team === 0) {
      select(s, clicked.acted ? null : clicked.id);
    } else if (sel && !sel.moved && reachable(s, sel).has(grid.key(cell.x, cell.y))) {
      const path = moveUnit(s, sel.id, cell.x, cell.y);
      if (path) this.animateMove(sel.id, path);
      if (targets(s, sel).length === 0) {
        sel.acted = true;
        select(s, null);
      }
    } else select(s, null);
    this.refresh();
    if (s.phase === "player" && allActed(s, 0)) this.tweens.after(0.3, () => this.doEndTurn());
  }

  private animateMove(id: number, path: grid.Cell[]): void {
    const n = this.nodes.get(id);
    if (!n) return;
    this.busy++;
    path.forEach((c, i) => {
      this.tweens.to(n, { x: c.x * T, y: c.y * T }, 0.09, { delay: i * 0.09, ease: "linear", onDone: i === path.length - 1 ? () => this.done() : undefined });
    });
    if (path.length === 0) this.done();
  }

  private animateAttack(r: AttackResult): void {
    const a = this.nodes.get(r.attackerId);
    const t = this.nodes.get(r.targetId);
    if (!a || !t) return;
    this.busy++;
    const dx = Math.sign(t.x - a.x) * 8;
    const dy = Math.sign(t.y - a.y) * 8;
    const ax = a.x;
    const ay = a.y;
    this.tweens.to(a, { x: ax + dx, y: ay + dy }, 0.08, {
      onDone: () => {
        this.tweens.to(a, { x: ax, y: ay }, 0.1);
        this.hits.burst(12, t.x + T / 2, t.y + T / 2);
        this.camera.shake(3, 0.15);
        if (r.killed) {
          this.tweens.to(t.sprite, { alpha: 0 }, 0.3, {
            onDone: () => {
              t.destroy();
              this.nodes.delete(r.targetId);
              this.done();
            },
          });
        } else this.done();
      },
    });
  }

  private done(): void {
    this.busy = Math.max(0, this.busy - 1);
    this.refresh();
    if (this.state.phase === "over" && !this.ending) {
      this.ending = true;
      this.tweens.after(0.8, () => this.app.scenes.change(new OverScene(this.state.winner === 0, this.state.round)));
    }
  }

  private doEndTurn(): void {
    if (this.state.phase !== "player") return;
    endTurn(this.state);
    this.enemyTimer = 0.5;
    this.refresh();
  }

  override onAction(name: string, pressed: boolean): void {
    if (pressed && name === "endTurn" && this.busy === 0) this.doEndTurn();
  }

  override update(dt: number): void {
    if (this.state.phase !== "enemy" || this.busy > 0) return;
    this.enemyTimer -= dt;
    if (this.enemyTimer > 0) return;
    this.enemyTimer = 0.45;
    const action = enemyStep(this.state);
    if (action) {
      this.animateMove(action.unitId, action.path);
      if (action.attack) {
        const r = action.attack;
        this.tweens.after(action.path.length * 0.09 + 0.05, () => this.animateAttack(r));
      }
    }
    this.refresh();
  }
}
