import { expect, it, vi } from 'vitest'
import { orderExplorerScenes } from './sceneExplorerOrdering'
import { buildPreferenceProfile, personalScore, sceneUsageScore, type SceneUsageMap } from '@/utils/sceneUX'
import type { ExplorerScene } from './sceneExplorerPresentation'

it('preserves legacy ordering across every mode, relevance ties and duplicate curation IDs', () => {
 vi.spyOn(Date,'now').mockReturnValue(1_700_000_000_000)
 const scenes: ExplorerScene[]=Array.from({length:60},(_,i)=>({id:`sc${i+1}`,title:['雨夜','樱花','清晨'][i%3],story:'x'.repeat(i*12),char:i%2?'nene':'natsume',rating:i%3?'All':'R15',emotion:i%2?'joy':''})).reverse()
 const curation={personaCoreSceneIds:['sc3','sc5','sc3'],signatureSceneIds:['sc5','sc6'],curatedSceneIds:['sc8','sc9','sc6']}
 const profile=buildPreferenceProfile([{id:1,scene:'sc10',character:'nene',favorite:true}],Date.now())
 const usage:SceneUsageMap={sc2:{uses:3,lastUsed:Date.now()},sc10:{uses:2,lastUsed:Date.now()-86400000}}
 const favorites=new Set(['sc8']);const relevance=new Map([['sc11',2],['sc12',2]])
 function curated(s:ExplorerScene){const groups=[curation.personaCoreSceneIds,curation.signatureSceneIds,curation.curatedSceneIds];for(let g=0;g<groups.length;g++){const n=groups[g].indexOf(s.id);if(n>=0)return(3-g)*10000-n}return [s.story,s.emotion,s.camera,s.lighting,s.location].filter(Boolean).length*100+Math.min((s.story||'').length,500)+(s.rating==='All'?20:0)}
 for(const mode of ['smart','favorite','used','title','newest','curation'])for(const rel of [new Map<string,number>(),relevance]){
  const score=(s:ExplorerScene)=>mode==='used'?sceneUsageScore(usage[s.id]):mode==='favorite'?(favorites.has(s.id)?100000:0)+personalScore(s,profile)*500+sceneUsageScore(usage[s.id]):mode==='smart'?sceneUsageScore(usage[s.id])*400+personalScore(s,profile)*500+curated(s):curated(s)
  const expected=[...scenes].sort((a,b)=>{const diff=(rel.get(b.id)||0)-(rel.get(a.id)||0);if(diff)return diff;if(mode==='newest')return String(b.id).localeCompare(String(a.id),undefined,{numeric:true});if(mode==='title')return String(a.title).localeCompare(String(b.title),'zh-CN');return score(b)-score(a)})
  expect(orderExplorerScenes(scenes,{mode,curation,profile,usage,favorites,relevance:rel}).map(s=>s.id)).toEqual(expected.map(s=>s.id))
 }
 expect(scenes[0].id).toBe('sc60');vi.restoreAllMocks()
})
