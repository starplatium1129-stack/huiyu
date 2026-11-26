use super::{ChatGptService, MODELS_CACHE_TTL, Model, selection_changed, storage};
use crate::chat::{
    Duration, Error, Result, responses,
    settings::Settings,
    transport::{self, Request, Transport},
};
use axum::http::StatusCode;
use serde_json::{Value, json};
use std::time::Instant;
use tokio_util::sync::CancellationToken;
use url::Url;

const MODELS_URL: &str = "https://api.openai.com/v1/models";

impl ChatGptService {
    pub(super) async fn list_models(
        &self,
        transport: &Transport,
        settings: &Settings,
        force_refresh: bool,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        if !force_refresh {
            let cached = {
                let _guard = self.storage_lock.lock().await;
                let store = storage::load(&settings.runtime).await?;
                if let Some(account) = store
                    .active_account()
                    .filter(|account| account.plan_enabled())
                {
                    let client_id = account.client_id.clone();
                    let mut runtime = self
                        .accounts
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    let entry = runtime.entry(client_id.clone()).or_default();
                    let fresh_memory = !entry.models.is_empty()
                        && entry
                            .models_fetched_at
                            .is_some_and(|at| at.elapsed() < MODELS_CACHE_TTL);
                    let models = if fresh_memory {
                        Some(entry.models.clone())
                    } else if !account.cached_models.is_empty() {
                        entry.models = account.cached_models.clone();
                        entry.models_fetched_at = Some(Instant::now());
                        Some(entry.models.clone())
                    } else {
                        None
                    };
                    models.map(|models| {
                        let selected = models
                            .iter()
                            .find(|model| model.slug == account.selected_model)
                            .or_else(|| models.first());
                        let (slug, name) = selected.map_or(("", ""), |model| {
                            (model.slug.as_str(), model.display_name.as_str())
                        });
                        json!({
                            "ok": true,
                            "clientId": client_id,
                            "models": models,
                            "selectedModel": slug,
                            "selectedModelName": name,
                        })
                    })
                } else {
                    None
                }
            };
            if let Some(result) = cached {
                return Ok(result);
            }
        }

        let mut session = self
            .ensure_access_token(transport, settings, None, false, cancel)
            .await?;
        let target = Url::parse(MODELS_URL).map_err(|_| Error::invalid("模型列表地址无效"))?;
        let mut refreshed_on_401 = false;
        let mut transient_retries = 0u8;
        let response = loop {
            let attempt = tokio::select! {
                _ = cancel.cancelled() => return Err(Error::stream("ABORTED", "已取消获取模型")),
                result = transport.send(
                    target.clone(),
                    Request {
                        body: None,
                        key: &session.access_token,
                        session_id: None,
                        public_only: false,
                        idle: Duration::from_secs(20),
                        total: Duration::from_secs(25),
                        accept: "application/json",
                    },
                ) => result,
            };
            let response = match attempt {
                Ok(response) => response,
                Err(error)
                    if transient_retries < 1
                        && matches!(error.code.as_str(), "UPSTREAM_UNAVAILABLE" | "UPSTREAM_TIMEOUT") =>
                {
                    transient_retries += 1;
                    tokio::select! {
                        _ = cancel.cancelled() => return Err(Error::stream("ABORTED", "已取消获取模型")),
                        _ = tokio::time::sleep(Duration::from_millis(600)) => continue,
                    }
                }
                Err(error) => return Err(error),
            };
            if response.status().is_success() {
                break response;
            }
            let status = response.status().as_u16();
            let request_id = responses::request_id(response.headers());
            let bytes = transport::bounded(response, 64 * 1024).await?;
            let body: Value = serde_json::from_slice(bytes.as_ref()).unwrap_or_default();
            let code = responses::upstream_code(&body);
            if status == 401
                && !refreshed_on_401
                && code != "subscription_sharing_invalid_user"
                && let Ok(next_session) = self
                    .force_refresh_access_token(
                        transport,
                        settings,
                        Some(&session.client_id),
                        false,
                        cancel,
                    )
                    .await
            {
                refreshed_on_401 = true;
                session = next_session;
                continue;
            }
            if matches!(status, 502 | 503 | 504) && transient_retries < 1 {
                transient_retries += 1;
                tokio::select! {
                    _ = cancel.cancelled() => return Err(Error::stream("ABORTED", "已取消获取模型")),
                    _ = tokio::time::sleep(Duration::from_millis(700)) => continue,
                }
            }
            self.handle_upstream_failure(
                &settings.runtime,
                &session.client_id,
                session.saved_at.as_deref(),
                code,
            )
            .await?;
            return Err(responses::siwc_error(status, body, request_id.as_deref()));
        };
        let bytes = transport::bounded(response, 2 * 1024 * 1024).await?;
        let data: Value = serde_json::from_slice(bytes.as_ref())
            .map_err(|_| Error::stream("INVALID_MODEL_LIST", "模型目录不是有效 JSON"))?;

        let items = data["models"].as_array().ok_or_else(|| {
            Error::stream(
                "INVALID_MODEL_LIST",
                "OpenAI 未返回当前账号的 ChatGPT 模型目录",
            )
        })?;
        let mut seen = std::collections::HashSet::new();
        let models: Vec<Model> = items
            .iter()
            .filter_map(|item| {
                let slug = item["slug"].as_str()?.trim();
                if item["visibility"] != "list"
                    || slug.is_empty()
                    || slug.len() > 200
                    || slug.chars().any(char::is_control)
                    || !seen.insert(slug)
                {
                    return None;
                }
                let display_name = item["display_name"]
                    .as_str()
                    .map(str::trim)
                    .filter(|name| {
                        !name.is_empty() && name.len() <= 200 && !name.chars().any(char::is_control)
                    })
                    .unwrap_or(slug);
                Some(Model {
                    slug: slug.into(),
                    display_name: display_name.into(),
                })
            })
            .collect();

        let _guard = self.storage_lock.lock().await;
        let mut store = storage::load(&settings.runtime).await?;
        let account = active_account_mut(&mut store, &session.client_id)?;
        if account.saved_at != session.saved_at {
            return Err(selection_changed());
        }
        let selected = models
            .iter()
            .find(|model| model.slug == account.selected_model)
            .or_else(|| models.first());
        let (slug, name) = selected.map_or(("", ""), |model| {
            (model.slug.as_str(), model.display_name.as_str())
        });
        if account.selected_model != slug
            || account.selected_model_name != name
            || account.cached_models != models
        {
            account.selected_model = slug.to_owned();
            account.selected_model_name = name.to_owned();
            account.cached_models = models.clone();
            storage::save(&settings.runtime, &store).await?;
        }
        let result = json!({
            "ok": true,
            "clientId": session.client_id,
            "models": models,
            "selectedModel": slug,
            "selectedModelName": name,
        });
        {
            let mut runtime = self
                .accounts
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let entry = runtime.entry(session.client_id).or_default();
            entry.models = models;
            entry.models_fetched_at = Some(Instant::now());
        }
        Ok(result)
    }

    pub(super) async fn select_account(
        &self,
        settings: &Settings,
        client_id: &str,
    ) -> Result<Value> {
        let client_id = client_id.trim();
        if client_id.is_empty() {
            return Err(Error::invalid("账号标识不能为空"));
        }
        let _guard = self.storage_lock.lock().await;
        let mut store = storage::load(&settings.runtime).await?;
        if !store
            .account(client_id)
            .is_some_and(storage::StoredAccount::has_session)
        {
            return Err(Error::new(
                401,
                "CHATGPT_REAUTH_REQUIRED",
                "请先重新登录所选 ChatGPT 账号",
            ));
        }
        store.active_client_id = Some(client_id.to_owned());
        storage::save(&settings.runtime, &store).await?;
        let flow = self
            .flow
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .to_json();
        Ok(store.public_status(flow))
    }

    pub(super) async fn select_model(
        &self,
        settings: &Settings,
        client_id: &str,
        model: &str,
    ) -> Result<Value> {
        let model = model.trim();
        let _guard = self.storage_lock.lock().await;
        let mut store = storage::load(&settings.runtime).await?;
        let account = active_account_mut(&mut store, client_id)?;
        let display_name = self
            .accounts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(client_id)
            .and_then(|state| state.models.iter().find(|entry| entry.slug == model))
            .map(|entry| entry.display_name.clone())
            .or_else(|| {
                account
                    .cached_models
                    .iter()
                    .find(|entry| entry.slug == model)
                    .map(|entry| entry.display_name.clone())
            })
            .ok_or_else(|| {
                Error::new(
                    400,
                    "CHATGPT_MODEL_UNAVAILABLE",
                    "所选模型不可用，请刷新 ChatGPT 模型列表",
                )
            })?;
        account.selected_model = model.to_owned();
        account.selected_model_name = display_name;
        storage::save(&settings.runtime, &store).await?;
        let flow = self
            .flow
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .to_json();
        Ok(store.public_status(flow))
    }

    pub(super) async fn resume_usage(&self, settings: &Settings, client_id: &str) -> Result<Value> {
        let _guard = self.storage_lock.lock().await;
        let mut store = storage::load(&settings.runtime).await?;
        let account = active_account_mut(&mut store, client_id)?;
        if account.usage_paused {
            account.usage_paused = false;
            storage::save(&settings.runtime, &store).await?;
        }
        Ok(store.public_status(
            self.flow
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .to_json(),
        ))
    }

    pub(super) async fn confirm_welcome(&self, settings: &Settings) -> Result<Value> {
        let _guard = self.storage_lock.lock().await;
        let mut store = storage::load(&settings.runtime).await?;
        store.welcome_confirmed = true;
        storage::save(&settings.runtime, &store).await?;
        let flow = self
            .flow
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .to_json();
        Ok(store.public_status(flow))
    }

    pub(super) async fn sign_out(
        &self,
        transport: &Transport,
        settings: &Settings,
        requested_client_id: Option<&str>,
    ) -> Result<Value> {
        let _guard = self.storage_lock.lock().await;
        self.cancel_pending();
        let mut store = storage::load(&settings.runtime).await?;
        let target_id = requested_client_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .or_else(|| store.active_client_id.clone());
        let Some(client_id) = target_id else {
            let flow = self
                .flow
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .to_json();
            return Ok(
                json!({ "ok": true, "remoteRevoked": true, "status": store.public_status(flow) }),
            );
        };
        self.stop_account(&client_id);
        let remote_revoked = self
            .revoke_account(transport, store.account(&client_id))
            .await;
        if let Some(account) = store.account_mut(&client_id) {
            account.clear_session();
        }
        storage::save(&settings.runtime, &store).await?;
        let flow = self
            .flow
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .to_json();
        Ok(json!({
            "ok": true,
            "remoteRevoked": remote_revoked,
            "status": store.public_status(flow),
        }))
    }

    pub(super) async fn remove_account(
        &self,
        transport: &Transport,
        settings: &Settings,
        client_id: &str,
    ) -> Result<Value> {
        let client_id = client_id.trim();
        if client_id.is_empty() {
            return Err(Error::invalid("账号标识不能为空"));
        }
        let _guard = self.storage_lock.lock().await;
        self.cancel_pending();
        let mut store = storage::load(&settings.runtime).await?;
        self.stop_account(client_id);
        let remote_revoked = self
            .revoke_account(transport, store.account(client_id))
            .await;
        store
            .accounts
            .retain(|account| account.client_id != client_id);
        if store.active_client_id.as_deref() == Some(client_id) {
            store.active_client_id = store
                .accounts
                .iter()
                .find(|account| account.plan_enabled())
                .or_else(|| store.accounts.iter().find(|account| account.has_session()))
                .map(|account| account.client_id.clone());
        }
        storage::save(&settings.runtime, &store).await?;
        let flow = self
            .flow
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .to_json();
        Ok(json!({
            "ok": true,
            "remoteRevoked": remote_revoked,
            "status": store.public_status(flow),
        }))
    }

    async fn revoke_account(
        &self,
        transport: &Transport,
        account: Option<&storage::StoredAccount>,
    ) -> bool {
        let Some(account) = account else { return true };
        match account.refresh_token() {
            Ok(Some(token)) => {
                self.revoke_refresh_token(transport, &account.client_id, &token)
                    .await
            }
            Ok(None) => true,
            Err(_) => false,
        }
    }

    async fn revoke_refresh_token(
        &self,
        transport: &Transport,
        client_id: &str,
        refresh_token: &str,
    ) -> bool {
        let revocation_url =
            tokio::time::timeout(Duration::from_secs(8), self.jwks.discovery(transport))
                .await
                .ok()
                .and_then(|result| result.ok())
                .and_then(|doc| doc.revocation_endpoint)
                .unwrap_or_else(|| "https://auth.openai.com/api/accounts/oauth/revoke".into());
        let Ok(target) = Url::parse(&revocation_url) else {
            return false;
        };
        let delays = [
            Duration::from_millis(0),
            Duration::from_millis(350),
            Duration::from_millis(900),
        ];
        for delay in delays {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            match transport
                .send_form(
                    target.clone(),
                    &[
                        ("token", refresh_token),
                        ("token_type_hint", "refresh_token"),
                        ("client_id", client_id),
                    ],
                    Duration::from_secs(5),
                )
                .await
            {
                Ok(response) if response.status() == StatusCode::OK => return true,
                Ok(response) if response.status().is_client_error() => return false,
                _ => continue,
            }
        }
        false
    }
}

fn active_account_mut<'a>(
    store: &'a mut storage::Store,
    client_id: &str,
) -> Result<&'a mut storage::StoredAccount> {
    if store.active_client_id.as_deref() != Some(client_id) {
        return Err(selection_changed());
    }
    store
        .account_mut(client_id)
        .filter(|account| account.plan_enabled())
        .ok_or_else(|| {
            Error::new(
                409,
                "CHATGPT_PLAN_NOT_ENABLED",
                "请先登录并授权使用 ChatGPT 订阅额度",
            )
        })
}
