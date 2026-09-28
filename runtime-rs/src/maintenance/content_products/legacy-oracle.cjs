// Executes only the legacy product handlers against the explicitly supplied
// neutral fixture root. No model, renderer, command runner or production data.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const root=path.resolve(__dirname,'../../../..');
process.env.AICS_DATA_ROOT=input.options.root;process.env.AICS_APP_ROOT=input.options.root;
const ts=require(path.join(root,'node_modules/typescript'));const ordinary=Module._extensions['.js'];
Module._extensions['.js']=(module,file)=>{const source=file.replace(/\.js$/,'.ts');if(file.startsWith(root+path.sep)&&!file.includes(`${path.sep}node_modules${path.sep}`)&&fs.existsSync(source)){module._compile(ts.transpileModule(fs.readFileSync(source,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);}else ordinary(module,file);};
const {createMaintenanceRouter}=require(path.join(root,'routes/maintenance'));
const service=createMaintenanceRouter({ROOT_DIR:input.options.root,RUNTIME_ROOT:input.options.runtime,SCENE_SHOWCASE_DIR:input.options.showcase});
const results=[];
for(const operation of input.operations){let value,status=200;const route=service.router.stack.find(layer=>layer.route?.path===`/api/maintenance/${operation.hero?'home-hero':'showcase'}`&&layer.route.methods.post);const response={status(code){status=code;return this;},json(body){value=body;return this;},setHeader(){return this;}};route.route.stack.at(-1).handle({body:operation.body},response);if(!value?.ok)throw new Error(JSON.stringify({status,value}));delete value.backup;results.push(value);}
const manifest=JSON.parse(fs.readFileSync(path.join(input.options.showcase,'manifest.json'),'utf8'));const hero=JSON.parse(fs.readFileSync(path.join(input.options.showcase,'home-hero.json'),'utf8'));for(const entry of Object.values(hero.entries||{}))if(entry.updatedAt)entry.updatedAt='<timestamp>';
service.close();process.stdout.write(JSON.stringify({results,manifest,hero}));
