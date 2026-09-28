import { expect, it, vi } from 'vitest'
import { preferenceHistoryRows } from './preferenceHistory'
import { buildPreferenceProfile } from '@/utils/sceneUX'
import { createWebArtworkRepository } from '@/platform/web/artworkRepository'
it('keeps scoring identical without reading image or recipe payloads', () => {
 const entry={id:'42',scene:'sc001',character:'nene',favorite:true,timestamp:3,get image_data(){throw new Error('media read')},get prompt(){throw new Error('prompt read')}}
 const history=[entry,{id:8,scene:'sc002'},[],null,5,{favorite:'yes',timestamp:'10'}]
 const rows=preferenceHistoryRows(history)
 expect(buildPreferenceProfile(rows,100)).toEqual(buildPreferenceProfile(history,100))
 expect(Object.keys(rows[0] as object)).toEqual(['id','scene','character','favorite','timestamp'])
 ;(rows[0] as {scene:string}).scene='changed';expect(entry.scene).toBe('sc001')
})
it('web recommendations project read-only history without a second full-record clone', async () => {
 const history=[{id:1,scene:'sc001',image_data:'x'.repeat(1_000_000),prompt:'large'}]
 const kv={get:vi.fn(async()=>history),set:vi.fn()};const repository=createWebArtworkRepository({kv})
 const result=await repository.readPreferenceHistory();expect(JSON.stringify(result).length).toBeLessThan(100);expect(kv.set).not.toHaveBeenCalled();expect(history[0].image_data.length).toBe(1_000_000)
})
