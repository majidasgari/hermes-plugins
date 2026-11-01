/**
 * Chat Wallpaper — a background image behind the chats, with an opacity dial.
 *
 * One injected stylesheet, nothing else:
 *   [data-chat-surface]      — the chat pane root. Redeclearing
 *                              `--ui-chat-surface-background: transparent` there
 *                              (not !important, an element declaration beats the
 *                              :root one) empties EVERY surface inside the pane
 *                              that paints that token — the pane itself, the
 *                              thread container, message slabs — which is the
 *                              same state the app's own glass mode puts them in.
 *   [data-chat-surface]::before — the image, `position:absolute; inset:0` on the
 *                              pane (it is already `relative isolate`), painted
 *                              at `z-index:-1` so it sits behind content but
 *                              above the transparent surface. Never eats a click.
 *
 * The picked file is downscaled to <=2560px and stored as a JPEG data URL in
 * plugin storage, so the wallpaper survives a restart and no path has to be
 * typed; the thumbnail never leaves this machine.
 *
 * Settings live in a status-bar chip (always on screen, no core change): pick an
 * image, dial its opacity, clear it. Another Hermes window follows over the
 * localStorage `storage` event.
 *
 * Save as: ~/.hermes/desktop-plugins/chat-wallpaper/plugin.js
 * (folder name == plugin id). Hot-reloads on save; toggle in Settings ▸ Plugins.
 */

import { createElement as h, useCallback, useState } from 'react'

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  STATUSBAR_AREAS
} from '@hermes/plugin-sdk'

const ID = 'chat-wallpaper'
const STYLE_ID = 'hermes-plugin-chat-wallpaper-style'
const SLOT = '__hermesChatWallpaper'
const STORAGE_KEY = 'settings'

/** What a fresh install looks like: no image, so the plugin paints nothing. */
const DEFAULTS = { image: '', opacity: 35 }

const OPACITIES = [10, 20, 35, 50, 75, 100]

/** Longest side kept from the picked image — a wallpaper never needs more. */
const MAX_SIDE = 2560

/** Stay well inside localStorage's ~5 MB per origin. */
const MAX_CHARS = 3_500_000

// ============================================================ state
let current = { ...DEFAULTS }

function normalize(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULTS }
  }

  return {
    image: typeof raw.image === 'string' ? raw.image : DEFAULTS.image,
    opacity: OPACITIES.includes(Number(raw.opacity)) ? Number(raw.opacity) : DEFAULTS.opacity
  }
}

function readStored(storage) {
  try {
    return normalize(storage?.get?.(STORAGE_KEY, null))
  } catch {
    return { ...DEFAULTS }
  }
}

// ============================================================ css
function buildCss(settings) {
  if (!settings.image) {
    return ''
  }

  return `
/* Chat Wallpaper — the image behind the chats. */
[data-chat-surface] {
  --ui-chat-surface-background: transparent;
}

[data-chat-surface]::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background-image: url("${settings.image}");
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
  opacity: ${settings.opacity / 100};
}
`
}

function apply() {
  const style = document.getElementById(STYLE_ID)

  if (style) {
    style.textContent = buildCss(current)
  }
}

/** Fresh style node, dropping anything a previous build left behind. */
function mountDom() {
  for (const stale of document.querySelectorAll(`#${STYLE_ID}`)) {
    stale.remove()
  }

  const style = document.createElement('style')
  style.id = STYLE_ID
  document.head.appendChild(style)

  return { style }
}

/** One write path: normalize, persist, repaint. */
function setSetting(ctx, patch) {
  current = normalize({ ...current, ...patch })

  try {
    ctx?.storage?.set?.(STORAGE_KEY, current)
  } catch {
    /* persistence is best-effort */
  }

  apply()

  return current
}

// ============================================================ image
/** Downscale + re-encode in the renderer: a 12 MP photo becomes a few hundred KB. */
async function imageToDataUrl(file) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')

  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)

  let url = canvas.toDataURL('image/jpeg', 0.82)

  // A hard-to-compress image: halve it once before giving up.
  if (url.length > MAX_CHARS) {
    const half = document.createElement('canvas')

    half.width = Math.max(1, canvas.width >> 1)
    half.height = Math.max(1, canvas.height >> 1)
    half.getContext('2d').drawImage(canvas, 0, 0, half.width, half.height)
    url = half.toDataURL('image/jpeg', 0.72)
  }

  return url.length > MAX_CHARS ? '' : url
}

// ============================================================ settings UI (Persian copy is inline: the app ships no `fa` locale)
const CHIP_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  height: '100%',
  padding: '0 8px',
  fontSize: '11px',
  fontWeight: 500,
  lineHeight: 1,
  color: 'var(--ui-text-secondary, #c3c7d1)',
  cursor: 'pointer',
  background: 'transparent',
  border: 'none',
  borderRadius: '4px',
  fontFamily: 'inherit'
}

const LABEL_STYLE = { fontSize: '11px', color: 'var(--ui-text-secondary, #c3c7d1)' }

const ROW_STYLE = { display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between' }

const ACTION_STYLE = {
  ...LABEL_STYLE,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '26px',
  padding: '0 10px',
  border: '1px solid var(--ui-stroke-secondary, #3a3f47)',
  borderRadius: '6px',
  cursor: 'pointer',
  color: 'var(--ui-text-primary, #e7e9ee)'
}

function row(label, control) {
  return h('div', { style: ROW_STYLE }, h('span', { style: LABEL_STYLE }, label), control)
}

function WallpaperChip({ ctx }) {
  const [settings, setSettings] = useState(() => current)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)

  // Another window or a reload can move the settings under us.
  const onOpenChange = useCallback(next => {
    setOpen(next)

    if (next) {
      setSettings(current)
      setError('')
    }
  }, [])

  const update = useCallback(patch => setSettings(setSetting(ctx, patch)), [ctx])

  const onPick = useCallback(
    async event => {
      const file = event.target.files?.[0]

      event.target.value = ''

      if (!file) {
        return
      }

      try {
        const url = await imageToDataUrl(file)

        if (!url) {
          setError('تصویر خیلی سنگین است — یکی کوچک‌تر انتخاب کن')

          return
        }

        setError('')
        update({ image: url })
      } catch (cause) {
        setError('این فایل تصویر نیست')

        console.error(`[${ID}] image pick failed`, cause)
      }
    },
    [update]
  )

  return h(
    Popover,
    { onOpenChange, open },
    h(
      PopoverTrigger,
      { asChild: true },
      h(
        'button',
        { style: CHIP_STYLE, title: 'پس‌زمینهٔ چت — تصویر و شفافیت', type: 'button' },
        h('span', {
          'aria-hidden': true,
          style: {
            background: settings.image ? 'var(--ui-accent)' : 'transparent',
            border: '1px solid var(--ui-stroke-secondary, #5a616b)',
            borderRadius: '50%',
            flexShrink: 0,
            height: '7px',
            width: '7px'
          }
        }),
        h('span', null, 'پس‌زمینه')
      )
    ),
    h(
      PopoverContent,
      { align: 'end', side: 'top', sideOffset: 6 },
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('div', { style: { fontSize: '12px', fontWeight: 600 } }, 'پس‌زمینهٔ چت'),
        h(
          'label',
          { style: ACTION_STYLE },
          'انتخاب تصویر…',
          h('input', {
            accept: 'image/*',
            onChange: onPick,
            style: { display: 'none' },
            type: 'file'
          })
        ),
        row(
          'شفافیت',
          h(
            Select,
            { onValueChange: value => update({ opacity: Number(value) }), value: String(settings.opacity) },
            h(SelectTrigger, { className: 'h-7 w-20 text-xs' }, h(SelectValue, null)),
            h(
              SelectContent,
              null,
              OPACITIES.map(percent => h(SelectItem, { key: percent, value: String(percent) }, `${percent}٪`))
            )
          )
        ),
        settings.image
          ? h(
              'button',
              { onClick: () => update({ image: '' }), style: ACTION_STYLE, type: 'button' },
              'حذف تصویر'
            )
          : null,
        error ? h('div', { style: { ...LABEL_STYLE, color: 'var(--ui-danger, #f87171)' } }, error) : null
      )
    )
  )
}

// ============================================================ plugin
export default {
  id: ID, // must match the folder name
  name: 'Chat Wallpaper',
  description: 'Background image behind the chats, with an opacity dial in the status bar.',
  register(ctx) {
    // Retire the previous incarnation FIRST, and never let it abort this one.
    const previous = globalThis[SLOT]

    globalThis[SLOT] = null

    try {
      previous?.dispose?.()
    } catch {
      /* the stale build's teardown must never wedge the new one */
    }

    const disposers = []

    current = readStored(ctx?.storage)

    try {
      mountDom()
      apply()
    } catch (error) {
      console.error(`[${ID}] stylesheet failed`, error)
    }

    try {
      disposers.push(
        ctx.register({
          area: STATUSBAR_AREAS.right,
          id: 'chip',
          order: 74,
          render: () => h(WallpaperChip, { ctx }),
          title: 'پس‌زمینهٔ چت'
        })
      )
    } catch (error) {
      console.error(`[${ID}] status-bar chip failed`, error)
    }

    // Another Hermes window changed the setting — follow it here (the
    // localStorage event fires in the OTHER documents of the origin only).
    try {
      ctx?.addEventListener?.(window, 'storage', event => {
        if (!event?.key || !event.key.endsWith(`.${ID}.${STORAGE_KEY}`)) {
          return
        }

        current = readStored(ctx.storage)
        apply()
      })
    } catch (error) {
      console.error(`[${ID}] storage listener failed`, error)
    }

    const dispose = () => {
      for (const disposeContribution of disposers) {
        try {
          disposeContribution()
        } catch {
          /* never fatal */
        }
      }

      try {
        document.getElementById(STYLE_ID)?.remove()
      } catch {
        /* never fatal */
      }
    }

    globalThis[SLOT] = { dispose }
    ctx?.onDispose?.(dispose)
  }
}
