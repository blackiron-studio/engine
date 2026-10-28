# Wisp Hollow

A 2D lantern adventure through a moonlit grove. Gather embers, evade wisps and keep the light alive.

Run `bun run dev` here, or `bun run gallery` from the engine. WASD/arrows, gamepad or touch move the lantern keeper. Hold the pointer to walk. Escape pauses, M toggles sound, and K cycles the vector keeper, rig, imported sheet and painted hero for comparison.

The example preserves the original rules, endless scoring and saved best score. Every visual is high-resolution procedural illustration painted in code at boot (src/art.ts): a seamless painted ground, a soft-stamped trail, volumetric tree crowns with rim light and canopy shadows, undergrowth, glowing mushrooms, the moon shrine with emissive runes, the hooded keeper and a vector HUD. Lights, emissive sprites, fog banks, moonbeams, fireflies and a colour grade set the mood. Canopies fade when the keeper walks behind them; the ember compass points toward the nearest collectible. Pause freezes the world and scene clock while its UI remains usable.
