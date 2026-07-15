import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// These are `external` in vite.main.config.ts — Vite never inlines them, so they
// must exist as real files in the packaged app:
//   • the Agent SDK spawns a native `claude` binary (a separate platform package)
//   • the Playwright MCP cli.js is spawned as a subprocess by path
// The Forge Vite plugin only copies .vite/ + package.json, so we install these
// production deps into the app dir ourselves (see packageAfterCopy below).
const RUNTIME_DEPS = ['@anthropic-ai/claude-agent-sdk', '@playwright/mcp'];

const NOTARY_PROFILE = 'mocca';

// Prefer a keychain profile (`xcrun notarytool store-credentials "mocca" …`) so
// the app-specific password never has to be typed into a shell or a config file.
// Fall back to env vars for CI. Return undefined to skip notarizing entirely.
function notarizeOptions() {
  const hasProfile = (() => {
    try {
      execFileSync('xcrun', ['notarytool', 'history', '--keychain-profile', NOTARY_PROFILE], {
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  })();

  if (hasProfile) {
    return { osxNotarize: { keychainProfile: NOTARY_PROFILE } } as const;
  }
  if (process.env.APPLE_ID && process.env.APPLE_PASSWORD && process.env.APPLE_TEAM_ID) {
    return {
      osxNotarize: {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      },
    } as const;
  }
  return undefined;
}

const config: ForgeConfig = {
  packagerConfig: {
    // Everything above needs to be a real file on disk (the native binary must
    // be executable; the MCP cli.js is spawned as a subprocess), so keep the
    // runtime node_modules out of the asar archive.
    asar: { unpack: '**/node_modules/**' },
    name: 'Mocca',
    // Packager appends the right extension per platform (.icns / .ico).
    icon: './assets/icon',
    // Ship the bundled workspace registry alongside the app.
    extraResource: ['./registry'],
    appBundleId: 'com.bayaq.mocca',
    // Sign with the Developer ID under hardened runtime. This is not optional
    // cosmetics: macOS on Apple Silicon refuses to run a binary whose signature
    // doesn't verify, and packaging (icon/plist rewrites + fuses) invalidates
    // the ad-hoc signature Electron ships with. Signing also covers the nested
    // native `claude` binary in app.asar.unpacked.
    osxSign: {
      // Your "Developer ID Application: …" identity. Set APPLE_SIGN_IDENTITY to
      // pin it; if unset, @electron/osx-sign auto-discovers a Developer ID in
      // the login keychain.
      identity: process.env.APPLE_SIGN_IDENTITY,
      optionsForFile: () => ({
        entitlements: 'build/entitlements.plist',
      }),
    },
    // Notarizing is what removes the "Apple could not verify this app is free of
    // malware" warning on someone else's Mac. A Developer ID signature alone is
    // not enough — Gatekeeper rejects a Developer-ID-signed app that has no
    // notarization ticket once the file carries the quarantine flag (i.e. as
    // soon as it's downloaded or AirDropped).
    //
    // Credentials come from a keychain profile created once with:
    //   xcrun notarytool store-credentials "mocca" \
    //     --apple-id <apple-id> --team-id <your-team-id>
    // so the app-specific password never lives in the repo, the env, or shell
    // history. Falls back to env vars for CI. Skipped entirely when neither is
    // present, so a plain local `npm run make` still works.
    ...(notarizeOptions() ?? {}),
  },
  hooks: {
    // The Vite plugin hands the packager a dir containing only the bundle and a
    // package.json — no node_modules — so the SDK/Playwright would be missing at
    // runtime and the app would crash on first require. Install just the runtime
    // deps (with their transitive tree) into that dir.
    //
    // This must run at packageAfterPrune, not packageAfterCopy: the Vite plugin
    // writes the app's package.json in its own copy hook (so it doesn't exist
    // yet at copy time), and prune would strip anything we installed earlier.
    packageAfterPrune: async (_forgeConfig, buildPath) => {
      const rootPkg = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'),
      );
      const pkgPath = path.join(buildPath, 'package.json');
      const pkg = fs.existsSync(pkgPath)
        ? JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
        : { name: rootPkg.name, version: rootPkg.version, main: rootPkg.main };

      pkg.dependencies = Object.fromEntries(
        RUNTIME_DEPS.map((d) => [d, rootPkg.dependencies[d]]),
      );
      delete pkg.devDependencies;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

      execFileSync(
        'npm',
        ['install', '--omit=dev', '--no-package-lock', '--no-audit', '--no-fund'],
        { cwd: buildPath, stdio: 'inherit' },
      );
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerDMG({}, ['darwin']),
    new MakerSquirrel({}),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      // Fuses rewrite the Electron binary, invalidating its signature — but
      // packagerConfig.osxSign re-signs with the Developer ID afterwards, so we
      // must NOT reset to an ad-hoc signature here (that would clobber it).
      // The headless-browser MCP spawns the Electron binary as Node via
      // ELECTRON_RUN_AS_NODE, so this must stay enabled.
      [FuseV1Options.RunAsNode]: true,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      // Integrity validation requires a signed, consistent asar; disabled while
      // the app is unsigned and ships unpacked resources.
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
