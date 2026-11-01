/**
 * DeepSeek Harness Launcher — desktop half of the dsh-launcher plugin.
 *
 * ONE button: "make `dsh web` exist, then show it in Hermes' own preview pane".
 *  1. Calls the Python backend POST /start — idempotent: an instance this plugin
 *     already started is re-opened as-is (never restarted); otherwise the
 *     backend spawns `dsh web --no-open` (port 3080, or an OS-picked free port
 *     when 3080 is taken) and reads the tokenized URL out of its own log.
 *  2. The backend then emits the same `preview.open` gateway event the built-in
 *     desktop_preview tool uses, so the UI opens in the right rail — no
 *     external browser, no focus stealing.
 *
 * Why an owned instance: `dsh web` only serves behind a cookie minted from the
 * one-time `/?token=…` URL printed at startup, and that token never leaves the
 * process that started the server. A copy started in the user's terminal
 * therefore cannot be shown here.
 *
 * UI: a status-bar chip (right cluster, next to the opencode chip) with a state
 * dot, plus a ⌘K command ("Open DeepSeek Harness Web").
 *
 * WHERE THIS FILE LIVES — and why it is NOT in ~/.hermes/plugins/dsh-launcher/desktop/
 * ---------------------------------------------------------------------------------
 * It lives in the STANDALONE door, ~/.hermes/desktop-plugins/dsh-launcher/plugin.js,
 * on purpose. `plugins/<id>/desktop/plugin.js` is the door for unified packages:
 * Electron copies that half out and stamps `.hermes-package.json`, and that
 * marker FORCES the plugin to load DISABLED until the user toggles it in
 * Settings → Plugins. This door has no such posture — a hand-placed, marker-less
 * folder loads enabled, so the chip is simply there with zero setup. Moving this
 * file into `plugins/dsh-launcher/desktop/` would silently turn the chip off
 * again and re-introduce the opt-in step. The Python half stays in
 * `~/.hermes/plugins/dsh-launcher/dashboard/plugin_api.py`, which is where
 * backend routes mount from (and needs one app relaunch to mount).
 */

import { host, STATUSBAR_AREAS, PALETTE_AREA } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useCallback, useEffect, useState } from 'react'

const ID = 'dsh-launcher'
const TITLE = 'DeepSeek Harness'

/** Backend result → in-app toast (Persian, matching the user's language). */
function human(res) {
  const port = res && res.port ? res.port : 3080
  const url = res && res.url ? res.url : `http://127.0.0.1:${port}`
  const opened = res && res.preview === 'opened'
  const started = !!(res && res.started)

  if (started) {
    const busyPort = port !== 3080
    return {
      kind: 'success',
      title: TITLE,
      message: opened
        ? `DeepSeek Harness روشن شد (پورت ${port}${busyPort ? ' — ۳۰۸۰ اشغال بود' : ''}) — الان توی پیش‌نمایش باز شد`
        : `DeepSeek Harness روشن شد (پورت ${port}) — آدرس: ${url}`
    }
  }
  if (res && res.already_running) {
    return {
      kind: 'info',
      title: TITLE,
      message: opened
        ? `DeepSeek Harness از قبل روشن بود (پورت ${port}) — ری‌استارتش نکردم؛ توی پیش‌نمایش بازش کردم`
        : `DeepSeek Harness از قبل روشن بود (پورت ${port}) — ری‌استارتش نکردم. آدرس: ${url}`
    }
  }
  return { kind: 'error', title: TITLE, message: 'جواب نامشخص از بک‌اند پلاگین' }
}

function isRunning(res) {
  return !!(res && res.running)
}

/** The one action both surfaces trigger. Returns the backend result or null. */
async function ensureDsh(ctx) {
  let res
  try {
    res = await ctx.rest('/start', { method: 'POST', body: {}, timeoutMs: 60_000 })
  } catch (err) {
    const detail = err && (err.detail || err.message)
    host.notifyError(
      detail ? new Error(String(detail)) : new Error('backend unavailable'),
      `${TITLE}: بک‌اند پلاگین در این پروسه mount نشده — با یک‌بار بستن و باز کردن هرمس فعال می‌شه («dsh-launcher» از قبل توی plugins.enabled هست)`
    )
    return null
  }
  host.notify(human(res))
  return res
}

function DshChip({ ctx }) {
  const [busy, setBusy] = useState(false)
  const [up, setUp] = useState(null) // null = unknown yet, true/false = last probe

  const refresh = useCallback(async () => {
    try {
      const res = await ctx.rest('/status', { timeoutMs: 8000 })
      setUp(isRunning(res))
    } catch {
      setUp(null) // backend not mounted yet (before the app relaunch) — stay quiet
    }
  }, [ctx])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const onClick = async () => {
    if (busy) return
    setBusy(true)
    const res = await ensureDsh(ctx)
    if (res) setUp(isRunning(res))
    setBusy(false)
  }

  const dotColor = up === true ? 'var(--ui-accent, #2f81f7)' : 'var(--ui-text-quaternary, #9aa0aa)'

  return jsxs('button', {
    type: 'button',
    title:
      'DeepSeek Harness (dsh web) — کلیک: اگه روشن نیست روشنش کن (پورت ۳۰۸۰) و توی پیش‌نمایش هرمس باز کن',
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
      busy ? 'dsh…' : 'dsh'
    ]
  })
}

export default {
  id: ID,
  name: 'DeepSeek Harness Launcher',
  defaultEnabled: true,
  register(ctx) {
    ctx.register({
      id: 'chip',
      area: STATUSBAR_AREAS.right,
      order: 71, // right next to the opencode chip (order 70)
      render: () => jsx(DshChip, { ctx })
    })
    ctx.register({
      id: 'open',
      area: PALETTE_AREA,
      data: {
        id: `${ID}.open`,
        label: 'Open DeepSeek Harness Web',
        keywords: ['dsh', 'deepseek', 'harness', 'web', 'launcher'],
        run: () => void ensureDsh(ctx)
      }
    })
  }
}
