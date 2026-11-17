/**
 * Session Color Tint — desktop plugin.
 *
 * Paints the session's own colour (the one Settings ▸ session menu → Color /
 * the sidebar dot shows) into the chat's SENT user messages:
 *
 *   the USER MESSAGE bubbles — the `--dt-user-bubble` token
 *
 * The COMPOSER deliberately gets NO colour: the write-in box keeps the app's
 * own default fill (the wash made an unsent draft look like a sent message),
 * and its accent/blue border is neutralised to a plain hairline — the app
 * paints `--dt-composer-ring` (theme accent) on the surface whenever the editor
 * has focus-visible, so an element-level `border-color` at `important` priority
 * is the only way to keep it colourless in BOTH states (rest + focus).
 *
 * No stores and no core change: the colour the app keeps for a session is in
 * localStorage (`hermes.desktop.sessionColors`, durable id → colour), the chat
 * pane carries `data-chat-surface`, and the paint is a plain CSS variable the
 * app already reads (`--dt-user-bubble`). Setting it on the pane is enough —
 * the app's own colour-mix formula stays in charge of the theme and of
 * Settings ▸ Appearance ▸ Message Bubble.
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

/** How much of the session colour goes into the user bubble. */
const BUBBLE_SHARE = 38

/** The composer's border, always: a neutral hairline (theme ink, 12%).
 *  Deliberately NOT accent-derived — no blue frame around the write-in box. */
const COMPOSER_BORDER = 'color-mix(in srgb, var(--ui-base) 12%, transparent)'

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

function paint(el, property, value, priority = '') {
  if (!el) {
    return
  }

  if (value) {
    if (el.style.getPropertyValue(property) !== value) {
      el.style.setProperty(property, value, priority)
    }
  } else if (el.style.getPropertyValue(property)) {
    el.style.removeProperty(property)
  }
}

/**
 * GHOST-TIMER GUARD.
 *
 * A previous build of this plugin stored its dispose CLOSURE in the hot-reload
 * slot; one reload later that closure was unreachable and its 600 ms interval
 * kept writing the composer fill. Two ticks then fight over the same inline
 * var and the box blinks once a second (colour on / off).
 *
 * An inline custom-property write cannot be beaten from CSS, so the only
 * non-destructive fix is to clear the stale value the instant it lands: the
 * observer runs before paint, so nothing ever flickers. It becomes a no-op
 * once the app restarts (the stale timer dies with the renderer) and costs one
 * empty check per repaint.
 */
const GUARDS = '__hermesSessionColorTintGuards'

function guardList() {
  let list = globalThis[GUARDS]

  if (!Array.isArray(list)) {
    list = []
    Object.defineProperty(list, 'roots', { value: new WeakSet(), configurable: true })
    globalThis[GUARDS] = list
  }

  return list
}

function stopGuards() {
  for (const observer of guardList()) {
    try {
      observer.disconnect()
    } catch {
      /* never fatal */
    }
  }

  globalThis[GUARDS] = null
}

function ensureGuard(root) {
  if (!root) {
    return
  }

  const list = guardList()

  if (list.roots.has(root)) {
    return
  }

  list.roots.add(root)

  const observer = new MutationObserver(() => {
    if (root.style.getPropertyValue('--composer-fill')) {
      root.style.removeProperty('--composer-fill')
    }
  })

  observer.observe(root, { attributes: true, attributeFilter: ['style'] })
  list.push(observer)
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

    // Composer: default fill, colourless border. The fill var is cleared here
    // (an older build set it) and the guard clears any stale write that lands
    // afterwards, so nothing blinks.
    const composerRoot = surface.querySelector('[data-slot="composer-root"]')
    paint(composerRoot, '--composer-fill', '')
    ensureGuard(composerRoot)

    // `important` beats the app's own `!important` rules for the resting ring
    // AND the focus-visible ring (`--dt-composer-ring`, the theme accent).
    paint(
      composerRoot?.querySelector('[data-slot="composer-surface"]'),
      'border-color',
      COMPOSER_BORDER,
      'important'
    )
  }
}

function clearAll() {
  for (const surface of document.querySelectorAll('[data-chat-surface]')) {
    paint(surface, '--dt-user-bubble', '')

    const composerRoot = surface.querySelector('[data-slot="composer-root"]')
    paint(composerRoot, '--composer-fill', '')
    paint(composerRoot?.querySelector('[data-slot="composer-surface"]'), 'border-color', '')
  }
}

export default {
  id: ID,
  name: 'Session Color Tint',
  defaultEnabled: true,
  register(ctx) {
    if (typeof document === 'undefined') {
      return
    }

    // Latest build wins on hot-reload: kill the previous tick. The slot carries
    // DATA only (a timer id), never a previous build's closure.
    const previous = globalThis[SLOT]
    globalThis[SLOT] = null

    stopGuards()

    try {
      if (typeof previous === 'function') {
        // A build that stored its dispose CLOSURE (older shape) — call it, or
        // its tick keeps writing the composer fill forever.
        previous()
      } else if (previous && typeof previous.timer === 'number') {
        window.clearInterval(previous.timer)
      }
    } catch {
      /* a stale teardown must never wedge this one */
    }

    let lastError = ''

    const tick = () => {
      try {
        apply()
        lastError = ''
      } catch (error) {
        // A 600 ms tick would otherwise repeat the same failure 100×/min into
        // desktop.log; report a changed failure once.
        const detail = String(error?.message || error)

        if (detail !== lastError) {
          lastError = detail
          console.error(`[${ID}] tint failed`, error)
        }
      }
    }

    tick()
    const timer = window.setInterval(tick, TICK_MS)

    const dispose = () => {
      window.clearInterval(timer)
      stopGuards()
      try {
        clearAll()
      } catch {
        /* never fatal */
      }
    }

    globalThis[SLOT] = { timer }


    // The loader's own teardown hook — runs on reload/disable.
    try {
      ctx?.onDispose?.(dispose)
    } catch {
      /* older loader: the slot above still stops the tick */
    }
  }
}
