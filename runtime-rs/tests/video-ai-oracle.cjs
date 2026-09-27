const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto'),ts=require('typescript');
const root=path.resolve(__dirname,'../..');
function load(relative,exports){
  const file=path.join(root,relative);let source=fs.readFileSync(file,'utf8');
  if(exports)source=source.replace(/export\s*=\s*\{ createVideoAiRouter:createVideoAiRouter \};/,`export = {${exports.join(',')}};`);
  const entry=new Module(file,module);entry.filename=file;entry.paths=Module._nodeModulePaths(path.dirname(file));
  entry._compile(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);return entry.exports;
}
const prompts=load('routes/video-ai-prompts.ts');
const output=load('routes/video-ai-output.ts');
const names=['DIALOGUE_SYSTEM_PROMPT','REVIEW_SYSTEM_PROMPT','SCRIPT_SYSTEM_PROMPT'];
for(const action of ['Dialogue','Review','Script'])names.push(`validate${action}Body`,`build${action}UserPrompt`,`clean${action}Output`);
const extra=load('routes/video-ai.ts',names);
const storyboard=load('routes/video/storyboard.ts');
if(process.argv[2]==='--extract'){
  const selected={REWRITE_SYSTEM_PROMPT:prompts.REWRITE_SYSTEM_PROMPT,POLISH_SYSTEM_PROMPT:prompts.POLISH_SYSTEM_PROMPT};
  for(const key of ['DIALOGUE_SYSTEM_PROMPT','REVIEW_SYSTEM_PROMPT','SCRIPT_SYSTEM_PROMPT'])selected[key]=extra[key];
  const directory=path.join(root,'runtime-rs/src/video/ai');fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(directory,'constants.json'),JSON.stringify(selected,null,2)+'\n');
  const sources=['routes/video-ai.ts','routes/video-ai-prompts.ts','routes/video-ai-output.ts','routes/video/storyboard.ts'];
  fs.writeFileSync(path.join(directory,'sources.json'),JSON.stringify({formatVersion:1,method:'System messages mechanically extracted from current Node modules without executing a router or LLM.',sources:sources.map(file=>({path:file,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex')}))},null,2)+'\n');
}else{
  const shot={prompt:'A neutral figure walks through a room.',shotSize:'medium',camera:'still',motion:'natural',dialogue:'你好'};
  const cases=[
    {action:'rewrite',input:{...shot,identity:'silver hair'},parsed:{prompt:' A person opens the door. ',shotSize:'closeup',camera:'invalid',motion:' expressive ',dialogue:'好'}},
    {action:'rewrite',input:{prompt:'test',unexpected:true},parsed:{}},
    {action:'polish',input:{identity:'fixture',shots:[shot,{...shot,dialogue:''}]},parsed:{shots:[{index:0,shotSize:'wide',camera:'push',motion:'natural',dialogue:''},{index:'0',camera:'orbit',dialogue:null},{index:1,motion:'bad',dialogue:18},{index:8,camera:'pan'}]}},
    {action:'dialogue',input:{prompt:'A neutral person waves.',currentDialogue:'你好',mood:'calm'},parsed:{options:[null,{text:''},{text:' 好呀 ',label:'温柔'},{text:'你好',label:'简洁'},{text:'来了',label:'俏皮'},{text:'fourth'}]}},
    {action:'review',input:{shots:[shot]},parsed:{issues:[{index:'0',severity:'warn',field:'camera',message:'test',suggestion:'fix'},{index:1,severity:'error',field:'prompt',message:'out'},{index:null,severity:'error',field:'continuity',message:' valid '},{index:0,severity:'bad',field:'prompt',message:'bad'}]}},
    {action:'script',input:{story:'A neutral walk through town.',identity:'fixture',shotCount:'8',totalSeconds:30,characterLabels:[null,false,4,'']},parsed:{shots:[{prompt:' A neutral shot ',camera:' push ',motion:'natural',duration:8},{prompt:'second',shotSize:'wide',camera:'pan',duration:'10'}]}},
    {action:'script',input:{story:'test',shotCount:3},parsed:{}},
  ];
  for(const item of cases){const label=item.action[0].toUpperCase()+item.action.slice(1),api=['rewrite','polish'].includes(item.action)?prompts:extra;
    const validated=api[`validate${label}Body`](item.input);item.validation=validated;
    if(validated.value){item.messages=[{role:'system',content:api[`${item.action.toUpperCase()}_SYSTEM_PROMPT`]},{role:'user',content:api[`build${label}UserPrompt`](validated.value)}];
      item.cleaned=item.action==='rewrite'?output.cleanRewriteOutput(item.parsed,validated.value):api[`clean${label}Output`](item.parsed,validated.value);}
  }
  const blueprint={id:'fixture',title:'Neutral room',characterId:'fixture',description:'【小白·测试】在房间里说「你好呀」，然后说「一起走吧」。',location:'房间',action:'轻轻挥手',lighting:'窗光',mood:'安静',timeOfDay:'午后',promptProse:'A neutral room in daylight.'};
  process.stdout.write(JSON.stringify({cases,storyboards:['','慢慢转身'].map(intent=>({blueprint,intent,result:storyboard.buildStoryboard(blueprint,{intent})}))}));
}
