/**
 * Status badge: a dot and coloured text, never a filled chip. The label is supplied by the server so the same
 * Russian wording is used in the verdict card, the API and the eventual channel table.
 *
 * `no_data` gets its own modifier so the honest empty state does not look like a warning.
 *
 * @param {{ status: 'healthy' | 'watch' | 'risk' | 'no_data', label: string }} props
 */
export function HealthBadge({ status, label }) {
  return <span className={`badge badge--${status}`}>{label}</span>;
}
