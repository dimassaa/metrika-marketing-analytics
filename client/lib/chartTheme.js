/**
 * Single source of chart colours and sizes for the React islands.
 *
 * Recharts accepts colours as props, so the values cannot come from CSS custom properties without reading the
 * computed style at runtime (a DOM dependency and a flash of unthemed SVG). Instead the hex literals are repeated
 * here and `tests/unit/chart-theme.test.js` asserts that every one of them exists in `:root` of `app.css`. A token
 * rename therefore breaks the test, not the contrast of a chart.
 */
export const chartTheme = Object.freeze({
  canvas: '#fafaf9',
  surface: '#ffffff',
  border: '#e8e6e5',
  grid: '#e8e6e5',
  axisText: '#78716c',
  axisMuted: '#a8a29e',
  seriesPrimary: '#3398e1',
  seriesMuted: '#78716c',
  // Soot for the third comparison series. The muted series is warm gray, so the third needs its own darker token;
  // using warm gray twice made first-touch and linear bars indistinguishable.
  seriesStoneDark: '#1c1917',
  healthy: '#2f7d5f',
  watch: '#a16207',
  risk: '#b91c1c',
  fontSize: 12,
  strokeWidth: 2,
});
