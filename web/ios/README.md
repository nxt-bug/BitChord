# BitChord for iPhone (experimental)

A [Capacitor](https://capacitorjs.com) wrapper around the web player (`web/app`). The extension the site normally needs is replaced by native HTTP (`app/src/extension/nativeBridge.ts`): URLSession ignores CORS and can send YouTube's `Origin`/`Referer`.

Works: search, browse, YouTube Music playback (if YouTube lets it), lyrics.
Not available: YouTube sign-in, Spotify, Discord. They need a browser's cookie jar.

## Build without a Mac

1. Fork this repo on GitHub.
2. In your fork: **Actions → iOS → Run workflow**. A GitHub-hosted Mac builds an unsigned `.ipa` (10–20 min).
3. Download the `BitChord-unsigned-ipa` artifact and unzip it.
4. Install it with [Sideloadly](https://sideloadly.io) or [AltStore](https://altstore.io) (Windows or macOS), signing with your Apple ID. A free Apple ID works, but the app must be re-signed every 7 days.

## Build on a Mac

```bash
cd web && corepack pnpm install && VITE_PARTY_SERVER_URL=https://party.example.com corepack pnpm --filter @bitchord/app build
cd ios && npm install && npx cap add ios && python3 scripts/patch-ios.py ios/App && npx cap sync ios && npx cap open ios
```

Then pick your team under Signing & Capabilities and run on your phone.

`scripts/patch-ios.py` adds background audio, the playback audio session and autoplay. It exits with an error if Capacitor's template changes, rather than building an app that stops when the screen locks.
