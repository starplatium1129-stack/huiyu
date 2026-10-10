use super::*;
use futures_util::future::BoxFuture;

#[derive(Default)]
struct Hooks(std::sync::Mutex<Vec<&'static str>>);
impl ExecutionHooks for Hooks {
    fn checkpoint(&self, _: Value) -> BoxFuture<'_, Result<()>> { Box::pin(async { self.0.lock().unwrap().push("checkpoint"); Ok(()) }) }
    fn submitting(&self, provider: String, _: String) -> BoxFuture<'_, Result<()>> { Box::pin(async move { assert_eq!(provider,"native"); self.0.lock().unwrap().push("submitting"); Ok(()) }) }
    fn observed(&self, _: String, _: Value) -> BoxFuture<'_, Result<()>> { Box::pin(async { self.0.lock().unwrap().push("observed"); Ok(()) }) }
    fn collect(&self, outputs: Vec<Output>) -> BoxFuture<'_, Result<()>> { Box::pin(async move { assert_eq!(outputs.len(),1); self.0.lock().unwrap().push("collect"); Ok(()) }) }
}
fn fixture(root: &std::path::Path, script: &str) -> (Arc<Service>, Plan) {
    let worker=root.join("worker.py");
    std::fs::write(&worker,script).unwrap();
    let mut service=Service::for_images(Config { sd_host:"http://127.0.0.1:1".into(),sd_auth:None,comfy_host:"http://127.0.0.1:1".into(),ai_workspace_root:root.into(),runtime_root:root.join("runtime") },LocalUpstream::new(),CancellationToken::new()).unwrap();
    // Inject the selected engine without process-global environment mutation.
    Arc::get_mut(&mut service.inner).unwrap().native_images=true;
    let plan=Plan {input:json!({"family":"anima","modelId":"anima-base-v1.0","prompt":"fixture","negative":"","width":1,"height":1,"steps":2,"cfg":4.5,"seed":1,"sampler":"euler","scheduler":"simple","teaCache":false,"inferenceEngine":"native"}),settings:Settings {engine:"native".into(),python:PathBuf::from("python3"),worker,models_root:root.join("models"),loras_root:root.join("loras"),environment_overrides:vec![]},model_dir:root.into(),mask_model_dir:None,tea_cache_profile_path:None,init_image:None,mask_image:None,loras:vec![]};
    (Arc::new(service),plan)
}
async fn settled(service: &Service, id: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(10),async {
        loop { let state=service.get_job(id,"owner").await.unwrap(); if terminal(state["status"].as_str().unwrap()) { return state; } tokio::time::sleep(Duration::from_millis(10)).await; }
    }).await.expect("fixture worker must settle")
}
#[tokio::test]
async fn native_result_uses_jobs_hooks_and_owner_authorization_without_comfy() {
    let root=tempfile::tempdir().unwrap();
    let (service,mut plan)=fixture(root.path(),r#"import json,sys,zlib,struct
r=json.loads(sys.stdin.readline())
assert r['input']['teaCache'] is False
assert 'teaCacheThresh' not in r['input'] and r['teaCacheProfilePath'] is None
assert open(r['inputImagePath'],'rb').read()==b'accepted original'
assert r['input']['denoisingStrength']==0.8
assert open(r['maskImagePath'],'rb').read()==b'accepted mask'
assert r['input']['growMaskBy']==6
assert 'maskImage' not in r['input']
assert r['loras'][0]['strength']==0.75
assert r['loras'][0]['path'].endswith('catalog.safetensors')
assert 'initImage' not in r['input'] and 'loraId' not in r['input']
def chunk(t,d): return struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d))
png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>2I5B',1,1,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b'\0\xff\0\0'))+chunk(b'IEND',b'')
open(r['outputPath'],'wb').write(png)
print(json.dumps({'id':r['id'],'event':'progress','step':1,'total':2}),flush=True)
print(json.dumps({'id':r['id'],'event':'result','outputPath':r['outputPath']}),flush=True)
"#);
    plan.init_image=Some(Arc::new(b"accepted original".to_vec()));
    plan.input["denoisingStrength"]=json!(0.8);
    plan.mask_image=Some(Arc::new(b"accepted mask".to_vec()));
    plan.input["growMaskBy"]=json!(6);
    plan.loras=vec![json!({"path":root.path().join("catalog.safetensors"),"strength":0.75})];
    let hooks=Arc::new(Hooks::default());
    let prepared=service.prepare_native(plan,CancellationToken::new()).await.unwrap();
    let submitted=service.clone().submit(prepared,"owner".into(),Some(hooks.clone())).await.unwrap();
    let id=submitted["id"].as_str().unwrap();
    let result=settled(&service,id).await;
    assert_eq!(result["status"],"succeeded","{result}");
    assert_eq!(result["provider"],"native");
    assert_eq!(result["progress"],1);
    assert_eq!(service.result(id,"intruder").await.unwrap_err().code,"RESULT_NOT_FOUND");
    assert_eq!(service.result(id,"owner").await.unwrap().mime(),"image/png");
    tokio::time::timeout(Duration::from_secs(2),async { loop { if hooks.0.lock().unwrap().contains(&"collect") { break; } tokio::task::yield_now().await; } }).await.unwrap();
    assert_eq!(*hooks.0.lock().unwrap(),vec!["checkpoint","submitting","observed","collect"]);
    service.close().await;
}

#[tokio::test]
async fn native_teacache_forwards_only_the_host_selected_profile_and_explicit_parameters() {
    let root=tempfile::tempdir().unwrap();
    let (service,mut plan)=fixture(root.path(),r#"import json,sys
r=json.loads(sys.stdin.readline())
assert r['teaCacheProfilePath'].endswith('teacache-profile.json')
assert r['input']['teaCache'] is True and r['input']['teaCacheThresh']==0.2
assert 'teaCacheProfilePath' not in r['input']
print(json.dumps({'id':r['id'],'event':'error','code':'FIXTURE_TEACACHE_VERIFIED','message':'contract verified'}),flush=True)
"#);
    plan.tea_cache_profile_path=Some(root.path().join("teacache-profile.json"));
    plan.input["teaCache"]=json!(true);
    plan.input["teaCacheThresh"]=json!(0.2);
    plan.input["teaCacheProfilePath"]=json!("/untrusted/request/path");
    let prepared=service.prepare_native(plan,CancellationToken::new()).await.unwrap();
    let submitted=service.clone().submit(prepared,"owner".into(),None).await.unwrap();
    let result=settled(&service,submitted["id"].as_str().unwrap()).await;
    assert_eq!(result["code"],"FIXTURE_TEACACHE_VERIFIED","{result}");
    service.close().await;
}
#[tokio::test]
async fn native_cancel_terminates_owned_worker_before_settling() {
    let root=tempfile::tempdir().unwrap();
    let marker=root.path().join("pid");
    let script=format!("import os,sys,json,time\nr=json.loads(sys.stdin.readline())\nopen({},'w').write(str(os.getpid()))\ntime.sleep(60)\n",serde_json::to_string(marker.to_str().unwrap()).unwrap());
    let (service,plan)=fixture(root.path(),&script);
    let prepared=service.prepare_native(plan,CancellationToken::new()).await.unwrap();
    let submitted=service.clone().submit(prepared,"owner".into(),None).await.unwrap();
    let id=submitted["id"].as_str().unwrap();
    let pid:i32=tokio::time::timeout(Duration::from_secs(5),async {loop { if let Ok(text)=tokio::fs::read_to_string(&marker).await {if let Ok(pid)=text.parse() {return pid;}} tokio::time::sleep(Duration::from_millis(10)).await; }}).await.unwrap();
    service.cancel(id,"owner").await.unwrap();
    assert_eq!(settled(&service,id).await["status"],"cancelled");
    assert_eq!(unsafe {libc::kill(pid,0)},-1,"owned worker must be reaped before cancellation settles");
    assert_eq!(service.pending(),0);
    service.close().await;
}

#[tokio::test]
async fn cancellation_before_registration_and_after_worker_success_settles() {
    for completed in [false, true] {
        let root=tempfile::tempdir().unwrap();
        let (service,plan)=fixture(root.path(),"");
        let prepared=service.prepare_native(plan,CancellationToken::new()).await.unwrap();
        let job=jobs::create(prepared,"owner".into(),None);
        // No registered cancellation token yet, or already completed process.
        cancel(service.inner.clone(),job.clone()).await.unwrap();
        let outcome=if completed { Ok(Output::Bytes {bytes:Arc::new(vec![1]),mime:"image/png".into()}) }
            else { Err(ApiError::new(499,"ABORT_ERR","cancelled before worker spawn")) };
        settle(&service.inner,&job,outcome,false).await;
        let state=job.state.lock().await;
        assert_eq!(state.status,"cancelled");
        assert!(state.settled && state.result.is_none() && state.permit.is_none());
        drop(state);
        assert_eq!(service.pending(),0);
        service.close().await;
    }
}

#[tokio::test]
async fn unconfirmed_termination_is_not_reported_as_cancelled() {
    let root=tempfile::tempdir().unwrap();
    let (service,plan)=fixture(root.path(),"");
    let prepared=service.prepare_native(plan,CancellationToken::new()).await.unwrap();
    let job=jobs::create(prepared,"owner".into(),None);
    cancel(service.inner.clone(),job.clone()).await.unwrap();
    settle(&service.inner,&job,Err(ApiError::new(503,"TERMINATION_UNCONFIRMED","cleanup failed")),true).await;
    let state=job.state.lock().await;
    assert_eq!(state.status,"failed");
    assert!(state.unknown && !state.settled && state.permit.is_some());
    assert_eq!(state.code.as_deref(),Some("TERMINATION_UNCONFIRMED"));
    drop(state);
    service.close().await;
}

#[tokio::test]
async fn native_automatic_mask_forwards_only_host_selected_model_and_frozen_parameters() {
    let root=tempfile::tempdir().unwrap();
    let (service,mut plan)=fixture(root.path(),r#"import json,sys
r=json.loads(sys.stdin.readline())
assert r['maskModelDir'].endswith('clipseg-rd64-refined')
assert r['maskImagePath'] is None
assert open(r['inputImagePath'],'rb').read()==b'accepted original'
assert r['input']['maskPrompt']=='jacket | sleeves'
assert r['input']['maskThreshold']==0.65
assert r['input']['growMaskBy']==4
assert 'maskModelDir' not in r['input']
print(json.dumps({'id':r['id'],'event':'error','code':'FIXTURE_MASK_VERIFIED','message':'contract verified'}),flush=True)
"#);
    plan.init_image=Some(Arc::new(b"accepted original".to_vec()));
    plan.mask_model_dir=Some(root.path().join("clipseg-rd64-refined"));
    plan.input["denoisingStrength"]=json!(0.6);
    plan.input["maskPrompt"]=json!("jacket | sleeves");
    plan.input["maskThreshold"]=json!(0.65);
    plan.input["growMaskBy"]=json!(4);
    plan.input["maskModelDir"]=json!("/untrusted/request/path");
    let prepared=service.prepare_native(plan,CancellationToken::new()).await.unwrap();
    let submitted=service.clone().submit(prepared,"owner".into(),None).await.unwrap();
    let result=settled(&service,submitted["id"].as_str().unwrap()).await;
    assert_eq!(result["code"],"FIXTURE_MASK_VERIFIED","{result}");
    service.close().await;
}
