# Blank

One scene, one sprite, arrow keys. The smallest possible Kiln project, for when you already know what you are building.

```bash
bun run dev        # http://localhost:4200, rebuilds on change
bun run build      # dist/
bun run export     # one self-contained HTML file in dist/
bun run atlas      # atlas/atlas.png + atlas.json from src/art.ts
bun test
```

- `kiln.json` declares the viewport, renderer and post-effect defaults.
- `src/art.ts` paints sprites in code and nothing else, so the atlas can bake headlessly.
- `src/main.ts` creates the App and the first scene.
