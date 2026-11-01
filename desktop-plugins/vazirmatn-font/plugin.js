/**
 * Vazirmatn Font — Hermes desktop plugin.
 *
 * Five jobs, one file:
 *
 * 1. FONT — changes the ENTIRE desktop UI font to Vazirmatn (installed locally,
 *    all 9 weights) by overriding the app's font tokens (--dt-font-sans /
 *    --font-sans) with !important, so a theme/skin switch can never stomp it.
 *    Code/diff blocks keep the monospace stack — Vazirmatn has no mono variant.
 *
 * 2. RTL TABLE CELLS — any <td>/<th> whose text carries even ONE Persian
 *    character is rendered `direction: rtl` + `text-align: right`. Detection is
 *    per CELL (not per table, not per row), re-evaluated as content streams in,
 *    so one table can mix LTR and RTL cells column by column.
 *      • counts:      Arabic-script letters (پ چ ژ گ ک ی …), Arabic-script digits
 *                     (۱۲۳ / ١٢٣), Arabic punctuation (، ؛ ؟ ٪)
 *      • never alone: bare diacritics (U+064B–U+0652 …) and invisible format
 *                     chars (ZWNJ U+200C) — a cell that is only "‌" stays LTR
 *      • LTR keeps:   everything ASCII-only ("12:30", "N/A", "n=17")
 *
 * 3. RTL PROSE BLOCKS — chat paragraphs, list items, headings and blockquotes
 *    (assistant prose inside `.aui-md`, plus the user's own message text).
 *    The app resolves those with `unicode-bidi: plaintext` (its #44150 RTL fix),
 *    i.e. each block takes its direction from its FIRST STRONG character. That
 *    is wrong for Persian text that opens with a number: Extended Arabic-Indic
 *    digits ۰-۹ (U+06F0–U+06F9) are bidi class EN — a WEAK class — so
 *    "۳. namespace اش خالیه" opens with a Latin strong char ("n") and the whole
 *    paragraph renders left-to-right with its Persian words in the wrong place.
 *    Here any block holding even ONE visible Persian character is pinned
 *    `direction: rtl` + `unicode-bidi: isolate` (isolate so the element's own
 *    direction property wins over plaintext's content resolution) +
 *    `text-align: right`. Fenced code stays LTR: <pre>/code-card are never
 *    matched, and inline code keeps its own `direction: ltr; isolate` rule.
 *
 * 4. RTL ASK-CARDS — the `clarify` tool's cards (the agent's questions to the
 *    user: single, batch, pending and settled). They sit OUTSIDE the app's
 *    RTL rules entirely, so a Persian question used to render left-aligned in
 *    an LTR card. Here the WHOLE card flips when its own text is Persian — not
 *    just the text runs — so option rows, their A/B/C letter badges, the
 *    free-text box and the action bar mirror together instead of reading as an
 *    LTR shell with right-aligned words inside it.
 *      • detection:  the card's own text (question + choice labels, or
 *                    question + answer on a settled card) — never the app's
 *                    own i18n copy for the buttons
 *      • marked on:  the card shell AND its enclosing <form> (the action bar
 *                    lives outside the shell, inside the form)
 *      • card root:  [data-slot='clarify-inline'], stable across all four
 *                    clarify shapes (pending/answered × single/batch)
 *
 * 5. RTL MARKDOWN PREVIEW — the right-rail file preview's rendered mode
 *    (`MarkdownPreview` → container `.preview-markdown`, see
 *    apps/desktop/src/app/chat/right-rail/preview-file.tsx). The app ships NO
 *    bidi rule in there: every #44150 rule in styles.css is scoped to the chat
 *    transcript (.aui-md / aui_user-inline-text), so a Persian .md file used to
 *    paint fully LTR with its runs reordered. Same per-block rule as chat
 *    prose, plus the preview-only chrome:
 *      • lists are marked as LISTS here (not just their <li>s), because their
 *        markers are chrome that only mirrors when the list box direction
 *        flips — and the preview draws the indent with a PHYSICAL utility
 *        (`pl-6`), so the marked list gets its padding mirrored too.
 *      • the quote rule (`border-l-2 pl-3`) is mirrored the same way.
 *      • fenced code inside a marked list item / quote stays LTR, and inline
 *        code keeps its own order inside an RTL block (the preview maps `code`
 *        without the app's `dir="ltr"` escape hatch, so this pass adds it).
 *      • the source/edit views and the chat's own lists are untouched.
 *
 * RELOAD SAFETY (learned the hard way — this plugin wedged the app once):
 * `register()` may never depend on the PREVIOUS module evaluation running
 * cleanly. A throw inside register() happens BEFORE the loader records the new
 * incarnation, so the stale one stays live and re-throws on every later reload:
 * the plugin ends up permanently `status: 'error'` with no activate handle (the
 * Settings toggle goes dead). So: teardown touches DATA (the observer instance,
 * a frame id, plain sets) instead of calling into a previous build's closures,
 * every step is individually guarded, the host's own `ctx.onDispose` is the
 * primary hook, and the font half is installed even if the RTL halves cannot be.
 *
 * Save as: ~/.hermes/desktop-plugins/vazirmatn-font/plugin.js
 * (folder name == plugin id). Hot-reloads within seconds of the file landing;
 * if not, run "Reload desktop plugins" from ⌘K.
 */

const ID = 'vazirmatn-font'

// Local fontconfig family (all weights Thin→Black installed at
// /usr/local/share/fonts/v/). Stack ends in system fallbacks so a missing
// font still renders something sane.
const VAZIRMATN_STACK =
  "'Vazirmatn', 'Vazirmatn UI', 'Vazirmatn FD', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"

const STYLE_ID = 'hermes-plugin-font-vazirmatn'

// Secondary safety net only: the host disposes via ctx.onDispose, and this slot
// covers a shell whose disposer never ran. It holds PLAIN DATA (never a closure
// from a previous build), so reading it can't throw.
const SLOT = '__hermes_plugin_vazirmatn_font__'

// Attribute the RTL pass writes on table cells; the stylesheet keys off it.
const CELL_RTL_ATTR = 'data-hermes-rtl-cell'

// Same, for chat prose blocks (paragraphs, list items, headings, blockquotes).
const BLOCK_RTL_ATTR = 'data-hermes-rtl-block'

// And for the clarify tool's ask-cards (and their enclosing form).
const CARD_RTL_ATTR = 'data-hermes-rtl-card'

// Prose blocks the app resolves with `unicode-bidi: plaintext` — the two
// selectors mirror its own #44150 rule exactly, so this pass owns precisely the
// elements whose direction the app leaves to the first strong character.
// Fenced code (`pre`, code-card, shiki) is deliberately absent: it must stay LTR.
//
// The third entry is the markdown PREVIEW (right-rail file preview). The app has
// no rule there at all, so matching it is the point; it carries `ul`/`ol` as
// well, because a list's markers and indent only mirror when the LIST box
// direction flips (the chat's lists are already handled by the app with
// `dir="auto"` + logical utilities, which is why they stay out of this pass).
const BLOCK_SELECTOR = [
  "[data-slot='aui_assistant-message-content'] .aui-md :where(p, h1, h2, h3, h4, h5, h6, li, blockquote)",
  "[data-slot='aui_user-inline-text']",
  '.preview-markdown :where(p, h1, h2, h3, h4, h5, h6, li, blockquote, ul, ol)'
].join(', ')

// The clarify card shell — present in ALL four shapes: pending single (with or
// without choices), pending batch, settled single, settled batch. The form hook
// is NOT reliable as a root: a single pending question with no choices renders
// the form unslotted (`data-clarify-choices` is omitted when there are none).
const CARD_SELECTOR = '[data-slot="clarify-inline"]'

// The action bar (Skip / Continue) lives BELOW the shell, inside the form.
const CARD_FORM_SELECTOR = 'form[data-clarify-choices], form[data-clarify-batch]'

const CSS = [
  ':root {',
  `  --dt-font-sans: ${VAZIRMATN_STACK} !important;`,
  `  --font-sans: ${VAZIRMATN_STACK} !important;`,
  '}',
  'body {',
  '  font-family: var(--dt-font-sans) !important;',
  '}',
  '',
  '/* Cells marked by the RTL pass below (see needsRtl). !important so the',
  "   header row's `text-left` utility and the theme context cannot win. */",
  `[${CELL_RTL_ATTR}] {`,
  '  direction: rtl !important;',
  '  text-align: right !important;',
  '}',
  '',
  '/* Chat prose blocks that carry any Persian character (see applyBlock).',
  '   `unicode-bidi: isolate` is load-bearing: the app sets `plaintext` on these',
  '   same elements, which would otherwise keep resolving the base direction',
  '   from the first STRONG char (a Persian digit is only bidi class EN, so',
  '   "۳. something in English" still resolved LTR). isolate lets the rtl',
  '   direction property win instead. */',
  `[${BLOCK_RTL_ATTR}] {`,
  '  direction: rtl !important;',
  '  text-align: right !important;',
  '  unicode-bidi: isolate !important;',
  '}',
  '',
  '/* Ask-cards of the `clarify` tool, marked by applyCard when the question (or',
  '   the settled answer) is Persian. The whole card flips: `direction: rtl`',
  "   mirrors the flex rows (letter badge to the right of its option, question",
  '   icon to the left), and the descendant rule forces the alignment so the',
  "   `text-left` utility on the option rows can't keep them flush left. */",
  `[${CARD_RTL_ATTR}] {`,
  '  direction: rtl !important;',
  '  text-align: right !important;',
  '}',
  '',
  `[${CARD_RTL_ATTR}] :where(span, p, div, button, label, textarea, input) {`,
  '  direction: rtl !important;',
  '  text-align: right !important;',
  '}',
  '',
  '/* ── markdown preview (right-rail file preview, .preview-markdown) ──────',
  '   A marked <ul>/<ol> mirrors its markers + indent. The preview draws the',
  '   list indent with the PHYSICAL `pl-6` utility, so with direction: rtl the',
  '   bullets would hang off the right edge over the container: swap the',
  '   padding with it. 1.5rem == pl-6. */',
  `[${BLOCK_RTL_ATTR}]:where(ul, ol) {`,
  '  padding-left: 0 !important;',
  '  padding-right: 1.5rem !important;',
  '}',
  '',
  '/* Same for the quote rule (`border-l-2 border-border pl-3`): move it to the',
  '   starting edge of the flipped block. */',
  `[${BLOCK_RTL_ATTR}]:where(blockquote) {`,
  '  border-left-width: 0 !important;',
  '  border-right-width: 2px !important;',
  '  padding-left: 0 !important;',
  '  padding-right: 0.75rem !important;',
  '}',
  '',
  '/* Fenced code inside a marked list item / quote / cell never mirrors — it is',
  '   code, and inheriting rtl would reorder its neutrals (dots, slashes). */',
  `[${BLOCK_RTL_ATTR}] :where(pre, [data-slot='code-card']) {`,
  '  direction: ltr !important;',
  '  text-align: left !important;',
  '}',
  '',
  "/* Inline code keeps its own order inside an RTL block. Mirrors the app's own",
  '   chat rule; the preview maps `code` without a `dir`, so this is the only',
  '   thing keeping `./bin/secure-vault` readable in a Persian paragraph. */',
  '.preview-markdown :where(:not(pre) > code) {',
  '  direction: ltr !important;',
  '  unicode-bidi: isolate !important;',
  '}'
].join('\n')

/* ── Persian/Arabic detection ───────────────────────────────────────────────
 * Script=Arabic covers Persian letters (پ چ ژ گ ک ی), the letters shared with
 * Arabic, both Arabic-Indic digit sets (٠-٩ / ۰-۹) and Arabic punctuation,
 * across the main / supplement / extended blocks. The Arabic block's COMMON-
 * script punctuation (U+060C ،  U+061B ؛  U+061F ؟  U+066A-U+066D ٪ ٫ ٬ ٭)
 * is not Script=Arabic, so it is listed explicitly — a cell of pure Persian
 * punctuation should behave like the Persian text it belongs to.
 * Diacritics (Mn) and format chars (Cf: ZWNJ U+200C, ZWJ, ALM) must never be
 * the only reason a cell flips.
 */
const ARABIC = /[\p{Script=Arabic}]/u
const ARABIC_PUNCT = /[\u060C\u061B\u061F\u066A-\u066D]/
const INVISIBLE = /[\p{Mn}\p{Cf}]/u

/**
 * True when `text` carries at least one VISIBLE Persian/Arabic character.
 * Iterates code points (for..of), so astral chars and combining marks are read
 * as single units.
 */
export function needsRtl(text) {
  if (!text) return false

  for (const ch of text) {
    if ((ARABIC.test(ch) || ARABIC_PUNCT.test(ch)) && !INVISIBLE.test(ch)) {
      return true
    }
  }

  return false
}

/** Mark (or un-mark) one table cell. Un-marking matters: streaming text can go
 *  from a placeholder to Persian, or a re-render can drop the Persian entirely. */
export function applyCell(cell) {
  if (needsRtl(cell.textContent)) {
    cell.setAttribute(CELL_RTL_ATTR, '1')
  } else {
    cell.removeAttribute(CELL_RTL_ATTR)
  }
}

/** Mark (or un-mark) one prose block. ANY visible Persian character in the
 *  block pins it RTL — the user's rule, and the fix for a paragraph whose first
 *  strong char is Latin because it opens with a Persian digit. */
export function applyBlock(block) {
  if (needsRtl(block.textContent)) {
    block.setAttribute(BLOCK_RTL_ATTR, '1')
  } else {
    block.removeAttribute(BLOCK_RTL_ATTR)
  }
}

/**
 * Mark (or un-mark) one clarify card. Reads the card's OWN text — the question
 * and its choice labels on a pending card, question + answer on a settled one —
 * so the app's i18n button copy ("Skip", "Continue") never decides it. The
 * enclosing form is marked too: the action bar sits below the shell, outside it.
 */
export function applyCard(card) {
  const rtl = needsRtl(card.textContent)
  const targets = [card]

  if (typeof card.closest === 'function') {
    const form = card.closest(CARD_FORM_SELECTOR)

    if (form) {
      targets.push(form)
    }
  }

  for (const target of targets) {
    if (rtl) {
      target.setAttribute(CARD_RTL_ATTR, '1')
    } else {
      target.removeAttribute(CARD_RTL_ATTR)
    }
  }
}

/* ── Live pass ─────────────────────────────────────────────────────────────
 * A full transcript can hold thousands of cells and stream for minutes, so the
 * pass is rAF-batched and targeted:
 *   • a mutation inside a cell           -> re-check THAT cell
 *   • a mutation inside a prose block    -> re-check THAT block (Persian text
 *                                           streamed into a paragraph flips it
 *                                           as it arrives)
 *   • a mutation inside a clarify card   -> re-check THAT card (and any card
 *                                           the mutation's subtree contains,
 *                                           since a mounting card arrives as a
 *                                           childList record on its container)
 *   • a mutation that touches a table    -> one full sweep of <td>/<th>
 *   • anything else                      -> ignored (no sweep)
 *
 * State lives in one record so teardown only ever READS data — see the reload
 * note in the header.
 */
function installRtlPass() {
  const state = {
    blocks: new Set(),
    cards: new Set(),
    frameId: 0,
    full: false,
    observer: null,
    pending: new Set(),
    scheduled: false
  }

  const flush = () => {
    state.scheduled = false
    state.frameId = 0

    const sweepEverything = state.full
    const cells = [...state.pending]
    const blocks = [...state.blocks]
    const cards = [...state.cards]

    state.pending.clear()
    state.blocks.clear()
    state.cards.clear()
    state.full = false

    if (sweepEverything) {
      document.querySelectorAll('td, th').forEach(applyCell)
      document.querySelectorAll(BLOCK_SELECTOR).forEach(applyBlock)
      document.querySelectorAll(CARD_SELECTOR).forEach(applyCard)

      return
    }

    for (const cell of cells) {
      if (cell.isConnected) {
        applyCell(cell)
      }
    }

    for (const block of blocks) {
      if (block.isConnected) {
        applyBlock(block)
      }
    }

    for (const card of cards) {
      if (card.isConnected) {
        applyCard(card)
      }
    }
  }

  /** Collect every element matching `selector` that this mutation touched: the
   *  ancestor chain (a mutation INSIDE the element) always; newly mounted
   *  descendants only when the record actually ADDED nodes — a streaming text
   *  node can't grow a new card or paragraph, so the cheap ancestor check is
   *  the right cost for every streamed frame. */
  const collect = (el, selector, target, sweepDescendants) => {
    let found = false

    if (typeof el.closest === 'function') {
      const owner = el.closest(selector)

      if (owner) {
        target.add(owner)
        found = true
      }
    }

    if (sweepDescendants && typeof el.querySelectorAll === 'function') {
      for (const node of el.querySelectorAll(selector)) {
        target.add(node)
        found = true
      }
    }

    return found
  }

  const schedule = (node, addedSubtrees) => {
    const el = !node ? null : node.nodeType === 1 ? node : node.parentElement

    if (!el || typeof el.querySelector !== 'function') {
      return
    }

    let needsFrame = false

    if (collect(el, BLOCK_SELECTOR, state.blocks, addedSubtrees)) {
      needsFrame = true
    }

    if (collect(el, CARD_SELECTOR, state.cards, addedSubtrees)) {
      needsFrame = true
    }

    const cell = el.closest('td, th')

    if (cell) {
      state.pending.add(cell)
      needsFrame = true
    } else if (!el.closest('table') && !el.querySelector('table, td, th')) {
      // Plain text somewhere we don't care about — nothing to re-check here.
    } else {
      state.full = true
      needsFrame = true
    }

    if (needsFrame && !state.scheduled) {
      state.scheduled = true
      state.frameId = requestAnimationFrame(flush)
    }
  }

  // The transcript already on screen is marked up-front; everything after that
  // arrives through the observer.
  document.querySelectorAll('td, th').forEach(applyCell)
  document.querySelectorAll(BLOCK_SELECTOR).forEach(applyBlock)
  document.querySelectorAll(CARD_SELECTOR).forEach(applyCard)

  state.observer = new MutationObserver(records => {
    for (const record of records) {
      schedule(record.target, record.type === 'childList' && record.addedNodes.length > 0)
    }
  })
  state.observer.observe(document.body, { childList: true, characterData: true, subtree: true })

  return state
}

/** Stop a pass from ANY build. Reads only browser objects/plain fields, so a
 *  state record from an older or half-initialised module cannot throw here. */
function stopRtlPass(state) {
  try {
    state?.observer?.disconnect()
  } catch {
    /* never fatal */
  }

  try {
    if (state?.scheduled) {
      cancelAnimationFrame(state.frameId)
    }
  } catch {
    /* never fatal */
  }

  for (const key of ['pending', 'blocks', 'cards']) {
    try {
      state?.[key]?.clear()
    } catch {
      /* never fatal */
    }
  }
}

function injectStyle() {
  let style = document.getElementById(STYLE_ID)

  if (!style) {
    style = document.createElement('style')
    style.id = STYLE_ID
    document.head.appendChild(style)
  }

  // Always overwrite the text: a getElementById-style skip would leave the
  // PREVIOUS build's CSS in place after a hot reload.
  style.textContent = CSS

  return style
}

export default {
  id: ID, // must match the folder name
  name: 'Vazirmatn Font',
  register(ctx) {
    if (typeof document === 'undefined') {
      return
    }

    // Retire the previous incarnation FIRST and never let it abort this one.
    const previous = globalThis[SLOT]

    globalThis[SLOT] = null // a stale record can no longer poison the next load
    stopRtlPass(previous)

    const style = injectStyle()

    let state = null

    // The font is the primary job — an unexpected DOM shape must not take it down.
    try {
      state = installRtlPass()
    } catch (error) {
      console.error(`[${ID}] RTL pass failed to start`, error)
    }

    const dispose = () => {
      stopRtlPass(state)
      state = null
    }

    globalThis[SLOT] = state

    // The host runs this on reload/disable (loader -> unloadRuntimePlugin).
    ctx?.onDispose?.(dispose)
  }
}
