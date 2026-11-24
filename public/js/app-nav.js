/**
 * Keyboard support for the mobile navigation disclosure.
 *
 * The disclosure is a native checkbox on purpose: Space, the checkbox state and the CSS rule are all built-ins, so the
 * menu still works with JavaScript disabled. Two keys are not native, though. Enter is what people press on a control
 * shaped like a button, and Escape must close a menu that covers content without moving focus elsewhere. Both handlers
 * only change `checked`, so the CSS rule remains the single source of truth for what is visible.
 */
(() => {
  const toggle = document.getElementById('app-nav-toggle');
  if (!toggle) return;

  toggle.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      toggle.checked = !toggle.checked;
    } else if (event.key === 'Escape' && toggle.checked) {
      event.preventDefault();
      toggle.checked = false;
      toggle.focus();
    }
  });

  // A keyboard user can move into a link and then press Escape; the menu must still close and return focus to its
  // control instead of silently keeping an overlay open.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !toggle.checked) return;
    toggle.checked = false;
    toggle.focus();
  });
})();
