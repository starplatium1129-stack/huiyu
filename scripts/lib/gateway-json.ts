/** Candidate runners inspect transport errors before deciding whether to retry their job. */
export async function gatewayJson(base: string, pathname: string, options?: RequestInit) {
  let response;
  try {
    response = await fetch(base.replace(/\/$/, '') + pathname, Object.assign({ cache: 'no-store' }, options || {}));
  } catch (error) {
    return { response: null, data: null, error: error instanceof Error ? error.message : String(error) };
  }
  let data = null;
  try { data = await response.json(); } catch { /* Keep null for non-JSON gateway responses. */ }
  return { response, data };
}
