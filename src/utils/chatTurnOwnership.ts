/** One inference writer per local origin. A busy window keeps its turn and draft. */
export async function withChatTurn<T>(run: () => Promise<T>, unavailable: () => void): Promise<void> {
  if (!navigator.locks?.request) { await run(); return }
  await navigator.locks.request('aics-chat-turn', { ifAvailable: true }, async lock => {
    if (!lock) { unavailable(); return }
    await run()
  })
}
