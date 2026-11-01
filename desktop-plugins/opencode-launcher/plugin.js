/**
 * OpenCode Launcher — desktop half of the opencode-launcher plugin.
 *
 * One button: "make the OpenCode web UI exist, then show it" (OpenCode v2).
 *  1. Calls the Python backend POST /start — idempotent: it never restarts a
 *     running shared service. v2 serves the web UI from the one background
 *     server every local client uses (default http://127.0.0.1:49374, loopback
 *     only) and it is PASSWORD PROTECTED, so a bare URL shows a sign-in page.
 *     Access comes from a one-time connect link minted by `opencode pair`
 *     (single use, 5 min) — the backend mints one and opens THAT.
 *  2. The backend emits the same `preview.open` gateway event the built-in
 *     desktop_preview tool uses, so the connect link opens in Hermes' own
 *     preview browser (right rail) — no external browser. The link plants a
 *     30-day session cookie, so the pane stays signed in.
 *
 * UI: a status-bar chip (right cluster) with a state dot, plus a ⌘K command
 * ("Open OpenCode Web") doing the same thing.
 *
 * Requires (both halves gated on purpose):
 *   1. Python backend enabled: `plugins.enabled` in config.yaml must include
 *      "opencode-launcher", then the app backend must be restarted so
 *      plugin_api.py imports.
 *   2. Nothing else — this desktop half sits marker-less in the standalone door
 *      and loads enabled; there is no Settings toggle to flip.
 *
 * WHERE THIS FILE LIVES — the ONE copy, and why the package keeps no desktop/ half
 * ---------------------------------------------------------------------------------
 * This is the STANDALONE door: <hermes home>/desktop-plugins/opencode-launcher/.
 * It is the only live desktop half of this plugin, on purpose:
 *  - `plugins/<id>/desktop/plugin.js` is the unified-package door: Electron
 *    copies it in and stamps `.hermes-package.json`, and that marker CAPS the
 *    folder to opt-in (runtime-loader.ts: `defaultEnabled: marker ? false :
 *    undefined`), so the chip only appears after a manual toggle in Settings →
 *    Plugins — the reason it vanished (Sep/Oct 2026).
 *  - Deleting the marker is not enough on its own: `materializeDesktopHalf`
 *    re-copies the package half (marker included) whenever the folder is
 *    missing, and re-stamps the marker onto a marker-less folder whose
 *    plugin.js is byte-identical to the source. So the stable arrangement is
 *    what it is now: NO `desktop/` directory in the agent package (the
 *    materializer then skips it entirely) and exactly one file here.
 * The marker must not exist beside this file; if it ever reappears, the chip is
 * off until it is re-toggled.
 * MARKER-LESS = load with this plugin's own `defaultEnabled` (true) = the chip
 * is simply there, the same posture the dsh chip has. No toggle, no restart.
 * The Python half stays at `plugins/opencode-launcher/dashboard/plugin_api.py`
 * (backend routes mount from there; one app relaunch after a change).
 */

import { host, STATUSBAR_AREAS, PALETTE_AREA } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useEffect, useState } from 'react'

const ID = 'opencode-launcher'
const TITLE = 'OpenCode Web'
const DEFAULT_PORT = 49374

/** Backend result → in-app toast (Persian, matching the user's language). */
function human(res) {
  const port = res && res.port ? res.port : DEFAULT_PORT
  const baseUrl = res && res.url ? res.url : `http://127.0.0.1:${port}`
  const opened = res && res.preview === 'opened'

  if (res && res.pair_error) {
    return {
      kind: 'info',
      title: TITLE,
      message: opened
        ? `سرویس opencode روشن است (پورت ${port}) ولی لینک اتصال ساخته نشد — آدرس خام را توی پیش‌نمایش باز کردم؛ برای ورود توی ترمینال «opencode pair» بزن و لینک چاپ‌شده را باز کن`
        : `سرویس opencode روشن است (پورت ${port}) ولی لینک اتصال ساخته نشد — توی ترمینال «opencode pair» بزن و لینک را باز کن. آدرس: ${baseUrl}`
    }
  }
  if (res && res.started) {
    return {
      kind: 'success',
      title: TITLE,
      message: opened
        ? `opencode روشن شد (پورت ${port}) — با لینک اتصال یک‌بارمصرف توی پیش‌نمایش باز شد`
        : `opencode روشن شد (پورت ${port}) — آدرس: ${baseUrl}`
    }
  }
  if (res && res.already_running) {
    return {
      kind: 'info',
      title: TITLE,
      message: opened
        ? `سرویس opencode از قبل روشن بود (پورت ${port}) — ری‌استارتش نکردم؛ لینک اتصال تازه ساختم و توی پیش‌نمایش باز کردم`
        : `سرویس opencode از قبل روشن بود (پورت ${port}) — ری‌استارتش نکردم. آدرس: ${baseUrl}`
    }
  }
  return { kind: 'error', title: TITLE, message: 'جواب نامشخص از بک‌اند پلاگین' }
}

function isRunning(res) {
  return !!(res && res.running)
}

/** The one action both surfaces trigger. Returns the backend result or null. */
async function ensureOpenCode(ctx) {
  let res
  try {
    res = await ctx.rest('/start', { method: 'POST', body: {}, timeoutMs: 45_000 })
  } catch (err) {
    const detail = err && (err.detail || err.message)
    host.notifyError(
      detail ? new Error(String(detail)) : new Error('backend unavailable'),
      `${TITLE}: بک‌اند پلاگین در دسترس نیست — مطمئن شو «opencode-launcher» توی plugins.enabled هست، اپ دوباره اجرا شده و پلاگین توی Settings → Plugins روشن باشه`
    )
    return null
  }
  host.notify(human(res))
  return res
}

function OpenCodeChip({ ctx }) {
  const [busy, setBusy] = useState(false)
  const [up, setUp] = useState(null) // null = unknown yet, true/false = last probe

  const refresh = useCallback(async () => {
    try {
      const res = await ctx.rest('/status', { timeoutMs: 20000 })
      setUp(isRunning(res))
    } catch {
      setUp(null)
    }
  }, [ctx])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const onClick = async () => {
    if (busy) return
    setBusy(true)
    const res = await ensureOpenCode(ctx)
    if (res) setUp(isRunning(res))
    setBusy(false)
  }

  const dotColor = up === true ? 'var(--ui-accent, #2f81f7)' : 'var(--ui-text-quaternary, #9aa0aa)'

  return jsxs('button', {
    type: 'button',
    title:
      'opencode web — کلیک: اگه سرویس خوابه روشنش کن، بعد با لینک اتصال یک‌بارمصرف (opencode pair) ' +
      'توی پیش‌نمایش هرمس باز کن. پورت پیش‌فرض 49374',
    onClick: () => void onClick(),
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      height: '100%',
      padding: '0 8px',
      fontSize: '11px',
      fontWeight: 500,
      lineHeight: 1,
      color: 'var(--ui-text-secondary, #c3c7d1)',
      cursor: busy ? 'wait' : 'pointer',
      background: 'transparent',
      border: 'none',
      borderRadius: '4px',
      fontFamily: 'inherit'
    },
    children: [
      jsx('span', {
        'aria-hidden': true,
        style: {
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: busy ? 'var(--ui-accent, #2f81f7)' : dotColor,
          flexShrink: 0,
          opacity: up === true || busy ? 1 : 0.45
        }
      }),
      busy ? 'opencode…' : 'opencode'
    ]
  })
}

export default {
  id: ID,
  name: 'OpenCode Launcher',
  defaultEnabled: true,
  register(ctx) {
    // console.ERROR, not log: the packaged app forwards only ERROR-level
    // renderer console lines to ~/.hermes/logs/desktop.log, and this one line
    // is the only evidence that the status-bar chip actually mounted.
    console.error('[opencode-launcher] registered')
    ctx.register({
      id: 'chip',
      area: STATUSBAR_AREAS.right,
      order: 70,
      render: () => jsx(OpenCodeChip, { ctx })
    })
    ctx.register({
      id: 'open',
      area: PALETTE_AREA,
      data: {
        id: `${ID}.open`,
        label: 'Open OpenCode Web',
        keywords: ['opencode', 'oc', 'open code', 'web', 'launcher'],
        run: () => void ensureOpenCode(ctx)
      }
    })
  }
}
