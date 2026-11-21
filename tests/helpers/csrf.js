/**
 * Reads the CSRF token from a page that renders a form. The attribute order is fixed by the templates, but the
 * pattern stays tolerant of extra attributes so a later markup tweak does not silently break every login test.
 *
 * @param {import('supertest').SuperAgentTest} agent Cookie-keeping agent.
 * @param {string} [path] Page that contains a `_csrf` input.
 * @returns {Promise<string>} Token ready to be sent as `_csrf` or `x-csrf-token`.
 * @throws {Error} When the page does not render a token; the status code is included to make a redirect obvious.
 */
export async function getCsrf(agent, path = '/login') {
  const res = await agent.get(path);
  const match = res.text.match(/name="_csrf" value="([^"]+)"/);
  if (!match) {
    throw new Error(`no CSRF token on ${path} (status ${res.status})`);
  }
  return match[1];
}
