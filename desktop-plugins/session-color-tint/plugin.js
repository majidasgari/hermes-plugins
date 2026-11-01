/**
 * Session Color Tint — desktop plugin.
 *
 * Paints the session's own colour (the one Settings ▸ session menu → Color /
 * the sidebar dot shows) into two more places of that chat:
 *
 *   1. the USER MESSAGE bubbles (both sides of the `--dt-user-bubble` token)
 *   2. the COMPOSER box, as a low-opacity wash of the same colour
 *
 * No stores and no core change: the colour the app keeps for a session is in
 * localStorage (`hermes.desktop.sessionColors`, durable id → colour), the chat
 * pane carries `data-chat-surface`, and both paints are plain CSS variables the
 * app already reads (`--dt-user-bubble`, `--composer-fill`). Setting them on the
 * pane / composer root is enough — the app's own colour-mix formulas stay in
 * charge of the theme and of Settings ▸ Appearance ▸ Message Bubble.
 *
 * WHICH SESSION a pane shows: a tile pane names its own session in
 * `data-session-anchor="session-tile:<id>"`. The primary pane says only
 * "workspace", so it follows `host.state.focusedStoredSessionId` — unless the
 * focused chat is one of the visible tiles, in which case the primary is showing
 * some other chat and gets NO tint rather than the wrong one.
 *
 * A 600 ms tick is the whole trigger (colour picked, session switched, tile
 * opened, another window recoloured) — cheaper to reason about than observers,
 * and it writes only when a value actually changes.
 *
 * Save as: ~/.hermes/desktop-plugins/session-color-tint/plugin.js
 * (folder name == plugin id). Hot-reloads on save; toggle in Settings ▸ Plugins.
 */

import { host } from '@hermes/plugin-sdk'

const ID = 'session-color-tint'
const SLOT = '__hermesSessionColorTint'

/** Where the app persists per-session colours (store/session-color.ts). */
const COLORS_KEY = 'hermes.desktop.sessionColors'

/** How much of the session colour goes into the user bubble / the composer. */
const BUBBLE_SHARE = 38
const COMPOSER_SHARE = 18

const TICK_MS = 600

/** A colour we are willing to splice into a CSS function: the app writes
 *  `#rrggbb` or one of the palette's `hsl(...)` strings. Anything else is
 *  ignored rather than injected. */
const COLOR_RE = /^(#[0-9a-f]{3,8}|(?:hsl|hsla|rgb|rgba|oklch|oklab|lab|lch)\([0-9a-z%.,\s/+-]*\))$/i

const TILE_PREFIX = 'session-tile:'

function readSessionColors() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(COLORS_KEY) || '{}')

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }

    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === 'string' && COLOR_RE.test(value))
    )
  } catch {
    return {}
  }
}

/** The theme's own bubble fill (Message Bubble transparency included) with the
 *  session colour mixed in — the app's formula, one extra colour stop. */
const bubbleFill = color =>
  `color-mix(in srgb, ${color} ${BUBBLE_SHARE}%, color-mix(in srgb, var(--ui-chat-bubble-background) var(--user-bubble-keep, 100%), transparent))`

/** A washed-out, see-through version of the same colour over a softer card. */
const composerFill = color =>
  `color-mix(in srgb, ${color} ${COMPOSER_SHARE}%, color-mix(in srgb, var(--dt-card) 55%, transparent))`

function paint(el, property, value) {
  if (!el) {
    return
  }

  if (value) {
    if (el.style.getPropertyValue(property) !== value) {
      el.style.setProperty(property, value)
    }
  } else if (el.style.getPropertyValue(property)) {
    el.style.removeProperty(property)
  }
}

function apply() {
  const colors = readSessionColors()
  const focused = host?.state?.focusedStoredSessionId?.get?.() ?? null
  const surfaces = [...document.querySelectorAll('[data-chat-surface]')]

  // A visible tile that owns the focused chat means the primary pane is showing
  // a DIFFERENT chat — it must not inherit the tile's colour.
  const tileIds = new Set(
    surfaces
      .map(el => el.dataset.sessionAnchor || '')
      .filter(anchor => anchor.startsWith(TILE_PREFIX))
      .map(anchor => anchor.slice(TILE_PREFIX.length))
  )

  for (const surface of surfaces) {
    const anchor = surface.dataset.sessionAnchor || ''
    const owned = anchor.startsWith(TILE_PREFIX) ? anchor.slice(TILE_PREFIX.length) : null
    const sessionId = owned ?? (focused && !tileIds.has(focused) ? focused : null)
    const color = sessionId ? colors[sessionId] : null

    paint(surface, '--dt-user-bubble', color ? bubbleFill(color) : '')
    paint(surface.querySelector('[data-slot="composer-root"]'), '--composer-fill', color ? composerFill(color) : '')
  }

}

function clearAll() {
  for (const surface of document.querySelectorAll('[data-chat-surface]')) {
    paint(surface, '--dt-user-bubble', '')
    paint(surface.querySelector('[data-slot="composer-root"]'), '--composer-fill', '')
  }
}

export default {
  id: ID,
  name: 'Session Color Tint',
  defaultEnabled: true,
  register() {
    if (typeof document === 'undefined') {
      return
    }

    // Latest build wins on hot-reload: the previous incarnation's tick must die.
    const previous = globalThis[SLOT]
    globalThis[SLOT] = null
    try {
      previous?.()
    } catch {
      /* a stale teardown must never wedge this one */
    }

    const tick = () => {
      try {
        apply()
      } catch (error) {
        console.error(`[${ID}] tint failed`, error)
      }
    }

    tick()
    const timer = window.setInterval(tick, TICK_MS)

    const dispose = () => {
      window.clearInterval(timer)
      try {
        clearAll()
      } catch {
        /* never fatal */
      }
    }

    globalThis[SLOT] = dispose
  }
}
