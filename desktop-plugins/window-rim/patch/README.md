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
with no transparency and no change to resize behaviour.

## What it installs

| File | Change |
|---|---|
| `resources/app.asar.unpacked/dist/electron-main.mjs` | appends a bootstrap that shapes every opaque Hermes window (skipping `?win=hud\|overlay\|quick\|wake\|intro`) and listens on `hermes:window:shape` |
| `resources/app.asar.unpacked/dist/electron-preload.js` | exposes `window.hermesDesktop.setWindowShape({ radius, dpr, width, height, screenX, screenY })` |

The plugin calls that bridge from its radius control, so the existing chip keeps
working; the radius is also persisted to `%APPDATA%\Hermes\window-shape.json`
so windows are shaped from the first frame on the next launch. Radius `0`
removes the region (the stock rectangle).

## Three geometry facts that make or break it

All three were found by measuring a live window (`GetWindowRgn` + pixel scans),
and each one produced a visible defect before it was fixed:

1. **Rects are in WINDOW coordinates, not client coordinates.** A frameless
   Windows window's client area is inset (measured: 8 px left, 0 px top, 8 px
   right, 8 px bottom). A region built from the client size at the window origin
   is therefore shifted 8 px left: it covers the left frame ring and shaves the
   last 8 px off the app, **cutting the rim's right border** — the "white bar on
   the right". The bootstrap derives the inset from
   `win.getBounds()` (client rect) minus the renderer's `window.screenX/Y`
   (window origin).
2. **Radius is CSS px, the region is physical px.** Scale by
   `clientWidth / innerWidth` (1.1 on a 110% display). A region radius left at
   the CSS value cuts an arc with a different radius than the rim's CSS arc, so
   the two curves cross and the corners read as "crooked".
3. **Never skip a scanline row whose inset rounds to 0.** Those rows sit next to
   the straight edge and the middle rect only starts at `y = r`, so skipping
   them leaves a ~5 px **transparent band** across the window just inside the top
   and bottom edges.

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
replaces those files, so **re-run `apply` after updating the app** (the plugin
still paints the rim without it; only the radius is inert, and the popover says
so).

## Verify it is live (no guessing)

```python
kind = user32.GetWindowRgn(hwnd, rgn)        # 3 = COMPLEXREGION = shaped
gdi32.GetRegionData(rgn, 0, None)            # nCount at offset 8, rcBound at 16
```

- `rgnKind=0, rects=1` → stock rectangle; `rgnKind=3` with ~29-53 rects → shaped.
- The region's bound must equal the CLIENT rect (offset by the client inset),
  e.g. window `(317,32)-(1800,970)`, client `1467x930 at (325,32)`, region
  bound `1467x930` starting at x=8.
- The four corners show whatever is behind the window instead of app pixels.
- `%APPDATA%\Hermes\window-shape.json` exists once the plugin has sent a radius.

## Known limits

- **Aliased corners.** A region is a union of rectangles, so the curve is a 1-px
  staircase. Anti-aliased rounding needs Windows 11
  (`DWMWA_WINDOW_CORNER_PREFERENCE`) or an alpha surface — do not promise
  smooth arcs.
- **No corner resize handles.** The corner sliver is outside the region, so
  hit-testing there falls through to the window behind; resize from the edges.
- **Maximized / fullscreen windows are not shaped** (a region there would leave
  gaps); the bootstrap clears the region for those states and restores it after.
- **Windows only.** On Linux/macOS the script reports `NOT APPLIED`.
- **Not the same as `transparent: true`.** Nothing becomes translucent — the
  corners are cut out, which is what "transparent underneath" looks like.
