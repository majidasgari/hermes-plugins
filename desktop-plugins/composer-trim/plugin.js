/**
 * Composer trim — two controls out of the composer row that Max never uses:
 *
 *   1. the VOICE DICTATION hub (the mic). It is a `FanMenu` hub: the mic is the
 *      button and hovering it fans out "read replies aloud" + the wake word, so
 *      hiding the hub hides all three toggles. Those three live nowhere else,
 *      and the hub is the ONLY `FanMenu` in the app (grep: fan-menu.tsx is
 *      imported by voice-fan.tsx alone), so the selector cannot catch a menu
 *      that matters.
 *   2. the EFFORT pill (`data-testid="reasoning-pill"`). Removing it does not
 *      remove the SETTING: the model pill's own menu carries the same
 *      Thinking / Fast / Effort rows, so effort stays reachable from there.
 *
 * There is no preference for either one in this build (Settings has no voice or
 * effort visibility toggle, and `voice:` in config.yaml only carries
 * `client_direct`), which is why the controls could not be turned off by hand.
 *
 * CSS only, no JS, no store, no core change: turn the plugin off in
 * Settings ▸ Plugins and both controls come back.
 */

const ID = 'composer-trim'
const STYLE_ID = 'hermes-plugin-composer-trim'

const CSS = `
/* The dictation hub (and the toggles fanned out of it). */
[data-slot="fan-menu-anchor"],
[data-slot="fan-menu"] {
  display: none !important;
}

/* The reasoning/effort pill; the model pill's menu still sets the level. */
[data-testid="reasoning-pill"] {
  display: none !important;
}
`

export default {
  id: ID,
  name: 'Composer trim',
  defaultEnabled: true,
  register(ctx) {
    if (typeof document === 'undefined') {
      return
    }

    // Hot reload REPLACES the build: rewrite the sheet every time, never skip.
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
