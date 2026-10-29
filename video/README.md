# OpenClaw — product video

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

A product video for OpenClaw, authored with the Companion video-kit from one file,
[`storyboard.json`](storyboard.json).

## What this film is, and is not

OpenClaw runs inside the Hub as a container behind the Hub's authenticated proxy. There is no stage
this repo can boot headlessly: the app only works as a Hub install. So **nothing here is captured**.
There is no `make.sh`, no `stage.sh` and no `capture` blocks.

- **One screen, committed.** `assets/shots/t` is the OpenClaw listing screenshot from
  `CI-Marketplace` (`h`), footer reads v2026.6.11. It is a **stale picture of a real install**
  (footer reads v2026.6.11), not a fresh capture. Re-shoot it from a live Hub install and replace the file when the UI
  you want to show has moved. No other footage appears; every other beat is a typographic card.
- **Every claim is from this repo's README**, checked against the card it sits on. Nothing is shown
  that the README does not say the app does.
- **Landscape film plus a vertical short.** `formats` is `["landscape"]` for the film: the only
  screenshot is a desktop one, and faking a phone layout would film a UI that does not exist. The
  `mobile` cut is typographic-only (no screenshot), so it can honestly be 9:16.

## Rendering

```bash
# from video/ , with CI-Common checked out at the video-kit version in package.json
ci-video narrate     # only re-cuts scenes whose mp3 is missing
ci-video build && ci-video check --allow-slates
ci-video render
```

`--allow-slates` is needed because video-kit 0.35.0's missing-shot gate ignores `formats` and asks
for `<shot>.mobile.png` even though no cut uses it. The landscape and vertical builds contain no
"capture pending" slate (`grep -c "capture pending" build/*/index.html` is 0).

Run it from a disposable checkout of CI-Common's `main`: a stale kit renders stale brand with no warning.
Renders are build output: `out/` and `build/` are not committed.

## What is committed

`assets/audio/*.mp3` and `narration.json` (narration costs an edge-tts round trip per scene),
`assets/shots/t` (durable input, see above), `assets/app-icon.png` (the Hub listing logo) and
the campaign music bed `assets/media/ci-campaign-bed-110.mp3`, as in Planning and Spellbook.
