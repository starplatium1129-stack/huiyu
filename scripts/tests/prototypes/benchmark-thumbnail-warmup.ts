import fs = require('node:fs');
import path = require('node:path');
import http = require('node:http');
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { parse } from '@vue/compiler-sfc';
import ts = require('typescript');

// Explicit opt-in benchmark: private browser contexts and an ephemeral loopback
// fixture only. Executes the current App.vue function, not a copied scheduler.
const root = path.resolve(__dirname, '../../..');
const appSource = fs.readFileSync(path.join(root, 'src/App.vue'), 'utf8');
const script = parse(appSource).descriptor.scriptSetup?.content;
if (!script) throw new Error('App.vue script setup unavailable');
const ast = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true);
const warm = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'warmGalleryThumbs');
if (!warm && !script.includes('startGalleryThumbnailWarmup')) throw new Error('Production warmup unavailable; update the measurement adapter');
const contents = `
import {kvInit, kvGet as get, kvSet as set} from './src/composables/useKVStore';
import {imgGet as read, imgPutRecord} from './src/composables/useImageStore';
import {blobThumbDataUrl as thumb, thumbKey} from './src/utils/imageThumb';
import {ARTWORK_HISTORY_KV_KEY as HISTORY_KEY} from './src/utils/storageKeys';
interface ThumbWarmEntry { image_id?: string }
let warmStopped=false, warmHandle=0;
const counters={reads:0, thumbnailReads:0, generated:0, writes:0, images:[] as string[]};
const kvGet=async(key:string)=>{ counters.reads++; if(key.startsWith('thumb:'))counters.thumbnailReads++; return get(key) };
const kvSet=async(key:string,value:unknown)=>{ counters.writes++; return set(key,value) };
const imgGet=async(id:string)=>{counters.images.push(id);return read(id)};
const blobThumbDataUrl=async(blob:Blob)=>{counters.generated++;return thumb(blob)};
${warm ? warm.getText(ast) : `
import {createThumbnailWarmup} from './src/utils/galleryThumbnailWarmup';
let stopWarm:()=>void=()=>{};
async function warmGalleryThumbs(){stopWarm=createThumbnailWarmup({
  list:async()=>{await kvInit();return kvGet(HISTORY_KEY)},get:kvGet,put:kvSet,image:imgGet,render:blobThumbDataUrl,
  lock:(key,work)=>navigator.locks.request('huiyu-thumbnail:'+key,work),
  visible:()=>document.visibilityState==='visible',
  listen:listener=>{document.addEventListener('visibilitychange',listener);return()=>document.removeEventListener('visibilitychange',listener)},
  schedule:work=>window.requestIdleCallback?window.requestIdleCallback(work,{timeout:4000}):window.setTimeout(work,120),
  cancel:handle=>window.cancelIdleCallback?window.cancelIdleCallback(handle):window.clearTimeout(handle),
})}`}
export async function seed(count:number) {
  const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=1024;
  const ctx=canvas.getContext('2d')!;ctx.fillStyle='#5a7680';ctx.fillRect(0,0,1024,1024);
  const blob=await new Promise<Blob>(resolve=>canvas.toBlob(value=>resolve(value!),'image/png'));
  for(let index=0;index<64;index++)await imgPutRecord({id:'fixture-'+index,blob});
  await set(HISTORY_KEY,Array.from({length:count},(_,index)=>({id:'work-'+index,image_id:'fixture-'+index%64})));
  return {originals:64,originalBytes:blob.size,pixels:[1024,1024]};
}
export function start(){return warmGalleryThumbs()}
export function stop(){${warm ? 'warmStopped=true;if(window.cancelIdleCallback)window.cancelIdleCallback(warmHandle);else clearTimeout(warmHandle)' : 'stopWarm()'}}
export function snapshot(){return {...counters,visibility:document.visibilityState}}
`;

async function main() {
  const bundle = await build({ stdin: { contents, resolveDir: root, loader:'ts' }, bundle:true,
    format:'iife', globalName:'warmFixture', write:false, platform:'browser', logLevel:'silent', alias:{'@':path.join(root,'src')} });
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/fixture.js' ? 'application/javascript' : 'text/html');
    response.end(request.url === '/fixture.js' ? bundle.outputFiles[0].text : '<!doctype html><title>Isolated warmup measurement</title><script src="/fixture.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].find(file => fs.existsSync(file));
  const report: { environment: Record<string, unknown>; method: string; results: unknown[] } = {
    environment: { node:process.version, platform:process.platform,
      sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
      appSha256:createHash('sha256').update(appSource).digest('hex'),
      fixtureSha256:createHash('sha256').update(bundle.outputFiles[0].text).digest('hex') },
    method:'Three trials per 1k/10k histories, 64 shared neutral 1024px originals; 5s cold-thumbnail observation per scenario. Browser-only fixture calls the extracted production warmup, with real IndexedDB and decoding. Visibility is observed, never mocked: unavailable hidden states remain unmeasured. CDP JS heap/script/task durations exclude native/GPU memory; no latency thresholds.',
    results:[],
  };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}),
      ignoreDefaultArgs: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    report.environment.browser = browser.version();
    for (const count of [1_000, 10_000]) for (const mode of ['foreground', 'background', 'two-pages']) for (let trial=0;trial<3;trial++) {
      const context = await browser.newContext({viewport:{width:1440,height:960}});
      try {
        const first = await context.newPage();await first.goto(url);
        const media = await first.evaluate(count => (window as any).warmFixture.seed(count), count);
        const pages = [first];
        if (mode === 'two-pages') { const second=await context.newPage();await second.goto(url);pages.push(second); }
        if (mode === 'background') { const cover=await context.newPage();await cover.goto('about:blank');await cover.bringToFront(); }
        else await pages[pages.length-1].bringToFront();
        const sessions = await Promise.all(pages.map(page => context.newCDPSession(page)));
        for (const session of sessions) await session.send('Performance.enable');
        const before = await Promise.all(sessions.map(session=>session.send('Performance.getMetrics')));
        const visibilityBefore = await Promise.all(pages.map(page=>page.evaluate(()=>document.visibilityState)));
        await Promise.all(pages.map(page=>page.evaluate(()=>(window as any).warmFixture.start())));
        await new Promise(resolve=>setTimeout(resolve,5_000));
        const after = await Promise.all(sessions.map(session=>session.send('Performance.getMetrics')));
        const snapshots = await Promise.all(pages.map(page=>page.evaluate(()=>{(window as any).warmFixture.stop();return (window as any).warmFixture.snapshot()})));
        const images = snapshots.flatMap(snapshot=>snapshot.images as string[]);
        report.results.push({count,mode,trial,media,visibilityBefore,
          status: mode==='background' && (visibilityBefore[0]!=='hidden' || snapshots[0].visibility!=='hidden') ? 'background-unavailable' : 'measured',
          snapshots, repeatedImageReads:images.length-new Set(images).size,
          cdp:after.map((value,index)=>Object.fromEntries(['JSHeapUsedSize','ScriptDuration','TaskDuration'].map(name=>{
            const initial=before[index].metrics.find(metric=>metric.name===name)?.value;
            const final=value.metrics.find(metric=>metric.name===name)?.value;
            return [name,{before:initial??null,after:final??null,delta:initial!==undefined&&final!==undefined?final-initial:null}];
          }))) });
      } finally {await context.close()}
    }
    console.log(JSON.stringify(report,null,2));
  } finally { await browser?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve())) }
}
main().catch(error=>{console.error(error);process.exitCode=1});
