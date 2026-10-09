// The shell: settings, save slots, tutorial hints and menus. Every piece is optional and
// data-first: stores and hint specs underneath, thin scenes on top that a game composes.

export { Settings, createSettings, defaultSettings, type SettingsData, type SettingsOptions } from "./settings.ts";
export { SaveSlots, createSaveSlots, type SaveSlotsOptions, type SlotInfo } from "./saves.ts";
export { Hints, HintLayer, glyphFor, keyName, type HintSpec, type HintLayerOptions } from "./hints.ts";
export {
  MenuScene, TitleScene, PauseScene, ConfirmScene, SettingsScene, ControlsScene, SaveSlotsScene, bindShellActions, SHELL_BINDINGS,
  type MenuEntry, type MenuOptions, type PauseOptions, type ConfirmOptions, type SettingsSceneOptions, type ControlsSceneOptions, type SaveSlotsSceneOptions,
} from "./menus.ts";
