/** Keep timings in the existing build log, including phases that fail. */
export async function timeDesktopBuild<T>(phase: string, run: () => T | Promise<T>): Promise<T> {
  const started = performance.now();
  try { return await run(); }
  finally { console.log(`[desktop:timing] ${phase}: ${((performance.now() - started) / 1000).toFixed(2)}s`); }
}
