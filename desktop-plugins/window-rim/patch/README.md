# Windows: really rounded window corners

The radius control in the `window-rim` plugin rounds the app's **own window**,
not just the coloured stroke. On Linux that works because the app is patched to
be born with an alpha surface and clips its shell (see the skill reference
`linux-window-rounding.md`). On **Windows** that route is closed — the app
deliberately refuses `transparent: true` because a *resizable* transparent
window is broken on Windows (electron#48421), and Windows 10 has no DWM corner
rounding at all.

Windows does have a first-class answer: **`BaseWindow.setShape(rects)`**
(Windows + Linux, experimental). It shapes the window with a native region, so
the four corners simply **do not exist** — the desktop behind shows through,
with no transparency, no per-frame DirectComposition cost, and no change to
resize behaviour.

## What it installs

| File | Change |
|---|---|
| `resources/app.asar.unpacked/dist/electron-main.mjs` | appends a small bootstrap that shapes every opaque Hermes window (skipping `?win=hud\|overlay\|quick\|wake\|intro`) and listens on `hermes:window:shape` |
| `resources/app.asar.unpacked/dist/electron-preload.js` | exposes `window.hermesDesktop.setWindowShape(px)` so the renderer can set the radius |

The plugin calls that bridge from its radius control, so the existing chip keeps
working; the radius is also persisted to `%APPDATA%\Hermes\window-shape.json`
so windows are shaped from the first frame on the next launch. Radius `0`
removes the region (the stock rectangle).

## Install

```bash
node patch/patch-windows-shape.js status
node patch/patch-windows-shape.js apply
```

Then **close and reopen Hermes** — window shape is a main-process property, a
renderer reload is not enough. `status` must read `patch APPLIED`.

## Revert / after an app update

```bash
node patch/patch-windows-shape.js revert
```

`apply` keeps `electron-main.mjs.stock` and `electron-preload.js.stock`
byte-for-byte backups, and `revert` restores them. An app rebuild or update
replaces those files, so **re-run `apply` after updating the app** (the
Settings row of the plugin still paints the rim without it; only the radius is
inert, and the popover says so).

## Verify it is live (no guessing)

- Native region present on a Hermes window (`rgnKind=3` = `COMPLEXREGION`):

  ```powershell
  # python one-liner equivalent: EnumWindows → GetWindowRgn → COMPLEXREGION with ~29 rects
  ```

- The four corners show whatever is behind the window instead of app pixels.
- `%APPDATA%\Hermes\window-shape.json` exists once the plugin has sent a radius.

## Known limits

- **Aliased corners.** A region is built from rectangles, so the curve is a
  1-px staircase (radius 24 → 24 scanline rows). Anti-aliased rounding needs
  either Windows 11 (`DWMWA_WINDOW_CORNER_PREFERENCE`) or an alpha surface.
- **No corner resize handles.** The corner sliver is outside the region, so
  hit-testing there falls through to the window behind — the resize grip is the
  edge, not the corner.
- **Maximized / fullscreen windows are not shaped** (a region there would leave
  gaps); the bootstrap clears the region for those states and restores it after.
- **Windows only.** On Linux/macOS the script reports `NOT APPLIED` and does
  nothing.
- **Not the same as `transparent: true`.** Nothing becomes translucent — the
  corners are cut out, which is what "transparent underneath" looks like.
