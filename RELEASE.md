# Releasing Mocca (macOS)

Produces a signed + **notarized** + stapled `.dmg` that installs on any Apple
Silicon Mac with **no Gatekeeper warning**.

## One-time setup (per machine)

You need an Apple **Developer ID Application** certificate in the login keychain
(team `328M5GAMDD`) and notary credentials stored as a keychain profile named
`mocca`. The build auto-detects both.

Store the notary profile from an App Store Connect API key (`.p8`):

```bash
xcrun notarytool store-credentials "mocca" \
  --key   "/path/to/AuthKey_XXXXXXXXXX.p8" \
  --key-id XXXXXXXXXX \
  --issuer <ISSUER_ID>            # App Store Connect → Users and Access → Integrations
```

Alternatively, set `APPLE_ID` + `APPLE_PASSWORD` (an app-specific password) +
`APPLE_TEAM_ID` in the environment (used as a fallback, e.g. in CI).

Verify it's stored:

```bash
xcrun notarytool history --keychain-profile mocca   # lists jobs, not an error
```

## Build a release

```bash
npm run make
```

That's it. The pipeline:

1. Builds the Vite bundles and packages the app.
2. Signs the `.app` (Developer ID, hardened runtime) and **notarizes** it —
   `osxSign` + `osxNotarize` in `forge.config.ts`.
3. Builds the `.dmg` and `.zip`.
4. **`postMake` hook** signs → notarizes → staples each `.dmg` (Forge notarizes
   the app but not the DMG wrapper, so a downloaded DMG would otherwise still
   prompt). This waits on Apple (~2–10 min).

Artifacts land in `out/make/`. Ship `out/make/Mocca-<version>-arm64.dmg`.

> If no notary credentials are found, `npm run make` still succeeds but leaves
> the DMG un-notarized (it logs `[postMake] No notary credentials …`). Such a
> build **will** show the Gatekeeper warning — don't distribute it.

## Verify before distributing

```bash
APP=out/Mocca-darwin-arm64/Mocca.app
DMG=$(ls -t out/make/*.dmg | head -1)

spctl -a -vv -t exec "$APP"                                    # accepted · Notarized Developer ID
xcrun stapler validate "$APP"                                  # worked
spctl -a -vv -t open --context context:primary-signature "$DMG"  # accepted · Notarized Developer ID
xcrun stapler validate "$DMG"                                  # worked
```

All four must pass. Then the DMG opens clean on a fresh Mac.

## Notes / limitations

- **Architecture:** this build is `arm64` only — Apple Silicon (M1–M4). It will
  not run on Intel Macs. For an Intel or universal build, change the packager
  `arch` (or build both and notarize each).
- **Debug builds:** never distribute a build made with `MOCCA_DEBUG_FUSES=1`
  (that flag enables the Node inspector fuse for Playwright-driven demos and
  weakens a security mitigation). Plain `npm run make` is the shippable one.
- Notary credentials live in your keychain, not in the repo. Don't commit the
  `.p8` key or any app-specific password.
