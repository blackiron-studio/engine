# Bench

A stress scene for measuring the engine, not a game: a large autotiled tile map under a
panning camera, thousands of moving sprites, three particle emitters, lights and HD text.
The frame-rate pill shows total CPU time per frame.

Parameters come from `bench` in `kiln.json`, or on the web from the URL:
`?n=4000&p=2000&cols=200&rows=120` (sprites, particles per second per emitter, map size).
`?kernel=ts` runs the reference TypeScript kernel instead of the compiled one for comparison.

```bash
bun run dev          # http://localhost:4200
bun run ios          # simulator
```
