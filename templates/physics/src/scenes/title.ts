import { createStore } from "@kiln/engine/save";
import { Anchor, Button, Column, Label, RichText, Scene, TextInput, Tooltip } from "@kiln/engine/scene";
import { PlayScene } from "./play.ts";

export const saves = createStore<{ name: string; best: number }>({ key: "crate-yard", version: 1, initial: () => ({ name: "", best: 0 }) });

export class TitleScene extends Scene {
  override ready(): void {
    this.name = "title";
    this.background = 0x1a1c2c;
    const data = saves.load();
    // A self-centring column under a centred anchor: text, field and button line up on the
    // same axis whatever their widths, and the block stays centred as lines wrap.
    const center = this.ui.add(new Anchor({ x: "center", y: "center" }));
    const menu = center.add(new Column({ gap: 22, align: "center", origin: "center" }));
    menu.add(new RichText("[b][color=#ffc857]CRATE[/color] YARD[/b]", 0, 0, { font: { family: "Instrument Sans", size: 56, weight: 700 }, align: "center", shadow: 0x000000 }));
    menu.add(new RichText("Run, jump and drop [icon=crate] crates on the [icon=ball] balls.\nReach the [icon=star] star before the yard fills up.", 0, 0, { font: { family: "Instrument Sans", size: 20, weight: 500 }, align: "center", color: 0xcfcbe8, shadow: 0x000000 }));
    menu.add(new TextInput(0, 0, 320, 44, { value: data.name, placeholder: "Your name", maxLength: 16, onSubmit: () => this.start() }));
    const play = menu.add(new Button("PLAY", 0, 0, 320, 52, { onPress: () => this.start() }));
    this.ui.add(new Tooltip(play, "Enter also starts", { delay: 0.4 }));
    if (data.best > 0) menu.add(new Label(`Best: ${data.best} stars`, 0, 0, { align: "center", color: 0x9a96b8 }));
    this.app.audio.setMood("menu", { crossfade: 1 });
  }

  override onAction(name: string, pressed: boolean): void {
    if (pressed && name === "confirm") this.start();
  }

  private start(): void {
    const input = this.ui.findAll(TextInput)[0];
    const data = saves.load();
    data.name = input?.value.trim() ?? data.name;
    saves.save(data);
    this.app.audio.play("click");
    this.app.scenes.change(new PlayScene(data.name || "Player"), { transition: "wipe", duration: 0.7, color: 0x0a0912 });
  }
}
