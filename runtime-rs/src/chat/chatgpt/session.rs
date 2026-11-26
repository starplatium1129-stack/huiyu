use super::{ActiveSession, ChatGptService, RESOURCE_URI, selection_changed, storage};
use crate::chat::{
    Duration, Error, Result,
    settings::Settings,
    transport::{self, Transport},
};
use serde_json::Value;
use std::path::Path;
use tokio_util::sync::CancellationToken;
use url::Url;

const REFRESH_LEEWAY_SECONDS: i64 = 120;

impl ChatGptService {
    pub(in crate::chat) async fn ensure_access_token(
        &self,
        transport: &Transport,
        settings: &Settings,
        requested_client_id: Option<&str>,
        for_inference: bool,
        cancel: &CancellationToken,
    ) -> Result<ActiveSession> {
        self.ensure_access_token_inner(
            transport,
            settings,
            requested_client_id,
            for_inference,
            false,
            cancel,
        )
        .await
    }

    pub(in crate::chat) async fn force_refresh_access_token(
        &self,
        transport: &Transport,
        settings: &Settings,
        requested_client_id: Option<&str>,
        for_inference: bool,
        cancel: &CancellationToken,
    ) -> Result<ActiveSession> {
        self.ensure_access_token_inner(
            transport,
            settings,
            requested_client_id,
            for_inference,
            true,
            cancel,
        )
        .await
    }

    async fn ensure_access_token_inner(
        &self,
        transport: &Transport,
        settings: &Settings,
        requested_client_id: Option<&str>,
        for_inference: bool,
        force_refresh: bool,
        cancel: &CancellationToken,
    ) -> Result<ActiveSession> {
        let guard = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Error::stream("ABORTED", "聊天已停止")),
            guard = self.storage_lock.clone().lock_owned() => guard,
        };
        let mut store = storage::load(&settings.runtime).await?;
        let active_id = store.active_client_id.clone().ok_or_else(|| {
            Error::new(
                401,
                "CHATGPT_NOT_SIGNED_IN",
                "尚未登录 ChatGPT，请在聊天设置中点击 Continue with ChatGPT。",
            )
        })?;
        if requested_client_id.is_some_and(|id| id != active_id) {
            return Err(selection_changed());
        }
        let account = store.account(&active_id).ok_or_else(|| {
            Error::new(
                401,
                "CHATGPT_NOT_SIGNED_IN",
                "尚未登录 ChatGPT，请在聊天设置中点击 Continue with ChatGPT。",
            )
        })?;
        if !account.has_session() {
            return Err(Error::new(
                401,
                "CHATGPT_REAUTH_REQUIRED",
                "当前 ChatGPT 会话已失效或已退出，请重新登录。",
            ));
        }
        if !account.plan_enabled() {
            return Err(Error::new(
                403,
                "CHATGPT_PLAN_NOT_ENABLED",
                "尚未开启 ChatGPT 订阅额度使用权限，请在聊天设置中重新授权或改用 API 服务。",
            ));
        }
        if for_inference && account.usage_paused {
            return Err(Error::new(
                429,
                "CHATGPT_USAGE_LIMIT",
                "ChatGPT 订阅额度已达上限。请查看用量，确认后恢复发送。",
            ));
        }
        let session_cancel = self
            .accounts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(active_id.clone())
            .or_default()
            .cancel
            .clone();

        let now = chrono::Utc::now().timestamp();
        let needs_refresh = force_refresh
            || account
                .expires_at
                .is_none_or(|exp| now + REFRESH_LEEWAY_SECONDS >= exp);
        let can_refresh_now = force_refresh
            || account
                .earliest_refresh_at
                .is_none_or(|earliest| now >= earliest)
            || account.expires_at.is_none_or(|exp| now >= exp);

        if !needs_refresh
            || !can_refresh_now
            || (account.sealed_refresh_token.is_none()
                && !force_refresh
                && account.expires_at.is_some_and(|exp| exp > now))
        {
            let access_token = account.access_token()?.ok_or_else(|| {
                Error::new(
                    401,
                    "CHATGPT_REAUTH_REQUIRED",
                    "ChatGPT 访问凭据缺失，请重新登录。",
                )
            })?;
            return Ok(ActiveSession {
                access_token,
                client_id: account.client_id.clone(),
                model: account.selected_model.clone(),
                saved_at: account.saved_at.clone(),
                cancel: session_cancel,
            });
        }

        let Some(refresh_token) = account.refresh_token()? else {
            if let Some(account) = store.account_mut(&active_id) {
                account.clear_session();
            }
            self.stop_account(&active_id);
            storage::save(&settings.runtime, &store).await?;
            return Err(Error::new(
                401,
                "CHATGPT_REAUTH_REQUIRED",
                "ChatGPT 登录已过期，请重新登录。",
            ));
        };
        let discovery = tokio::select! {
            _ = cancel.cancelled() => return Err(Error::stream("ABORTED", "聊天已停止")),
            result = self.jwks.discovery(transport) => result?,
        };
        let token_url = Url::parse(&discovery.token_endpoint)
            .map_err(|_| Error::new(503, "CHATGPT_AUTH_CONFIG", "OpenAI 令牌端点无效"))?;
        let runtime = settings.runtime.clone();
        let transport = transport.clone();
        // Finish writing a rotating refresh token even if the caller closes the chat.
        let pending = tokio::spawn(async move {
            let _guard = guard;
            Self::refresh_tokens(
                &transport,
                &runtime,
                store,
                active_id,
                refresh_token,
                token_url,
                session_cancel,
            )
            .await
        });
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(Error::stream("ABORTED", "聊天已停止")),
            result = pending => result.map_err(|_| Error::stream("CHATGPT_REFRESH_UNAVAILABLE", "ChatGPT 登录刷新未能完成"))?,
        }
    }

    async fn refresh_tokens(
        transport: &Transport,
        runtime: &Path,
        mut store: storage::Store,
        client_id: String,
        refresh_token: String,
        token_url: Url,
        session_cancel: CancellationToken,
    ) -> Result<ActiveSession> {
        let form = [
            ("grant_type", "refresh_token"),
            ("client_id", client_id.as_str()),
            ("refresh_token", refresh_token.as_str()),
            ("resource", RESOURCE_URI),
        ];
        let mut attempts = 0u8;
        let response = loop {
            match transport
                .send_form(token_url.clone(), &form, Duration::from_secs(20))
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
        let status = response.status();
        let bytes = transport::bounded(response, 128 * 1024).await?;
        let body: Value = serde_json::from_slice(bytes.as_ref()).unwrap_or_default();

        if !status.is_success() {
            let code = body["error"]
                .as_str()
                .or_else(|| body["error"]["code"].as_str())
                .or_else(|| body["code"].as_str())
                .unwrap_or("");
            if matches!(
                code,
                "invalid_grant"
                    | "invalid_refresh_token"
                    | "token_expired"
                    | "refresh_token_expired"
                    | "refresh_token_invalidated"
                    | "refresh_token_reused"
            ) {
                session_cancel.cancel();
                if let Some(account) = store.account_mut(&client_id) {
                    account.clear_session();
                }
                storage::save(runtime, &store).await?;
                return Err(Error::new(
                    401,
                    "CHATGPT_REAUTH_REQUIRED",
                    "ChatGPT 会话已失效或已在设置中断开，请重新登录。",
                ));
            }
            if code == "invalid_client" {
                return Err(Error::new(
                    401,
                    "CHATGPT_INVALID_CLIENT",
                    "ChatGPT 客户端注册无效，请添加新的账号连接或重新登录。",
                ));
            }
            return Err(Error::new(
                503,
                "CHATGPT_REFRESH_UNAVAILABLE",
                "暂时无法刷新 ChatGPT 登录令牌，本地凭据已保留，请稍后重试。",
            ));
        }

        let access_token = body["access_token"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                Error::new(
                    503,
                    "CHATGPT_REFRESH_UNAVAILABLE",
                    "OpenAI 令牌刷新响应缺少访问令牌，请稍后重试。",
                )
            })?;
        let replacement_refresh = body["refresh_token"].as_str();
        let expires_at = token_expiry(&body);
        let earliest_refresh_at = parse_earliest_refresh(&body["earliest_refresh_at"]);
        let account = store
            .account_mut(&client_id)
            .ok_or_else(|| Error::new(401, "CHATGPT_NOT_SIGNED_IN", "ChatGPT 账号不存在"))?;
        let scopes = match body.get("scope") {
            Some(scope) => parse_scopes(scope.as_str()),
            None => account.scopes.clone(),
        };
        account.set_tokens(
            access_token,
            replacement_refresh,
            None,
            expires_at,
            earliest_refresh_at,
            scopes,
        )?;
        let plan_enabled = account.plan_enabled();
        let model = account.selected_model.clone();
        let saved_at = account.saved_at.clone();
        storage::save(runtime, &store).await?;

        if !plan_enabled {
            session_cancel.cancel();
            return Err(Error::new(
                403,
                "CHATGPT_PLAN_NOT_ENABLED",
                "ChatGPT 订阅额度授权已关闭，请在聊天设置中重新授权或改用 API 服务。",
            ));
        }
        Ok(ActiveSession {
            access_token: access_token.to_owned(),
            client_id,
            model,
            saved_at,
            cancel: session_cancel,
        })
    }

    pub(in crate::chat) async fn handle_upstream_failure(
        &self,
        runtime: &Path,
        client_id: &str,
        saved_at: Option<&str>,
        code: &str,
    ) -> Result<()> {
        if !matches!(
            code,
            "subscription_sharing_invalid_user" | "subscription_sharing_usage_limit_exceeded"
        ) {
            return Ok(());
        }
        let _guard = self.storage_lock.lock().await;
        let mut store = storage::load(runtime).await?;
        if let Some(account) = store
            .account_mut(client_id)
            .filter(|account| account.has_session())
        {
            match code {
                "subscription_sharing_invalid_user" if account.saved_at.as_deref() == saved_at => {
                    account.clear_session();
                    self.stop_account(client_id);
                }
                "subscription_sharing_usage_limit_exceeded" if !account.usage_paused => {
                    account.usage_paused = true;
                }
                _ => return Ok(()),
            }
            storage::save(runtime, &store).await?;
        }
        Ok(())
    }
}

pub(super) fn parse_scopes(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or("")
        .split_whitespace()
        .map(str::to_owned)
        .collect()
}

pub(super) fn token_expiry(tokens: &Value) -> i64 {
    let seconds = tokens["expires_in"]
        .as_i64()
        .filter(|value| *value > 0)
        .unwrap_or(3600);
    chrono::Utc::now().timestamp().saturating_add(seconds)
}

pub(super) fn parse_earliest_refresh(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        value
            .as_str()
            .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
            .map(|dt| dt.timestamp())
    })
}
