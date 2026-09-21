import http = require('node:http');
import fs = require('node:fs');
import path = require('node:path');
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// Production exporter, parser and restore transaction in a fresh browser origin.
// No gateway, installed profile, external URL or user library is opened.
async function main() {
  const root = path.resolve(__dirname, '../../..');
  const bundle = await build({stdin:{resolveDir:root,contents:[
    "export * from './src/utils/backupExport';", "export * from './src/utils/backupCore';",
    "export * from './src/storage/backupRestore';", "export * from './src/composables/useKVStore';",
    "export * from './src/composables/useImageStore';", "export * from './src/utils/storageKeys';",
  ].join('\n')},bundle:true,write:false,format:'iife',globalName:'restoreFixture',platform:'browser',logLevel:'silent',alias:{'@':path.join(root,'src')}});
  const server = http.createServer((request,response)=>{
    response.setHeader('Content-Type',request.url==='/fixture.js'?'application/javascript':'text/html');
    response.end(request.url==='/fixture.js'?bundle.outputFiles[0].text:'<!doctype html><script src="/fixture.js"></script>');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].find(file=>fs.existsSync(file));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const report: {environment:Record<string,unknown>;method:string;results:unknown[]} = {
    environment:{node:process.version,platform:process.platform,
      sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
      fixtureSha256:createHash('sha256').update(bundle.outputFiles[0].text).digest('hex')},
    method:'Three fresh private contexts each for 1k/10k histories and 64 deterministic 256px noisy PNG originals. Real buildBackupBlob -> Blob.text -> JSON.parse/normalizeBackup -> restoreBackupData(replace=true); verifies restored count, all 64 original byte lengths, remapped references and preserved old original. CDP JSHeapUsedSize sampled ~25ms is a lower bound on observed JS heap, excludes Blob backing memory, browser/native/GPU memory; not a 512MiB capacity or cancellation claim.',results:[],
  };
  try {
    browser=await chromium.launch({...(executablePath?{executablePath}:{})});
    report.environment.browser=browser.version();
    for(const count of [1_000,10_000])for(let trial=0;trial<3;trial++){
      const context=await browser.newContext();
      try{
        const page=await context.newPage();await page.goto(`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`);
        const session=await context.newCDPSession(page);await session.send('Performance.enable');
        const heap:number[]=[];let finished=false;
        const sampling=(async()=>{while(!finished){const metrics=await session.send('Performance.getMetrics');const value=metrics.metrics.find(metric=>metric.name==='JSHeapUsedSize')?.value;if(value!==undefined)heap.push(value);await new Promise(resolve=>setTimeout(resolve,25));}})();
        let measured:unknown;
        try{
          measured=await page.evaluate(async count=>{
            const api=(window as any).restoreFixture;
            const images:any[]=[];let seed=123456789;
            const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
            const ctx=canvas.getContext('2d')!;
            for(let index=0;index<64;index++){
              const pixels=ctx.createImageData(256,256);
              for(let pos=0;pos<pixels.data.length;pos+=4){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;pixels.data[pos]=seed&255;pixels.data[pos+1]=(seed>>>8)&255;pixels.data[pos+2]=(seed>>>16)&255;pixels.data[pos+3]=255;}
              ctx.putImageData(pixels,0,0);
              const blob=await new Promise<Blob>(resolve=>canvas.toBlob(value=>resolve(value!),'image/png'));
              images.push({id:`image-${index}`,blob,name:`neutral-${index}.png`,type:'image/png',size:blob.size,created_at:1});
            }
            const history=Array.from({length:count},(_,index)=>({id:`work-${index}`,image_id:`image-${index%64}`,prompt:'Isolated capacity fixture. '.repeat(16),timestamp:index+1}));
            await api.imgPutRecord({id:'old-original',blob:images[0].blob});
            await api.kvSet(api.ARTWORK_HISTORY_KV_KEY,[{id:'old-work',image_id:'old-original'}]);
            localStorage.setItem('aics_theme','dark');
            const exportStart=performance.now();
            const {blob}=await api.buildBackupBlob({appVersion:'capacity-fixture',history,projects:[{id:'project',history_ids:history.map(item=>item.id)}],settings:{aics_theme:'light'}},images);
            const exportMs=performance.now()-exportStart;
            const readStart=performance.now();const text=await blob.text();const readMs=performance.now()-readStart;
            const parseStart=performance.now();const parsed=api.normalizeBackup(JSON.parse(text));const parseMs=performance.now()-parseStart;
            const restoreStart=performance.now();await api.restoreBackupData(parsed,true);const restoreMs=performance.now()-restoreStart;
            const restored=await api.kvGet(api.ARTWORK_HISTORY_KV_KEY);
            if(restored.length!==count||localStorage.getItem('aics_theme')!=='light')throw Error('Restored metadata mismatch');
            const ids=[...new Set<string>(restored.map((item:any)=>item.image_id))];
            if(ids.length!==64||ids.some(id=>!id.startsWith('img_restore_')))throw Error('Restored image identities mismatch');
            let restoredImageBytes=0;
            for(let index=0;index<ids.length;index++){const image=await api.imgGetRecord(ids[index]);if(!image||image.blob.size!==images[index].blob.size)throw Error('Restored original mismatch');restoredImageBytes+=image.blob.size;}
            if(!(await api.imgGetRecord('old-original')))throw Error('Existing original was removed');
            return {exportMs,readMs,parseMs,restoreMs,backupBytes:blob.size,restoredImageBytes,historyCount:restored.length,imageCount:ids.length,visibility:document.visibilityState};
          },count);
        }finally{finished=true;await sampling}
        report.results.push({count,trial,measured,heap:{unit:'bytes',samples:heap.length,before:heap[0]??null,after:heap.at(-1)??null,observedPeak:heap.length?Math.max(...heap):null,raw:heap}});
      }finally{await context.close()}
    }
    console.log(JSON.stringify(report,null,2));
  }finally{await browser?.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
}
main().catch(error=>{console.error(error);process.exitCode=1});
