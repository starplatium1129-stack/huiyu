type Participant = () => void | Promise<unknown>
type Phase = 'idle' | 'preparing' | 'sealed'
const participants = new Set<Participant>()
let phase: Phase = 'idle'
let artworkCleanupPhase: Phase = 'idle'
export function registerMaintenanceParticipant(flush: Participant): () => void {
  participants.add(flush)
  return () => { participants.delete(flush) }
}
export function maintenanceParticipants(): Participant[] { return [...participants] }
export function maintenanceFrozen(): boolean { return phase !== 'idle' || artworkCleanupPhase !== 'idle' }
export function setMaintenancePhase(value: Phase): void { phase = value }
export function setArtworkCleanupPhase(value: Phase): void { artworkCleanupPhase = value }
export function artworkCleanupFrozen(): boolean { return artworkCleanupPhase !== 'idle' }
export function assertMaintenanceWritable(): void { if (phase === 'sealed' || artworkCleanupPhase === 'sealed') throw new Error('MAINTENANCE_SEALED') }
/** Covers the complete media operation, including time between upload chunks. */
export async function trackMaintenanceWrite<T>(work: () => Promise<T>): Promise<T> {
  if (maintenanceFrozen()) throw new Error('MAINTENANCE_FROZEN')
  const release = registerMaintenanceParticipant(() => { throw new Error('ARTWORK_BUSY') })
  try { return await work() } finally { release() }
}
