import { isRecord } from '@/composables/live2d/catalog'

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isCatchable(value: unknown): value is { catch(handler: (error: unknown) => void): unknown } {
  return isRecord(value) && typeof value.catch === 'function'
}
