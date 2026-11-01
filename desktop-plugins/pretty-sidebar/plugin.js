/**
 * Pretty Sidebar — Hermes desktop plugin.
 *
 * (A) COMPACT TOP NAV — the five labeled nav rows collapse into one icon strip.
 * (B) SESSION ROWS AS CARDS — rounded, seam-separated cards; active session
 *     gets an accent fill + inset ring.
 * (C) BOTTOM SECTION TABS — Pinned / Sessions / Messaging platforms
 *     (Telegram, …) / Scheduled jobs become an ICON-ONLY tab dock at the
 *     BOTTOM of the sidebar (above the profile rail). Clicking a tab expands
 *     that ONE section (its native header toggle) and collapses + hides the
 *     rest, so only the chosen view takes space.
 *
 * HOW THE TABS WORK (no app changes, all native affordances):
 *   - The sidebar's session wrapper ([data-sessions-mode]) stacks section
 *     roots (SidebarGroup divs) in a fixed order:
 *         [0] Pinned, [1] Sessions/Recents, [2..n-1] messaging platforms
 *         (Telegram, …), [last] Scheduled jobs (only when jobs exist).
 *   - Each section root's header holds a toggle button
 *     (`button.group\/section-label`) whose click flips the section's
 *     persisted open state; a closed section unmounts its content, so the
 *     layout math (flex sizing, virtualization) stays native and correct.
 *   - The dock is a plain DOM node React never knows about; a MutationObserver
 *     keeps it anchored above the profile rail and self-heals placement.
 *     Switching tabs clicks the native toggles (expand target, collapse the
 *     rest), then hides collapsed roots so the sidebar reads as one view.
 *     State persists like manual collapse does; removing the plugin leaves
 *     whatever collapse state was last set.
 *   - The dock hides while searching (results replace the wrapper's children)
 *     and in project/workspace views (sessions-mode != flat|archived).
 *
 * DOM hook caveats: selectors rely on stable data attributes
 * (data-tour="sessions-sidebar", data-sessions-mode, data-tour^="sidebar-nav-")
 * and on class tokens that land verbatim in the class attribute
 * ('group/section-label', 'bg-(--ui-row-active-background)'). If a future app
 * version renames those, the worst case is a feature stops matching — the
 * rest of the styling stays intact. Tab icons are hand-drawn inline SVGs
 * (outline, currentColor) so nothing depends on the app's icon font.
 *
 * Save as: ~/.hermes/desktop-plugins/pretty-sidebar/plugin.js
 * (folder name == plugin id). Hot-reloads within seconds of the file landing;
 * if not, run "Reload desktop plugins" from ⌘K.
 */

const ID = 'pretty-sidebar'
const STYLE_ID = 'hermes-plugin-pretty-sidebar'
const TAB_BAR_ID = 'hermes-plugin-pretty-tabs'

// ============================================================ CSS
const CSS = `
/* ---------- (A) Top nav → one horizontal icon strip ---------- */
[data-tour='sessions-sidebar'] ul:has(> li [data-tour^='sidebar-nav-']) {
  display: flex !important;
  flex-direction: row !important;
  align-items: center !important;
  gap: 2px !important;
}
[data-tour='sessions-sidebar'] ul:has(> li [data-tour^='sidebar-nav-']) > li {
  flex: 1 1 0 !important;
  min-width: 0 !important;
}
[data-tour='sessions-sidebar'] [data-tour^='sidebar-nav-'] {
  display: none !important;
}
[data-tour='sessions-sidebar'] ul:has(> li [data-tour^='sidebar-nav-']) button {
  justify-content: center !important;
  padding-left: 0 !important;
  padding-right: 0 !important;
}
[data-tour='sessions-sidebar'] ul:has(> li [data-tour^='sidebar-nav-']) button .ml-auto {
  display: none !important;
}
[data-tour='sessions-sidebar'] button:has(> [data-tour='sidebar-nav-new-session']) {
  background: color-mix(in srgb, var(--ui-accent, #0053fd) 11%, transparent) !important;
}
[data-tour='sessions-sidebar'] button:has(> [data-tour='sidebar-nav-new-session']) svg {
  color: var(--ui-accent, #0053fd) !important;
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

/* ---------- (C) Bottom icon tab dock ---------- */
.hermes-ptab-bar {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  gap: 8px;
  padding: 6px 12px 8px;
  overflow: hidden;
}
.hermes-ptab-bar.hermes-ptab-hidden {
  display: none !important;
}
.hermes-ptab {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--ui-text-secondary, inherit);
  flex: 1 1 0;
  min-width: 0;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  cursor: pointer;
  padding: 0;
  transition: background 0.12s ease, color 0.12s ease;
}
.hermes-ptab svg {
  display: block;
  width: 14px;
  height: 14px;
}
.hermes-ptab:hover {
  background: color-mix(in srgb, var(--ui-accent, #0053fd) 9%, transparent);
  color: var(--ui-text-primary, inherit);
}
.hermes-ptab[aria-pressed='true'] {
  background: color-mix(in srgb, var(--ui-accent, #0053fd) 15%, transparent);
  color: var(--ui-accent, #0053fd);
}
`

// ============================================================ icons
// Outline glyphs, hand-drawn on a 14x14 grid, all currentColor.
const SVG_ATTRS =
  'viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.25" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'

const ICON_PATHS = {
  pin: [
    // map pin: outer teardrop + inner dot
    '<path d="M7 1.5c-2 0-3.6 1.5-3.6 3.5 0 2.6 3.6 6.5 3.6 6.5s3.6-3.9 3.6-6.5c0-2-1.6-3.5-3.6-3.5Z"/>',
    '<path d="M7 6.7a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"/>'
  ],
  chat: [
    // rounded bubble with a tail at bottom-left
    '<path d="M1.7 3.1a1.4 1.4 0 0 1 1.4-1.4h7.8a1.4 1.4 0 0 1 1.4 1.4v4.4a1.4 1.4 0 0 1-1.4 1.4H6.6L4.5 12v-1.7H3.1A1.4 1.4 0 0 1 1.7 8.9V3.1Z"/>'
  ],
  plane: [
    // paper plane pointing up-right, with the fold crease
    '<path d="M1.7 7.4 12.7 1.4 9.2 12.6 7 9.2Z"/>',
    '<path d="M12.7 1.4 7 9.2"/>'
  ],
  globe: [
    '<circle cx="7" cy="7" r="5.7"/>',
    '<path d="M1.4 7h11.2"/>',
    '<path d="M7 1.3c-2.5 2.5-2.5 8.9 0 11.4M7 1.3c2.5 2.5 2.5 8.9 0 11.4"/>'
  ],
  clock: [
    '<circle cx="7" cy="7" r="5.7"/>',
    '<path d="M7 4.1V7l2.3 1.4"/>'
  ]
}

function iconFor(index, sections, label) {
  if (index === 0) return 'pin'
  if (index === 1) return 'chat'
  const l = (label || '').toLowerCase()
  if (/(schedule|job|cron)/.test(l)) return 'clock'
  if (l.includes('telegram')) return 'plane'
  return 'globe'
}

function iconSVG(name) {
  const paths = ICON_PATHS[name] || ICON_PATHS.globe
  return `<svg ${SVG_ATTRS}>${paths.join('')}</svg>`
}

// ============================================================ shared state
let recomputeTimer = null
let activeTab = null // index into the last known section snapshot

const LABEL_BTN_SEL = 'button.group\\/section-label'

function labelOf(section) {
  const btn = section.querySelector(LABEL_BTN_SEL)
  if (!btn) return ''
  // Prefer the actual caption (SidebarPanelLabel's truncated label span) so a
  // platform avatar's own text never doubles into the label, e.g. a Telegram
  // section read as 'Telegram' instead of 'TelegramTelegram'.
  const caption = btn.querySelector('.truncate')
  const text = (caption ? caption.textContent : btn.textContent) || ''
  return text.replace(/\s+/g, ' ').trim()
}

function isSectionOpen(section) {
  // A section root is [header, content?]; content unmounts when collapsed.
  return section.childElementCount > 1
}

function sectionToggle(section) {
  return section.querySelector(LABEL_BTN_SEL)
}

// ============================================================ tab dock
function buildTabButton(index, sections, host) {
  const label = labelOf(sections[index]) || `Tab ${index + 1}`
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'hermes-ptab'
  btn.title = label
  btn.setAttribute('aria-label', label)
  btn.setAttribute('aria-pressed', 'false')
  btn.innerHTML = iconSVG(iconFor(index, sections, label))
  btn.addEventListener('click', () => onTabClick(index))
  return btn
}

function buildTabBar(sections) {
  const host = document.createElement('div')
  host.id = TAB_BAR_ID
  host.className = 'hermes-ptab-bar'
  host.setAttribute('role', 'tablist')
  sections.forEach((_, i) => host.appendChild(buildTabButton(i, sections, host)))
  return host
}

function syncTabBar(host, sections) {
  const labels = sections.map(s => labelOf(s) || '')
  const key = labels.join('\u0001')
  if (host.dataset.key === key) return
  host.dataset.key = key
  const frag = document.createDocumentFragment()
  sections.forEach((_, i) => frag.appendChild(buildTabButton(i, sections, host)))
  host.replaceChildren(frag)
}

// Collapse/expand native section toggles so exactly `activeIndex` is open,
// then hide the other sections' roots entirely (clean single-view look).
function applyTabs(sections, activeIndex) {
  sections.forEach((section, i) => {
    const target = i === activeIndex
    const open = isSectionOpen(section)
    const toggle = sectionToggle(section)
    if (toggle && open !== target) {
      toggle.click()
    }
    section.style.display = target ? '' : 'none'
  })
}

function onTabClick(index) {
  const wrapper = getWrapper()
  if (!wrapper) return
  const sections = collectSections(wrapper)
  if (index < 0 || index >= sections.length) return
  activeTab = index
  applyTabs(sections, index)
  // React mounts/unmounts content async; settle after the dust clears.
  setTimeout(() => recompute(), 250)
}

// ============================================================ recompute
function getWrapper() {
  return document.querySelector('[data-tour="sessions-sidebar"] [data-sessions-mode]')
}

function collectSections(wrapper) {
  // Only collapsible sections with a header toggle are tabbable.
  return [...wrapper.children].filter(el => el.querySelector(LABEL_BTN_SEL))
}

function ensureDockPlacement(host, wrapper) {
  // Dock sits at the bottom of the sidebar content, directly above the
  // profile rail (the wrapper's last sibling when present).
  const sc = wrapper.parentNode
  const last = sc.lastElementChild
  if (host.isConnected && host.parentNode === sc) {
    if (last === host || host.nextElementSibling === last) return // already placed
    host.remove()
  }
  if (last === wrapper || last === host) {
    sc.appendChild(host) // no rail below the sessions area
  } else {
    sc.insertBefore(host, last)
  }
}

function recompute() {
  if (typeof document === 'undefined') return
  const wrapper = getWrapper()
  let host = document.getElementById(TAB_BAR_ID)

  if (!wrapper) {
    if (host) host.remove()
    return
  }

  const mode = wrapper.getAttribute('data-sessions-mode')
  const sections = collectSections(wrapper)

  // Tabs only make sense for the flat/archived stacks of >=2 collapsible
  // sections. Search replaces the children with a results list; project /
  // workspace views have their own chrome.
  const usable = (mode === 'flat' || mode === 'archived') && sections.length >= 2

  if (!usable) {
    // Leave tab mode cleanly: undo any display:none we applied so native
    // sections (search results, project view) are all visible again.
    ;[...wrapper.children].forEach(el => {
      el.style.display = ''
    })
    if (host) host.classList.add('hermes-ptab-hidden')
    return
  }

  if (!host || !host.isConnected) {
    host = buildTabBar(sections)
    // ensureDockPlacement anchors it; do not append first or the dock lands
    // below the profile rail.
  } else {
    syncTabBar(host, sections)
  }
  ensureDockPlacement(host, wrapper)
  host.classList.remove('hermes-ptab-hidden')

  // Active tab: honor the previous choice when it still exists, else adopt
  // the single open section, else fall back to Sessions (index 1). On the
  // very first pass with several sections open, collapse the extras for real
  // (native toggles) so only the Sessions view takes space from the start.
  const firstDecision = activeTab === null
  if (activeTab === null || activeTab >= sections.length) {
    let openIdx = -1
    let openCount = 0
    sections.forEach((s, i) => {
      if (isSectionOpen(s)) {
        if (openIdx < 0) openIdx = i
        openCount += 1
      }
    })
    activeTab = openCount === 1 ? openIdx : 1
    if (firstDecision && openCount > 1) {
      applyTabs(sections, activeTab)
    }
  }

  // Reflect which section is active on the dock icons.
  ;[...host.children].forEach((btn, i) => {
    btn.setAttribute('aria-pressed', String(i === activeTab))
  })

  // Hide non-active roots (display only — open/collapse state stays native,
  // so nothing here fights React or the persisted store).
  sections.forEach((section, i) => {
    section.style.display = i === activeTab ? '' : 'none'
  })
}

function scheduleRecompute() {
  if (recomputeTimer) clearTimeout(recomputeTimer)
  recomputeTimer = setTimeout(recompute, 180)
}

// ============================================================ nav titles
function addNavTitles(root = document) {
  root.querySelectorAll?.('[data-tour^="sidebar-nav-"]').forEach(span => {
    const btn = span.closest('button')
    if (!btn || btn.dataset.prettySidebarTitle) return
    const text = (span.textContent || '').trim()
    if (!text) return
    btn.dataset.prettySidebarTitle = '1'
    btn.title = text
  })
}

// ============================================================ RTL titles
// A title is treated as right-to-left when it carries any character from an
// RTL script (Arabic / Persian / Hebrew / presentation forms). Pure-Emoji or
// accent-free Latin titles stay LTR — an emoji like 🚀 is not an RTL trigger.
const RTL_RE = /[\u0590-\u08ff\uFB1d-\uFDFD\uFE70-\uFEFF]/

function isRtl(text) {
  return RTL_RE.test(text || '')
}

// For every session row (projects/messaging rows too), make the title and the
// preview line RTL + right-aligned when their own text is RTL; otherwise leave
// the app's default LTR. Inline style survives React re-renders (row elements
// are reused), and new rows are covered by the observer.
function applyRtlTitles(root = document) {
  root.querySelectorAll?.('[data-sessions-mode] .row-hover span.hover-marquee').forEach(el => {
    const rtl = isRtl((el.textContent || '').trim())
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
  // Always overwrite the live stylesheet so a hot-reloaded version replaces
  // the previous build's CSS instead of finding it and skipping.
  style.textContent = CSS
}

export default {
  id: ID, // must match the folder name
  name: 'Pretty Sidebar',
  register() {
    if (typeof document === 'undefined') return

    installStyle()
    addNavTitles()
    recompute()
    applyRtlTitles()

    // Latest version wins on hot-reload: drop any observer the previous build
    // installed (its closure would otherwise keep driving the OLD logic and
    // fight this one), then install ours.
    const g = globalThis
    if (g.__prettySidebarObserver) {
      g.__prettySidebarObserver.disconnect()
    }
    observer = new MutationObserver(() => {
      addNavTitles()
      scheduleRecompute()
      scheduleRtl()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    g.__prettySidebarObserver = observer
  }
}
