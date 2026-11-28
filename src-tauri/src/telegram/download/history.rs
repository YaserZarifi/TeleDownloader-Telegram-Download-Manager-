use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::model::{Job, JobState};
use crate::store;

pub(super) fn account_dir(account_id: i64) -> Result<PathBuf> {
    Ok(store::data_dir()?
        .join("download-history")
        .join(account_id.to_string()))
}

pub(super) async fn record(dir: &Path, job: &Job) -> Result<()> {
    tokio::fs::create_dir_all(dir).await?;
    let path = dir.join(format!("{}.json", job.id));
    let temp = path.with_extension("json.tmp");
    tokio::fs::write(&temp, serde_json::to_vec(job)?)
        .await
        .context("could not write completed download history")?;
    store::restrict_permissions(&temp);
    tokio::fs::rename(temp, path)
        .await
        .context("could not publish completed download history")?;
    Ok(())
}

pub(super) async fn load(dir: &Path) -> Result<Vec<Job>> {
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut jobs = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        if let Ok(bytes) = tokio::fs::read(path).await {
            if let Ok(job) = serde_json::from_slice::<Job>(&bytes) {
                if job.state == JobState::Done {
                    jobs.push(job);
                }
            }
        }
    }
    jobs.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(jobs)
}

pub(super) async fn clear(dir: &Path) -> Result<()> {
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) == Some("json") {
            match tokio::fs::remove_file(path).await {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(error).context("could not clear completed download history")
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn finished_downloads_survive_reload_and_clear_only_removes_history() -> Result<()> {
        let root = std::env::temp_dir().join(format!("telewire-history-{}", uuid::Uuid::new_v4()));
        let account = root.join("100");
        let other_account = root.join("200");
        let media = root.join("clip.mp4");
        let job = Job {
            id: "finished-file".into(),
            channel_id: 10,
            channel_title: "Chat".into(),
            message_id: 20,
            name: "clip.mp4".into(),
            dest_path: media.to_string_lossy().into_owned(),
            size: 5,
            done: 5,
            state: JobState::Done,
            speed_bps: 0,
            eta_s: None,
            workers: 0,
            worker_fill: Vec::new(),
            error: None,
            flood_wait_until: None,
            created_at: 123,
        };

        assert!(load(&account).await?.is_empty());
        record(&account, &job).await?;
        tokio::fs::write(&media, b"video").await?;
        tokio::fs::write(account.join("unfinished.json.tmp"), b"{").await?;
        let restored = load(&account).await?;
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].id, job.id);
        assert_eq!(restored[0].state, JobState::Done);
        assert_eq!(restored[0].dest_path, job.dest_path);
        assert!(load(&other_account).await?.is_empty());

        record(&other_account, &job).await?;
        clear(&account).await?;
        assert!(load(&account).await?.is_empty());
        assert_eq!(load(&other_account).await?.len(), 1);
        assert_eq!(tokio::fs::read(&media).await?, b"video");

        tokio::fs::remove_dir_all(root).await?;
        Ok(())
    }
}
