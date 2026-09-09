import { ref } from 'vue';

// On a phone the header and toolbar cost several rows of a short screen, so
// scrolling down into a note puts them away and scrolling up brings them back.
// Only the panes scroll (not the window), and they are separate elements that
// come and go, so the listener sits on the pane container and catches their
// scroll events on the way down — scroll doesn't bubble, but it does capture.
//
// Takes `mode` so it can be gentler while editing; returns state the layout
// binds to, and a `reset` for when a new note is opened.
export function useChrome(mode) {
  const chromeHidden = ref(false);
  const paneEl = ref(null);
  let lastScrollTop = 0;

  function onPaneScroll(e) {
    const el = e.target;
    const y = el.scrollTop;
    // Near the top there is nothing to gain, and it avoids a flicker as a short
    // note settles.
    if (y < 48) {
      chromeHidden.value = false;
      lastScrollTop = y;
      return;
    }
    // At the end of a note, rubber-band scrolling springs back: scrollTop drops
    // for a moment, which looks exactly like scrolling up and would bring the
    // chrome back every time you hit the bottom. Reaching the end isn't an
    // intention to see the toolbar.
    if (el.scrollHeight - el.clientHeight - y < 8) {
      lastScrollTop = y;
      return;
    }
    const dy = y - lastScrollTop;
    // A bigger threshold while editing: the textarea scrolls itself as the caret
    // moves, and a single new line shouldn't make the header leave.
    if (Math.abs(dy) < (mode.value === 'edit' ? 48 : 12)) return;
    chromeHidden.value = dy > 0;
    lastScrollTop = y;
  }

  // A newly opened note starts with the chrome shown.
  function reset() {
    chromeHidden.value = false;
    lastScrollTop = 0;
  }

  return { chromeHidden, paneEl, onPaneScroll, reset };
}
