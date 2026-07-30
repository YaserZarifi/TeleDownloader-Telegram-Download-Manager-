//! Telegram client lifecycle and the login flow.
//!
//! One `Client` is created per process and shared by cloning. grammers 0.10's
//! `Client` is `Arc<ClientInner>` over a `SenderPool` that keeps one lazily
//! opened connection per data center, so cloning is cheap and every clone
//! multiplexes onto the same pool. That is exactly what the download engine
//! wants: N parallel range-fetches without N logins (§11.6).

pub mod channel;
pub mod download;

use anyhow::{anyhow, Context, Result};
use grammers_client::client::{LoginToken, PasswordToken};
use grammers_client::{Client, SignInError};
use grammers_mtsender::SenderPool;
use grammers_session::storages::SqliteSession;
use grammers_session::types::PeerRef;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::model::{AuthState, TgUser};
use crate::store;

/// Everything mutable about the connection, behind one lock. The lock is only
/// ever held across an `await` during login — the download path clones the
/// `Client` out and releases it immediately, so transfers never serialise on it.
#[derive(Default)]
struct Inner {
    client: Option<Client>,
    /// Set between `request_login_code` and a successful `sign_in`.
    login_token: Option<LoginToken>,
    /// Set when Telegram answers `sign_in` with SESSION_PASSWORD_NEEDED.
    /// `check_password` consumes it by value, hence the `Option` + `take()`.
    password_token: Option<PasswordToken>,
    phone: Option<String>,
    user: Option<TgUser>,
    /// `PeerRef` is the only accepted way to address a chat in 0.10, it is
    /// `Copy`, and it cannot be rebuilt from a bare i64 — so every peer we
    /// resolve is cached here under the id the UI knows it by.
    peers: HashMap<i64, PeerRef>,
    /// Channel titles, for the `<channel>/<year>-<month>/` download layout.
    titles: HashMap<i64, String>,
    /// Avatar data URIs. `Some(None)` records "this chat has no photo", so a
    /// missing avatar is fetched once rather than on every rail render.
    photos: HashMap<i64, Option<String>>,
}

#[derive(Default)]
pub struct Telegram {
    inner: Mutex<Inner>,
}

impl Telegram {
    /// Bring up the connection if it isn't already, using stored credentials.
    /// Returns `Ok(None)` when there are no credentials yet — a normal
    /// first-run state, not an error.
    async fn ensure_client(inner: &mut Inner) -> Result<Option<Client>> {
        if let Some(c) = &inner.client {
            return Ok(Some(c.clone()));
        }
        let Some(creds) = store::load_credentials()? else {
            return Ok(None);
        };

        let path = store::session_path()?;
        let session = Arc::new(
            SqliteSession::open(&path)
                .await
                .map_err(|e| anyhow!("{e}"))
                .with_context(|| format!("could not open session store at {}", path.display()))?,
        );
        store::restrict_permissions(&path);

        let SenderPool {
            runner,
            handle,
            mut updates,
        } = SenderPool::new(Arc::clone(&session), creds.api_id);

        // The runner drives every connection. Without this spawn, every
        // request fails with `InvocationError::Dropped` — and it fails at
        // runtime, not compile time, so it is worth stating plainly.
        tokio::spawn(runner.run());

        // TeleWire is a download manager, not a chat client: it subscribes to
        // no updates. The channel is unbounded, so it still has to be drained
        // or it would grow for the lifetime of the process.
        tokio::spawn(async move { while updates.recv().await.is_some() {} });

        let client = Client::new(handle);
        inner.client = Some(client.clone());
        Ok(Some(client))
    }

    /// Current auth state, connecting and checking authorisation if needed.
    pub async fn state(&self) -> AuthState {
        let mut inner = self.inner.lock().await;
        self.state_locked(&mut inner).await
    }

    async fn state_locked(&self, inner: &mut Inner) -> AuthState {
        // Mid-flow states win: a pending code should survive a UI reload.
        if inner.password_token.is_some() {
            return AuthState::NeedsPassword {
                hint: inner
                    .password_token
                    .as_ref()
                    .and_then(|t| t.hint())
                    .map(str::to_owned),
            };
        }
        if inner.login_token.is_some() {
            return AuthState::NeedsCode {
                phone: inner.phone.clone().unwrap_or_default(),
                code_length: None,
            };
        }
        if let Some(user) = &inner.user {
            return AuthState::Ready { user: user.clone() };
        }

        let creds = match store::load_credentials() {
            Ok(Some(c)) => c,
            Ok(None) => return AuthState::NeedsCredentials,
            Err(e) => {
                return AuthState::Error {
                    message: format!("{e:#}"),
                    recoverable: false,
                }
            }
        };

        let client = match Self::ensure_client(inner).await {
            Ok(Some(c)) => c,
            Ok(None) => return AuthState::NeedsCredentials,
            Err(e) => {
                return AuthState::Error {
                    message: format!("{e:#}"),
                    recoverable: true,
                }
            }
        };

        match client.is_authorized().await {
            Ok(true) => match client.get_me().await {
                Ok(me) => {
                    let user = to_tg_user(&me);
                    inner.user = Some(user.clone());
                    AuthState::Ready { user }
                }
                Err(e) => AuthState::Error {
                    message: friendly(&e.to_string()),
                    recoverable: true,
                },
            },
            Ok(false) => AuthState::NeedsPhone {
                api_id: creds.api_id,
            },
            Err(e) => AuthState::Error {
                message: friendly(&e.to_string()),
                recoverable: true,
            },
        }
    }

    pub async fn save_credentials(&self, api_id: i32, api_hash: &str) -> Result<AuthState> {
        store::save_credentials(api_id, api_hash)?;
        let mut inner = self.inner.lock().await;
        // Credentials changed: drop any half-built client so the next call
        // rebuilds the pool with the new api_id.
        *inner = Inner::default();
        Ok(self.state_locked(&mut inner).await)
    }

    pub async fn start_login(&self, phone: &str) -> Result<AuthState> {
        let creds = store::load_credentials()?
            .ok_or_else(|| anyhow!("Enter your API ID and hash first."))?;

        let mut inner = self.inner.lock().await;
        let client = Self::ensure_client(&mut inner)
            .await?
            .ok_or_else(|| anyhow!("Enter your API ID and hash first."))?;

        match client.request_login_code(phone, &creds.api_hash).await {
            Ok(token) => {
                inner.login_token = Some(token);
                inner.phone = Some(phone.to_owned());
                Ok(AuthState::NeedsCode {
                    phone: phone.to_owned(),
                    // Telegram reports the expected length on the raw type, but
                    // grammers keeps `LoginToken`'s fields private. Five is the
                    // universal case; the UI treats this as a hint, not a rule.
                    code_length: Some(5),
                })
            }
            Err(e) => Ok(AuthState::Error {
                message: friendly(&e.to_string()),
                recoverable: true,
            }),
        }
    }

    pub async fn submit_code(&self, code: &str) -> Result<AuthState> {
        let mut inner = self.inner.lock().await;
        let client = inner
            .client
            .clone()
            .ok_or_else(|| anyhow!("Not connected. Start the sign-in again."))?;
        let token = inner
            .login_token
            .as_ref()
            .ok_or_else(|| anyhow!("No login in progress. Request a new code."))?;

        match client.sign_in(token, code).await {
            Ok(user) => {
                inner.login_token = None;
                let user = to_tg_user(&user);
                inner.user = Some(user.clone());
                Ok(AuthState::Ready { user })
            }
            Err(SignInError::PasswordRequired(password_token)) => {
                inner.login_token = None;
                let hint = password_token.hint().map(str::to_owned);
                inner.password_token = Some(password_token);
                Ok(AuthState::NeedsPassword { hint })
            }
            Err(SignInError::InvalidCode) => Ok(AuthState::Error {
                message: "That code isn't right. Check it and try again.".into(),
                recoverable: true,
            }),
            Err(SignInError::SignUpRequired) => Ok(AuthState::Error {
                message: "That number has no Telegram account. Sign up in an official Telegram app first.".into(),
                recoverable: false,
            }),
            Err(e) => Ok(AuthState::Error {
                message: friendly(&e.to_string()),
                recoverable: true,
            }),
        }
    }

    pub async fn submit_password(&self, password: &str) -> Result<AuthState> {
        let mut inner = self.inner.lock().await;
        let client = inner
            .client
            .clone()
            .ok_or_else(|| anyhow!("Not connected. Start the sign-in again."))?;
        let token = inner
            .password_token
            .take()
            .ok_or_else(|| anyhow!("No password challenge in progress."))?;

        match client.check_password(token, password).await {
            Ok(user) => {
                let user = to_tg_user(&user);
                inner.user = Some(user.clone());
                Ok(AuthState::Ready { user })
            }
            // The server hands back a fresh challenge with every rejection —
            // keeping it is what lets the user retry without restarting.
            Err(SignInError::InvalidPassword(fresh)) => {
                let hint = fresh.hint().map(str::to_owned);
                inner.password_token = Some(fresh);
                let _ = hint;
                Ok(AuthState::Error {
                    message: "Wrong password. Try again.".into(),
                    recoverable: true,
                })
            }
            Err(e) => Ok(AuthState::Error {
                message: friendly(&e.to_string()),
                recoverable: true,
            }),
        }
    }

    pub async fn logout(&self) -> Result<AuthState> {
        let mut inner = self.inner.lock().await;
        if let Some(client) = inner.client.clone() {
            // A failure here (offline, already invalidated) must not block the
            // local sign-out — the user asked to be signed out either way.
            let _ = client.sign_out().await;
            client.disconnect();
        }
        *inner = Inner::default();
        store::clear_session()?;
        // Credentials are deliberately kept: signing out of an account is not
        // the same as forgetting which app registration this install uses.
        Ok(self.state_locked(&mut inner).await)
    }

    /// A connected, authorised client, or an error the UI can show.
    pub async fn client(&self) -> Result<Client> {
        let mut inner = self.inner.lock().await;
        if inner.user.is_none() {
            return Err(anyhow!("Not signed in."));
        }
        Self::ensure_client(&mut inner)
            .await?
            .ok_or_else(|| anyhow!("Not connected to Telegram."))
    }

    pub async fn remember_peer(&self, id: i64, peer: PeerRef, title: &str) {
        let mut inner = self.inner.lock().await;
        inner.peers.insert(id, peer);
        inner.titles.insert(id, title.to_owned());
    }

    pub async fn peer(&self, id: i64) -> Option<PeerRef> {
        self.inner.lock().await.peers.get(&id).copied()
    }

    pub async fn channel_title(&self, id: i64) -> Option<String> {
        self.inner.lock().await.titles.get(&id).cloned()
    }

    /// `Some(x)` means "already resolved"; the inner `x` may itself be `None`
    /// for a chat that genuinely has no avatar.
    pub async fn cached_photo(&self, id: i64) -> Option<Option<String>> {
        self.inner.lock().await.photos.get(&id).cloned()
    }

    pub async fn cache_photo(&self, id: i64, photo: Option<String>) {
        self.inner.lock().await.photos.insert(id, photo);
    }
}

pub fn to_tg_user(user: &grammers_client::peer::User) -> TgUser {
    TgUser {
        id: user.id().bare_id().unwrap_or_default(),
        first_name: user
            .first_name()
            .map(str::to_owned)
            .unwrap_or_else(|| user.full_name()),
        last_name: user.last_name().map(str::to_owned),
        username: user.username().map(str::to_owned),
        phone: user.phone().map(str::to_owned),
    }
}

/// Turn a raw MTProto error into something a person can act on.
///
/// Deliberately conservative: anything unrecognised is passed through rather
/// than replaced with a vague message, because a real error code is far more
/// useful in a bug report than "something went wrong".
pub fn friendly(raw: &str) -> String {
    let upper = raw.to_ascii_uppercase();
    if upper.contains("PHONE_NUMBER_INVALID") {
        "Telegram doesn't recognise that phone number.".into()
    } else if upper.contains("PHONE_CODE_EXPIRED") {
        "That code expired. Request a new one.".into()
    } else if upper.contains("PHONE_CODE_INVALID") {
        "That code isn't right. Check it and try again.".into()
    } else if upper.contains("PHONE_NUMBER_BANNED") {
        "Telegram has banned that number.".into()
    } else if upper.contains("API_ID_INVALID") || upper.contains("API_ID_PUBLISHED") {
        "That API ID and hash pair was rejected. Re-check them at my.telegram.org/apps.".into()
    } else if upper.contains("FLOOD_WAIT") {
        format!("Telegram is rate-limiting this account: {raw}")
    } else if upper.contains("USERNAME_NOT_OCCUPIED") || upper.contains("USERNAME_INVALID") {
        "No channel with that name.".into()
    } else if upper.contains("CHANNEL_PRIVATE") {
        "That channel is private, or this account isn't a member.".into()
    } else if upper.contains("AUTH_KEY_UNREGISTERED") || upper.contains("SESSION_REVOKED") {
        "This session was signed out from another device. Sign in again.".into()
    } else {
        raw.to_owned()
    }
}
