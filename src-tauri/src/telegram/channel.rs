//! Resolving channels and paginating their media history.

use anyhow::{anyhow, Context, Result};
use grammers_client::media::{Downloadable, Media};
use grammers_client::peer::Peer;
use grammers_client::Client;
use grammers_session::types::PeerRef;

use super::{friendly, Telegram};
use crate::model::{ChannelInfo, ChatKind, MediaFilter, MediaItem, MediaKind, MediaPage};

/// How many messages we are willing to walk past while looking for `limit`
/// media items. Media channels are nearly all media, so this is rarely
/// reached; the cap exists so a chatty group with occasional files can't turn
/// one page request into an unbounded scan. When it trips we still return a
/// `next_offset_id`, so the UI simply pages again.
const SCAN_CAP: usize = 600;

/// True for the signed-in account's own chat — Telegram's "Saved Messages".
fn is_saved_messages(peer: &Peer) -> bool {
    matches!(peer, Peer::User(u) if u.is_self())
}

/// A stable, unique i64 for a peer.
///
/// NOT `i64::from(PeerRef)` — that conversion yields the same value
/// (-1000000000000) for every chat, which silently collapses the whole peer
/// cache onto one key and makes every chat show the last one's contents.
/// `bot_api_dialog_id()` is the Bot-API-style id that encodes the peer type,
/// so channels, groups and users can never collide.
fn peer_key(peer: &Peer) -> i64 {
    let id = peer.id();
    id.bot_api_dialog_id()
        .or_else(|| id.bare_id())
        // `self_user()` is the only PeerId with neither; it is Saved Messages.
        .unwrap_or(i64::MIN)
}

fn peer_info(peer: &Peer, id: i64) -> ChannelInfo {
    let kind = match peer {
        _ if is_saved_messages(peer) => ChatKind::Saved,
        Peer::Channel(_) => ChatKind::Channel,
        Peer::Group(_) => ChatKind::Group,
        Peer::User(u) if u.is_bot() => ChatKind::Bot,
        Peer::User(_) => ChatKind::Person,
    };

    ChannelInfo {
        id,
        title: if kind == ChatKind::Saved {
            // The peer's own name here is the user's first name, which is not
            // what Telegram calls this chat anywhere in its own clients.
            "Saved Messages".to_owned()
        } else {
            peer.name().unwrap_or("Untitled").to_owned()
        },
        username: peer.username().map(str::to_owned),
        // Telegram only reports member counts on the *full* channel object,
        // which is one extra round-trip per row. The rail doesn't need it
        // badly enough to make opening the app N requests slower.
        participants: None,
        // Avatars are a separate file download each. The initials fallback in
        // the UI is good enough that fetching them at list time isn't worth
        // the latency; left as a deliberate gap.
        photo: None,
        broadcast: matches!(peer, Peer::Channel(_)),
        kind,
    }
}

/// Everything the signed-in account already has in its chat list, narrowed to
/// channels and groups — one-to-one conversations have no media library worth
/// browsing here.
pub async fn list_dialogs(tg: &Telegram, client: &Client) -> Result<Vec<ChannelInfo>> {
    let mut out = Vec::new();
    let mut iter = client.iter_dialogs();

    // `DialogIter::next` is an inherent async fn returning Result<Option<_>>,
    // not a Stream — a `while let` on `?` is the only shape that compiles.
    while let Some(dialog) = iter
        .next()
        .await
        .map_err(|e| anyhow!(friendly(&e.to_string())))?
    {
        // Every chat is listed — channels, groups, bots and people. Files
        // arrive through all of them, and filtering any out just means the one
        // the user wanted is missing. The rail groups them by kind instead.
        let peer = dialog.peer();
        let peer_ref = dialog.peer_ref();
        let id = peer_key(peer);
        let info = peer_info(peer, id);
        tg.remember_peer(id, peer_ref, &info.title).await;
        out.push(info);

        // A very large account could have thousands of dialogs; the rail is a
        // navigation aid, not an archive. Anything beyond this is reachable
        // through "Add channel".
        if out.len() >= 300 {
            break;
        }
    }
    Ok(out)
}

/// Fetch a chat's avatar as an inline data URI.
///
/// Deliberately a separate command rather than part of `list_dialogs`: an
/// account with 120 chats would otherwise turn opening the app into 120 file
/// downloads before the rail could render. The UI asks for these lazily, per
/// visible row, and the result is cached so scrolling doesn't refetch.
///
/// Returns `Ok(None)` for chats with no photo — a normal state, not an error.
pub async fn photo_for(client: &Client, peer_id: i64, tg: &Telegram) -> Result<Option<String>> {
    let Some(peer_ref) = tg.peer(peer_id).await else {
        return Ok(None);
    };
    let peer = client
        .resolve_peer(peer_ref)
        .await
        .map_err(|e| anyhow!(friendly(&e.to_string())))?;

    let Some(photo) = peer
        .photo(false)
        .await
        .map_err(|e| anyhow!(friendly(&e.to_string())))?
    else {
        return Ok(None);
    };

    // Some avatars ship a stripped thumbnail inline, which costs no network
    // round-trip at all. Prefer it when present.
    let bytes = if let Some(inline) = photo.to_data() {
        inline
    } else {
        let mut buf = Vec::new();
        let mut chunks = client.iter_download(&photo);
        while let Some(chunk) = chunks
            .next()
            .await
            .map_err(|e| anyhow!(friendly(&e.to_string())))?
        {
            buf.extend_from_slice(&chunk);
            // Avatars are small; this only guards against a surprise.
            if buf.len() > 512 * 1024 {
                break;
            }
        }
        buf
    };

    if bytes.is_empty() {
        return Ok(None);
    }
    Ok(Some(format!(
        "data:image/jpeg;base64,{}",
        base64_encode(&bytes)
    )))
}

/// Minimal base64 encoder. A whole crate for one 30-line function that runs a
/// few dozen times per session isn't worth the dependency.
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Accepts `@name`, `name`, `https://t.me/name`, and `t.me/name`.
fn extract_username(query: &str) -> Result<String> {
    let q = query.trim();
    let q = q
        .strip_prefix("https://")
        .or_else(|| q.strip_prefix("http://"))
        .unwrap_or(q);
    let q = q
        .strip_prefix("t.me/")
        .or_else(|| q.strip_prefix("telegram.me/"))
        .or_else(|| q.strip_prefix("telegram.dog/"))
        .unwrap_or(q);
    let q = q.split(['/', '?']).next().unwrap_or(q);
    let q = q.trim_start_matches('@');

    if q.is_empty() {
        return Err(anyhow!("Enter a channel @username or t.me link."));
    }
    // Private invite links carry an opaque hash, not a username. Resolving one
    // means *joining* the chat, which is a side effect a download manager
    // should not perform behind the user's back.
    if q.starts_with('+') || q.starts_with("joinchat") {
        return Err(anyhow!(
            "That's a private invite link. Join the channel in Telegram first, then it will appear in your list."
        ));
    }
    Ok(q.to_owned())
}

pub async fn resolve(tg: &Telegram, client: &Client, query: &str) -> Result<ChannelInfo> {
    let username = extract_username(query)?;
    let peer = client
        .resolve_username(&username)
        .await
        .map_err(|e| anyhow!(friendly(&e.to_string())))?
        .ok_or_else(|| anyhow!("No channel called @{username}."))?;

    let peer_ref = peer
        .to_ref()
        .await
        .map_err(|e| anyhow!("{e}"))?
        .ok_or_else(|| anyhow!("Couldn't get a usable reference to @{username}."))?;

    let id = peer_key(&peer);
    let info = peer_info(&peer, id);
    tg.remember_peer(id, peer_ref, &info.title).await;
    Ok(info)
}

/// Pull the displayable metadata out of a message's media, or `None` when the
/// message carries nothing downloadable (text, polls, service messages).
///
/// Shared with the download engine so a queued job's filename and size are
/// derived exactly the way the list showed them.
pub fn describe(media: &Media, message_id: i32) -> Option<(String, String, u64)> {
    match media {
        Media::Document(doc) => {
            let size = doc.size()? as u64;
            let mime = doc.mime_type().unwrap_or("application/octet-stream").to_owned();
            let name = doc.name().map(str::to_owned).unwrap_or_else(|| {
                // Unnamed documents are common (forwarded video, voice notes).
                // The message id keeps the fallback unique within a channel.
                let ext = mime.rsplit_once('/').map(|(_, e)| e).unwrap_or("bin");
                format!("{message_id}.{ext}")
            });
            Some((name, mime, size))
        }
        Media::Photo(photo) => {
            let size = photo.size().unwrap_or(0) as u64;
            Some((format!("{message_id}.jpg"), "image/jpeg".to_owned(), size))
        }
        // Stickers, polls, contacts, geo and web previews are media but not
        // things anyone opens a download manager for.
        _ => None,
    }
}

pub async fn list_media(
    client: &Client,
    peer: PeerRef,
    offset_id: i32,
    limit: usize,
    filter: MediaFilter,
) -> Result<MediaPage> {
    let limit = limit.clamp(1, 200);
    // `.limit()` is mandatory, not an optimisation: it is a *total* cap on the
    // iterator, and without it `next()` reports the iterator as already
    // finished and returns `None` on the very first call — every chat looks
    // empty. Cap it at the scan budget for this page.
    let mut iter = client.iter_messages(peer).limit(SCAN_CAP);
    if offset_id > 0 {
        // Exclusive upper bound: paging continues strictly below the last id
        // the UI already has.
        iter = iter.offset_id(offset_id);
    }

    let mut items = Vec::with_capacity(limit);
    let mut scanned = 0usize;
    let mut last_seen_id = offset_id;
    let mut exhausted = true;

    // Counters for the diagnostic line below. A channel that looks empty in the
    // UI is almost always one of these buckets, and guessing which is far
    // slower than being told.
    let (mut no_media, mut undescribable, mut filtered, mut kinds) =
        (0usize, 0usize, 0usize, Vec::<String>::new());

    while items.len() < limit && scanned < SCAN_CAP {
        let message = match iter.next().await {
            Ok(Some(m)) => m,
            // End of history: no further pages exist.
            Ok(None) => {
                exhausted = true;
                break;
            }
            Err(e) => return Err(anyhow!(friendly(&e.to_string()))).context("listing media"),
        };
        scanned += 1;
        exhausted = false;
        last_seen_id = message.id();

        let Some(media) = message.media() else {
            no_media += 1;
            continue;
        };
        let Some((name, mime, size)) = describe(&media, message.id()) else {
            undescribable += 1;
            if kinds.len() < 8 {
                kinds.push(format!("{media:?}").chars().take(48).collect());
            }
            continue;
        };

        let kind = MediaKind::classify(&mime, &name);
        if !kind.matches(filter) {
            filtered += 1;
            continue;
        }

        items.push(MediaItem {
            message_id: message.id(),
            // Channel message ids *are* the post's ordinal position in that
            // channel, counting from 1 — so this column shows something real
            // rather than a row number (§17).
            seq: message.id() as i64,
            name,
            mime,
            kind,
            size,
            date: message.date().timestamp(),
            duration: None,
        });
    }

    eprintln!(
        "[telewire] list_media offset={offset_id} filter={filter:?}: scanned={scanned} \
         found={} no_media={no_media} undescribable={undescribable} filtered={filtered} \
         exhausted={exhausted}{}",
        items.len(),
        if kinds.is_empty() {
            String::new()
        } else {
            format!(" unhandled={kinds:?}")
        }
    );

    // Only report the end of history when the iterator actually ran dry. A
    // page that stopped because it hit `limit` or `SCAN_CAP` must stay pageable.
    let next_offset_id = if exhausted && items.len() < limit {
        None
    } else {
        Some(last_seen_id)
    };

    Ok(MediaPage {
        items,
        next_offset_id,
        total: None,
    })
}
