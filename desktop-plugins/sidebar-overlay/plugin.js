/**
 * Sidebar Overlay — Hermes desktop plugin.
 *
 * The Sessions sidebar stops being a docked column: whenever it is open it
 * floats OVER the chat instead of squeezing it, so the chat keeps the full
 * window width. A click on the chat dismisses it (a drawer, not a column), and
 * every open starts on the newest session.
 *
 * THE PIN CHIP — a status-bar chip (right cluster) cycles three modes and
 * remembers the choice: «خودکار» (default) follows the window width — pinned to
 * the app's own docked column while the window is wide enough for a rail beside
 * a usable chat (≥960px), floating over the chat when it is not; «شناور» always
 * floats; «پین» always docks. Persisted through `ctx.storage`, so it survives a
 * restart and follows into the other open Hermes windows.
 *
 * HOW (no app code changed): the layout tree renders every pane as
 *   div[data-tree-split] > div (the track, inline `flex: 0 1 <width>px`)
 *                        > div[data-tree-group="<zone>"] > … > [data-tour="sessions-sidebar"]
 * A track that is `position: fixed` drops out of the flex row (the chat zone
 * absorbs the space). Its box comes from the app's own numbers: width from the
 * inline `flexBasis` (the persisted resize), top/height from the workspace box
 * (the layout tree's container) — NOT from the nearest positioned ancestor,
 * which a nested preset answers with a sub-rectangle (the panel then opened as
 * a strip at the bottom of the window).
 *
 * Closed (⌘B / the titlebar toggle) the app itself sets `display: none` on the
 * track, so nothing shows; a MINIMIZED zone (28px rail) is excluded by the
 * `:not([style*=…])` guard. The list mounts with ESTIMATED row heights and
 * measures them ~500ms later; native scroll anchoring paid for that growth by
 * scrolling the whole sidebar to its end — which is why it "opened at the very
 * bottom" — so anchoring is off for the sidebar and a scroll reset on open is
 * the safety net.
 *
 * DOM hook caveats: selectors use stable data attributes (data-tree-split,
 * data-tree-group, data-tour="sessions-sidebar"). If a future app version
 * renames them the rules stop matching (silent no-op), nothing else breaks.
 *
 * Save as: ~/.hermes/desktop-plugins/sidebar-overlay/plugin.js
 * (folder name == plugin id). Hot-reloads within seconds; otherwise ⌘K →
 * "Reload desktop plugins".
 */

import { createElement as h, useEffect, useState } from 'react'

import { STATUSBAR_AREAS } from '@hermes/plugin-sdk'

const ID = 'sidebar-overlay'
const STYLE_ID = 'hermes-plugin-sidebar-overlay'
const MODE_ATTR = 'data-hermes-sidebar-overlay'
const STORAGE_KEY = 'mode'
const WIDTH_VAR = '--hermes-sidebar-overlay-w'
const TOP_VAR = '--hermes-sidebar-overlay-top'
const HEIGHT_VAR = '--hermes-sidebar-overlay-h'

// The sidebar's track = the nearest split child whose DIRECT child is the zone
// holding the sessions sidebar (a deeper wrapper would also match its subtree).
const TRACK_WITH_SIDEBAR = "[data-tree-split] > div:has(> [data-tree-group] [data-tour='sessions-sidebar'])"

// Every rule is keyed on the mode attribute, so "pinned" is simply the app's
// own layout with none of this applied.
const CSS = `
/* ---------- the sessions track floats over the chat ---------- */
:root[${MODE_ATTR}='on'] ${TRACK_WITH_SIDEBAR}:not([style*='0 0 1.75rem']) {
  position: fixed !important;
  top: var(${TOP_VAR}, 0px) !important;
  height: var(${HEIGHT_VAR}, 100vh) !important;
  bottom: auto !important;
  left: 0 !important;
  right: auto !important;
  width: var(${WIDTH_VAR}, 260px) !important;
  min-width: 0 !important;
  max-width: none !important;
  flex: none !important;
  z-index: 30 !important;
  /* one themed hairline — flat, no glow (the panel is distinguished by the
     content it covers, not by elevation) */
  box-shadow: 0 0 0 1px var(--ui-stroke-tertiary, rgb(255 255 255 / 0.08)) !important;
}

/* Its resize seam would sit on the window edge — and resizing is meaningless
   for a floating panel, so remove the affordance instead of leaving a dead
   drag handle there. */
:root[${MODE_ATTR}='on'] ${TRACK_WITH_SIDEBAR} > [role='separator'] {
  display: none !important;
}

/* The virtualized list measures its rows a few hundred ms after mount; native
   scroll anchoring paid for that growth by scrolling the sidebar to its end
   (the "opens at the very bottom" report). Same call as the app's own thread
   viewport. */
:root[${MODE_ATTR}='on'] [data-tour='sessions-sidebar'] .scrollbar-fade {
  overflow-anchor: none !important;
}
`

// ============================================================ state
/** 'auto' follows the window width, 'float' and 'pin' are the user's override.
 *  Stored as `{mode}` (a legacy `{pinned:boolean}` just falls back to auto). */
let mode = 'auto'

/** Wide enough to carry a docked rail beside a usable chat: the panel's width
 *  (≥237px, 319 by default) plus the ~640px the chat wants. Below it the rail
 *  floats over the chat instead of squeezing it. */
const PIN_MIN_WIDTH = 960

function resolvedPinned() {
  return mode === 'pin' || (mode === 'auto' && window.innerWidth >= PIN_MIN_WIDTH)
}

function readMode(storage) {
  try {
    const stored = storage?.get?.(STORAGE_KEY, null)

    return stored?.mode === 'float' || stored?.mode === 'pin' ? stored.mode : 'auto'
  } catch {
    return 'auto'
  }
}

function writeMode(storage, value) {
  try {
    storage?.set?.(STORAGE_KEY, { mode: value })
  } catch {
    /* a storage hiccup must never take the plugin down */
  }
}

/** Pinned = the app's own docked column: the attribute (and so every rule
 *  above) is simply gone. Re-run on every resize — that is what makes 'auto'
 *  follow the window. */
function applyMode() {
  const root = document.documentElement

  if (resolvedPinned()) {
    root.removeAttribute(MODE_ATTR)
  } else {
    root.setAttribute(MODE_ATTR, 'on')
    syncGeometry()
  }
}

function installStyle() {
  let style = document.getElementById(STYLE_ID)
  if (!style) {
    style = document.createElement('style')
    style.id = STYLE_ID
    document.head.appendChild(style)
  }
  // Always overwrite: a hot-reloaded build must replace the previous CSS.
  style.textContent = CSS
}

// ============================================================ geometry
/** Publish the panel box from the app's own values: the width comes from the
 *  track's inline `style.flexBasis` ("calc(319px)" — the persisted resize,
 *  resolved by a detached probe so any CSS function works), the top/height from
 *  the workspace box (the layout tree's container). */
function syncGeometry() {
  const root = document.querySelector('[data-tree-split]')?.parentElement

  if (root) {
    const box = root.getBoundingClientRect()
    const vars = document.documentElement.style

    vars.setProperty(TOP_VAR, `${Math.round(box.top)}px`)
    vars.setProperty(HEIGHT_VAR, `${Math.round(box.height)}px`)
  }

  const basis = document.querySelector(TRACK_WITH_SIDEBAR)?.style.flexBasis
  if (!basis) return

  const probe = document.createElement('div')
  probe.style.cssText = `position:absolute;height:0;pointer-events:none;visibility:hidden;width:${basis}`
  document.body.appendChild(probe)
  const width = Math.round(probe.getBoundingClientRect().width)
  probe.remove()

  if (width > 0) document.documentElement.style.setProperty(WIDTH_VAR, `${width}px`)
}

/** A panel that opens on the newest session, not wherever its list happened to
 *  be scrolled. The container mounts with estimated row heights and the browser
 *  moves its scroll offset while the rows measure — with no JS call behind it
 *  (no scrollIntoView, no focus, no scrollTop write: verified), so a one-shot
 *  reset races it. LOCK the top for the measure window instead. */
function lockScrollTop(ms = 800) {
  const until = performance.now() + ms

  const step = () => {
    // Re-query each frame: the list remounts its container while it measures,
    // so a captured node can be a dead one.
    document.querySelectorAll("[data-tour='sessions-sidebar'] .scrollbar-fade").forEach(scroller => {
      if (scroller.scrollTop !== 0) scroller.scrollTop = 0
    })
    if (performance.now() < until) requestAnimationFrame(step)
  }

  step()
}

/** Is the panel on screen? A closed sidebar stays in the DOM as display:none,
 *  so ask the box, not the selector. */
function isPanelOpen() {
  const track = document.querySelector(TRACK_WITH_SIDEBAR)

  return Boolean(track) && track.getBoundingClientRect().width > 0
}

let wasOpen = false
let wasWide = false

// ============================================================ interactions
/** Flip the sidebar through the app's own toggle action ("Toggle sessions
 *  sidebar", mod+B): pane-bound, so it means the SIDEBAR even after ⌘\ moves
 *  it to the right edge. shortcut: a rebound mod+B needs this chord updated. */
function toggleSidebarChord() {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || '')
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'b',
      code: 'KeyB',
      ctrlKey: !mac,
      metaKey: mac,
      bubbles: true,
      cancelable: true
    })
  )
}

/** Clicking the chat (anywhere in the layout tree outside the panel) dismisses
 *  it — a drawer, not a column. Titlebar / statusbar / portalled popovers
 *  (dialogs, menus) are outside the tree and keep it open. Floating only: a
 *  pinned sidebar is the app's own column and must not vanish under a click. */
function onPointerDown(event) {
  if (resolvedPinned()) return

  const target = event.target
  if (!(target instanceof Element)) return
  if (target.closest(TRACK_WITH_SIDEBAR)) return
  if (!target.closest('[data-tree-split]')) return

  const track = document.querySelector(TRACK_WITH_SIDEBAR)

  // A closed sidebar stays in the DOM as `display: none` — width 0 means it
  // is not on screen, so there is nothing to dismiss.
  if (track && track.getBoundingClientRect().width > 0) toggleSidebarChord()
}

/** 'auto' manages the sidebar for you, so GROWING the window back past the
 *  threshold re-docks it — including opening it again when it had been
 *  dismissed while floating. Only on the crossing (not on every resize), or a
 *  sidebar you closed on a wide window could never stay closed. */
function onResize() {
  const wide = window.innerWidth >= PIN_MIN_WIDTH
  const crossedUp = wide && !wasWide

  applyMode()

  if (mode === 'auto' && crossedUp && !isPanelOpen()) {
    toggleSidebarChord()
    // Above the app's own narrow breakpoint the pane state and the screen can
    // disagree (a sidebar dismissed as a narrow overlay still reads "open"),
    // where one toggle means close. Re-check and flip again if it stayed shut.
    setTimeout(() => {
      if (!isPanelOpen()) toggleSidebarChord()
    }, 250)
  }

  wasWide = wide
}

// ============================================================ chip
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

const MODES = ['float', 'auto', 'pin']

const MODE_LABELS = { float: 'شناور', auto: 'خودکار', pin: 'پین' }

const MODE_TITLES = {
  float: 'سایدبار شناور روی چت — کلیک: خودکار (پنجرهٔ بزرگ = پین)',
  auto: 'خودکار: پنجرهٔ بزرگ پین، پنجرهٔ باریک شناور — کلیک: همیشه پین',
  pin: 'سایدبار پین شده (ستون ثابت) — کلیک: همیشه شناور'
}

/** Status-bar chip: the label is the chosen mode, the dot the LIVE state a
 *  click lands on (filled = docked column now, hollow = floating now — in
 *  'auto' that follows the window width). */
function PinChip({ ctx }) {
  const [current, setCurrent] = useState(mode)
  const [, setTick] = useState(0)

  // 'auto' resolves against the window width: re-render on resize so the dot
  // never shows a stale state.
  useEffect(() => {
    const bump = () => setTick(tick => tick + 1)

    window.addEventListener('resize', bump)

    return () => window.removeEventListener('resize', bump)
  }, [])

  const cycle = () => {
    mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length]
    writeMode(ctx?.storage, mode)
    applyMode()
    setCurrent(mode)
  }

  const isPinned = resolvedPinned()

  return h(
    'button',
    {
      'aria-pressed': isPinned,
      onClick: cycle,
      style: CHIP_STYLE,
      title: MODE_TITLES[current],
      type: 'button'
    },
    h('span', {
      'aria-hidden': true,
      style: {
        borderRadius: '50%',
        flexShrink: 0,
        height: '7px',
        width: '7px',
        background: isPinned ? 'var(--ui-accent, #0053fd)' : 'transparent',
        boxShadow: isPinned ? 'none' : 'inset 0 0 0 1px var(--ui-text-secondary, #c3c7d1)'
      }
    }),
    h('span', null, MODE_LABELS[current])
  )
}

// ============================================================ plugin
export default {
  id: ID, // must match the folder name
  name: 'Sidebar Overlay',
  description: 'Sidebar floats over the chat; auto-pins on wide windows. Status-bar chip cycles the mode.',
  register(ctx) {
    if (typeof document === 'undefined') return

    // Latest build wins on hot-reload: drop the previous incarnation's
    // observer/listeners before installing ours.
    const g = globalThis
    g.__hermesSidebarOverlayObserver?.disconnect()

    mode = readMode(ctx?.storage)
    installStyle()
    applyMode()
    wasOpen = isPanelOpen()

    let timer = null
    const observer = new MutationObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (resolvedPinned()) return

        syncGeometry()

        const open = isPanelOpen()
        if (open && !wasOpen) lockScrollTop()
        wasOpen = open
      }, 200)
    })

    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
    g.__hermesSidebarOverlayObserver = observer

    // Resize drives BOTH the 'auto' threshold and the published top/height
    // (the workspace box moves with the window). Seeded here so a restart on a
    // wide window is not treated as a crossing (it must not reopen a sidebar
    // the user left closed).
    wasWide = window.innerWidth >= PIN_MIN_WIDTH
    if (g.__hermesSidebarOverlayResize) window.removeEventListener('resize', g.__hermesSidebarOverlayResize)
    g.__hermesSidebarOverlayResize = onResize
    window.addEventListener('resize', onResize)

    // Capture phase, so the panel is gone before the click reaches the chat.
    if (g.__hermesSidebarOverlayDown) document.removeEventListener('pointerdown', g.__hermesSidebarOverlayDown, true)
    g.__hermesSidebarOverlayDown = onPointerDown
    document.addEventListener('pointerdown', onPointerDown, true)

    try {
      ctx?.register?.({
        area: STATUSBAR_AREAS.right,
        id: 'pin-chip',
        order: 71,
        render: () => h(PinChip, { ctx }),
        title: 'سایدبار: پین / شناور'
      })
    } catch (error) {
      console.error(`[${ID}] status-bar chip failed`, error)
    }

    // Another Hermes window changed the mode — follow it here (the storage
    // event fires in the OTHER documents of the origin only).
    ctx?.addEventListener?.(window, 'storage', event => {
      if (!event?.key || !event.key.endsWith(`.${ID}.${STORAGE_KEY}`)) return

      mode = readMode(ctx.storage)
      applyMode()
    })
  }
}
