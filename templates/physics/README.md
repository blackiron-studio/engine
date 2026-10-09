# Crate Yard (physics starter)

A small physics playground: a character who runs and jumps through a yard of crates and
balls, a goal zone, and a menu that shows the newer UI. It exercises:

- `physics` in `blackiron.json`, `StaticBody2D`, `RigidBody2D`, `CharacterBody2D`, `Area2D`, joints and raycasts
- `AnimationPlayer` squash-and-stretch and a `StateMachine` for the hero
- `RichText`, `TextInput`, `ScrollContainer`, `Grid`, `Tooltip`, the theme, and scene transitions
- positional sound and a music crossfade

Controls: arrows or A/D to run, Space or W to jump, click or tap to drop a crate, R to reset.

Where to change things: `src/art.ts` paints the sprites; `src/scenes/play.ts` owns the yard;
`src/scenes/title.ts` is the menu with the name field.
