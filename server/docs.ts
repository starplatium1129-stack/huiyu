'use strict';
const redirects: Readonly<Record<string, string>> = require('../docs/redirects.json');

/** Keep previously shared manual URLs usable after documentation moves. */
function redirectLegacyDocs(req: { method: string; path: string; url: string }, res: { redirect: (status: number, url: string) => any }, next: () => any) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const key = '/docs' + req.path;
  if (!Object.hasOwn(redirects, key)) return next();
  const queryAt = req.url.indexOf('?');
  const query = queryAt < 0 ? '' : req.url.slice(queryAt);
  return res.redirect(308, redirects[key] + query);
}
export = { redirectLegacyDocs };
