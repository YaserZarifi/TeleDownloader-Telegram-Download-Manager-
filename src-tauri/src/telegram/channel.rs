//! Resolving channels and paginating their media history.

use anyhow::{anyhow, Context, Result};
use grammers_client::media::{Downloadable, Media};
use grammers_client::peer::Peer;
use grammers_client::Client;
use grammers_session::types::PeerRef;
use grammers_tl_types as tl;

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

/// Telegram's `photoStrippedSize`: a JPEG with its quantisation and Huffman
/// tables stripped out, leaving ~100 bytes. The tables are a fixed constant
/// shared by every stripped thumbnail, so a real JPEG is reconstructed by
/// splicing them back in — two bytes of the payload carry the dimensions.
///
/// This is the whole reason grid thumbnails cost nothing: the bytes already
/// travelled with the message list, so there is no extra request per tile.
fn inflate_stripped_jpeg(stripped: &[u8]) -> Option<Vec<u8>> {
    if stripped.len() < 3 || stripped[0] != 0x01 {
        return None;
    }
    const HEADER: &[u8] = &[
        0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x28, 0x1c, 0x1e, 0x23, 0x1e, 0x19, 0x28, 0x23,
        0x21, 0x23, 0x2d, 0x2b, 0x28, 0x30, 0x3c, 0x64, 0x41, 0x3c, 0x37, 0x37, 0x3c, 0x7b, 0x58,
        0x5d, 0x49, 0x64, 0x91, 0x80, 0x99, 0x96, 0x8f, 0x80, 0x8c, 0x8a, 0xa0, 0xb4, 0xe6, 0xc3,
        0xa0, 0xaa, 0xda, 0xad, 0x8a, 0x8c, 0xc8, 0xff, 0xcb, 0xda, 0xee, 0xf5, 0xff, 0xff, 0xff,
        0x9b, 0xc1, 0xff, 0xff, 0xff, 0xfa, 0xff, 0xe6, 0xfd, 0xff, 0xf8, 0xff, 0xc0, 0x00, 0x11,
        0x08, 0x00, 0x00, 0x00, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
        0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
        0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03, 0x03, 0x02, 0x04,
        0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d, 0x01, 0x02, 0x03, 0x00, 0x04, 0x11,
        0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81,
        0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
        0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34,
        0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53,
        0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a,
        0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
        0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6,
        0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
        0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9,
        0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
        0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f,
        0x00,
    ];
    const FOOTER: &[u8] = &[0xff, 0xd9];

    let mut out = Vec::with_capacity(HEADER.len() + stripped.len() + FOOTER.len());
    out.extend_from_slice(HEADER);
    // Bytes 1 and 2 are height and width; patch them into the SOF0 marker.
    out[164] = stripped[1];
    out[166] = stripped[2];
    out.extend_from_slice(&stripped[3..]);
    out.extend_from_slice(FOOTER);
    Some(out)
}

/// A tiny inline preview for a message's media, or `None`.
///
/// Only ever uses bytes that already arrived with the message — no extra
/// request per tile — so a grid of hundreds of thumbnails costs nothing and
/// cannot compete with the download engine for bandwidth.
pub fn thumbnail_for(media: &Media) -> Option<String> {
    // The raw TL types are walked directly rather than via
    // `Downloadable::to_data()`: that trait method's default is `None`, and in
    // practice nothing useful comes back through the `Media` wrapper — which
    // is why every tile initially fell back to its glyph. Photos keep their
    // preview in `photo.sizes`; documents (playable videos, GIFs, stickers)
    // keep theirs in `document.thumbs`. A document uploaded as a plain file
    // genuinely has no preview, and the glyph fallback is the right answer.
    let raw = match media {
        Media::Photo(photo) => inline_from_photo(&photo.raw),
        Media::Document(doc) => inline_from_document(&doc.raw),
        Media::Sticker(sticker) => inline_from_document(&sticker.document.raw),
        _ => None,
    }?;

    let jpeg = if raw.first() == Some(&0x01) {
        inflate_stripped_jpeg(&raw)?
    } else if raw.starts_with(&[0xff, 0xd8]) {
        // `photoCachedSize` carries a complete small JPEG as-is.
        raw
    } else {
        return None;
    };
    Some(format!("data:image/jpeg;base64,{}", base64_encode(&jpeg)))
}

/// Inline preview bytes from a photo's size list, if any variant carries them.
fn inline_from_photo(raw: &tl::types::MessageMediaPhoto) -> Option<Vec<u8>> {
    let tl::enums::Photo::Photo(photo) = raw.photo.as_ref()? else {
        return None;
    };
    inline_from_sizes(&photo.sizes)
}

/// Inline preview bytes from a document's thumb list.
fn inline_from_document(raw: &tl::types::MessageMediaDocument) -> Option<Vec<u8>> {
    let tl::enums::Document::Document(doc) = raw.document.as_ref()? else {
        return None;
    };
    inline_from_sizes(doc.thumbs.as_ref()?)
}

/// Prefer the stripped size (universal, ~100 bytes); fall back to a cached
/// size, which is a complete small JPEG. Everything else in the list is a
/// server-side size that would cost a network request — not for tiles.
fn inline_from_sizes(sizes: &[tl::enums::PhotoSize]) -> Option<Vec<u8>> {
    sizes
        .iter()
        .find_map(|t| match t {
            tl::enums::PhotoSize::PhotoStrippedSize(s) => Some(s.bytes.clone()),
            _ => None,
        })
        .or_else(|| {
            sizes.iter().find_map(|t| match t {
                tl::enums::PhotoSize::PhotoCachedSize(s) => Some(s.bytes.clone()),
                _ => None,
            })
        })
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
            thumb: thumbnail_for(&media),
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
