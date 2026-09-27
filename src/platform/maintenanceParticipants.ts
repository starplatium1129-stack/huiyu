type Participant = () => void | Promise<unknown>
const participants = new Set<Participant>()
let phase: 'idle' | 'preparing' | 'sealed' = 'idle'
export function registerMaintenanceParticipant(flush: Participant): () => void {
  participants.add(flush)
  return () => { participants.delete(flush) }
}
export function maintenanceParticipants(): Participant[] { return [...participants] }
export function maintenanceFrozen(): boolean { return phase !== 'idle' }
export function setMaintenancePhase(value: typeof phase): void { phase = value }
export function assertMaintenanceWritable(): void { if (phase === 'sealed') throw new Error('MAINTENANCE_SEALED') }
/** Covers the complete media operation, including time between upload chunks. */
export async function trackMaintenanceWrite<T>(work: () => Promise<T>): Promise<T> {
  if (phase !== 'idle') throw new Error('MAINTENANCE_FROZEN')
  const release = registerMaintenanceParticipant(() => { throw new Error('ARTWORK_BUSY') })
  try { return await work() } finally { release() }
}
