//! The chunked, parallel, crash-safe download engine (Plan.md §11).
//!
//! Shape of one transfer:
//!
//! ```text
//!   file size ──► chunk plan (512 KiB units) ──► shared pending queue
//!                                                      │
//!            ┌────────────┬────────────┬───────────────┤  workers pull
//!         worker 0     worker 1     worker 2  …        ▼  the next index
//!            │            │            │
//!            └──── seek + write into <name>.part ──────┘
//!                          │
//!                   manifest.json (which chunks are confirmed on disk)
//!                          │
//!            all chunks done ──► verify length ──► rename to <name>
//! ```
//!
//! Four design points worth stating, because each replaces an obvious-but-worse
//! alternative:
//!
//! 1. **A shared queue of chunk indices *is* the work-stealing scheme** (§11.5).
//!    Statically slicing the file into N ranges makes the whole job wait on its
//!    slowest range. Here a slow connection simply takes fewer chunks, and the
//!    tail of the file is picked up by whichever worker is free.
//! 2. **Chunks are a fixed 512 KiB at 512 KiB-aligned offsets**, including the
//!    final short one. Telegram requires `limit` to divide 1 MiB, `offset` to be
//!    a multiple of 4 KiB, and a request never to straddle a 1 MiB boundary;
//!    512 KiB alignment satisfies all three by construction, and the server
//!    simply returns fewer bytes at end-of-file.
//! 3. **The manifest is the source of truth for resume** (§11.7). It records
//!    only chunks whose bytes are already flushed to the `.part` file, so a
//!    kill -9 at any instant can at worst lose the in-flight chunks, never
//!    corrupt the ones it claims.
//! 4. **The real name only ever appears on a complete file** (§11.2). Everything
//!    happens on `.part`, and the rename is the last step after a length check.

use anyhow::{anyhow, Context, Result};
use grammers_client::media::Downloadable;
use grammers_client::{Client, InvocationError};
use grammers_session::types::PeerRef;
use grammers_tl_types as tl;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Mutex;

use super::{friendly, Telegram};
use crate::model::{Job, JobState, ProgressBatch, ProgressEntry, Settings, EV_JOB, EV_PROGRESS};
use crate::store;

/// 512 KiB — grammers' own `MAX_CHUNK_SIZE`, and the largest value that keeps
/// every request inside a single 1 MiB window.
const CHUNK: u64 = 512 * 1024;
/// Hard ceiling on worker slots, independent of the user's setting.
const MAX_SLOTS: usize = 16;
/// §11.9 — batch progress to the UI instead of emitting per chunk.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(400);
/// How often the adaptive controller re-evaluates worker count.
const PROBE_INTERVAL: Duration = Duration::from_millis(2200);

/* ------------------------------------------------------------- manifest */

#[derive(Debug, Serialize, Deserialize)]
struct Manifest {
    version: u32,
    size: u64,
    chunk: u64,
    /// Indices of chunks confirmed written to the `.part` file.
    done: Vec<u32>,
}

fn part_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_os_string();
    s.push(".part");
    PathBuf::from(s)
}

fn manifest_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_os_string();
    s.push(".part.manifest.json");
    PathBuf::from(s)
}

/// Load the resume set, but only if it demonstrably describes *this* file:
/// same size, same chunking, and a `.part` already preallocated to full length.
/// Anything else is discarded rather than risking a silently corrupt merge.
async fn load_manifest(dest: &Path, size: u64) -> Vec<u32> {
    let mpath = manifest_path(dest);
    let ppath = part_path(dest);
    let Ok(text) = tokio::fs::read_to_string(&mpath).await else {
        return Vec::new();
    };
    let Ok(m) = serde_json::from_str::<Manifest>(&text) else {
        return Vec::new();
    };
    if m.version != 1 || m.size != size || m.chunk != CHUNK {
        return Vec::new();
    }
    match tokio::fs::metadata(&ppath).await {
        Ok(meta) if meta.len() == size => m.done,
        _ => Vec::new(),
    }
}

/// Written via temp-file + rename so a crash mid-write can never leave a
/// half-parsed manifest claiming chunks that aren't there.
async fn save_manifest(dest: &Path, size: u64, done: &[u32]) -> Result<()> {
    let mpath = manifest_path(dest);
    let tmp = mpath.with_extension("json.tmp");
    let text = serde_json::to_string(&Manifest {
        version: 1,
        size,
        chunk: CHUNK,
        done: done.to_vec(),
    })?;
    tokio::fs::write(&tmp, text).await?;
    tokio::fs::rename(&tmp, &mpath).await?;
    Ok(())
}

/* --------------------------------------------------------------- control */

struct Control {
    paused: AtomicBool,
    cancelled: AtomicBool,
}

/// Live counters shared between a job's workers and the progress ticker.
struct Live {
    done: AtomicU64,
    total: u64,
    /// How many worker slots should currently be running. The adaptive
    /// controller moves this; workers whose slot index reaches it retire.
    target: AtomicU32,
    active: AtomicU32,
    /// Cumulative bytes per slot; the ticker differentiates these to get each
    /// connection's real throughput.
    per_slot: Vec<AtomicU64>,
    flood_until: AtomicI64,
}

impl Live {
    fn new(total: u64, done: u64, start_workers: u32) -> Self {
        Self {
            done: AtomicU64::new(done),
            total,
            target: AtomicU32::new(start_workers),
            active: AtomicU32::new(0),
            per_slot: (0..MAX_SLOTS).map(|_| AtomicU64::new(0)).collect(),
            flood_until: AtomicI64::new(0),
        }
    }
}

struct Record {
    job: Job,
    control: Arc<Control>,
    live: Option<Arc<Live>>,
    /// Kept so a paused job can be resumed without re-resolving the message.
    peer: PeerRef,
}

/* ---------------------------------------------------------------- engine */

pub struct Engine {
    app: AppHandle,
    tg: Arc<Telegram>,
    jobs: Mutex<HashMap<String, Record>>,
    /// Insertion order, so the queue renders and promotes deterministically.
    order: Mutex<Vec<String>>,
    /// Nudges the scheduler to look for promotable work.
    ///
    /// Scheduling is a separate task rather than a direct call because the
    /// natural shape — `pump` starts a job, the job finishes, the finish
    /// promotes the next one — is a recursive async cycle, and `rustc` cannot
    /// prove such a cycle is `Send` (it would have to know the future's size
    /// before it has finished inferring it). One scheduler loop breaks the
    /// cycle and gives queue promotion a single, serialised owner.
    wake: tokio::sync::mpsc::UnboundedSender<()>,
}

impl Engine {
    pub fn new(app: AppHandle, tg: Arc<Telegram>) -> Arc<Self> {
        let (wake, mut wake_rx) = tokio::sync::mpsc::unbounded_channel();
        let engine = Arc::new(Self {
            app,
            tg,
            jobs: Mutex::new(HashMap::new()),
            order: Mutex::new(Vec::new()),
            wake,
        });

        // `tauri::async_runtime::spawn`, not `tokio::spawn`: this constructor
        // runs inside Tauri's `setup` hook, which is on the main thread with no
        // runtime entered — a bare `tokio::spawn` there panics with "there is
        // no reactor running". Everything spawned later is already inside a
        // command or a task, where either would work.
        let ticker = Arc::clone(&engine);
        tauri::async_runtime::spawn(async move { ticker.progress_loop().await });

        let scheduler = Arc::clone(&engine);
        tauri::async_runtime::spawn(async move {
            while wake_rx.recv().await.is_some() {
                scheduler.pump().await;
            }
        });

        engine
    }

    /// Ask the scheduler to promote whatever it can. Never blocks, and is safe
    /// to call from inside a running job.
    fn nudge(&self) {
        let _ = self.wake.send(());
    }

    /* ---------------------------------------------------------- listing */

    pub async fn list(&self) -> Vec<Job> {
        let jobs = self.jobs.lock().await;
        let order = self.order.lock().await;
        order
            .iter()
            .filter_map(|id| jobs.get(id).map(|r| r.job.clone()))
            .collect()
    }

    async fn emit_job(&self, job: &Job) {
        let _ = self.app.emit(EV_JOB, job);
    }

    /// Snapshot every live job's counters and push one batched event (§11.9).
    async fn progress_loop(self: Arc<Self>) {
        let mut last_slot: HashMap<String, Vec<u64>> = HashMap::new();
        let mut last_done: HashMap<String, u64> = HashMap::new();
        let mut last_tick = Instant::now();

        loop {
            tokio::time::sleep(PROGRESS_INTERVAL).await;
            let dt = last_tick.elapsed().as_secs_f64().max(0.001);
            last_tick = Instant::now();

            let mut entries = Vec::new();
            let mut total_bps = 0u64;
            {
                let mut jobs = self.jobs.lock().await;
                for (id, rec) in jobs.iter_mut() {
                    let Some(live) = rec.live.as_ref() else { continue };
                    if rec.job.state != JobState::Running {
                        continue;
                    }

                    let done = live.done.load(Ordering::Relaxed);
                    let prev = last_done.get(id).copied().unwrap_or(done);
                    let bps = (((done.saturating_sub(prev)) as f64) / dt) as u64;
                    last_done.insert(id.clone(), done);

                    let active = live.active.load(Ordering::Relaxed);
                    let slots: Vec<u64> = live
                        .per_slot
                        .iter()
                        .map(|a| a.load(Ordering::Relaxed))
                        .collect();
                    let prev_slots = last_slot.get(id).cloned().unwrap_or_else(|| vec![0; MAX_SLOTS]);
                    let deltas: Vec<u64> = slots
                        .iter()
                        .zip(prev_slots.iter())
                        .map(|(now, before)| now.saturating_sub(*before))
                        .collect();
                    last_slot.insert(id.clone(), slots);

                    // Each bar is that connection's share of the fastest one —
                    // a real readout of per-connection throughput, not a
                    // decorative animation.
                    let peak = deltas.iter().copied().max().unwrap_or(0).max(1);
                    let worker_fill: Vec<f32> = deltas
                        .iter()
                        .take(active.max(1) as usize)
                        .map(|d| (*d as f32 / peak as f32).clamp(0.0, 1.0))
                        .collect();

                    let eta_s = if bps > 0 {
                        Some(live.total.saturating_sub(done) / bps.max(1))
                    } else {
                        None
                    };

                    rec.job.done = done;
                    rec.job.speed_bps = bps;
                    rec.job.eta_s = eta_s;
                    rec.job.workers = active;
                    rec.job.worker_fill = worker_fill.clone();
                    let flood = live.flood_until.load(Ordering::Relaxed);
                    rec.job.flood_wait_until = (flood > 0).then_some(flood);

                    total_bps = total_bps.saturating_add(bps);
                    entries.push(ProgressEntry {
                        id: id.clone(),
                        done,
                        speed_bps: bps,
                        eta_s,
                        workers: active,
                        worker_fill,
                    });
                }
            }

            // Emit even when idle-but-recently-active so the wire can settle
            // back to zero rather than freezing at the last reading.
            if !entries.is_empty() || total_bps > 0 {
                let _ = self.app.emit(
                    EV_PROGRESS,
                    ProgressBatch {
                        jobs: entries,
                        total_bps,
                    },
                );
            }
        }
    }

    /* --------------------------------------------------------- enqueue */

    pub async fn enqueue(
        self: &Arc<Self>,
        channel_id: i64,
        channel_title: String,
        message_ids: Vec<i32>,
    ) -> Result<Vec<Job>> {
        let client = self.tg.client().await?;
        let peer = self
            .tg
            .peer(channel_id)
            .await
            .ok_or_else(|| anyhow!("That channel is no longer open. Select it again."))?;

        let messages = client
            .get_messages_by_id(peer, &message_ids)
            .await
            .map_err(|e| anyhow!(friendly(&e.to_string())))?;

        let settings = store::load_settings();
        let mut created = Vec::new();

        for message in messages.into_iter().flatten() {
            let Some(media) = message.media() else { continue };
            let Some((name, _mime, size)) = super::channel::describe(&media, message.id()) else {
                continue;
            };
            // Nothing without a raw file location can be range-fetched.
            if media.to_raw_input_location().is_none() {
                continue;
            }

            let dest = destination(&settings, &channel_title, &name, message.date().timestamp())?;

            let job = Job {
                id: uuid::Uuid::new_v4().to_string(),
                channel_id,
                channel_title: channel_title.clone(),
                message_id: message.id(),
                name,
                dest_path: dest.to_string_lossy().into_owned(),
                size,
                done: 0,
                state: JobState::Queued,
                speed_bps: 0,
                eta_s: None,
                workers: 0,
                worker_fill: Vec::new(),
                error: None,
                flood_wait_until: None,
                created_at: chrono::Utc::now().timestamp(),
            };

            {
                let mut jobs = self.jobs.lock().await;
                let mut order = self.order.lock().await;
                order.push(job.id.clone());
                jobs.insert(
                    job.id.clone(),
                    Record {
                        job: job.clone(),
                        control: Arc::new(Control {
                            paused: AtomicBool::new(false),
                            cancelled: AtomicBool::new(false),
                        }),
                        live: None,
                        peer,
                    },
                );
            }
            self.emit_job(&job).await;
            created.push(job);
        }

        self.pump().await;
        Ok(created)
    }

    /// Promote queued jobs into free slots, respecting `max_concurrent_jobs`.
    async fn pump(self: &Arc<Self>) {
        let settings = store::load_settings();
        let mut to_start = Vec::new();
        {
            let jobs = self.jobs.lock().await;
            let order = self.order.lock().await;
            let running = jobs
                .values()
                .filter(|r| r.job.state == JobState::Running)
                .count();
            let mut free = settings.max_concurrent_jobs as usize - running.min(settings.max_concurrent_jobs as usize);
            for id in order.iter() {
                if free == 0 {
                    break;
                }
                if jobs.get(id).map(|r| r.job.state) == Some(JobState::Queued) {
                    to_start.push(id.clone());
                    free -= 1;
                }
            }
        }
        for id in to_start {
            self.start(id).await;
        }
    }

    async fn start(self: &Arc<Self>, id: String) {
        let (control, peer, job) = {
            let mut jobs = self.jobs.lock().await;
            let Some(rec) = jobs.get_mut(&id) else { return };
            if rec.job.state == JobState::Running {
                return;
            }
            rec.control.paused.store(false, Ordering::SeqCst);
            rec.control.cancelled.store(false, Ordering::SeqCst);
            rec.job.state = JobState::Running;
            rec.job.error = None;
            (Arc::clone(&rec.control), rec.peer, rec.job.clone())
        };
        self.emit_job(&job).await;

        let engine = Arc::clone(self);
        tokio::spawn(async move {
            let outcome = engine.run_job(&id, peer, control).await;
            engine.finish(&id, outcome).await;
        });
    }

    async fn finish(self: &Arc<Self>, id: &str, outcome: Result<Outcome>) {
        let job = {
            let mut jobs = self.jobs.lock().await;
            let Some(rec) = jobs.get_mut(id) else { return };
            rec.live = None;
            rec.job.speed_bps = 0;
            rec.job.worker_fill.clear();
            rec.job.workers = 0;
            match outcome {
                Ok(Outcome::Complete) => {
                    rec.job.state = JobState::Done;
                    rec.job.done = rec.job.size;
                }
                Ok(Outcome::Paused) => rec.job.state = JobState::Paused,
                Ok(Outcome::Cancelled) => rec.job.state = JobState::Cancelled,
                Err(e) => {
                    rec.job.state = JobState::Error;
                    rec.job.error = Some(format!("{e:#}"));
                }
            }
            rec.job.clone()
        };
        self.emit_job(&job).await;
        self.nudge();
    }

    /* --------------------------------------------------------- controls */

    pub async fn pause(&self, id: &str) -> Result<()> {
        let jobs = self.jobs.lock().await;
        let rec = jobs.get(id).ok_or_else(|| anyhow!("No such download."))?;
        rec.control.paused.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub async fn resume(self: &Arc<Self>, id: &str) -> Result<()> {
        {
            let mut jobs = self.jobs.lock().await;
            let rec = jobs.get_mut(id).ok_or_else(|| anyhow!("No such download."))?;
            if rec.job.state != JobState::Paused && rec.job.state != JobState::Error {
                return Ok(());
            }
            rec.job.state = JobState::Queued;
        }
        self.pump().await;
        Ok(())
    }

    pub async fn retry(self: &Arc<Self>, id: &str) -> Result<()> {
        self.resume(id).await
    }

    pub async fn cancel(self: &Arc<Self>, id: &str) -> Result<()> {
        let (dest, was_running, job) = {
            let mut jobs = self.jobs.lock().await;
            let rec = jobs.get_mut(id).ok_or_else(|| anyhow!("No such download."))?;
            rec.control.cancelled.store(true, Ordering::SeqCst);
            let running = rec.job.state == JobState::Running;
            if !running {
                rec.job.state = JobState::Cancelled;
            }
            (PathBuf::from(&rec.job.dest_path), running, rec.job.clone())
        };

        // A running job tears its own partial file down when its workers see
        // the cancel flag; a queued/paused one has no task to do it.
        if !was_running {
            let _ = tokio::fs::remove_file(part_path(&dest)).await;
            let _ = tokio::fs::remove_file(manifest_path(&dest)).await;
            self.emit_job(&job).await;
        }
        Ok(())
    }

    pub async fn clear_finished(&self) -> Result<()> {
        let mut jobs = self.jobs.lock().await;
        let mut order = self.order.lock().await;
        jobs.retain(|_, r| !r.job.state.is_terminal());
        order.retain(|id| jobs.contains_key(id));
        Ok(())
    }

    /* ------------------------------------------------------- the transfer */

    async fn run_job(
        self: &Arc<Self>,
        id: &str,
        _peer: PeerRef,
        control: Arc<Control>,
    ) -> Result<Outcome> {
        let (job, settings) = {
            let jobs = self.jobs.lock().await;
            let rec = jobs.get(id).ok_or_else(|| anyhow!("No such download."))?;
            (rec.job.clone(), store::load_settings())
        };

        let client = self.tg.client().await?;
        let dest = PathBuf::from(&job.dest_path);
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .with_context(|| format!("could not create {}", parent.display()))?;
        }

        let location = self.resolve_location(&client, &job).await?;
        let part = part_path(&dest);
        let size = job.size;
        let total_chunks = size.div_ceil(CHUNK) as u32;

        // Preallocate so every worker can write at its own offset without the
        // file growing underneath it (§11.2).
        {
            let file = tokio::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(false)
                .open(&part)
                .await
                .with_context(|| format!("could not open {}", part.display()))?;
            file.set_len(size).await?;
        }
        store::restrict_permissions(&part);

        let already = load_manifest(&dest, size).await;
        let done_set = Arc::new(Mutex::new(already.clone()));
        let mut pending: Vec<u32> = (0..total_chunks).filter(|i| !already.contains(i)).collect();
        // Hand the lowest offsets out first: sequential-ish access is friendlier
        // to the filesystem and makes a partially-downloaded file useful sooner.
        pending.sort_unstable();
        let queue = Arc::new(Mutex::new(std::collections::VecDeque::from(pending)));

        let start_workers = if settings.adaptive {
            2
        } else {
            settings.max_workers.min(MAX_SLOTS as u32)
        };
        let live = Arc::new(Live::new(
            size,
            already.len() as u64 * CHUNK,
            start_workers.max(1),
        ));
        {
            let mut jobs = self.jobs.lock().await;
            if let Some(rec) = jobs.get_mut(id) {
                rec.live = Some(Arc::clone(&live));
            }
        }

        let ceiling = settings.max_workers.clamp(1, MAX_SLOTS as u32);
        let mut set = tokio::task::JoinSet::new();
        let mut spawned = 0u32;

        let spawn_worker = |set: &mut tokio::task::JoinSet<Result<()>>, slot: u32| {
            let worker = Worker {
                slot,
                client: client.clone(),
                location: location.clone(),
                part: part.clone(),
                dest: dest.clone(),
                size,
                queue: Arc::clone(&queue),
                done_set: Arc::clone(&done_set),
                live: Arc::clone(&live),
                control: Arc::clone(&control),
            };
            set.spawn(async move { worker.run().await });
        };

        for slot in 0..start_workers.min(ceiling) {
            spawn_worker(&mut set, slot);
            spawned += 1;
        }

        // Adaptive controller (§11.4). Probes upward while the marginal worker
        // is actually earning its keep, and backs off when it isn't. This is the
        // difference between "several connections" and "faster".
        let controller = {
            let live = Arc::clone(&live);
            let control = Arc::clone(&control);
            tokio::spawn(async move {
                if !settings.adaptive {
                    return;
                }
                let mut last_bytes = live.done.load(Ordering::Relaxed);
                let mut last_rate = 0f64;
                let mut probing_up = true;
                loop {
                    tokio::time::sleep(PROBE_INTERVAL).await;
                    if control.cancelled.load(Ordering::Relaxed)
                        || control.paused.load(Ordering::Relaxed)
                    {
                        return;
                    }
                    let now = live.done.load(Ordering::Relaxed);
                    let rate = (now.saturating_sub(last_bytes)) as f64
                        / PROBE_INTERVAL.as_secs_f64();
                    last_bytes = now;

                    let target = live.target.load(Ordering::Relaxed);
                    if last_rate > 0.0 {
                        let gain = (rate - last_rate) / last_rate;
                        if probing_up && gain < 0.08 {
                            // The extra connection didn't pay for itself. Give
                            // it back and stop climbing.
                            if target > 1 {
                                live.target.store(target - 1, Ordering::Relaxed);
                            }
                            probing_up = false;
                        } else if gain < -0.15 && target > 1 {
                            // Throughput collapsed (congestion, or Telegram
                            // throttling): shed a connection.
                            live.target.store(target - 1, Ordering::Relaxed);
                        } else if probing_up && target < ceiling {
                            live.target.store(target + 1, Ordering::Relaxed);
                        }
                    } else if target < ceiling {
                        live.target.store(target + 1, Ordering::Relaxed);
                    }
                    last_rate = rate;
                }
            })
        };

        // Periodically flush the manifest so a crash costs at most a couple of
        // seconds of work rather than the whole transfer.
        let flusher = {
            let done_set = Arc::clone(&done_set);
            let dest = dest.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    let snapshot = done_set.lock().await.clone();
                    let _ = save_manifest(&dest, size, &snapshot).await;
                }
            })
        };

        // Top up worker slots as the controller raises the target.
        let mut failure: Option<anyhow::Error> = None;
        loop {
            let target = live.target.load(Ordering::Relaxed).min(ceiling);
            while spawned < target {
                spawn_worker(&mut set, spawned);
                spawned += 1;
            }

            match tokio::time::timeout(Duration::from_millis(250), set.join_next()).await {
                Ok(Some(Ok(Ok(())))) => {}
                Ok(Some(Ok(Err(e)))) => {
                    failure.get_or_insert(e);
                    control.cancelled.store(true, Ordering::SeqCst);
                }
                Ok(Some(Err(e))) => {
                    failure.get_or_insert(anyhow!("worker panicked: {e}"));
                    control.cancelled.store(true, Ordering::SeqCst);
                }
                // All workers have retired.
                Ok(None) => break,
                // Timeout: loop round to re-check the worker target.
                Err(_) => {}
            }
        }

        controller.abort();
        flusher.abort();

        let final_done = done_set.lock().await.clone();
        let _ = save_manifest(&dest, size, &final_done).await;

        if let Some(e) = failure {
            return Err(e);
        }
        if control.cancelled.load(Ordering::SeqCst) {
            let _ = tokio::fs::remove_file(&part).await;
            let _ = tokio::fs::remove_file(manifest_path(&dest)).await;
            return Ok(Outcome::Cancelled);
        }
        if control.paused.load(Ordering::SeqCst) {
            return Ok(Outcome::Paused);
        }

        if (final_done.len() as u32) < total_chunks {
            return Ok(Outcome::Paused);
        }

        // §11.10 — verify before the file is allowed to wear its real name.
        let meta = tokio::fs::metadata(&part).await?;
        if meta.len() != size {
            return Err(anyhow!(
                "size check failed: expected {size} bytes on disk, found {}",
                meta.len()
            ));
        }

        let final_path = unique_path(&dest).await;
        tokio::fs::rename(&part, &final_path).await.with_context(|| {
            format!("could not move the finished file into place at {}", final_path.display())
        })?;
        let _ = tokio::fs::remove_file(manifest_path(&dest)).await;

        if final_path != dest {
            let mut jobs = self.jobs.lock().await;
            if let Some(rec) = jobs.get_mut(id) {
                rec.job.dest_path = final_path.to_string_lossy().into_owned();
            }
        }
        Ok(Outcome::Complete)
    }

    /// File references go stale (Telegram rotates them), so the location is
    /// fetched fresh at the start of every attempt rather than cached at
    /// enqueue time.
    async fn resolve_location(
        &self,
        client: &Client,
        job: &Job,
    ) -> Result<tl::enums::InputFileLocation> {
        let peer = self
            .tg
            .peer(job.channel_id)
            .await
            .ok_or_else(|| anyhow!("That channel is no longer open. Select it again."))?;
        let messages = client
            .get_messages_by_id(peer, &[job.message_id])
            .await
            .map_err(|e| anyhow!(friendly(&e.to_string())))?;
        let media = messages
            .into_iter()
            .flatten()
            .next()
            .and_then(|m| m.media())
            .ok_or_else(|| anyhow!("That message no longer exists in the channel."))?;
        media
            .to_raw_input_location()
            .ok_or_else(|| anyhow!("That media can't be downloaded directly."))
    }
}

enum Outcome {
    Complete,
    Paused,
    Cancelled,
}

/* ---------------------------------------------------------------- worker */

struct Worker {
    slot: u32,
    client: Client,
    location: tl::enums::InputFileLocation,
    part: PathBuf,
    dest: PathBuf,
    size: u64,
    queue: Arc<Mutex<std::collections::VecDeque<u32>>>,
    done_set: Arc<Mutex<Vec<u32>>>,
    live: Arc<Live>,
    control: Arc<Control>,
}

impl Worker {
    async fn run(self) -> Result<()> {
        // Each worker holds its own handle so seek+write never races another
        // worker's file cursor.
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .open(&self.part)
            .await
            .with_context(|| format!("could not open {}", self.part.display()))?;

        self.live.active.fetch_add(1, Ordering::Relaxed);
        let result = self.pump(&mut file).await;
        self.live.active.fetch_sub(1, Ordering::Relaxed);
        let _ = file.flush().await;
        result
    }

    async fn pump(&self, file: &mut tokio::fs::File) -> Result<()> {
        loop {
            if self.control.cancelled.load(Ordering::Relaxed)
                || self.control.paused.load(Ordering::Relaxed)
            {
                return Ok(());
            }
            // Retire when the adaptive controller has lowered the target below
            // this slot index.
            if self.slot >= self.live.target.load(Ordering::Relaxed) {
                return Ok(());
            }

            let Some(index) = self.queue.lock().await.pop_front() else {
                return Ok(());
            };

            match self.fetch(index).await {
                Ok(bytes) => {
                    let offset = index as u64 * CHUNK;
                    file.seek(std::io::SeekFrom::Start(offset)).await?;
                    file.write_all(&bytes).await?;
                    // Flush before claiming the chunk: the manifest must never
                    // promise bytes the OS hasn't been handed yet (§11.7).
                    file.flush().await?;

                    self.done_set.lock().await.push(index);
                    let n = bytes.len() as u64;
                    self.live.done.fetch_add(n, Ordering::Relaxed);
                    self.live.per_slot[self.slot as usize].fetch_add(n, Ordering::Relaxed);
                }
                Err(e) => {
                    // Put the chunk back so another worker (or a later retry)
                    // can take it — losing it would silently truncate the file.
                    self.queue.lock().await.push_front(index);
                    return Err(e);
                }
            }
        }
    }

    /// One `upload.getFile` call, with flood-wait and retry handling.
    async fn fetch(&self, index: u32) -> Result<Vec<u8>> {
        let offset = index as u64 * CHUNK;
        // Always request a full aligned chunk; at end-of-file the server
        // simply returns the remaining bytes.
        let request = tl::functions::upload::GetFile {
            precise: false,
            cdn_supported: false,
            location: self.location.clone(),
            offset: offset as i64,
            limit: CHUNK as i32,
        };

        let mut attempt = 0u32;
        loop {
            attempt += 1;
            match self.client.invoke(&request).await {
                Ok(tl::enums::upload::File::File(f)) => {
                    self.live.flood_until.store(0, Ordering::Relaxed);
                    let expected = (self.size - offset).min(CHUNK) as usize;
                    if f.bytes.len() < expected {
                        return Err(anyhow!(
                            "Telegram returned {} bytes for a {expected}-byte chunk",
                            f.bytes.len()
                        ));
                    }
                    return Ok(f.bytes.into_iter().take(expected).collect());
                }
                Ok(tl::enums::upload::File::CdnRedirect(_)) => {
                    // We never set `cdn_supported`, so this should be
                    // unreachable; treat it as a hard error rather than
                    // pretending we handled it.
                    return Err(anyhow!("Telegram redirected this file to a CDN, which TeleWire does not support yet."));
                }
                Err(InvocationError::Rpc(ref rpc)) if rpc.is("FLOOD_WAIT") => {
                    // §11.8 — back off exactly this task for exactly as long as
                    // Telegram asked, then carry on. The rest of the job keeps
                    // running.
                    let secs = rpc.value.unwrap_or(5).min(600) as u64;
                    self.live.flood_until.store(
                        chrono::Utc::now().timestamp() + secs as i64,
                        Ordering::Relaxed,
                    );
                    tokio::time::sleep(Duration::from_secs(secs)).await;
                    if self.control.cancelled.load(Ordering::Relaxed) {
                        return Err(anyhow!("cancelled"));
                    }
                    continue;
                }
                Err(e) if attempt < 4 => {
                    // Transient transport hiccups are normal on a long
                    // multi-connection transfer; a short backoff beats failing
                    // a 4 GB download over one dropped packet.
                    tokio::time::sleep(Duration::from_millis(400 * attempt as u64)).await;
                    let _ = e;
                    continue;
                }
                Err(e) => {
                    return Err(anyhow!(friendly(&e.to_string())))
                        .with_context(|| format!("chunk {index} of {}", self.dest.display()))
                }
            }
        }
    }
}

/* ------------------------------------------------------------ file paths */

/// `<root>/<channel>/<YYYY-MM>/<name>` unless organising is off (§11).
fn destination(
    settings: &Settings,
    channel_title: &str,
    name: &str,
    date_unix: i64,
) -> Result<PathBuf> {
    let mut path = PathBuf::from(&settings.download_root);
    if settings.organize {
        path.push(sanitize_filename::sanitize(channel_title));
        let dt = chrono::DateTime::from_timestamp(date_unix, 0).unwrap_or_else(chrono::Utc::now);
        path.push(dt.format("%Y-%m").to_string());
    }
    path.push(sanitize_filename::sanitize(name));
    Ok(path)
}

/// Never overwrite: an existing file with the real name is, by this engine's
/// own invariant, a complete download.
async fn unique_path(dest: &Path) -> PathBuf {
    if tokio::fs::metadata(dest).await.is_err() {
        return dest.to_path_buf();
    }
    let stem = dest.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = dest.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
    let parent = dest.parent().map(Path::to_path_buf).unwrap_or_default();
    for n in 2..10_000 {
        let candidate = parent.join(format!("{stem} ({n}){ext}"));
        if tokio::fs::metadata(&candidate).await.is_err() {
            return candidate;
        }
    }
    dest.to_path_buf()
}
