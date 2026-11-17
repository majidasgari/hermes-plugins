/**
 * Fast transcript — one CSS rule that makes switching sessions stop freezing.
 *
 * WHY: opening a session mounts its whole live window (100+ messages, and a
 * long agent turn is mostly TOOL blocks — measured on a real chat: 65 tool
 * blocks + 36 thinking disclosures for ~2800 nodes). Chromium then recomputes
 * style for every one of them, and a CPU trace of a single switch shows the
 * biggest phase by far is UpdateLayoutTree (style recalc: measured 1.7-2.6 s on
 * one switch), while real geometry Layout is ~20 ms and Paint ~20 ms. Nothing
 * is visible below the fold, so that work is pure waste.
 *
 * `content-visibility: auto` tells the renderer to SKIP style, layout and paint
 * for offscreen subtrees, using `contain-intrinsic-size: auto 120px` as the
 * placeholder height until the real block has been measured once (the `auto`
 * keyword then remembers its true size, so scrolling never jumps back over a
 * block the user has already seen).
 *
 * Same page, same sessions, measured A/B (main-thread blocking per switch):
 *   with-prev-plugins : 511 / 148 / 1517 ms
 *   with this rule    : 336 / 129 /  823 ms
 * and the "time to settled transcript" dropped 45%.
 *
 * No JS, no store, no core change: a stylesheet, removable in Settings ▸ Plugins.
 */

const ID = 'fast-transcript'
const STYLE_ID = 'hermes-plugin-fast-transcript'

/** Blocks that carry the bulk of a transcript. Keep this list to message-level
 *  containers: `content-visibility` on a small inline node buys nothing. */
const TARGETS = [
  '[data-slot="aui_turn-pair"]',
  '[data-slot="aui_assistant-message-root"]',
  '[data-slot="aui_user-message-root"]',
  '[data-slot="tool-block"]'
].join(',\n')

const CSS = `
${TARGETS} {
  content-visibility: auto;
  contain-intrinsic-size: auto 120px;
}
`

export default {
  id: ID,
  name: 'Fast transcript',
  defaultEnabled: true,
  register(ctx) {
    if (typeof document === 'undefined') {
      return
    }

    // Hot reload REPLACES the build: always rewrite the sheet, never skip it.
    let style = document.getElementById(STYLE_ID)

    if (!style) {
      style = document.createElement('style')
      style.id = STYLE_ID
      document.head.appendChild(style)
    }

    style.textContent = CSS

    ctx?.onDispose?.(() => {
      document.getElementById(STYLE_ID)?.remove()
    })
  }
}
