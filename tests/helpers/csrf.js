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

/**
 * Reads the CSRF token of an authenticated session from the sidebar logout form.
 *
 * Application forms carry the same session token, so one read per test is enough for any number of POSTs. The
 * helper stays separate from `getCsrf` because the two read different pages for different reasons: the login form
 * is anonymous, this one requires a signed-in session.
 *
 * @param {import('supertest').SuperAgentTest} agent Cookie-keeping agent that has already logged in.
 * @param {string} [path] Authenticated page that renders the app shell.
 * @returns {Promise<string>} Token ready to be sent as `_csrf` or `x-csrf-token`.
 */
export async function getAppCsrf(agent, path = '/app/dashboard') {
  return getCsrf(agent, path);
}
