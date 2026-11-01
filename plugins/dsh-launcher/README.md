# dsh-launcher — where each half lives (read before moving files)

This plugin is split across the two plugin doors ON PURPOSE. Moving either file
flips user-visible behaviour.

| Half | Path | Door semantics |
|---|---|---|
| Python backend (`router` → `/api/plugins/dsh-launcher/`) | `~/.hermes/plugins/dsh-launcher/dashboard/plugin_api.py` | Mounted only for plugins listed in `plugins.enabled`; routes exist from process start, so **the app must be relaunched** after a change. |
| Desktop half (status-bar chip + ⌘K command) | `~/.hermes/desktop-plugins/dsh-launcher/plugin.js` | Standalone door: a hand-placed folder with **no** `.hermes-package.json` loads ENABLED. |

## Why there is no `desktop/` directory here

`plugins/<id>/desktop/plugin.js` is the door for *unified packages*. Electron
copies that half out to `~/.hermes/desktop-plugins/<id>/` and stamps
`.hermes-package.json` (see `apps/desktop/electron/desktop-plugins-root.ts`,
`materializeDesktopHalf`). The runtime loader then reads that marker and
**forces the plugin to load DISABLED** (`runtime-loader.ts`: `defaultEnabled:
marker ? false : undefined`), so the user has to toggle it once in
Settings → Plugins.

Keeping the desktop half here, marker-less, means the chip is present with zero
setup — which is what was asked for ("a button in the status bar like
opencode's"). The trade-off is that the desktop row no longer pairs with the
agent package on the Plugins page; that pairing buys nothing for a private
plugin.

Note also: `materializeDesktopHalf` would ADOPT a marker-less folder whose
`plugin.js` is byte-identical to a `plugins/<id>/desktop/plugin.js`, re-stamping
the marker and turning the chip off again. So do not recreate that source path
"for symmetry".

## Operation

- `GET  /api/plugins/dsh-launcher/status` — is a `dsh web` answering, is it ours,
  and is it on the fixed port (`on_fixed_port`)?
- `POST /api/plugins/dsh-launcher/start` — **the port is fixed (3080) and this
  route enforces it.** Idempotent when our instance already sits on 3080 (reused
  untouched, never restarted). Otherwise: an instance of ours caught on a stale
  port is moved onto 3080, and a *dsh* holding 3080 (usually one started in a
  terminal — unadoptable, its launch token never left that terminal) is stopped
  (SIGTERM → SIGKILL after a grace) so ours can bind it. A **non-dsh** holder is
  never killed: the call fails 409 naming the holder, and `{"port": N}` in the
  body selects a different fixed port for that call. The response reports
  `stopped_foreign_pids`, `moved_from_port` and `rtl_pass`.
- `POST /api/plugins/dsh-launcher/takeover` — kept for compatibility; `/start`
  already does what it did.

Why the launcher must own the process: `dsh web` answers 401 unless the request
carries a cookie minted from the one-time `/?token=<launchToken>` URL printed at
startup, and `launchToken` is random per process (memory-only). A server started
in the user's own terminal can never be adopted by the preview pane.

## RTL + وزیرمتن for the harness UI («فارسی‌ساز» pass)

The harness UI gets the same Persian/LTR treatment as Max's Firefox add-on
(`/data/Codes/firefox-farsi-helper`): only elements carrying a Persian/Arabic
letter flip to RTL (blocks, table cells, leaf text containers, Persian form
fields); everything else stays LTR and `pre/code` never flip.

- Canonical sources: `rtl/farsi-web.js`, `rtl/farsi-web.css`, `rtl/vazirmatn.woff2`.
- Installer: `tools/apply_dsh_rtl.py` — copies them into the dsh web frontend's
  served `dist/dsh-rtl/` and injects the `<link>`/`<script defer>` tags into
  `dist/index.html` between the `<!-- dsh-rtl:start -->` / `:end -->` markers.
  `--check` fails on drift; `--remove` takes it out; `--dist` overrides the path.
- **Re-run it after every `npm i -g @deepseek-ai/dsh`** — the upgrade replaces
  the whole package, dist included. That is why the sources live here.
- Changing `rtl/*` needs one more `apply_dsh_rtl.py` run, then a page reload.

### It repairs itself (no manual step after an upgrade)

- `POST /start` calls `_ensure_rtl_patch()` (a `--check`, then an install when it
  fails) *before* it opens the pane, and reports the outcome in the response as
  `rtl_pass` (`ok` / `reinstalled` / `failed` / `tool_missing`).
- Cron `dsh-rtl-watchdog` (job `8d4567f519a9`, daily 10:00, `no_agent`, script
  `~/.hermes/scripts/dsh_rtl_watchdog.py`, `deliver='all'`) is the safety net for
  when he opens the harness without the launcher. Watchdog rule: **silent while
  healthy** (empty stdout sends nothing), a short Persian report only after it
  repaired something, exit 1 when it could not.
- Both paths shell out to this same tool, so there is exactly one implementation
  of "install the pass". Changing `rtl/*` therefore also needs no script edit.


