use super::*;
use std::{path::PathBuf, process::Stdio};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::mpsc,
};
pub(super) struct TunnelRun {
    cancel: CancellationToken,
    done: tokio::task::JoinHandle<()>,
}

async fn drain<R: AsyncRead + Unpin>(
    stream: Option<R>,
    tx: mpsc::Sender<Vec<u8>>,
    cancel: CancellationToken,
) {
    let Some(mut stream) = stream else { return };
    let mut bytes = [0u8; 4096];
    loop {
        let read = tokio::select! {r=stream.read(&mut bytes)=>r,_=cancel.cancelled()=>break};
        match read {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                tokio::select! {r=tx.send(bytes[..n].to_vec())=>if r.is_err(){break},_=cancel.cancelled()=>break}
            }
        }
    }
}
pub(super) fn tunnel_url(text: &str) -> Option<String> {
    static URL: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com\b").unwrap()
    });
    URL.find_iter(text)
        .find(|m| {
            text[m.end()..]
                .chars()
                .next()
                .is_none_or(|c| !c.is_ascii_alphanumeric() && !matches!(c, '.' | '-'))
        })
        .map(|m| m.as_str().to_owned())
}
impl ControlService {
    pub(super) fn tunnel_path(&self) -> PathBuf {
        std::env::var_os("CLOUDFLARED_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Program Files (x86)\cloudflared\cloudflared.exe"))
    }
    pub(super) fn tunnel_disabled(&self) -> bool {
        std::env::var("DISABLE_TUNNEL").is_ok_and(|s| s == "1")
    }
    pub(super) async fn start_tunnel(self: &Arc<Self>) -> Result<()> {
        let _action = self.tunnel_action.lock().await;
        let mut current = self.tunnel.lock().await;
        if self.shutdown.is_cancelled() {
            return Err(ApiError::new(503, "SHUTTING_DOWN", "运行时正在退出"));
        }
        if current
            .as_ref()
            .is_some_and(|run| !run.cancel.is_cancelled())
        {
            return Ok(());
        }
        if self.tunnel_disabled() {
            return Err(ApiError::new(
                409,
                "TUNNEL_DISABLED",
                "公网分享已被配置禁用",
            ));
        }
        if !self.tunnel_path().is_file() {
            return Err(ApiError::new(
                503,
                "TUNNEL_UNAVAILABLE",
                "cloudflared 未安装",
            ));
        }
        let cancel = self.shutdown.child_token();
        self.patch(json!({"autoTunnel":true})).await?;
        let process = self.spawn_tunnel()?;
        self.remote.set_tunnel_url("")?;
        let service = self.clone();
        let task_cancel = cancel.clone();
        let done = self.tasks.spawn(async move {
            service.supervise_tunnel(process, task_cancel).await;
        });
        *current = Some(TunnelRun { cancel, done });
        Ok(())
    }
    fn spawn_tunnel(&self) -> Result<crate::processes::OwnedProcess> {
        let mut command = Command::new(self.tunnel_path());
        command
            .args([
                "tunnel",
                "--url",
                &format!("http://127.0.0.1:{}", self.config.bind.port()),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        self.processes.spawn(&mut command)
    }
    async fn supervise_tunnel(
        self: Arc<Self>,
        mut process: crate::processes::OwnedProcess,
        cancel: CancellationToken,
    ) {
        let mut attempts = 0u32;
        loop {
            let (stdout, stderr) = process.take_output();
            let (tx, mut rx) = mpsc::channel(16);
            let readers = cancel.child_token();
            let out = self.tasks.spawn(drain(stdout, tx.clone(), readers.clone()));
            let err = self.tasks.spawn(drain(stderr, tx, readers.clone()));
            let mut buffer = String::new();
            let mut published = false;
            loop {
                tokio::select! {
                    _=cancel.cancelled()=>break,
                    chunk=rx.recv()=>if let Some(chunk)=chunk {buffer.push_str(&String::from_utf8_lossy(&chunk));
                        if !published&&buffer.to_ascii_lowercase().contains("registered tunnel connection")&& let Some(url)=tunnel_url(&buffer) {
                            let _guard=self.tunnel.lock().await;
                            if !cancel.is_cancelled()&&self.remote.set_tunnel_url(&url).is_ok(){published=true;attempts=0;self.log("公网分享通道已连接");}
                        }
                        if buffer.len()>64*1024 {let mut start=buffer.len()-32*1024;while !buffer.is_char_boundary(start){start+=1;}buffer.drain(..start);}
                    }else{break},
                    _=tokio::time::sleep(Duration::from_millis(200))=>if process.exited().ok().flatten().is_some(){break;},
                }
            }
            readers.cancel();
            let _ = process.stop().await;
            let _ = tokio::join!(out, err);
            {
                let _guard = self.tunnel.lock().await;
                if !cancel.is_cancelled() {
                    let _ = self.remote.set_tunnel_url("");
                }
            }
            if cancel.is_cancelled() {
                break;
            }
            attempts += 1;
            if attempts > 10 {
                self.log("公网分享重连次数已达上限");
                cancel.cancel();
                break;
            }
            tokio::select! {_=cancel.cancelled()=>break,_=tokio::time::sleep(Duration::from_secs((5*attempts as u64).min(30)))=>{}}
            if cancel.is_cancelled() {
                break;
            }
            match self.spawn_tunnel() {
                Ok(next) => process = next,
                Err(_) => {
                    self.log("公网分享进程无法启动");
                    cancel.cancel();
                    break;
                }
            }
        }
    }
    pub(super) async fn stop_tunnel(&self) {
        let _ = self.stop_tunnel_request(false).await;
    }
    pub(super) async fn stop_tunnel_request(&self, persist: bool) -> Result<()> {
        let _action = self.tunnel_action.lock().await;
        let run = {
            let mut current = self.tunnel.lock().await;
            let run = current.take();
            if let Some(run) = &run {
                run.cancel.cancel();
            }
            let _ = self.remote.set_tunnel_url("");
            run
        };
        if let Some(run) = run {
            let _ = run.done.await;
        }
        if persist {
            self.patch(json!({"autoTunnel":false})).await?;
        }
        Ok(())
    }
}
