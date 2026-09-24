import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAnimaSession, type AnimaRequest } from './useAnimaSession'
import type { ApiClient, ApiRequestOptions } from '@/api/client'

const request: AnimaRequest = {
  prompt: 'cancel fixture',
  negative: '',
  profileId: 'default',
  modelId: 'anima-fixture',
  loraId: null,
  loraStrength: null,
  width: 832,
  height: 1216,
  steps: 20,
  cfg: 4,
  character: 'nene',
}

afterEach(() => vi.clearAllMocks())

describe('useAnimaSession · submission cancellation', () => {
  it('aborts a pending submission and deletes a job accepted after the cancel', async () => {
    let resolvePost!: (value: { ok: true; job: { id: string; status: 'queued'; seed: number; resultAvailable: boolean; resultUrl: null; error: null; code: null } }) => void
    const calls: Array<{ url: string; options?: ApiRequestOptions }> = []
    const client = {
      request: vi.fn(async <T extends object>(url: string, options?: ApiRequestOptions): Promise<T> => {
        calls.push({ url, options })
        if (url === '/api/anima/jobs' && options?.method === 'POST') {
          return await new Promise<T>(resolve => { resolvePost = resolve as typeof resolvePost })
        }
        return { ok: true, job: { status: 'cancelled' } } as T
      }),
    } as unknown as ApiClient
    const session = useAnimaSession({
      getCharacter: () => 'nene',
      isPopular: () => false,
      getFamily: () => 'anima',
      getRequest: () => request,
      onResult: vi.fn(),
      flash: vi.fn(),
      preferredSize: () => '832x1216',
      client,
    })
    session.patchState({ online: true })

    const pending = session.generate()
    await vi.waitFor(() => expect(calls.some(call => call.url === '/api/anima/jobs')).toBe(true))
    await session.cancel()
    expect(session.state.value.phase).toBe('cancelled')

    resolvePost({ ok: true, job: { id: 'late-anima', status: 'queued', seed: 1, resultAvailable: false, resultUrl: null, error: null, code: null } })
    await pending
    expect(calls.some(call => call.url === '/api/anima/jobs/late-anima' && call.options?.method === 'DELETE')).toBe(true)
    session.dispose()
  })
})
