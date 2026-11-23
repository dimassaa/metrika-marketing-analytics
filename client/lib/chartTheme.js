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
  seriesPrimary: '#3ba6f1',
  seriesMuted: '#a8a29e',
  // Darker stone for the third comparison series; the warm-gray token is also a text colour, but here it is explicitly
  // a series colour so a chart never borrows an axis token by accident.
  seriesStoneDark: '#78716c',
  healthy: '#2f7d5f',
  watch: '#a16207',
  risk: '#b91c1c',
  fontSize: 12,
  strokeWidth: 2,
});
