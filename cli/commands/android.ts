import { stageExport } from "../export-transaction.ts";
import { exportDirectory, requireTarget, xmlText } from "../export-support.ts";
// Android export through the generic host: a Gradle project with the host as a shared
// library behind GameActivity, the game as assets, and an icon. `run android` builds the
// APK and launches it on the connected device or emulator.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Args } from "../args.ts";
import { pascal, renderIcon } from "../icon.ts";
import { encodePNG } from "../png.ts";
import { type Project, loadProject, slug } from "../project.ts";
import { buildNative } from "./build.ts";
import { HOST_DIR, sh } from "./desktop.ts";

const GRADLE_VERSION = "8.11.1";
const AGP_VERSION = "8.9.1";
const GAMES_ACTIVITY_VERSION = "3.0.5";

function sdkDir(): string {
  const env = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (env) return env;
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Android", "sdk");
  if (process.platform === "win32")
    return join(process.env.LOCALAPPDATA ?? homedir(), "Android", "Sdk");
  return join(homedir(), "Android", "Sdk");
}

/** A usable JDK: JAVA_HOME when it is real, else the platform's default (Java 17 on macOS). */
function javaHome(): string | undefined {
  const current = process.env.JAVA_HOME;
  if (current && existsSync(join(current, "bin", "java"))) return current;
  if (process.platform === "darwin") {
    for (const version of ["17", "21", ""]) {
      const p = Bun.spawnSync(
        ["/usr/libexec/java_home", ...(version ? ["-v", version] : [])],
        { stdout: "pipe", stderr: "pipe" },
      );
      const home = new TextDecoder().decode(p.stdout).trim();
      if (p.exitCode === 0 && home && existsSync(join(home, "bin", "java")))
        return home;
    }
  }
  return undefined;
}

export function ndkDir(sdk: string): string {
  const usable = (dir: string) => {
    const prebuilts = join(dir, "toolchains", "llvm", "prebuilt");
    return (
      existsSync(join(dir, "source.properties")) &&
      existsSync(prebuilts) &&
      readdirSync(prebuilts).some((host) =>
        existsSync(
          join(
            prebuilts,
            host,
            "bin",
            process.platform === "win32" ? "clang.exe" : "clang",
          ),
        ),
      )
    );
  };
  if (process.env.ANDROID_NDK_HOME) {
    if (usable(process.env.ANDROID_NDK_HOME))
      return process.env.ANDROID_NDK_HOME;
    throw new Error(
      "ANDROID_NDK_HOME points to an incomplete NDK; install NDK 27.2.12479018 with Android Studio SDK Manager.",
    );
  }
  const root = join(sdk, "ndk");
  const versions = existsSync(root)
    ? readdirSync(root)
        .filter((version) => usable(join(root, version)))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    : [];
  if (versions.length === 0)
    throw new Error(
      `No complete Android NDK (metadata and clang required) under ${root}; install one with sdkmanager "ndk;27.2.12479018"`,
    );
  return join(root, versions[versions.length - 1]);
}

export interface AndroidExport {
  dir: string;
  applicationId: string;
}

export async function exportAndroid(
  project: Project,
  opts: { out?: string } = {},
): Promise<AndroidExport> {
  requireTarget(project, "android");
  const dir = exportDirectory(
    project,
    opts.out ?? `dist/android/${pascal(project.config.name) || "Game"}`,
  );
  let staged = "";
  const result = await stageExport(project, dir, async (stage) => {
    staged = stage;
    return buildAndroidExport(project, { ...opts, out: stage });
  });
  console.log(`  export ready: ${dir}`);
  return { ...result, dir };
}

async function buildAndroidExport(
  project: Project,
  opts: { out?: string } = {},
): Promise<AndroidExport> {
  requireTarget(project, "android");
  const sdk = sdkDir();
  const ndk = ndkDir(sdk);
  const name = pascal(project.config.name) || "Game";
  const applicationId =
    project.config.android?.applicationId ??
    project.config.ios?.bundleId ??
    `com.kiln.${slug(project.config.name).replace(/-/g, "")}`;
  const orientation =
    project.config.android?.orientation ??
    project.config.ios?.orientation ??
    (project.config.viewport.width >= project.config.viewport.height
      ? "landscape"
      : "portrait");
  const dir = exportDirectory(project, opts.out ?? `dist/android/${name}`);
  await rm(dir, { recursive: true, force: true });
  const main = join(dir, "app", "src", "main");
  await mkdir(join(main, "res", "mipmap-xxxhdpi"), { recursive: true });
  const native = await buildNative(project, {
    out: join(main, "assets", "Kiln"),
  });

  console.log("  building the host for arm64-v8a (cargo ndk)");
  const env: Record<string, string> = {
    ANDROID_HOME: sdk,
    ANDROID_NDK_HOME: ndk,
  };
  if (!process.env.LIBCLANG_PATH && process.platform === "darwin") {
    // bindgen needs libclang; Xcode's toolchain has one.
    const xcode = Bun.spawnSync(["xcode-select", "-p"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const dev = new TextDecoder().decode(xcode.stdout).trim();
    const lib = join(
      dev,
      "Toolchains",
      "XcodeDefault.xctoolchain",
      "usr",
      "lib",
    );
    if (existsSync(join(lib, "libclang.dylib"))) env.LIBCLANG_PATH = lib;
  }
  sh(
    [
      "cargo",
      "ndk",
      "-t",
      "arm64-v8a",
      "-o",
      join(main, "jniLibs"),
      "build",
      "--locked",
      "--release",
      "--lib",
    ],
    HOST_DIR,
    env,
  );

  await writeJavaSources(main);
  const { rgba, sprite } = await renderIcon(project, native.dir, 512);
  await Bun.write(
    join(main, "res", "mipmap-xxxhdpi", "ic_launcher.png"),
    encodePNG(512, 512, rgba),
  );
  if (sprite) console.log(`  app icon from sprite "${sprite}"`);

  const screen =
    orientation === "landscape"
      ? "sensorLandscape"
      : orientation === "portrait"
        ? "sensorPortrait"
        : "fullSensor";
  await Bun.write(
    join(main, "AndroidManifest.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-feature android:glEsVersion="0x00030000" android:required="true" />
  <uses-permission android:name="android.permission.VIBRATE" />
  <application android:label="${xmlText(project.config.name)}" android:icon="@mipmap/ic_launcher" android:allowBackup="true" android:hasCode="true">
    <activity android:name="com.kiln.host.KilnActivity"
        android:exported="true"
        android:launchMode="singleTask"
        android:screenOrientation="${screen}"
        android:configChanges="orientation|screenSize|screenLayout|keyboardHidden|keyboard|navigation|uiMode|density"
        android:theme="@style/KilnTheme">
      <meta-data android:name="android.app.lib_name" android:value="kiln_host" />
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>
`,
  );
  await mkdir(join(main, "res", "values"), { recursive: true });
  await Bun.write(
    join(main, "res", "values", "styles.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <style name="KilnTheme" parent="Theme.AppCompat.NoActionBar">
    <item name="android:windowFullscreen">true</item>
    <item name="android:windowBackground">@android:color/black</item>
    <item name="android:windowLayoutInDisplayCutoutMode">shortEdges</item>
  </style>
</resources>
`,
  );
  await Bun.write(
    join(dir, "settings.gradle"),
    `pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories { google(); mavenCentral() } }
rootProject.name = "${name}"
include ':app'
`,
  );
  await Bun.write(
    join(dir, "build.gradle"),
    `plugins { id 'com.android.application' version '${AGP_VERSION}' apply false }\n`,
  );
  await Bun.write(
    join(dir, "gradle.properties"),
    "android.useAndroidX=true\norg.gradle.jvmargs=-Xmx2g\nandroid.nonTransitiveRClass=true\n",
  );
  await Bun.write(
    join(dir, "app", "build.gradle"),
    `plugins { id 'com.android.application' }

android {
  namespace '${applicationId}'
  compileSdk 35
  defaultConfig {
    applicationId '${applicationId}'
    minSdk 28
    targetSdk 35
    versionCode ${project.config.buildNumber ?? 1}
    versionName '${project.config.version ?? "1.0.0"}'
    ndk { abiFilters 'arm64-v8a' }
  }
  buildTypes { release { minifyEnabled false } }
  packagingOptions { jniLibs { useLegacyPackaging false } }
}

dependencies {
  implementation platform('org.jetbrains.kotlin:kotlin-bom:1.9.24')
  implementation 'androidx.games:games-activity:${GAMES_ACTIVITY_VERSION}'
  implementation 'androidx.appcompat:appcompat:1.7.0'
}
`,
  );
  // Only the host library belongs in the APK; the kernel is linked into it.
  await rm(join(main, "jniLibs", "arm64-v8a", "libkiln_kernel.so"), {
    force: true,
  });
  console.log("  generating the Gradle wrapper");
  sh(
    ["gradle", "wrapper", "--gradle-version", GRADLE_VERSION, "-q"],
    dir,
    gradleEnv(sdk),
  );
  return { dir, applicationId };
}

/**
 * The activity and the input bridge. GameActivity forwards touches and keys to native code
 * but not controller motion, so KilnActivity catches controller events first and hands them
 * to the host through KilnInput's native methods (host/src/android.rs); the host calls back
 * into KilnInput.haptic for vibration.
 */
async function writeJavaSources(main: string): Promise<void> {
  const pkg = join(main, "java", "com", "kiln", "host");
  await mkdir(pkg, { recursive: true });
  await Bun.write(
    join(pkg, "KilnActivity.java"),
    `package com.kiln.host;

import android.hardware.input.InputManager;
import android.os.Bundle;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import com.google.androidgamesdk.GameActivity;

/** GameActivity plus the game-controller events it does not forward to native code. */
public class KilnActivity extends GameActivity implements InputManager.InputDeviceListener {
  private static boolean fromController(int source) {
    return (source & InputDevice.SOURCE_GAMEPAD) == InputDevice.SOURCE_GAMEPAD
        || (source & InputDevice.SOURCE_JOYSTICK) == InputDevice.SOURCE_JOYSTICK;
  }

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    InputManager im = (InputManager) getSystemService(INPUT_SERVICE);
    if (im != null) im.registerInputDeviceListener(this, null);
  }

  @Override
  public boolean onGenericMotionEvent(MotionEvent event) {
    if (fromController(event.getSource()) && event.getAction() == MotionEvent.ACTION_MOVE) {
      KilnInput.motion(event);
      return true;
    }
    return super.onGenericMotionEvent(event);
  }

  @Override
  public boolean dispatchKeyEvent(KeyEvent event) {
    int code = event.getKeyCode();
    boolean pad = KeyEvent.isGamepadButton(code) || (fromController(event.getSource()) && KilnInput.isDpad(code));
    if (pad) {
      if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
        KilnInput.nativeButton(event.getDeviceId(), code, true);
      } else if (event.getAction() == KeyEvent.ACTION_UP) {
        KilnInput.nativeButton(event.getDeviceId(), code, false);
      }
      return true;
    }
    return super.dispatchKeyEvent(event);
  }

  @Override public void onInputDeviceAdded(int deviceId) {}
  @Override public void onInputDeviceChanged(int deviceId) {}
  @Override public void onInputDeviceRemoved(int deviceId) { KilnInput.nativeRemoved(deviceId); }
}
`,
  );
  await Bun.write(
    join(pkg, "KilnInput.java"),
    `package com.kiln.host;

import android.content.Context;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.KeyEvent;
import android.view.MotionEvent;

/** Bridge between the Android input system and the Rust host (host/src/android.rs). */
public final class KilnInput {
  private KilnInput() {}

  private static final int[] AXES = {
    MotionEvent.AXIS_X, MotionEvent.AXIS_Y, MotionEvent.AXIS_Z, MotionEvent.AXIS_RZ,
    MotionEvent.AXIS_HAT_X, MotionEvent.AXIS_HAT_Y,
    MotionEvent.AXIS_LTRIGGER, MotionEvent.AXIS_RTRIGGER, MotionEvent.AXIS_BRAKE, MotionEvent.AXIS_GAS,
  };

  static boolean isDpad(int code) {
    return code >= KeyEvent.KEYCODE_DPAD_UP && code <= KeyEvent.KEYCODE_DPAD_CENTER;
  }

  static void motion(MotionEvent event) {
    int device = event.getDeviceId();
    for (int axis : AXES) nativeAxis(device, axis, event.getAxisValue(axis));
  }

  /**
   * Vibration for app.haptic(kind): "light", "medium", "heavy", "success", "warning", "error".
   * Takes a Context because the host holds the Application, not the Activity.
   */
  /** Read text through TalkBack (or any accessibility service) when one is on. */
  public static void announce(Context context, String text) {
    android.view.accessibility.AccessibilityManager am = (android.view.accessibility.AccessibilityManager) context.getSystemService(Context.ACCESSIBILITY_SERVICE);
    if (am == null || !am.isEnabled()) return;
    android.view.accessibility.AccessibilityEvent event = android.view.accessibility.AccessibilityEvent.obtain(android.view.accessibility.AccessibilityEvent.TYPE_ANNOUNCEMENT);
    event.getText().add(text);
    event.setClassName(KilnInput.class.getName());
    event.setPackageName(context.getPackageName());
    am.sendAccessibilityEvent(event);
  }

  public static void haptic(Context context, String kind) {
    Vibrator v = (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
    if (v == null || !v.hasVibrator()) return;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      int effect;
      switch (kind) {
        case "heavy":
        case "error":
          effect = VibrationEffect.EFFECT_HEAVY_CLICK;
          break;
        case "medium":
        case "warning":
        case "success":
          effect = VibrationEffect.EFFECT_CLICK;
          break;
        default:
          effect = VibrationEffect.EFFECT_TICK;
      }
      v.vibrate(VibrationEffect.createPredefined(effect));
    } else {
      long ms = kind.equals("heavy") || kind.equals("error") ? 40 : kind.equals("light") ? 10 : 20;
      v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
    }
  }

  static native void nativeAxis(int device, int axis, float value);
  static native void nativeButton(int device, int key, boolean down);
  static native void nativeRemoved(int device);
}
`,
  );
}

function gradleEnv(sdk: string): Record<string, string> {
  const env: Record<string, string> = { ANDROID_HOME: sdk };
  const java = javaHome();
  if (java) env.JAVA_HOME = java;
  return env;
}

export async function exportAndroidCommand(args: Args): Promise<void> {
  const project = await loadProject();
  await exportAndroid(project, { out: args.str("out", "") || undefined });
}

export interface AndroidBuild {
  apk: string;
  applicationId: string;
  dir: string;
}

/** Export and assemble the debug APK. */
export async function buildAndroidApk(project: Project): Promise<AndroidBuild> {
  const exp = await exportAndroid(project);
  const sdk = sdkDir();
  console.log(
    "  assembling the APK (gradle; the first build downloads the Android Gradle plugin)",
  );
  sh(["./gradlew", "assembleDebug", "-q"], exp.dir, gradleEnv(sdk));
  const apk = join(
    exp.dir,
    "app",
    "build",
    "outputs",
    "apk",
    "debug",
    "app-debug.apk",
  );
  if (!existsSync(apk)) throw new Error(`APK not found at ${apk}`);
  return { apk, applicationId: exp.applicationId, dir: exp.dir };
}

/** The adb command for a device serial, or the default device. */
export function adbFor(serial = ""): string[] {
  const adb = join(sdkDir(), "platform-tools", "adb");
  return serial ? [adb, "-s", serial] : [adb];
}

/** Install and launch; `extras` become string extras on the launch intent. */
export function launchAndroidApp(
  built: AndroidBuild,
  serial = "",
  extras: Record<string, string> = {},
): void {
  const target = adbFor(serial);
  sh([...target, "install", "-r", built.apk], built.dir);
  sh([...target, "shell", "am", "force-stop", built.applicationId], built.dir);
  const cmd = [
    ...target,
    "shell",
    "am",
    "start",
    "-n",
    `${built.applicationId}/com.kiln.host.KilnActivity`,
  ];
  for (const [k, v] of Object.entries(extras))
    cmd.push("--es", k, `'${v.replace(/'/g, "")}'`);
  sh(cmd, built.dir);
}

/** Export, build the debug APK, install it on the connected device or emulator, and launch. */
export async function runAndroid(args: Args): Promise<void> {
  const project = await loadProject();
  const built = await buildAndroidApk(project);
  launchAndroidApp(built, args.str("device", ""));
  console.log(`  launched ${built.applicationId}`);
}
