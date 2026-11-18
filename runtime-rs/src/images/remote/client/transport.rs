use super::*;

impl Client {
    pub(super) async fn bytes(
        &self,
        method: Method,
        path: &str,
        body: Option<Vec<u8>>,
        content_type: &str,
        max: usize,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>> {
        let mut request =
            self.request(method, path)
                .timeout(Duration::from_secs(if path.ends_with("/status") {
                    4
                } else {
                    60
                }));
        if let Some(body) = body {
            request = request.header("content-type", content_type).body(body);
        }
        read_body(self.send(request, cancel).await?, max, cancel).await
    }

    pub(super) fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{path}", self.base))
            .header("x-token", &self.key)
    }

    pub(super) async fn send(
        &self,
        request: reqwest::RequestBuilder,
        cancel: &CancellationToken,
    ) -> Result<reqwest::Response> {
        let response = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(inputs::cancelled()),
            response = request.send() => response.map_err(|_| unavailable())?,
        };
        if !header_enabled(&response, "x-huiyu-image-protocol") {
            return Err(ApiError::new(
                502,
                "REMOTE_PROTOCOL_MISMATCH",
                "该地址不是兼容的绘遇远程绘图端口",
            ));
        }
        let status = response.status();
        if status.is_success() {
            self.completion_supported.store(
                header_enabled(&response, COMPLETION_HEADER),
                Ordering::Relaxed,
            );
            return Ok(response);
        }
        let bytes = read_body(response, 64 * 1024, cancel).await?;
        let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        let message = value["error"]
            .as_str()
            .unwrap_or("请检查远程绘图服务、地址和连接密钥")
            .replace(&self.key, "[redacted]");
        Err(ApiError::new(
            status.as_u16(),
            "REMOTE_REQUEST_FAILED",
            message.chars().take(300).collect::<String>(),
        ))
    }

    pub(super) async fn json(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let body = body.map(serde_json::to_vec).transpose()?;
        let bytes = self
            .bytes(
                method,
                path,
                body,
                "application/json",
                RECEIPT_LIMIT,
                cancel,
            )
            .await?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| protocol())?;
        if value["ok"] != true {
            return Err(protocol());
        }
        Ok(value)
    }
}

pub(super) const RECEIPT_LIMIT: usize = 2 * 1024 * 1024;

pub(super) async fn read_body(
    response: reqwest::Response,
    max: usize,
    cancel: &CancellationToken,
) -> Result<Vec<u8>> {
    let too_large = || ApiError::new(502, "REMOTE_RESPONSE_INVALID", "远程绘图返回的数据过大");
    let length = response.content_length().unwrap_or_default();
    if length > max as u64 {
        return Err(too_large());
    }
    let mut bytes = Vec::with_capacity(if response.status().is_success() {
        length as usize
    } else {
        0
    });
    let mut stream = response.bytes_stream();
    loop {
        let chunk = tokio::select! {
            _ = cancel.cancelled() => return Err(inputs::cancelled()),
            chunk = stream.next() => chunk,
        };
        let Some(chunk) = chunk else { break };
        let chunk = chunk.map_err(|_| unavailable())?;
        if chunk.len() > max - bytes.len() {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub(super) fn header_enabled(response: &reqwest::Response, header: &str) -> bool {
    response
        .headers()
        .get(header)
        .is_some_and(|value| value == "1")
}
