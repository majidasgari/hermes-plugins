/**
 * Pretty Sidebar — Hermes desktop plugin.
 *
 * (A) ONE ⋯ MENU INSTEAD OF TWO BARS — the five nav rows (New session, Skills,
 *     Messaging, Artifacts, Scheduled) and the section switcher (Pinned /
 *     Sessions / platforms / Scheduled jobs) both fold into a single "⋯"
 *     button at the right end of the Search-sessions row. Closed, the sidebar
 *     gives away ZERO rows to either: the nav list is display:none, the
 *     switcher is a floating card that only exists while the menu is open.
 * (B) SESSION ROWS AS CARDS — rounded, seam-separated cards; active session
 *     gets an accent fill + inset ring.
 * (C) RTL TITLES — a row whose own text is RTL is drawn RTL + right-aligned.
 *
 * HOW (no app changes, native affordances only):
 *   - The nav rows stay the app's OWN <ul> of real buttons — nothing is
 *     cloned or moved, only re-positioned (fixed) while the menu is open, so
 *     every native behaviour survives: split submenu, tooltips, keybind hints,
 *     the "drag New session onto a zone" gesture, active-row state.
 *   - The section list is our own card; a row click clicks the section's
 *     native header toggle (expand target, collapse the rest) — the same
 *     affordance a manual collapse uses, so layout math and virtualization
 *     stay native. Non-active section roots are only display:none'd.
 *   - Gating attribute is :root[data-pretty-menu] — set only while the trigger
 *     is actually mounted. No trigger (collapsed rail, search view) → the app's
 *     own nav stays exactly as shipped.
 *
 * DOM hooks: data-tour="sessions-sidebar", data-sessions-mode, the nav rows'
 * data-tour^="sidebar-nav-", the section headers' `group/section-label` class
 * token, and the search row found from the sidebar's own <input>. A future
 * rename costs one feature, not the styling.
 *
 * Save as: ~/.hermes/desktop-plugins/pretty-sidebar/plugin.js (folder name ==
 * plugin id). Hot-reloads within seconds; if not, ⌘K → "Reload desktop plugins".
 */

const ID = 'pretty-sidebar'
const STYLE_ID = 'hermes-plugin-pretty-sidebar'
const PANEL_ID = 'hermes-plugin-pretty-menu'
const TRIGGER_ID = 'hermes-plugin-pretty-trigger'
const ROOT_ATTR = 'data-pretty-menu' // '' (ready) | 'open'

const NAV_UL = "[data-tour='sessions-sidebar'] ul:has(> li [data-tour^='sidebar-nav-'])"
const LABEL_BTN_SEL = 'button.group\\/section-label'

// ============================================================ CSS
const CARD = `
  background: var(--ui-bg-elevated, #1c1c20) !important;
  border: 1px solid var(--ui-stroke-tertiary, rgba(127, 127, 127, 0.25)) !important;
  border-radius: 10px !important;
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.22) !important;
  padding: 4px !important;
  max-height: calc(100vh - 96px) !important;
  overflow-y: auto !important;
`

const CSS = `
/* ---------- (A) The nav rows become the top block of the ⋯ menu ---------- */
:root[${ROOT_ATTR}] ${NAV_UL} {
  display: none !important;
}
:root[${ROOT_ATTR}='open'] ${NAV_UL} {
  display: flex !important;
  position: fixed !important;
  z-index: 60 !important;
  flex-direction: column !important;
  gap: 1px !important;
  ${CARD}
}

/* trigger: last thing on the Search-sessions row */
#${TRIGGER_ID} {
  appearance: none;
  flex: 0 0 auto;
  margin-left: auto;
  height: 24px;
  width: 24px;
  display: grid;
  place-items: center;
  padding: 0;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--ui-text-tertiary, inherit);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
#${TRIGGER_ID}:hover,
#${TRIGGER_ID}[aria-expanded='true'] {
  background: color-mix(in srgb, var(--ui-accent, #0053fd) 12%, transparent);
  color: var(--ui-text-primary, inherit);
}
#${TRIGGER_ID} svg {
  display: block;
  width: 15px;
  height: 15px;
}

/* section switcher: the second block of the same menu */
#${PANEL_ID} {
  display: none;
  position: fixed;
  z-index: 60;
  ${CARD}
}
:root[${ROOT_ATTR}='open'] #${PANEL_ID} {
  display: block;
}
#${PANEL_ID} button {
  appearance: none;
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--ui-text-secondary, inherit);
  font-size: 0.8125rem;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#${PANEL_ID} button:hover {
  background: var(--ui-control-hover-background, rgba(127, 127, 127, 0.12));
  color: var(--ui-text-primary, inherit);
}
#${PANEL_ID} button[aria-pressed='true'] {
  background: color-mix(in srgb, var(--ui-accent, #0053fd) 14%, transparent);
  color: var(--ui-accent, #0053fd);
}

/* ---------- (B) Session rows as modern cards ---------- */
[data-sessions-mode] .row-hover {
  border-radius: 9px !important;
  background: color-mix(in srgb, var(--ui-accent, #0053fd) 3%, transparent) !important;
  border-bottom: 2px solid var(--ui-sidebar-surface-background, transparent) !important;
  transition: background 0.12s ease, box-shadow 0.12s ease !important;
}
[data-sessions-mode] .row-hover:hover {
  background: color-mix(in srgb, var(--ui-accent, #0053fd) 7%, transparent) !important;
}
[data-sessions-mode] .row-hover[data-glass-opaque] {
  background: var(--ui-sidebar-surface-background, transparent) !important;
  box-shadow: none !important;
}
[data-sessions-mode] .row-hover[class~='bg-(--ui-row-active-background)'] {
  background: color-mix(in srgb, var(--ui-accent, #0053fd) 14%, transparent) !important;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ui-accent, #0053fd) 45%, transparent) !important;
}
[data-sessions-mode] .row-hover[class~='bg-(--ui-row-open-background)'] {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ui-accent, #0053fd) 22%, transparent) !important;
}
`

// ============================================================ shared state
let recomputeTimer = null
let activeTab = null // index into the last known section snapshot
let menuWired = false

const THREE_DOTS =
  '<svg viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">' +
  '<circle cx="2.9" cy="7" r="1.25"/><circle cx="7" cy="7" r="1.25"/><circle cx="11.1" cy="7" r="1.25"/></svg>'

function root(el) {
  return document.documentElement
}

function menuState() {
  return root().getAttribute(ROOT_ATTR)
}

function setMenu(state) {
  if (state) root().setAttribute(ROOT_ATTR, state)
  else root().removeAttribute(ROOT_ATTR)
  const trigger = document.getElementById(TRIGGER_ID)
  if (trigger) trigger.setAttribute('aria-expanded', String(state === 'open'))
}

// ============================================================ sections
function getSidebar() {
  return document.querySelector('[data-tour="sessions-sidebar"]')
}

function getWrapper() {
  return document.querySelector('[data-tour="sessions-sidebar"] [data-sessions-mode]')
}

function getSearchRow() {
  const input = getSidebar()?.querySelector('input')
  return input ? input.closest('div')?.parentElement ?? null : null
}

function labelOf(section) {
  const btn = section.querySelector(LABEL_BTN_SEL)
  if (!btn) return ''
  // The caption span, so a platform avatar's own text never doubles up.
  const caption = btn.querySelector('.truncate')
  const text = (caption ? caption.textContent : btn.textContent) || ''
  return text.replace(/\s+/g, ' ').trim()
}

function isSectionOpen(section) {
  // A section root is [header, content?]; content unmounts when collapsed.
  return section.childElementCount > 1
}

function collectSections(wrapper) {
  return [...wrapper.children].filter(el => el.querySelector(LABEL_BTN_SEL))
}

function buildPanel(sections) {
  const panel = document.createElement('div')
  panel.id = PANEL_ID
  panel.setAttribute('role', 'menu')
  sections.forEach((_, i) => panel.appendChild(buildPanelRow(i, sections)))
  return panel
}

function buildPanelRow(index, sections) {
  const label = labelOf(sections[index]) || `Section ${index + 1}`
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.textContent = label
  btn.title = label
  btn.setAttribute('aria-pressed', 'false')
  btn.addEventListener('click', () => onSectionPick(index))
  return btn
}

function syncPanel(panel, sections) {
  const key = sections.map(s => labelOf(s)).join('\u0001')
  if (panel.dataset.key === key) return
  panel.dataset.key = key
  const frag = document.createDocumentFragment()
  sections.forEach((_, i) => frag.appendChild(buildPanelRow(i, sections)))
  panel.replaceChildren(frag)
}

// Collapse/expand the native section toggles so exactly `activeIndex` is open,
// then hide the other roots (display only — open state stays the app's).
function applyTabs(sections, activeIndex) {
  sections.forEach((section, i) => {
    const target = i === activeIndex
    const toggle = section.querySelector(LABEL_BTN_SEL)
    if (toggle && isSectionOpen(section) !== target) toggle.click()
    section.style.display = target ? '' : 'none'
  })
}

function onSectionPick(index) {
  const wrapper = getWrapper()
  if (!wrapper) return
  const sections = collectSections(wrapper)
  if (index < 0 || index >= sections.length) return
  activeTab = index
  applyTabs(sections, index)
  closeMenu()
  setTimeout(recompute, 250)
}

// ============================================================ menu
function navList() {
  return document.querySelector(NAV_UL)
}

function openMenu() {
  const nav = navList()
  if (!nav) return
  setMenu('open')
  if (!menuWired) {
    menuWired = true
    // A nav row click must run the app's own handler first (React listens at
    // the root, i.e. after us) — close on the next tick.
    nav.addEventListener('click', () => setTimeout(closeMenu, 0))
    document.addEventListener(
      'pointerdown',
      event => {
        if (menuState() !== 'open') return
        const t = event.target
        if (t.closest?.(`#${PANEL_ID}`) || t.closest?.(`#${TRIGGER_ID}`)) return
        if (navList()?.contains(t)) return
        closeMenu()
      },
      true
    )
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeMenu()
    })
    window.addEventListener('resize', closeMenu)
  }
  place()
}

function closeMenu() {
  if (menuState() === 'open') setMenu('ready')
}

function place() {
  const trigger = document.getElementById(TRIGGER_ID)
  const nav = navList()
  const sidebar = getSidebar()
  if (!trigger || !nav || !sidebar) return
  const t = trigger.getBoundingClientRect()
  const s = sidebar.getBoundingClientRect()
  const top = t.bottom + 4
  const left = s.left + 8
  const width = Math.max(120, s.width - 16)
  nav.style.left = `${left}px`
  nav.style.top = `${top}px`
  nav.style.width = `${width}px`
  // The switcher card stacks under whatever height the nav block took.
  const panel = document.getElementById(PANEL_ID)
  if (panel) {
    panel.style.left = `${left}px`
    panel.style.top = `${top + (nav.getBoundingClientRect().height || 0) + 4}px`
    panel.style.width = `${width}px`
  }
}

// ============================================================ recompute
function ensureTrigger(row) {
  let trigger = document.getElementById(TRIGGER_ID)
  if (!trigger) {
    trigger = document.createElement('button')
    trigger.id = TRIGGER_ID
    trigger.type = 'button'
    trigger.title = 'منو'
    trigger.setAttribute('aria-label', 'menu')
    trigger.setAttribute('aria-expanded', 'false')
    trigger.innerHTML = THREE_DOTS
    trigger.addEventListener('click', () => {
      if (menuState() === 'open') closeMenu()
      else openMenu()
    })
  }
  // The row is the app's own block container; lay it out as a flex row so the
  // trigger can take the empty space after the (content-sized) search field.
  row.style.display = 'flex'
  row.style.alignItems = 'center'
  if (trigger.parentNode !== row) row.appendChild(trigger)
}

function recompute() {
  if (typeof document === 'undefined') return
  const wrapper = getWrapper()
  const row = getSearchRow()
  const panel = document.getElementById(PANEL_ID) || document.body.appendChild(buildPanel([]))

  if (!wrapper || !row) {
    // No sidebar / no search row (collapsed rail, search view): hand the
    // sidebar back to the app untouched.
    setMenu(null)
    closePanelInto(panel)
    return
  }

  ensureTrigger(row)
  if (!menuState()) setMenu('ready')

  const mode = wrapper.getAttribute('data-sessions-mode')
  const sections = collectSections(wrapper)
  // One-view tabs need a stack of >=2 collapsible sections; search results and
  // project views have their own chrome.
  const usable = (mode === 'flat' || mode === 'archived') && sections.length >= 2

  if (!usable) {
    ;[...wrapper.children].forEach(el => {
      el.style.display = ''
    })
    panel.style.display = 'none'
    closeMenu()
    return
  }

  syncPanel(panel, sections)
  panel.style.display = ''

  // Active tab: keep the previous pick when it still exists, else adopt the
  // single open section, else Sessions (index 1).
  if (activeTab === null || activeTab >= sections.length) {
    let openIdx = -1
    let openCount = 0
    sections.forEach((s, i) => {
      if (!isSectionOpen(s)) return
      if (openIdx < 0) openIdx = i
      openCount += 1
    })
    activeTab = openCount === 1 ? openIdx : 1
    if (openCount > 1) applyTabs(sections, activeTab)
  }

  ;[...panel.children].forEach((btn, i) => {
    btn.setAttribute('aria-pressed', String(i === activeTab))
  })
  sections.forEach((section, i) => {
    section.style.display = i === activeTab ? '' : 'none'
  })

  if (menuState() === 'open') place()
}

// The panel lives on <body>; when the sidebar is gone, park it out of the way.
function closePanelInto(panel) {
  if (panel) panel.style.display = 'none'
}

function scheduleRecompute() {
  if (recomputeTimer) clearTimeout(recomputeTimer)
  recomputeTimer = setTimeout(recompute, 180)
}

// ============================================================ nav titles
function addNavTitles(rootEl = document) {
  rootEl.querySelectorAll?.('[data-tour^="sidebar-nav-"]').forEach(span => {
    const btn = span.closest('button')
    if (!btn || btn.dataset.prettySidebarTitle) return
    const text = (span.textContent || '').trim()
    if (!text) return
    btn.dataset.prettySidebarTitle = '1'
    btn.title = text
  })
}

// ============================================================ RTL titles
// A title is right-to-left when it carries any character from an RTL script.
// Pure-Emoji or accent-free Latin titles stay LTR.
const RTL_RE = /[\u0590-\u08ff\uFB1d-\uFDFD\uFE70-\uFEFF]/

function applyRtlTitles(rootEl = document) {
  rootEl.querySelectorAll?.('[data-sessions-mode] .row-hover span.hover-marquee').forEach(el => {
    const rtl = RTL_RE.test(el.textContent || '')
    el.style.direction = rtl ? 'rtl' : ''
    el.style.textAlign = rtl ? 'right' : ''
  })
}

let rtlTimer = null
function scheduleRtl() {
  if (rtlTimer) clearTimeout(rtlTimer)
  rtlTimer = setTimeout(() => applyRtlTitles(), 120)
}

// ============================================================ register
let observer = null

function installStyle() {
  let style = document.getElementById(STYLE_ID)
  if (!style) {
    style = document.createElement('style')
    style.id = STYLE_ID
    document.head.appendChild(style)
  }
  // Always overwrite: a hot reload must replace the previous build's CSS.
  style.textContent = CSS
}

export default {
  id: ID, // must match the folder name
  name: 'Pretty Sidebar',
  register(ctx) {
    if (typeof document === 'undefined') return

    installStyle()
    addNavTitles()
    recompute()
    applyRtlTitles()

    // Latest build wins on hot reload: drop the previous one's observer and
    // its markup-producing state, then install ours.
    const g = globalThis
    if (g.__prettySidebarObserver) g.__prettySidebarObserver.disconnect()
    menuWired = false
    observer = new MutationObserver(() => {
      addNavTitles()
      scheduleRecompute()
      scheduleRtl()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    g.__prettySidebarObserver = observer

    // Disposing (disable / reload) must leave the app exactly as shipped.
    const teardown = () => {
      observer?.disconnect()
      document.getElementById(STYLE_ID)?.remove()
      document.getElementById(TRIGGER_ID)?.remove()
      document.getElementById(PANEL_ID)?.remove()
      setMenu(null)
      const wrapper = getWrapper()
      wrapper && [...wrapper.children].forEach(el => (el.style.display = ''))
    }
    if (typeof ctx?.onDispose === 'function') ctx.onDispose(teardown)
  }
}
