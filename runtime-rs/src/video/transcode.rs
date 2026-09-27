use super::*;
use futures_util::future::BoxFuture;
use std::process::Stdio;
use tokio::sync::{Mutex, Semaphore};
pub trait Transcoder: Send + Sync {
    fn run(&self, args: Vec<String>, cancel: CancellationToken) -> BoxFuture<'_, Result<()>>;
    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
}
#[derive(Default)]
pub(super) struct Ffmpeg {
    processes: Arc<crate::processes::Processes>,
}
impl Transcoder for Ffmpeg {
    fn run(&self, args: Vec<String>, cancel: CancellationToken) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let mut command = tokio::process::Command::new("ffmpeg");
            command
                .args(args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let process = self.processes.spawn(&mut command)?;
            let result = tokio::select! {_=cancel.cancelled()=>Err(error(499,"VIDEO_BATCH_CANCELLED","视频处理已取消")),_=tokio::time::sleep(Duration::from_secs(600))=>Err(error(504,"FFMPEG_TIMEOUT","视频处理超时")),result=async{loop{if let Some(ok)=process.exited()?{return if ok{Ok(())}else{Err(error(502,"FFMPEG_FAILED","ffmpeg 执行失败"))}}tokio::time::sleep(Duration::from_millis(50)).await;}}=>result};
            process.stop().await?;
            result
        })
    }
    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async { self.processes.close().await })
    }
}
pub(super) struct Queue {
    capacity: Arc<Semaphore>,
    serial: Mutex<()>,
    runner: Arc<dyn Transcoder>,
}
impl Queue {
    pub fn new(runner: Arc<dyn Transcoder>) -> Self {
        Self {
            capacity: Arc::new(Semaphore::new(4)),
            serial: Mutex::new(()),
            runner,
        }
    }
    pub async fn run(&self, args: Vec<String>, cancel: CancellationToken) -> Result<()> {
        let _permit = self
            .capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| error(503, "QUEUE_FULL", "视频处理队列已满"))?;
        let _serial = tokio::select! {lock=self.serial.lock()=>lock,_=cancel.cancelled()=>return Err(error(499,"VIDEO_BATCH_CANCELLED","视频处理已取消"))};
        if cancel.is_cancelled() {
            return Err(error(499, "VIDEO_BATCH_CANCELLED", "视频处理已取消"));
        }
        self.runner.run(args, cancel).await
    }
    pub async fn close(&self) {
        self.runner.close().await
    }
}
pub(super) async fn tail(
    service: &Service,
    result: &Output,
    cancel: CancellationToken,
) -> Result<String> {
    let Output::File { path, .. } = result else {
        return Err(error(500, "VIDEO_RESULT_INVALID", "视频结果缺少文件"));
    };
    let name = format!("aics_video_input_{}.png", uuid::Uuid::new_v4().simple());
    let target = inputs::path(&service.config, &name)?;
    tokio::fs::create_dir_all(target.parent().unwrap()).await?;
    let args = [
        "-y",
        "-sseof",
        "-0.1",
        "-i",
        path.to_str()
            .ok_or_else(|| error(500, "VIDEO_RESULT_INVALID", "视频路径无效"))?,
        "-frames:v",
        "1",
        "-update",
        "1",
        target.to_str().unwrap(),
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    if let Err(e) = service.transcode.run(args, cancel).await {
        let _ = tokio::fs::remove_file(target).await;
        return Err(e);
    }
    if !tokio::fs::metadata(&target)
        .await
        .is_ok_and(|m| m.is_file() && m.len() > 0)
    {
        return Err(error(500, "VIDEO_TAIL_FAILED", "尾帧抽取未产生文件"));
    }
    Ok(name)
}
pub(super) async fn concat(
    service: &Service,
    id: &str,
    outputs: &[Output],
    canvas: &Value,
    cancel: CancellationToken,
) -> Result<Output> {
    let root = service.config.runtime_root.join("outputs/video");
    tokio::fs::create_dir_all(&root).await?;
    let operation = uuid::Uuid::new_v4().simple().to_string();
    let list = root.join(format!("batch_{id}_{operation}.txt"));
    let pending = root.join(format!(".batch_{id}_{operation}.part.mp4"));
    let target = root.join(format!("batch_{id}_{operation}.mp4"));
    let result=async{
        let mut lines=String::new();for output in outputs{let Output::File{path,..}=output else{return Err(error(500,"VIDEO_RESULT_INVALID","视频结果缺少文件"))};let canonical=tokio::fs::canonicalize(path).await?;if !canonical.starts_with(tokio::fs::canonicalize(&root).await?){return Err(error(403,"VIDEO_RESULT_INVALID","视频结果超出授权目录"))}lines.push_str(&format!("file '{}'\n",path.to_string_lossy().replace('\'',"'\\''")));}tokio::fs::write(&list,lines).await?;
        let filter=format!("scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2,setsar=1",canvas["width"],canvas["height"],canvas["width"],canvas["height"]);
        let mut common=vec!["-y".into(),"-f".into(),"concat".into(),"-safe".into(),"0".into(),"-i".into(),list.to_string_lossy().into_owned(),"-vf".into(),filter];common.extend(["-c:v","libx264","-preset","medium","-crf","19","-pix_fmt","yuv420p"].map(str::to_owned));
        let mut audio=common.clone();audio.extend(["-c:a","aac","-b:a","192k"].map(str::to_owned));audio.push(pending.to_string_lossy().into_owned());
        if let Err(e)=service.transcode.run(audio,cancel.clone()).await{if cancel.is_cancelled(){return Err(e)}let _=tokio::fs::remove_file(&pending).await;common.push("-an".into());common.push(pending.to_string_lossy().into_owned());service.transcode.run(common,cancel.clone()).await?;}
        if cancel.is_cancelled(){return Err(error(499,"VIDEO_BATCH_CANCELLED","视频拼接已取消"))}let bytes=tokio::fs::metadata(&pending).await?.len();if bytes==0{return Err(error(500,"BATCH_CONCAT_FAILED","视频拼接失败"))}tokio::fs::rename(&pending,&target).await?;Ok(Output::File{path:target.clone(),mime:"video/mp4".into(),bytes})
    }.await;
    let _ = tokio::fs::remove_file(list).await;
    let _ = tokio::fs::remove_file(pending).await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(target).await;
    }
    result
}
