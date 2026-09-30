import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require=createRequire(import.meta.url);
const {developmentNativeEnvironment}:typeof import('./maintenance/desktop-rust-inputs.js')=require('./maintenance/desktop-rust-inputs.js');
const defaultRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ROOT_INPUTS=new Set(['runtime-rs/Cargo.toml','runtime-rs/Cargo.lock','runtime-rs/build.rs','runtime-rs/native-dependencies.windows-x64.json']);
const SOURCE_DIRECTORIES=['runtime-rs/src','runtime-rs/native-data','data','native'];
interface DevelopmentOptions {
  watch?:boolean;debounceMs?:number;build?:()=>boolean|Promise<boolean>;start?:()=>ChildProcess;
  stop?:(child:ChildProcess)=>Promise<void>;reportError?:(error:unknown)=>void;
}
interface Running {directory:string;secret:string;profile:string;origin:string}
function waitExit(child:ChildProcess,timeout:number):Promise<void>{
  if(child.exitCode!==null||child.signalCode!==null)return Promise.resolve();
  return new Promise((resolve,reject)=>{const close=()=>{clearTimeout(timer);resolve();};
    const timer=setTimeout(()=>{child.removeListener('close',close);reject(Error(`Runtime ${child.pid} did not exit after authenticated drain; no replacement started`));},timeout);
    child.once('close',close);
  });
}
export async function drainDevelopmentRuntime(previous:ChildProcess,owned:{secret:string;profile:string;origin:string}){
    // Startup may still be opening storage. Challenge authentication prevents a
    // same-port stranger from authorizing shutdown or replacement of our child.
    const deadline=Date.now()+20000;let ready=false;
    while(Date.now()<deadline){if(previous.exitCode!==null||previous.signalCode!==null)return;
      const challenge=randomBytes(32).toString('hex');
      try{const response=await fetch(owned.origin+'/api/health',{headers:{'X-AICS-Desktop-Challenge':challenge},signal:AbortSignal.timeout(1200)});const value:any=await response.json();
        if(response.ok&&value.desktopProof===createHmac('sha256',owned.secret).update(challenge).digest('hex')){ready=true;break;}
      }catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(!ready)throw Error(`Runtime ${previous.pid} identity unavailable; retained process, no replacement started`);
    const body=JSON.stringify({action:'shutdown',windowId:'atelier',origin:owned.origin,sourceProfileId:owned.profile,timestamp:Date.now(),nonce:randomBytes(32).toString('hex')});
    const proof=createHmac('sha256',owned.secret).update('aics-desktop-host:v1\n'+body).digest('hex');
    const response=await fetch(owned.origin+'/api/desktop-host',{method:'POST',headers:{'content-type':'application/json','X-AICS-Host-Proof':proof},body,signal:AbortSignal.timeout(30000)});
    const result:any=await response.json();if(!response.ok||result.closed!==true)throw Error(`Runtime ${previous.pid} drain not confirmed; no replacement started`);
    await waitExit(previous,8000);
  }

/** Builds write Cargo's normal output; running images are independent copies so
 * Windows never locks the next compilation's EXE. Failed builds preserve service. */
export async function startDevelopment(root=defaultRoot,options:DevelopmentOptions={}){
  // Supported Node/libuv on Windows can abort when 8.3 watch roots receive long-path events.
  // Keep native canonical paths while those runtime versions remain supported.
  root=fs.realpathSync.native(path.resolve(root));const reportError=options.reportError||((error:unknown)=>console.error(error instanceof Error?error.message:String(error)));
  const watchers:fs.FSWatcher[]=[];const watched=new Set<string>();const ownership=new WeakMap<ChildProcess,Running>();
  let child:ChildProcess|undefined,timer:ReturnType<typeof setTimeout>|undefined,running:Promise<void>|undefined;
  let requested=false,closed=false,candidate:{directory:string;executable:string;env:NodeJS.ProcessEnv}|undefined;
  const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||3000);
  const bind=`${host.includes(':')?`[${host}]`:host}:${port}`,origin=`http://${bind}`;
  const profile=`profile-${randomBytes(32).toString('hex')}`;
  function discardCandidate(){if(candidate){fs.rmSync(candidate.directory,{recursive:true,force:true});candidate=undefined;}}
  const build=options.build||async function(){
    const cargoHome=process.env.CARGO_HOME||path.join(os.homedir(),'.cargo'),cargoPath=path.join(cargoHome,'bin',process.platform==='win32'?'cargo.exe':'cargo');
    const env={...process.env,CARGO_TARGET_DIR:path.join(root,'runtime-rs/target')};
    const compiling=spawn(fs.existsSync(cargoPath)?cargoPath:'cargo',['build','--locked','--manifest-path',path.join(root,'runtime-rs/Cargo.toml')],{cwd:root,env,stdio:'inherit',windowsHide:true});
    await new Promise<void>((resolve,reject)=>{compiling.once('error',reject);compiling.once('close',code=>code===0?resolve():reject(Error(`Rust build failed (${code}); keeping the last gateway`)));});
    const native=developmentNativeEnvironment(root,env);
    const executable=path.join(root,'runtime-rs/target/debug',process.platform==='win32'?'huiyu-runtime.exe':'huiyu-runtime');
    fs.mkdirSync(path.join(root,'runtime'),{recursive:true});const directory=fs.mkdtempSync(path.join(root,'runtime/dev-server-build-'));
    const versioned=path.join(directory,path.basename(executable));
    try{fs.copyFileSync(executable,versioned);if(process.platform!=='win32')fs.chmodSync(versioned,0o755);}
    catch(error){fs.rmSync(directory,{recursive:true,force:true});throw error;}
    discardCandidate();candidate={directory,executable:versioned,env:native};return true;
  };
  const start=options.start||function(){
    if(!candidate)throw Error('No successfully built Rust executable');
    const prepared=candidate;candidate=undefined;const secret=randomBytes(32).toString('hex');
    const env:NodeJS.ProcessEnv={...prepared.env,AICS_APP_ROOT:root,AICS_RUNTIME_ROOT:path.join(root,'runtime'),AICS_DESKTOP_GATEWAY_TOKEN:secret,AICS_DESKTOP_SOURCE_PROFILE_ID:profile};
    delete env.AICS_DESKTOP_CONFIG_ROOT;
    const started=spawn(prepared.executable,['--app-root',root,'--bind',bind],{cwd:root,env,stdio:'inherit',windowsHide:true});
    ownership.set(started,{directory:prepared.directory,secret,profile,origin});
    started.once('close',()=>{try{fs.rmSync(prepared.directory,{recursive:true,force:true,maxRetries:3,retryDelay:50});}catch(error){reportError(error);}});
    if(options.watch!==false)for(const key of ['AICS_ORT_DYLIB_PATH','AICS_VIPS_DYLIB_PATH'])if(env[key]){try{watchNative(env[key]!);}catch(error){reportError(error);}}
    return started;
  };
  async function authenticatedStop(previous:ChildProcess){
    const owned=ownership.get(previous);if(!owned)throw Error('A custom development start requires an explicit stop fixture');
    await drainDevelopmentRuntime(previous,owned);
  }
  async function stopChild(){
    const previous=child;if(!previous)return;
    if(previous.exitCode===null&&previous.signalCode===null)await (options.stop||authenticatedStop)(previous);
    // Failed drain retains the actual owned process; a retry cannot create a
    // second writer, and neither Windows SIGTERM nor taskkill bypasses storage.
    if(child===previous)child=undefined;
  }
  function rebuild():Promise<void>{
    if(closed)return Promise.resolve();requested=true;if(running)return running;
    running=Promise.resolve().then(async()=>{while(requested&&!closed){requested=false;
      try{const changed=await build();if(!closed&&(!child||changed)){await stopChild();if(closed)break;
        const started=start();child=started;started.once('error',reportError);started.once('close',()=>{if(child===started)child=undefined;});
      }}catch(error){reportError(error);}
    }}).finally(()=>{running=undefined;});return running;
  }
  function schedule(relative:string){
    relative=relative.replaceAll('\\','/');if(closed)return;
    if(!ROOT_INPUTS.has(relative)&&!SOURCE_DIRECTORIES.some(dir=>relative.startsWith(dir+'/')))return;
    clearTimeout(timer);timer=setTimeout(()=>{void rebuild();},options.debounceMs??180);
  }
  function watch(directory:string,recursive:boolean){
    const absolute=path.join(root,directory);if(!fs.existsSync(absolute)||watched.has(absolute))return;
    const watcher=fs.watch(absolute,{recursive},(_event,filename)=>{if(filename)schedule(path.join(directory,String(filename)));});
    watcher.on('error',reportError);watchers.push(watcher);watched.add(absolute);
  }
  function watchNative(file:string){
    const absolute=path.resolve(file);if(watched.has(absolute))return;
    const watcher=fs.watch(path.dirname(absolute),(_event,filename)=>{if(filename&&String(filename)===path.basename(absolute)){clearTimeout(timer);timer=setTimeout(()=>{void rebuild();},options.debounceMs??180);}});
    watcher.on('error',reportError);watchers.push(watcher);watched.add(absolute);
  }
  if(options.watch!==false){watch('runtime-rs',false);for(const directory of SOURCE_DIRECTORIES)watch(directory,true);}
  await rebuild();return {rebuild,get pid(){return child?.pid;},async close(){closed=true;clearTimeout(timer);for(const watcher of watchers)watcher.close();await running;await stopChild();discardCandidate();}};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  if(process.argv.slice(2).some(arg=>arg==='--help'||arg==='--plan'))console.log('dev-server.mts\nWatch Rust source/Cargo/native data. Build first, then authenticate and drain the prior runtime before restarting. Failed builds keep the working service; failed drains never start another writer.');
  else if(process.argv.length>2){console.error('Unknown arguments. Use --help.');process.exitCode=2;}
  else {try{const session=await startDevelopment();let stopping=false;const close=()=>{if(stopping)return;stopping=true;void session.close().then(()=>{process.exitCode=0;}).catch(error=>{stopping=false;console.error(error);process.exitCode=1;});};process.on('SIGINT',close);process.on('SIGTERM',close);}catch(error){console.error(error);process.exitCode=1;}}
}
