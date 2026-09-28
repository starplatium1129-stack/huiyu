import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSceneStore } from './sceneStore'
import { deferred, fullRoutes, response, scene } from './sceneStoreTestFixtures'
beforeEach(() => setActivePinia(createPinia()))
afterEach(() => vi.unstubAllGlobals())
function fixture() {
  const data: Record<string, unknown> = { ...fullRoutes({ personaCoreSceneIds: ['sc004'] }), 'scenes-core.json': [scene('sc004', { tags: ['core'] })] }
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { const name = url.split('/').pop()!.split('?')[0]; calls.push(name); return response(data[name] ?? []) }))
  return { calls, data }
}
it('loads only browsing data, shares in-flight shards and returns detached snapshots', async () => {
  const { calls } = fixture(); const store = useSceneStore()
  const [a,b] = await Promise.all([store.loadBrowserScenes('core'),store.loadBrowserScenes('core')])
  expect(calls.sort()).toEqual(['curation.json','scenes-core.json','scenes-shared.json'])
  expect(a.scenes.map(s=>s.id)).toEqual(['sc001','sc004'])
  a.scenes[1].title = 'changed'; a.curation.personaCoreSceneIds!.push('changed')
  expect(b.scenes[1].title).toBe('sc004'); expect(b.curation.personaCoreSceneIds).toEqual(['sc004'])
  expect(store.scenes).toEqual([]); expect(store.loaded).toBe(false)
  await store.ensureCore(); expect(calls).toContain('scene-blueprints.json')
  await store.load(); const studioIds=store.scenes.map(s=>s.id)
  await store.loadBrowserScenes('core'); expect(store.scenes.map(s=>s.id)).toEqual(studioIds)
})
it('reuses core after switching characters and preserves full studio metadata loading', async () => {
  const { calls }=fixture();const store=useSceneStore()
  await store.loadCore();await store.loadCharacter('natsume');await store.ensureCore()
  expect(store.scenes.map(s=>s.id)).toEqual(['sc001','sc004'])
  expect(calls.filter(f=>f==='scenes-core.json')).toHaveLength(1)
  expect(calls).toContain('scene-blueprints.json')
})
it('rejects an outdated browser snapshot after a forced refresh', async () => {
  const late=deferred<Response>();let delayed=true
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{const file=url.split('/').pop()!.split('?')[0];if(file==='scenes-core.json'&&delayed){delayed=false;return late.promise}return response(file==='curation.json'?{}:file==='popular-characters.json'?{characters:[]}:file==='scene-blueprints.json'?{blueprints:[]}:[]) }))
  const store=useSceneStore();const pending=store.loadBrowserScenes('core');const rejected=expect(pending).rejects.toThrow('已更新');await store.load(true);late.resolve(response([scene('old')]));await rejected
})
it('blueprint browsing does not fetch studio options or scene shards', async () => {
  const {calls}=fixture();const store=useSceneStore();await store.loadBlueprintCatalog()
  expect(calls.sort()).toEqual(['curation.json','popular-characters.json','scene-blueprints.json'])
  expect(store.loaded).toBe(false)
})
