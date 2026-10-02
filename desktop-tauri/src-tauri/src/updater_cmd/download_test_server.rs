//! Small, bounded loopback fixtures: no production installer or network access.
use super::super::{
    cache::{Cache, Record},
    download,
};
use reqwest::{Client, Url};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

pub(super) const SIZE: usize = 64 * 1024;
pub(super) const PREFIX: usize = 16 * 1024;
static NEXT_ROOT: AtomicU64 = AtomicU64::new(0);

pub(super) struct Root(pub(super) PathBuf);
impl Root {
    pub(super) fn new() -> Self {
        Self(std::env::temp_dir().join(
            format!("studio-updater-http-{}-{}-{}",
            std::process::id(), NEXT_ROOT.fetch_add(1, Ordering::Relaxed),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()),
        ))
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        // Only remove the three known files in this fixture's unique directory.
        for name in ["download.lock", "download.json", "package.part"] {
            let _ = fs::remove_file(self.0.join(name));
        }
        let _ = fs::remove_dir(&self.0);
    }
}

#[derive(Debug, Clone)]
pub(super) struct Request {
    pub(super) path: String,
    headers: BTreeMap<String, String>,
    pub(super) body_bytes: usize,
}
pub(super) struct Reply {
    status: &'static str,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
    pub(super) stall: bool,
}
impl Reply {
    pub(super) fn new(status: &'static str, body: Vec<u8>) -> Self {
        let length = body.len();
        Self {
            status,
            headers: BTreeMap::new(),
            body,
            stall: false,
        }
        .header("Content-Length", length.to_string())
    }
    pub(super) fn header(mut self, key: &str, value: impl Into<String>) -> Self {
        self.headers.insert(key.into(), value.into());
        self
    }
    pub(super) fn complete(body: &[u8], etag: &str) -> Self {
        Self::new("200 OK", body.to_vec()).header("ETag", etag)
    }
    pub(super) fn partial(body: &[u8], etag: &str) -> Self {
        Self::new("206 Partial Content", body[PREFIX..].to_vec())
            .header("ETag", etag)
            .header(
                "Content-Range",
                format!("bytes {PREFIX}-{}/{}", body.len() - 1, body.len()),
            )
    }
    pub(super) fn redirect(path: &str) -> Self {
        Self::new("302 Found", Vec::new()).header("Location", path)
    }
}

pub(super) struct Server {
    pub(super) url: Url,
    requests: Arc<Mutex<Vec<Request>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Server {
    pub(super) fn start(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!(
            "http://{}/package",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        listener.set_nonblocking(true).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let logs = Arc::clone(&requests);
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = Arc::clone(&stop);
        let worker = thread::spawn(move || {
            let mut connections = Vec::new();
            'replies: for reply in replies {
                let deadline = Instant::now() + Duration::from_secs(4);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            if stopped.load(Ordering::Relaxed) {
                                break 'replies;
                            }
                            assert!(Instant::now() < deadline, "fixture request timed out");
                            thread::sleep(Duration::from_millis(2));
                        }
                        Err(error) => panic!("fixture accept: {error}"),
                    }
                };
                // Windows inherits the listener's nonblocking mode on accept.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                let request = read_request(&mut stream);
                let index = {
                    let mut logs = logs.lock().unwrap();
                    logs.push(request);
                    logs.len() - 1
                };
                let logs = Arc::clone(&logs);
                connections.push(thread::spawn(move || {
                    let mut head = format!("HTTP/1.1 {}\r\nConnection: close\r\n", reply.status);
                    for (name, value) in &reply.headers {
                        head.push_str(&format!("{name}: {value}\r\n"));
                    }
                    head.push_str("\r\n");
                    stream.write_all(head.as_bytes()).unwrap();
                    if stream.write_all(&reply.body).is_ok() {
                        logs.lock().unwrap()[index].body_bytes = reply.body.len();
                    }
                    if reply.stall {
                        // Wait for cancellation/read timeout to close the client, bounded by SO_RCVTIMEO.
                        let _ = stream.read(&mut [0]);
                    }
                }));
            }
            for connection in connections {
                connection.join().unwrap();
            }
        });
        Self {
            url,
            requests,
            stop,
            worker: Some(worker),
        }
    }
    pub(super) fn finish(mut self) -> Vec<Request> {
        self.worker.take().unwrap().join().unwrap();
        let requests = self.requests.lock().unwrap().clone();
        requests
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn read_request(stream: &mut TcpStream) -> Request {
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        let mut byte = [0];
        assert_eq!(stream.read(&mut byte).unwrap(), 1);
        bytes.push(byte[0]);
        assert!(bytes.len() < 8192, "fixture request exceeds header limit");
    }
    let text = String::from_utf8(bytes).unwrap();
    let mut lines = text.lines();
    let path = lines
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .into();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_string()))
        .collect();
    Request {
        path,
        headers,
        body_bytes: 0,
    }
}
pub(super) fn client() -> Client {
    // Only the loopback fixture overrides production HTTPS-only transport.
    download::configure_client(Client::builder())
        .https_only(false)
        .no_proxy()
        .connect_timeout(Duration::from_secs(1))
        .read_timeout(Duration::from_millis(150))
        .build()
        .unwrap()
}
pub(super) fn payload(marker: usize) -> Vec<u8> {
    (0..SIZE).map(|i| ((i * 37 + marker) % 251) as u8).collect()
}
pub(super) fn seed(root: &Root, url: &Url, bytes: &[u8], identity: &str) {
    let mut cache = Cache::open(&root.0, identity).unwrap();
    cache.record = Record {
        identity: identity.into(),
        etag: Some("\"v1\"".into()),
        resource: download::resource(url),
        total: Some(SIZE as u64),
    };
    cache.save().unwrap();
    cache.append(bytes).unwrap();
}
pub(super) fn assert_range(request: &Request, expected: bool) {
    if expected {
        assert_eq!(
            request.headers.get("range").map(String::as_str),
            Some(format!("bytes={PREFIX}-").as_str())
        );
        assert_eq!(
            request.headers.get("if-range").map(String::as_str),
            Some("\"v1\"")
        );
    } else {
        assert!(!request.headers.contains_key("range"), "{request:?}");
        assert!(!request.headers.contains_key("if-range"), "{request:?}");
    }
    assert_eq!(
        request.headers.get("accept-encoding").map(String::as_str),
        Some("identity")
    );
}
