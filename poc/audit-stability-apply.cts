'use strict';
// One-shot isolated-branch patch application. Not a production maintenance command.
import fs = require('node:fs');
import cp = require('node:child_process');
import assert = require('node:assert/strict');
import crypto = require('node:crypto');
interface EditableRecord { id: string; [field: string]: unknown }
interface PopularDocument { characters: Array<{ id: string; outfits: EditableRecord[] }> }
interface BlueprintRecord extends EditableRecord { negativeTokens: string[] }
interface BlueprintDocument { blueprints: BlueprintRecord[] }
interface TestReport { numTotalTests: number; numFailedTests: number; numPassedTests: number }
interface AuditChange { file: string; id: string; beforeSha256: string; afterSha256: string; fields: string[]; visualStatus: 'not-run' }
const evidence='docs/evidence/scene-audit-closeout-2026-09-10';
fs.mkdirSync(evidence,{recursive:true});
const hash=(value: unknown)=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function run(args: string[]){return cp.spawnSync('npx',args,{encoding:'utf8',timeout:120000,maxBuffer:20*1024*1024});}
const old=run(['vitest','run','src/api/client.refresh.spec.ts','--reporter=json','--outputFile=/tmp/huiyu-refresh-before.json']);
assert.equal(old.status,1,'old refresh implementation must fail the new behavioral tests');
const oldReport: TestReport=JSON.parse(fs.readFileSync('/tmp/huiyu-refresh-before.json','utf8'));
assert.equal(oldReport.numTotalTests,4); assert.equal(oldReport.numFailedTests,3);
let client=fs.readFileSync('src/api/client.ts','utf8');
const generationAnchor='      const generation = generationOf(url)';
assert.equal(client.split(generationAnchor).length,2);
client=client.replace(generationAnchor,"      // A forced refresh starts a new read generation without cancelling existing consumers.\n      if (usesMemoryCache && cachePolicy === 'refresh') generations.set(url, generationOf(url) + 1)\n"+generationAnchor);
const cacheAnchor='          // 写入期间该 URL 已被作废的旧代读取不回填，避免旧配置复活（R1）';
assert(client.includes(cacheAnchor));
client=client.replace(cacheAnchor,"          // A successful uncached refresh must not leave the old TTL value visible.\n          // Keep the previous good value when refresh fails, or a newer generation won.\n          if (cachePolicy === 'refresh' && generation === generationOf(url)) responseCache.delete(url)\n"+cacheAnchor);
client=client.replace('成功后回填缓存；','成功后清除旧缓存；显式 cacheTtlMs 才回填新缓存；');
fs.writeFileSync('src/api/client.ts',client);
const fixed=run(['vitest','run','src/api/client.spec.ts','src/api/client.refresh.spec.ts','--reporter=json','--outputFile=/tmp/huiyu-refresh-after.json']);
assert.equal(fixed.status,0,(fixed.stderr||'')+(fixed.stdout||''));
const fixedReport: TestReport=JSON.parse(fs.readFileSync('/tmp/huiyu-refresh-after.json','utf8'));
const changes: AuditChange[]=[];
function edit<T>(file: string,selector: (data: T) => EditableRecord | undefined,expected: Record<string, unknown>,patch: Record<string, unknown>){
 const data: T=JSON.parse(fs.readFileSync(file,'utf8')), record=selector(data);
 assert(record,`${file}: target record missing`);
 for(const [field,value]of Object.entries(expected))assert.deepEqual(record[field],value,`${file}/${record.id}.${field}: unexpected source drift`);
 const before=hash(record); Object.assign(record,patch);
 changes.push({file,id:record.id,beforeSha256:before,afterSha256:hash(record),fields:Object.keys(patch),visualStatus:'not-run'});
 fs.writeFileSync(file,JSON.stringify(data,null,2)+'\n');
}
edit('data/popular/attack-on-titan.json',(d: PopularDocument)=>d.characters.find(c=>c.id==='krista_lenz')!.outfits.find(o=>o.id==='coronation_winter_wall'),{tokens:['white_dress','cloak','crown','dark_boots','formal','winter']},{tokens:['white_dress','cloak','crown','dark_boots','formal'],prose:'her white coronation gown with a ceremonial cloak and crown, paired with dark closed boots'});
edit('data/popular/yuzusoft.json',(d: PopularDocument)=>d.characters.find(c=>c.id==='murasame')!.outfits.find(o=>o.id==='festival_red_yukata_no_fan'),{tokens:['yukata','red_yukata','goldfish_pattern','red_obi','geta','festival']},{tokens:['yukata','red_yukata','goldfish_pattern','red_obi','geta'],prose:'a scarlet cotton yukata with delicate goldfish and water-ripple patterns, a deep red obi sash and wooden geta sandals'});
edit('data/blueprints/my-dress-up-darling.json',(d: BlueprintDocument)=>d.blueprints.find(b=>b.id==='kitagawa_marin_bubble_tea'),{outfitId:'gal_casual'},{outfitId:'school_uniform',action:'一手捧着奶茶，另一手举手机拍摄自拍',description:'【喜多川海梦 · 街头奶茶店】涩谷街头的奶茶店门前，穿着校服的海梦左手捧着加了双倍珍珠的黑糖波霸奶茶，右手举起手机，朝自拍镜头露出灿烂笑容——「一二三——茄子！这张要当今天的每日精选哦！」',promptProse:'Outside a Shibuya boba shop in bright afternoon daylight, Marin holds a cup of brown-sugar milk tea in her left hand and raises her smartphone in her right hand for a solo selfie. Her open school blazer and loose tie catch the breeze as she smiles toward the phone camera, with the shop window softly reflected behind her.',promptTokens:['boba_shop','smartphone','selfie','holding_cup','milk_tea','straw','smile','daylight','medium_shot','detailed_background','cinematic_lighting','volumetric_lighting','depth_of_field']});
const surtr={
 surtr_arknights_dorm_window:['Sitting on the dormitory windowsill with her knees drawn up, Surtr looks across the wasteland at dusk, her expression distant and faintly annoyed as warm light catches her red hair.','Sitting on the dormitory windowsill with her knees drawn up, Surtr looks across the wasteland at dusk. Her expression is distant and faintly annoyed as warm light catches her red hair.'],
 surtr_arknights_training_ground:['At the Rhodes Island training ground in the cool morning light, Surtr holds her sword in one hand with the tip angled toward the scorched floor, sparks tracing the line as she faces the viewer with a competitive smirk.','At the Rhodes Island training ground in the cool morning light, Surtr holds her sword in one hand with the tip angled toward the scorched floor. Sparks trace the line as she faces the viewer with a competitive smirk.'],
 surtr_arknights_archive_reading:['In the quiet Rhodes Island archives, Surtr leans beside a desk and flips through a weathered Sakaz geography book, looking down at the old pages as dusty afternoon light falls across the shelves.','In the quiet Rhodes Island archives, Surtr leans beside a desk and flips through a weathered Sakaz geography book. She looks down at the old pages as dusty afternoon light falls across the shelves.'],
 kaltsit_arknights_archive_ledger:["Under a single desk lamp in the central archives, Kal'tsit writes precise annotations in a thick paper ledger, fountain pen poised over the page as she reviews the records.","Under a single desk lamp in the central archives, Kal'tsit writes precise annotations in a thick paper ledger. Her fountain pen is poised over the page as she reviews the records."]
};
for(const [id,[before,after]]of Object.entries(surtr)) edit('data/blueprints/arknights.json',(d: BlueprintDocument)=>d.blueprints.find(b=>b.id===id),{promptProse:before},{promptProse:after});
// Only explicit daylight-vs-day negative contradiction; no bulk negative cleanup.
const marinFile='data/blueprints/my-dress-up-darling.json';
const marin=(JSON.parse(fs.readFileSync(marinFile,'utf8')) as BlueprintDocument).blueprints.find(b=>b.id==='kitagawa_marin_gyaru_street')!;
assert(marin.negativeTokens.includes('day'));
edit(marinFile,(d: BlueprintDocument)=>d.blueprints.find(b=>b.id===marin.id),{negativeTokens:marin.negativeTokens},{negativeTokens:marin.negativeTokens.filter(t=>t!=='day')});
for(const script of ['scenes:build','popular:build','blueprints:build','scenes:pin']){
 const r=cp.spawnSync('npm',['run',script],{encoding:'utf8',timeout:120000,maxBuffer:10*1024*1024});
 assert.equal(r.status,0,`${script}: ${r.stdout}\n${r.stderr}`);
}
// Reject any accidental edit to pinned baseline or protected scene fields.
assert.equal(cp.execFileSync('git',['diff','--','data/prompt-pinned-scenes.json','data/scenes'],{encoding:'utf8'}),'');
let quality=fs.readFileSync('.github/workflows/quality.yml','utf8');
const buildMarker='      - name: Build SPA\n'; assert(quality.includes(buildMarker));
quality=quality.replace(buildMarker,'      - name: Validate canonical data version and pinned baseline before build\n        run: |\n          npm run scenes:build\n          npm run popular:build\n          npm run blueprints:build\n          npm run scenes:pin\n          git diff --exit-code -- src/stores/sceneStore.ts\n'+buildMarker);
fs.writeFileSync('.github/workflows/quality.yml',quality);
const results={baselineCommit:'b18fa1b65d228d428a04249b57f82e9a69870d27',node:process.version,refreshBefore:{total:oldReport.numTotalTests,failed:oldReport.numFailedTests,passed:oldReport.numPassedTests},refreshAfter:{total:fixedReport.numTotalTests,failed:fixedReport.numFailedTests,passed:fixedReport.numPassedTests},dataChanges:changes,pinnedBaselineChanged:false,protectedSceneFieldsChanged:false,visualReview:'not-run',fullGate:'pending'};
fs.writeFileSync(evidence+'/repair-evidence.json',JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results));
