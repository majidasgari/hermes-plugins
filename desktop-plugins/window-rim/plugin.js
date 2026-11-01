/**
 * Window Rim — Hermes desktop plugin.
 *
 * 1) THE RIM — a colored border around the window edge, so a Hermes window is
 *    unmistakable next to every other window on the desktop (the app is
 *    frameless — `titleBarStyle: 'hidden'` — and its chrome is the same
 *    light/dark grey as the apps around it, so the window boundary disappears).
 *    One `position: fixed; inset: 0` overlay on <body> that draws only a border
 *    (`pointer-events: none`, so it never eats a click — it overlaps the
 *    titlebar drag strip). Max z-index, above every app surface. The app's own
 *    layout is untouched, so no measurement/virtualization is affected.
 *
 * 2) THE SETTINGS — a chip in the status bar (its dot is the live rim color)
 *    opens a popover built from the app's own primitives (`ColorSwatches` /
 *    `Input` / `Select` / `Switch`): rim color, any #rrggbb, thickness, focus
 *    dimming, hairline, glow. Choices persist in plugin storage and apply to
 *    THIS window instantly; other open Hermes windows follow through the
 *    localStorage `storage` event, so every window stays in step with no reload.
 *    A ⌘K entry ("قاب پنجره: رنگ بعدی") cycles the presets for keyboard use.
 *
 *    The same popover rounds the window's own corners (0-24px). On Linux the
 *    chat windows are born with an alpha surface for exactly this (see
 *    electron/main.ts: chatWindowSurfaceOptions) and the core css
 *    (styles.css: "Rounded window corners") clips the shell to
 *    --hermes-window-radius while this plugin sets the attribute — so the
 *    desktop shows through the four corner slivers. Radius 0 = the plain
 *    rectangle, attribute removed.
 *
 *    NOT on Settings ▸ Appearance, deliberately: that page mounts its plugin
 *    slot (`appearance.extra`) only while `subpage === undefined`, and the
 *    settings router resolves a subpage for EVERY view — `resolveSettingsSubpage`
 *    falls back to `pages[0].id`, and appearance declares six subpages — so
 *    nothing on that page is ever top-level and the slot cannot render. The
 *    status bar is a mount point the app actually renders.
 *
 * WHICH WINDOWS: only OPAQUE windows get the rim. The transparent ones
 * (`?win=hud|overlay|quick|wake|intro` — the pet, the floating HUD, the wake
 * indicator, the intro cinematic) have no visible rectangle to outline; a
 * border there would draw a floating box on the user's desktop. Secondary
 * session windows (`?win=secondary`) and the browser window are opaque and DO
 * get it — each Hermes window is individually identifiable.
 *
 * DEFAULTS below are what a fresh install looks like; once the user touches the
 * Settings rows, the stored choice is the source of truth.
 *
 * Save as: ~/.hermes/desktop-plugins/window-rim/plugin.js
 * (folder name == plugin id). Hot-reloads on save; toggle in Settings ▸ Plugins.
 */

import { createElement as h, useCallback, useState } from 'react'

import {
  ColorSwatches,
  Input,
  PALETTE_AREA,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  STATUSBAR_AREAS,
  Switch
} from '@hermes/plugin-sdk'

const ID = 'window-rim'
const STYLE_ID = 'hermes-plugin-window-rim-style'
const RIM_ID = 'hermes-plugin-window-rim'
const SLOT = '__hermesWindowRim'
const STORAGE_KEY = 'settings'

/** What a fresh install looks like. */
const DEFAULTS = {
  preset: 'emerald',
  custom: '',
  thickness: 2,
  radius: 0,
  dimUnfocused: true,
  hairline: true,
  glow: false
}

/** Opacity of an unfocused window's rim — quieter, but never invisible. */
const DIM_OPACITY = 0.5

const THICKNESSES = [1, 2, 3, 4]

/** Window corner radii. 0 = the plain rectangle (nothing to undo on screen). */
const RADII = [0, 2, 4, 6, 8, 10, 12, 16, 20, 24]

/** Preset colors, resolved for the app's light theme and its dark one
 *  (`.dark` on :root — the app's own selector, see src/themes/context.tsx). */
const PRESETS = {
  violet: { light: '#7c3aed', dark: '#a78bfa' },
  cyan: { light: '#0891b2', dark: '#22d3ee' },
  emerald: { light: '#059669', dark: '#34d399' },
  amber: { light: '#d97706', dark: '#fbbf24' },
  magenta: { light: '#db2777', dark: '#f472b6' },
  crimson: { light: '#dc2626', dark: '#f87171' },
  accent: { light: 'var(--ui-accent)', dark: 'var(--ui-accent)' }
}

const PRESET_KEYS = Object.keys(PRESETS)

const SWATCH_COLORS = PRESET_KEYS.map(key => PRESETS[key].light)

/** The `?win=` kinds whose Electron window is transparent: no rectangle to
 *  outline. Mirrors TRANSPARENT_WINDOWS in the app's src/main.tsx. */
const TRANSPARENT_WINDOWS = new Set(['hud', 'overlay', 'quick', 'wake', 'intro'])

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

// ============================================================ copy
// Strings are authored inline in Persian: the app's locale list
// (src/i18n/types.ts) ships no `fa` locale, so routing plugin copy through
// ctx.i18n would only ever fall back to English.

// ============================================================ state
let current = { ...DEFAULTS }

function resolveColor(settings) {
  const custom = typeof settings.custom === 'string' ? settings.custom.trim() : ''

  if (HEX_RE.test(custom)) {
    return { light: custom, dark: custom }
  }

  return PRESETS[settings.preset] ?? PRESETS.violet
}

function buildCss(settings) {
  const color = resolveColor(settings)
  const hairline = settings.hairline
    ? 'box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--rim-color) 34%, transparent) !important;'
    : ''
  const glow = settings.glow
    ? `#${RIM_ID}::after {
  content: '';
  position: absolute;
  inset: 0;
  box-shadow: inset 0 0 18px 0 color-mix(in srgb, var(--rim-color) 40%, transparent);
}`
    : ''

  return `
/* Window Rim — the whole rim is this one fixed layer. */
#${RIM_ID} {
  position: fixed !important;
  inset: 0 !important;
  z-index: 2147483647 !important;
  pointer-events: none !important;
  box-sizing: border-box !important;
  border: ${settings.thickness}px solid var(--rim-color) !important;
  border-radius: ${settings.radius}px !important;
  --rim-color: ${color.light};
  opacity: 1;
  transition: opacity 180ms ease !important;
  ${hairline}
}

:root.dark #${RIM_ID} {
  --rim-color: ${color.dark};
}

#${RIM_ID}[data-rim-unfocused] {
  opacity: ${settings.dimUnfocused ? DIM_OPACITY : 1};
}

${glow}
`
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULTS }
  }

  const preset = PRESET_KEYS.includes(raw.preset) ? raw.preset : DEFAULTS.preset
  const thickness = THICKNESSES.includes(Number(raw.thickness)) ? Number(raw.thickness) : DEFAULTS.thickness
  const radius = RADII.includes(Number(raw.radius)) ? Number(raw.radius) : DEFAULTS.radius

  return {
    preset,
    custom: typeof raw.custom === 'string' ? raw.custom : DEFAULTS.custom,
    thickness,
    radius,
    dimUnfocused: raw.dimUnfocused !== false,
    hairline: raw.hairline !== false,
    glow: raw.glow === true
  }
}

function readStored(storage) {
  try {
    return normalize(storage?.get?.(STORAGE_KEY, null))
  } catch {
    return { ...DEFAULTS }
  }
}

// ============================================================ DOM
/** Which window is this? A transparent one gets no rim. */
function shouldRender() {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return false
  }

  const kind = new URLSearchParams(window.location.search).get('win')

  return !(kind && TRANSPARENT_WINDOWS.has(kind))
}

/** Fresh style + rim nodes, dropping anything a previous build left behind. */
function mountDom() {
  for (const stale of document.querySelectorAll(`#${RIM_ID}, #${STYLE_ID}`)) {
    stale.remove()
  }

  const style = document.createElement('style')
  style.id = STYLE_ID
  document.head.appendChild(style)

  const rim = document.createElement('div')
  rim.id = RIM_ID
  rim.setAttribute('data-hermes-window-rim', '')
  rim.setAttribute('aria-hidden', 'true')
  document.body.appendChild(rim)

  return { rim, style }
}

function syncFocus(rim) {
  const focused = typeof document.hasFocus === 'function' ? document.hasFocus() : true

  if (focused) {
    rim.removeAttribute('data-rim-unfocused')
  } else {
    rim.setAttribute('data-rim-unfocused', '')
  }
}

/** Paint the current settings into the live stylesheet + rim node. */
function apply() {
  const style = document.getElementById(STYLE_ID)
  const rim = document.getElementById(RIM_ID)
  const root = document.documentElement

  // Corner radius. The core css (styles.css, "Rounded window corners") clips the
  // app shell to --hermes-window-radius only while this attribute is present,
  // which is what makes the desktop show through the four corners on Linux —
  // those windows are born with an alpha surface (electron/main.ts,
  // chatWindowSurfaceOptions), which is the whole reason a radius can work at
  // all. At 0 the attribute is absent, so the window is the plain rectangle the
  // app always drew and nothing has to be undone.
  if (root && root.style && typeof root.setAttribute === 'function') {
    if (current.radius > 0) {
      root.style.setProperty('--hermes-window-radius', `${current.radius}px`)
      root.setAttribute('data-hermes-window-radius', String(current.radius))
    } else {
      root.style.removeProperty('--hermes-window-radius')
      root.removeAttribute('data-hermes-window-radius')
    }
  }

  if (style) {
    style.textContent = buildCss(current)
  }

  if (rim) {
    syncFocus(rim)
  }
}

// ============================================================ settings UI
function presetForColor(color) {
  return PRESET_KEYS.find(key => PRESETS[key].light === color) ?? current.preset
}

/** Persian labels for the preset swatches — the plugin's own surface, so it
 *  carries its own copy (the app ships no `fa` locale). */
const PRESET_LABELS = {
  violet: 'بنفش',
  cyan: 'فیروزه‌ای',
  emerald: 'زمرد',
  amber: 'کهربایی',
  magenta: 'سرخابی',
  crimson: 'قرمز',
  accent: 'رنگ اپ'
}

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

/** One line of the popover: a label and the control that sets it. */
function row(label, control) {
  return h('div', { style: ROW_STYLE }, h('span', { style: LABEL_STYLE }, label), control)
}

/** One on/off line — clicking anywhere on the row flips it. */
function toggleRow(label, checked, onChange) {
  return h(
    'label',
    { style: { ...ROW_STYLE, cursor: 'pointer' } },
    h('span', { style: LABEL_STYLE }, label),
    h(Switch, { checked: checked === true, onCheckedChange: value => onChange(value === true) })
  )
}

/** The one write path: normalize, persist, repaint, hand back the new state. */
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

/** ⌘K: walk the presets without touching the mouse. */
function cyclePreset(ctx) {
  const index = PRESET_KEYS.indexOf(current.preset)

  return setSetting(ctx, { custom: '', preset: PRESET_KEYS[(index + 1) % PRESET_KEYS.length] })
}

/** Status-bar chip (its dot is the live rim color) + the settings popover. */
function RimChip({ ctx }) {
  const [settings, setSettings] = useState(() => current)
  const [draft, setDraft] = useState(() => current.custom)
  const [open, setOpen] = useState(false)

  // Another window, a ⌘K cycle or a reload can move the settings under us:
  // re-read them when the popover opens so it never shows a stale color.
  const onOpenChange = useCallback(next => {
    setOpen(next)

    if (next) {
      setSettings(current)
      setDraft(current.custom)
    }
  }, [])

  const update = useCallback(
    patch => {
      setSettings(setSetting(ctx, patch))
    },
    [ctx]
  )

  const customValid = HEX_RE.test(settings.custom.trim())
  const draftInvalid = draft.trim() !== '' && !HEX_RE.test(draft.trim())
  const rimColor = resolveColor(settings)

  return h(
    Popover,
    { onOpenChange, open },
    h(
      PopoverTrigger,
      { asChild: true },
      h(
        'button',
        { style: CHIP_STYLE, title: 'قاب پنجره — رنگ، ضخامت و حالت‌ها', type: 'button' },
        h('span', {
          'aria-hidden': true,
          style: {
            background: rimColor.light,
            borderRadius: '50%',
            boxShadow: 'inset 0 0 0 1px rgb(0 0 0 / 0.25)',
            flexShrink: 0,
            height: '7px',
            width: '7px'
          }
        }),
        h('span', null, 'قاب')
      )
    ),
    h(
      PopoverContent,
      { align: 'end', side: 'top', sideOffset: 6 },
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('div', { style: { fontSize: '12px', fontWeight: 600 } }, 'قاب پنجره'),
        h(ColorSwatches, {
          clearLabel: 'رنگ پیش‌فرض',
          onChange: color => update(color ? { custom: '', preset: presetForColor(color) } : { custom: '' }),
          swatchLabel: color => PRESET_LABELS[presetForColor(color)] ?? color,
          swatches: SWATCH_COLORS,
          value: customValid ? null : rimColor.light
        }),
        row(
          'رنگ دلخواه',
          h(Input, {
            'aria-invalid': draftInvalid ? 'true' : undefined,
            'aria-label': 'رنگ دلخواه',
            className: 'w-32 font-mono',
            onBlur: () => setDraft(current.custom),
            onChange: event => {
              const value = event.target.value

              setDraft(value)

              // Apply as soon as it is a usable color; an unfinished hex is text.
              if (value.trim() === '' || HEX_RE.test(value.trim())) {
                update({ custom: value })
              }
            },
            placeholder: '#7c3aed',
            value: draft
          })
        ),
        row(
          'ضخامت',
          h(
            Select,
            { onValueChange: value => update({ thickness: Number(value) }), value: String(settings.thickness) },
            h(SelectTrigger, { className: 'h-7 w-20 text-xs' }, h(SelectValue, null)),
            h(
              SelectContent,
              null,
              THICKNESSES.map(px => h(SelectItem, { key: px, value: String(px) }, `${px} پیکسل`))
            )
          )
        ),
        row(
          'گردی گوشه‌ها',
          h(
            Select,
            { onValueChange: value => update({ radius: Number(value) }), value: String(settings.radius) },
            h(SelectTrigger, { className: 'h-7 w-24 text-xs' }, h(SelectValue, null)),
            h(
              SelectContent,
              null,
              RADII.map(px =>
                h(SelectItem, { key: px, value: String(px) }, px === 0 ? 'بدون گردی' : `${px} پیکسل`)
              )
            )
          )
        ),
        toggleRow('کمرنگ در حالت بی‌فوکوس', settings.dimUnfocused, value => update({ dimUnfocused: value })),
        toggleRow('خط مویی درونی', settings.hairline, value => update({ hairline: value })),
        toggleRow('درخشش', settings.glow, value => update({ glow: value }))
      )
    )
  )
}

// ============================================================ plugin
export default {
  id: ID, // must match the folder name
  name: 'Window Rim',
  description: 'Colored rim around the window edge; colour/thickness in the status-bar chip.',
  register(ctx) {
    if (!shouldRender()) {
      return
    }

    // Retire the previous incarnation FIRST, and never let it abort this one.
    const previous = globalThis[SLOT]

    globalThis[SLOT] = null

    try {
      previous?.dispose?.()
    } catch {
      /* the stale build's teardown must never wedge the new one */
    }

    let dom = null
    const disposers = []

    current = readStored(ctx?.storage)

    try {
      dom = mountDom()
      apply()
    } catch (error) {
      console.error(`[${ID}] rim layer failed`, error)
    }

    try {
      disposers.push(
        ctx.register({
          area: STATUSBAR_AREAS.right,
          id: 'chip',
          order: 72,
          render: () => h(RimChip, { ctx }),
          title: 'قاب پنجره'
        })
      )
    } catch (error) {
      console.error(`[${ID}] status-bar chip failed`, error)
    }

    try {
      disposers.push(
        ctx.register({
          area: PALETTE_AREA,
          data: {
            id: `${ID}.nextColor`,
            keywords: ['rim', 'قاب', 'رنگ', 'window', 'border', 'color'],
            label: 'قاب پنجره: رنگ بعدی',
            run: () => cyclePreset(ctx)
          },
          id: 'next-color',
          order: 60
        })
      )
    } catch (error) {
      console.error(`[${ID}] palette entry failed`, error)
    }

    if (dom) {
      const onFocus = () => syncFocus(dom.rim)

      // Scoped listeners: the host removes them on reload/disable, so a stale
      // build can never keep reacting to focus changes.
      ctx?.addEventListener?.(window, 'focus', onFocus)
      ctx?.addEventListener?.(window, 'blur', onFocus)

      // Another Hermes window changed the setting — follow it here (the
      // localStorage event fires in the OTHER documents of the origin only).
      ctx?.addEventListener?.(window, 'storage', event => {
        if (!event?.key || !event.key.endsWith(`.${ID}.${STORAGE_KEY}`)) {
          return
        }

        current = readStored(ctx.storage)
        apply()
      })
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
        dom?.rim?.remove()
        dom?.style?.remove()
      } catch {
        /* never fatal */
      }
    }

    globalThis[SLOT] = { dispose }
    ctx?.onDispose?.(dispose)

    // Liveness check (leave out of the shipped file): a successful load logs
    // nothing on its own — only failures are reported. To prove which build is
    // live, add `console.error('[${ID}] registered')` right here and save; the
    // reload lands in ~/.hermes/logs/desktop.log as a
    // "[renderer console:main] ..." line. An EDIT reloads in place; a file that
    // was REPLACED (rename / atomic write) leaves the loader watching a dead
    // inode and never reloads again — park the folder outside the plugins root
    // and move it back to force a re-read.
  }
}
