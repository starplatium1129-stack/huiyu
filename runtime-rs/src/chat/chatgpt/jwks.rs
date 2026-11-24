use crate::chat::{
    Duration, Error, Result,
    transport::{self, Request, Transport},
};
use aws_lc_rs::signature::{
    ECDSA_P256_SHA256_FIXED, RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents, UnparsedPublicKey,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::Value;
use std::time::Instant;
use tokio::sync::Mutex;
use url::Url;

const DISCOVERY_URL: &str = "https://auth.openai.com/.well-known/openid-configuration";
const EXPECTED_ISSUER: &str = "https://auth.openai.com";
const CLOCK_SKEW_SECONDS: i64 = 5;
const DISCOVERY_TTL: Duration = Duration::from_secs(6 * 3600);
const JWKS_TTL: Duration = Duration::from_secs(3600);
const JWKS_MIN_REFRESH_GAP: Duration = Duration::from_secs(15);

#[derive(Clone, Deserialize)]
pub(super) struct Discovery {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    #[serde(default)]
    pub revocation_endpoint: Option<String>,
    pub jwks_uri: String,
}

#[derive(Clone, Deserialize)]
struct JwkSet {
    keys: Vec<Jwk>,
}

#[derive(Clone, Deserialize)]
struct Jwk {
    kty: String,
    #[serde(default)]
    kid: Option<String>,
    #[serde(rename = "use", default)]
    key_use: Option<String>,
    #[serde(default)]
    alg: Option<String>,
    #[serde(default)]
    n: Option<String>,
    #[serde(default)]
    e: Option<String>,
    #[serde(default)]
    crv: Option<String>,
    #[serde(default)]
    x: Option<String>,
    #[serde(default)]
    y: Option<String>,
}

#[derive(Deserialize)]
struct JwtHeader {
    alg: String,
    #[serde(default)]
    kid: Option<String>,
}

pub(super) struct VerifiedIdentity {
    pub issuer: String,
    pub subject: String,
    pub email: Option<String>,
    pub email_verified: bool,
    pub name: Option<String>,
}

#[derive(Default)]
struct CacheState {
    discovery: Option<(Discovery, Instant)>,
    jwks: Option<(JwkSet, Instant)>,
}

#[derive(Default)]
pub(super) struct JwksCache {
    state: Mutex<CacheState>,
}

impl JwksCache {
    pub(super) async fn discovery(&self, client: &Transport) -> Result<Discovery> {
        {
            let guard = self.state.lock().await;
            if let Some((doc, fetched_at)) = &guard.discovery
                && fetched_at.elapsed() < DISCOVERY_TTL
            {
                return Ok(doc.clone());
            }
        }
        let target = Url::parse(DISCOVERY_URL).map_err(|_| auth_error("OpenAI 发现地址无效"))?;
        let mut attempts = 0u8;
        let response = loop {
            match client
                .send(
                    target.clone(),
                    Request {
                        body: None,
                        key: "",
                        session_id: None,
                        public_only: false,
                        idle: Duration::from_secs(15),
                        total: Duration::from_secs(20),
                        accept: "application/json",
                    },
                )
                .await
            {
                Ok(response) => break response,
                Err(error)
                    if attempts < 1
                        && matches!(error.code.as_str(), "UPSTREAM_UNAVAILABLE" | "UPSTREAM_TIMEOUT") =>
                {
                    attempts += 1;
                    tokio::time::sleep(Duration::from_millis(600)).await;
                }
                Err(error) => return Err(error),
            }
        };
        let response = transport::success(response, 64 * 1024, "OpenAI OIDC 发现配置").await?;
        let bytes = transport::bounded(response, 64 * 1024).await?;
        let doc: Discovery = serde_json::from_slice(bytes.as_ref())
            .map_err(|_| auth_error("无法解析 OpenAI OIDC 发现配置"))?;
        validate_discovery(&doc)?;
        let mut guard = self.state.lock().await;
        guard.discovery = Some((doc.clone(), Instant::now()));
        Ok(doc)
    }

    async fn jwks(&self, client: &Transport, uri: &str, force_refresh: bool) -> Result<JwkSet> {
        {
            let guard = self.state.lock().await;
            if let Some((set, fetched_at)) = &guard.jwks {
                let fresh = fetched_at.elapsed() < JWKS_TTL;
                let too_recent = fetched_at.elapsed() < JWKS_MIN_REFRESH_GAP;
                if (!force_refresh && fresh) || (force_refresh && too_recent) {
                    return Ok(set.clone());
                }
            }
        }
        let target = Url::parse(uri).map_err(|_| auth_error("OpenAI JWKS 地址无效"))?;
        validate_auth_url(&target)?;
        let response = client
            .send(
                target,
                Request {
                    body: None,
                    key: "",
                    session_id: None,
                    public_only: false,
                    idle: Duration::from_secs(15),
                    total: Duration::from_secs(20),
                    accept: "application/json",
                },
            )
            .await?;
        let response = transport::success(response, 64 * 1024, "OpenAI JWKS 密钥集").await?;
        let bytes = transport::bounded(response, 256 * 1024).await?;
        let set: JwkSet = serde_json::from_slice(bytes.as_ref())
            .map_err(|_| auth_error("无法解析 OpenAI JWKS 密钥集"))?;
        let mut guard = self.state.lock().await;
        guard.jwks = Some((set.clone(), Instant::now()));
        Ok(set)
    }

    pub(super) async fn verify_id_token(
        &self,
        client: &Transport,
        id_token: &str,
        expected_client_id: &str,
        expected_nonce: &str,
    ) -> Result<VerifiedIdentity> {
        let mut parts = id_token.split('.');
        let (Some(header_b64), Some(payload_b64), Some(sig_b64), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(auth_error("ID Token 格式无效"));
        };
        let header_bytes = URL_SAFE_NO_PAD
            .decode(header_b64)
            .map_err(|_| auth_error("ID Token 头部编码无效"))?;
        let header: JwtHeader = serde_json::from_slice(&header_bytes)
            .map_err(|_| auth_error("ID Token 头部解析失败"))?;
        if !matches!(header.alg.as_str(), "RS256" | "ES256") {
            return Err(auth_error("不支持的 ID Token 签名算法"));
        }
        let sig_bytes = URL_SAFE_NO_PAD
            .decode(sig_b64)
            .map_err(|_| auth_error("ID Token 签名编码无效"))?;
        let signing_input = format!("{header_b64}.{payload_b64}");

        let discovery = self.discovery(client).await?;
        let mut jwks = self.jwks(client, &discovery.jwks_uri, false).await?;
        let mut key = find_key(&jwks, &header);
        if key.is_none() {
            jwks = self.jwks(client, &discovery.jwks_uri, true).await?;
            key = find_key(&jwks, &header);
        }
        let key = key.ok_or_else(|| auth_error("未找到匹配的 OpenAI 签名公钥"))?;
        verify_signature(&header.alg, key, signing_input.as_bytes(), &sig_bytes)?;

        let payload_bytes = URL_SAFE_NO_PAD
            .decode(payload_b64)
            .map_err(|_| auth_error("ID Token 载荷编码无效"))?;
        let claims: Value = serde_json::from_slice(&payload_bytes)
            .map_err(|_| auth_error("ID Token 载荷解析失败"))?;

        if claims["iss"].as_str() != Some(discovery.issuer.as_str()) {
            return Err(auth_error("ID Token 签发方不匹配"));
        }
        let aud_ok = match &claims["aud"] {
            Value::String(aud) => aud == expected_client_id,
            Value::Array(list) => list
                .iter()
                .any(|item| item.as_str() == Some(expected_client_id)),
            _ => false,
        };
        if !aud_ok {
            return Err(auth_error("ID Token 受众与当前客户端不匹配"));
        }
        let now = chrono::Utc::now().timestamp();
        let exp = claims["exp"]
            .as_i64()
            .ok_or_else(|| auth_error("ID Token 缺少过期时间"))?;
        let iat = claims["iat"]
            .as_i64()
            .ok_or_else(|| auth_error("ID Token 缺少签发时间"))?;
        if now > exp + CLOCK_SKEW_SECONDS {
            return Err(auth_error("ID Token 已过期"));
        }
        if iat > now + 300 {
            return Err(auth_error("ID Token 签发时间无效"));
        }
        if let Some(nbf) = claims["nbf"].as_i64()
            && now + CLOCK_SKEW_SECONDS < nbf
        {
            return Err(auth_error("ID Token 尚未生效"));
        }
        if claims["nonce"].as_str() != Some(expected_nonce) {
            return Err(auth_error("ID Token nonce 校验失败"));
        }
        let subject = claims["sub"]
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| auth_error("ID Token 缺少用户主体标识"))?
            .to_owned();
        if let Some(sid) = claims.get("sid")
            && !sid.is_null()
            && sid.as_str().is_none_or(|value| value.trim().is_empty())
        {
            return Err(auth_error("ID Token 会话标识格式无效"));
        }
        let email = claims["email"]
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let email_verified = email.is_some() && claims["email_verified"] == Value::Bool(true);
        let name = claims["name"]
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);

        Ok(VerifiedIdentity {
            issuer: discovery.issuer,
            subject,
            email,
            email_verified,
            name,
        })
    }
}

fn validate_discovery(doc: &Discovery) -> Result<()> {
    if doc.issuer != EXPECTED_ISSUER {
        return Err(auth_error("OpenAI OIDC 签发方配置异常"));
    }
    for raw in [
        doc.authorization_endpoint.as_str(),
        doc.token_endpoint.as_str(),
        doc.jwks_uri.as_str(),
    ] {
        let parsed = Url::parse(raw).map_err(|_| auth_error("OpenAI OIDC 端点地址无效"))?;
        validate_auth_url(&parsed)?;
    }
    if let Some(revocation) = &doc.revocation_endpoint {
        let parsed = Url::parse(revocation).map_err(|_| auth_error("OpenAI 撤销端点地址无效"))?;
        validate_auth_url(&parsed)?;
    }
    Ok(())
}

fn validate_auth_url(url: &Url) -> Result<()> {
    if url.scheme() != "https" || url.host_str() != Some("auth.openai.com") {
        return Err(auth_error("OpenAI 认证端点域名不受信任"));
    }
    Ok(())
}

fn find_key<'a>(jwks: &'a JwkSet, header: &JwtHeader) -> Option<&'a Jwk> {
    let expected_kty = match header.alg.as_str() {
        "RS256" => "RSA",
        "ES256" => "EC",
        _ => return None,
    };
    jwks.keys.iter().find(|key| {
        key.kty == expected_kty
            && key.key_use.as_deref().is_none_or(|value| value == "sig")
            && key
                .alg
                .as_deref()
                .is_none_or(|value| value == header.alg.as_str())
            && match &header.kid {
                Some(kid) => key.kid.as_deref() == Some(kid.as_str()),
                None => true,
            }
    })
}

fn verify_signature(alg: &str, key: &Jwk, message: &[u8], signature: &[u8]) -> Result<()> {
    match alg {
        "RS256" => {
            let n = URL_SAFE_NO_PAD
                .decode(key.n.as_deref().ok_or_else(|| auth_error("JWKS 缺少 RSA 模数"))?)
                .map_err(|_| auth_error("JWKS RSA 模数编码无效"))?;
            let e = URL_SAFE_NO_PAD
                .decode(key.e.as_deref().ok_or_else(|| auth_error("JWKS 缺少 RSA 指数"))?)
                .map_err(|_| auth_error("JWKS RSA 指数编码无效"))?;
            let components = RsaPublicKeyComponents { n: &n, e: &e };
            components
                .verify(&RSA_PKCS1_2048_8192_SHA256, message, signature)
                .map_err(|_| auth_error("ID Token 签名校验失败"))
        }
        "ES256" => {
            if key.crv.as_deref() != Some("P-256") {
                return Err(auth_error("不支持的 ECDSA 曲线"));
            }
            let x = URL_SAFE_NO_PAD
                .decode(key.x.as_deref().ok_or_else(|| auth_error("JWKS 缺少 EC x"))?)
                .map_err(|_| auth_error("JWKS EC x 编码无效"))?;
            let y = URL_SAFE_NO_PAD
                .decode(key.y.as_deref().ok_or_else(|| auth_error("JWKS 缺少 EC y"))?)
                .map_err(|_| auth_error("JWKS EC y 编码无效"))?;
            if x.len() != 32 || y.len() != 32 {
                return Err(auth_error("JWKS EC 公钥长度无效"));
            }
            let mut uncompressed = Vec::with_capacity(65);
            uncompressed.push(0x04);
            uncompressed.extend_from_slice(&x);
            uncompressed.extend_from_slice(&y);
            UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, uncompressed)
                .verify(message, signature)
                .map_err(|_| auth_error("ID Token 签名校验失败"))
        }
        _ => Err(auth_error("不支持的 ID Token 签名算法")),
    }
}

fn auth_error(message: &str) -> Error {
    Error::new(401, "CHATGPT_ID_TOKEN_INVALID", message)
}
