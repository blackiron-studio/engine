#!/usr/bin/env bun
// blackiron — the engine CLI.
//
//   blackiron dev        serve the project with rebuild-on-change
//   blackiron gallery    serve the demo and every starter behind one menu page
//   blackiron build      bundle to dist/
//   blackiron export web bundle for the web; --single-file inlines everything into one HTML
//   blackiron verify     render every project on a host and compare against golden images
//   blackiron atlas      bake every sprite headlessly to atlas.png + atlas.json
//   blackiron new <dir>  scaffold a project
//   blackiron test       run bun test

import { parseArgs } from "./args.ts";

const [, , command, ...rest] = process.argv;
const args = parseArgs(rest);

const usage = `Blackiron Engine
blackiron <command> [options]

  dev         [--port 4200] [--open]        Dev server with rebuild on change
  gallery     [dirs...] [--port 4200]       Serve the demo and every starter behind one menu
  build       [--report] [--target native]  Bundle into dist/ (native: one script + prebaked atlas)
  export web  [--single-file] [--out path]  Web build; single-file inlines JS into HTML
  export ios  [--out dir]                   Xcode project with the native host in dist/ios/
              [--version X.Y.Z] [--build-number N] [--bundle-id ID] [--team-id ID]
              [--signing external|automatic|unsigned]
                                            CLI overrides blackiron.json; external signing is the default without a team
  export desktop [--platform macos|windows|linux] [--out dir]
                                            App bundle or folder with the generic host in dist/desktop/
  export android [--out dir]                Gradle project with the generic host in dist/android/
  run ios     [--device "iPhone 17 Pro"]    Export, build for the simulator and launch
  run desktop [--fullscreen] [--size WxH] [--js v8|quickjs]
                                            Build the game and the host, open a window
  run android [--device serial]             Export, build the APK, install and launch
  verify      [--host desktop|ios|android|all] [--update] [--only name] [--tolerance 0.005] [--js quickjs|v8]
                                            Render every project's snapshots and compare with the goldens
  atlas       [--out dir] [--split]         Bake sprites headlessly to PNG + JSON
  art import <sheet.png> [--name prefix] [--out assets] [--cell WxH] [--pixel N] [--shrink 2]
                         [--anim walk=down:4,5;up:1;left:2,6;right:3,7] [--mirror attack] [--event attack:9=hit] [--hold hurt=0.4] [--hitbox 9=x,y,w,h]
  art parts <sheet.png> --frame N --name prefix [--template humanoid] --cut head=x,y,w,h ... [--anchor part=fx,fy]
  art tileset <tiles.png> --tile 16 --name ground [--terrain blob|edges|none] [--pixel N]   slice a tile sheet, check seams
  art check [assets]       lint imported sheets against the style bible
  art brief [--subject "..."] [--height 64] [--poses "..."]   a prompt for an artist or a generator
                                            Key, find, resample and palette-snap a generated sprite sheet
  new <dir>                                 Scaffold a new project
  migrate [dir] [--apply] [--engine path]    Preview or apply a backed-up source migration
  engine-lock [dir] [--update]              Verify or explicitly pin engine source
  test        [bun test args...]            Run the project's tests
`;

async function main(): Promise<void> {
  switch (command) {
    case "dev":
      return (await import("./commands/dev.ts")).dev(args);
    case "gallery":
      return (await import("./commands/gallery.ts")).gallery(args);
    case "build":
      return (await import("./commands/build.ts")).build(args);
    case "export": {
      const target = args._[0] ?? "web";
      if (target === "web") return (await import("./commands/export.ts")).exportWeb(args);
      if (target === "ios") return (await import("./commands/ios.ts")).exportIosCommand(args);
      if (target === "desktop") return (await import("./commands/desktop.ts")).exportDesktopCommand(args);
      if (target === "android") return (await import("./commands/android.ts")).exportAndroidCommand(args);
      throw new Error(`Unknown export target "${target}". Targets: web, ios, desktop, android.`);
    }
    case "run": {
      const target = args._[0] ?? "ios";
      if (target === "ios") return (await import("./commands/ios.ts")).runIos(args);
      if (target === "desktop") return (await import("./commands/desktop.ts")).runDesktop(args);
      if (target === "android") return (await import("./commands/android.ts")).runAndroid(args);
      throw new Error(`Unknown run target "${target}". Targets: ios, desktop, android.`);
    }
    case "verify":
      return (await import("./commands/verify.ts")).verify(args);
    case "atlas":
      return (await import("./commands/atlas.ts")).atlas(args);
    case "art":
      return (await import("./commands/art.ts")).art(args);
    case "new":
      return (await import("./commands/new.ts")).scaffold(args);
    case "migrate":
      return (await import("./commands/migrate.ts")).migrate(args);
    case "engine-lock":
      return (await import("./engine-lock.ts")).engineLock(args);
    case "test":
      return (await import("./commands/test.ts")).test(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(usage);
      return;
    default:
      console.error(`Unknown command "${command}"\n`);
      console.log(usage);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
