import { beforeEach, describe, expect, it, vi } from 'vitest'

const environment = vi.hoisted(() => ({ local: true }))
vi.mock('./runtimeEnvironment', () => ({ isLocalStudioHost: () => environment.local }))

beforeEach(() => {
  vi.resetModules()
  environment.local = true
  vi.stubGlobal('fetch', vi.fn())
})

async function loadModule() {
  return import('./localCompanions')
}

describe('local companion directory loading', () => {
  it.each([
    { label: 'HTTP failure', first: { ok: false, status: 503, json: async () => null } },
    { label: 'invalid top-level shape', first: { ok: true, status: 200, json: async () => ({ characters: [] }) } },
  ])('retries after a $label instead of caching failure', async ({ first }) => {
    const fetcher = vi.mocked(fetch)
    fetcher
      .mockResolvedValueOnce(first as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [] } as Response)
    const { loadLocalCompanions } = await loadModule()

    await loadLocalCompanions()
    await loadLocalCompanions()
    expect(fetcher).toHaveBeenCalledTimes(2)
    await loadLocalCompanions()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('deduplicates concurrent loads and treats a valid empty array as success', async () => {
    let resolve!: (response: Response) => void
    const fetcher = vi.mocked(fetch).mockImplementation(() => new Promise(done => { resolve = done }))
    const { loadLocalCompanions } = await loadModule()
    const first = loadLocalCompanions()
    const second = loadLocalCompanions()
    expect(fetcher).toHaveBeenCalledTimes(1)
    resolve({ ok: true, status: 200, json: async () => [] } as Response)
    await Promise.all([first, second])
    await loadLocalCompanions()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not request the local directory from a remote host', async () => {
    environment.local = false
    const fetcher = vi.mocked(fetch)
    const { loadLocalCompanions } = await loadModule()
    await loadLocalCompanions()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
