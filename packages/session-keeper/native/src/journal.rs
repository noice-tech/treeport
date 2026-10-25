use crate::protocol::{encode_jsonl, encode_metadata_json, Record, RecordData, MAX_FRAME_BYTES};
use anyhow::{bail, Context, Result};
use flate2::{read::MultiGzDecoder, write::GzEncoder, Compression};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    os::unix::fs::{FileExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

const SEGMENT_BYTES: u64 = 1024 * 1024;
const MAX_CHECKPOINTS: usize = 65_520;
const MAX_ACTIVE_OFFSETS: usize = 65_536;

pub struct Journal {
    directory: PathBuf,
    active: File,
    bytes: u64,
    offsets: Vec<(u64, u64)>,
    archive_bytes: u64,
    checkpoints: Vec<(PathBuf, u64)>,
    rotation: Option<Rotation>,
    pub sequence: u64,
    pub limit_bytes: u64,
}
struct Rotation {
    retired: PathBuf,
    replacement: PathBuf,
    moved: bool,
}
impl Journal {
    pub fn new(directory: &Path, limit_bytes: u64) -> Result<Self> {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            if !matches!(
                entry.file_name().to_str(),
                Some("manifest.json" | "owner.log")
            ) || !entry.file_type()?.is_file()
            {
                bail!(
                    "Session storage is not fresh; refusing a new journal: {}",
                    entry.path().display()
                );
            }
        }
        let active = open_regular(
            &directory.join("journal.jsonl"),
            OpenOptions::new().read(true).write(true).create_new(true),
        )?;
        File::open(directory)?.sync_all()?;
        Ok(Self {
            directory: directory.into(),
            active,
            bytes: 0,
            offsets: Vec::new(),
            archive_bytes: 0,
            checkpoints: Vec::new(),
            rotation: None,
            sequence: 0,
            limit_bytes,
        })
    }

    pub fn append(&mut self, data: RecordData, at: u64) -> Result<Record> {
        let record = Record {
            data,
            at,
            sequence: self.sequence + 1,
        };
        record.validate()?;
        let encoded = encode_jsonl(&record).context("Cannot encode journal record")?;
        if self.rotation.is_some() {
            self.finish_rotation()?;
        }
        if self.bytes >= SEGMENT_BYTES || self.offsets.len() >= MAX_ACTIVE_OFFSETS {
            self.compact()?;
        }
        if self.offsets.len() >= MAX_ACTIVE_OFFSETS {
            bail!("Terminal journal active index limit reached; increase the journal quota to allow compaction, or close the terminal");
        }
        if self.archive_bytes + self.bytes + encoded.len() as u64 > self.limit_bytes {
            self.compact()?;
            if self.archive_bytes + self.bytes + encoded.len() as u64 > self.limit_bytes {
                bail!("Terminal journal quota reached ({} bytes). Increase TREEPORT_TERMINAL_JOURNAL_LIMIT_BYTES and restart Treeport to resume capture.", self.limit_bytes);
            }
        }
        self.active.write_all_at(&encoded, self.bytes)?;
        self.active.set_len(self.bytes + encoded.len() as u64)?;
        self.active.sync_data()?;
        self.offsets.push((record.sequence, self.bytes));
        self.bytes += encoded.len() as u64;
        self.sequence = record.sequence;
        Ok(record)
    }

    fn compact(&mut self) -> Result<()> {
        if self.rotation.is_some() {
            return self.finish_rotation();
        }
        if self.bytes == 0 {
            return Ok(());
        }
        if self.checkpoints.len() >= MAX_CHECKPOINTS {
            bail!("Terminal journal checkpoint index limit reached; close the terminal to release retained history");
        }
        let number = self.checkpoints.len() + 1;
        let checkpoint = self.directory.join(format!("checkpoint-{number:010}.gz"));
        let temporary = checkpoint.with_extension("gz.tmp");
        let output = open_regular(
            &temporary,
            OpenOptions::new().write(true).create(true).truncate(true),
        )?;
        let mut zip = GzEncoder::new(output, Compression::default());
        io::copy(
            &mut Prefix {
                file: self.active.try_clone()?,
                offset: 0,
                end: self.bytes,
            },
            &mut zip,
        )?;
        let output = zip.finish()?;
        let bytes = output.metadata()?.len();
        if self.archive_bytes + bytes > self.limit_bytes {
            drop(output);
            fs::remove_file(temporary)?;
            return Ok(());
        }
        output.sync_all()?;
        drop(output);
        let replacement = self.directory.join("journal-next.tmp");
        // A separate empty-file sync adds a device-wide barrier on Darwin for
        // every small-quota checkpoint, without protecting any output.
        match fs::remove_file(&replacement) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        drop(open_regular(
            &replacement,
            OpenOptions::new().read(true).write(true).create_new(true),
        )?);
        fs::rename(temporary, &checkpoint)?;
        self.checkpoints.push((checkpoint, self.sequence));
        self.archive_bytes += bytes;
        self.rotation = Some(Rotation {
            retired: self.directory.join(format!("retired-{number}.jsonl")),
            replacement,
            moved: false,
        });
        self.finish_rotation()
    }

    fn finish_rotation(&mut self) -> Result<()> {
        File::open(&self.directory)?.sync_all()?;
        let rotation = self.rotation.as_mut().context("Missing rotation state")?;
        if !rotation.moved {
            fs::rename(self.directory.join("journal.jsonl"), &rotation.retired)?;
            rotation.moved = true;
        }
        if rotation.replacement.exists() {
            fs::rename(&rotation.replacement, self.directory.join("journal.jsonl"))?;
        }
        let next = open_regular(
            &self.directory.join("journal.jsonl"),
            OpenOptions::new().read(true).write(true),
        )?;
        File::open(&self.directory)?.sync_all()?;
        match fs::remove_file(&rotation.retired) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        self.active = next;
        self.bytes = 0;
        self.offsets.clear();
        self.rotation = None;
        Ok(())
    }

    pub fn snapshot(&self, after: u64) -> Result<Snapshot> {
        if self.checkpoints.len() > MAX_CHECKPOINTS || self.offsets.len() > MAX_ACTIVE_OFFSETS {
            bail!("Terminal journal exceeds the index limit");
        }
        if after > self.sequence {
            bail!("Snapshot fence exceeds the journal");
        }
        let first = self
            .checkpoints
            .partition_point(|(_, fence)| *fence <= after);
        let checkpoints = self.checkpoints[first..].to_vec();
        let index = self
            .offsets
            .partition_point(|(sequence, _)| *sequence <= after);
        let start = self
            .offsets
            .get(index)
            .map_or(self.bytes, |(_, offset)| *offset);
        let active = if start < self.bytes {
            Some(Prefix {
                file: self.active.try_clone()?,
                offset: start,
                end: self.bytes,
            })
        } else {
            None
        };
        Ok(Snapshot {
            checkpoints,
            active,
            fence: self.sequence,
            after,
            input: None,
            archive_fence: None,
            index: 0,
        })
    }
}

// dup shares an open-file-description cursor. pread gives every snapshot its
// own offset and remains valid across rename/unlink without reopening a path.
struct Prefix {
    file: File,
    offset: u64,
    end: u64,
}
impl Read for Prefix {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let count = bytes.len().min((self.end - self.offset) as usize);
        let read = self.file.read_at(&mut bytes[..count], self.offset)?;
        self.offset += read as u64;
        Ok(read)
    }
}

pub struct Snapshot {
    checkpoints: Vec<(PathBuf, u64)>,
    active: Option<Prefix>,
    pub fence: u64,
    after: u64,
    input: Option<Box<dyn BufRead + Send>>,
    archive_fence: Option<u64>,
    index: usize,
}
impl Snapshot {
    pub fn next_record(&mut self) -> Result<Option<Record>> {
        loop {
            if self.input.is_none() {
                self.input = if let Some((path, fence)) = self.checkpoints.get(self.index) {
                    self.index += 1;
                    self.archive_fence = Some(*fence);
                    Some(Box::new(BufReader::new(MultiGzDecoder::new(open_regular(
                        path,
                        OpenOptions::new().read(true),
                    )?))))
                } else if let Some(active) = self.active.take() {
                    Some(Box::new(BufReader::new(active)))
                } else {
                    if self.after != self.fence {
                        bail!("Terminal journal does not reach its captured fence");
                    }
                    return Ok(None);
                };
            }
            let mut line = Vec::new();
            let count = self
                .input
                .as_mut()
                .unwrap()
                .take((MAX_FRAME_BYTES + 1) as u64)
                .read_until(b'\n', &mut line)?;
            if count == 0 {
                if self.archive_fence.take().is_some() {
                    bail!("Terminal checkpoint does not reach its captured fence");
                }
                self.input = None;
                continue;
            }
            if count > MAX_FRAME_BYTES || line.last() != Some(&b'\n') {
                bail!("Incomplete or oversized journal record");
            }
            let record: Record = serde_json::from_slice(&line)?;
            record.validate()?;
            if let Some(fence) = self.archive_fence {
                if record.sequence > fence {
                    bail!("Terminal checkpoint exceeds its captured fence");
                }
                if record.sequence == fence {
                    if !self.input.as_mut().unwrap().fill_buf()?.is_empty() {
                        bail!("Terminal checkpoint contains data beyond its captured fence");
                    }
                    self.input = None;
                    self.archive_fence = None;
                }
            }
            if record.sequence <= self.after {
                continue;
            }
            if record.sequence != self.after + 1 || record.sequence > self.fence {
                bail!("Terminal journal has a sequence gap or exceeds its fence");
            }
            self.after = record.sequence;
            return Ok(Some(record));
        }
    }
}

pub fn atomic_json<T: serde::Serialize>(directory: &Path, name: &str, value: &T) -> Result<()> {
    let encoded = encode_metadata_json(value)?;
    let temporary = directory.join(format!("{name}.tmp"));
    let mut file = open_regular(
        &temporary,
        OpenOptions::new().write(true).create(true).truncate(true),
    )?;
    file.write_all(&encoded)?;
    file.sync_all()?;
    fs::rename(temporary, directory.join(name))?;
    File::open(directory)?.sync_all()?;
    Ok(())
}

// O_NONBLOCK keeps a FIFO open from blocking; it does not make regular disk I/O async.
pub fn open_regular(path: &Path, options: &mut OpenOptions) -> Result<File> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() => {
            bail!(
                "Session storage path is not a regular file: {}",
                path.display()
            );
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let file = options
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)?;
    if !file.metadata()?.is_file() {
        bail!(
            "Session storage path is not a regular file: {}",
            path.display()
        );
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "opt-in durable journal throughput measurement"]
    fn measure_durable_batches() -> Result<()> {
        use std::time::Instant;
        for batch in [32 * 1024, 64 * 1024, 128 * 1024] {
            let root = tempfile::tempdir()?;
            let mut journal = Journal::new(root.path(), 64 * SEGMENT_BYTES)?;
            let pattern = "terminal output\r\n\x1b[32m";
            let data = pattern.repeat(batch / pattern.len());
            let count = 8 * 1024 * 1024 / data.len();
            let mut latencies = Vec::new();
            let started = Instant::now();
            for sequence in 0..count {
                let append = Instant::now();
                journal.append(RecordData::Output { data: data.clone() }, sequence as u64)?;
                latencies.push(append.elapsed().as_secs_f64() * 1000.0);
            }
            let elapsed = started.elapsed().as_secs_f64();
            latencies.sort_by(f64::total_cmp);
            let mut snapshot = journal.snapshot(0)?;
            for _ in 0..count {
                let record = snapshot.next_record()?.expect("durable record");
                assert_eq!(record.data, RecordData::Output { data: data.clone() });
            }
            assert!(snapshot.next_record()?.is_none());
            eprintln!(
                "batch={} records={} MiB/s={:.2} append_p99_ms={:.2}",
                data.len(),
                count,
                (data.len() * count) as f64 / elapsed / 1048576.0,
                latencies[latencies.len() * 99 / 100]
            );
        }
        Ok(())
    }

    #[test]
    fn snapshots_have_independent_offsets_and_survive_rotation() -> Result<()> {
        let root = tempfile::tempdir()?;
        let mut journal = Journal::new(root.path(), 10 * SEGMENT_BYTES)?;
        let first = journal.append(
            RecordData::Output {
                data: "a".repeat(SEGMENT_BYTES as usize),
            },
            1,
        )?;
        let mut old = journal.snapshot(0)?;
        let second = journal.append(RecordData::Resize { cols: 99, rows: 35 }, 2)?;
        let mut all = journal.snapshot(0)?;
        let mut tail = journal.snapshot(1)?;
        assert_eq!(tail.next_record()?, Some(second.clone()));
        assert_eq!(all.next_record()?, Some(first.clone()));
        assert_eq!(old.next_record()?, Some(first));
        assert_eq!(old.next_record()?, None);
        assert_eq!(all.next_record()?, Some(second));
        assert_eq!(all.next_record()?, None);
        assert_eq!(tail.next_record()?, None);
        Ok(())
    }

    #[test]
    fn partial_uncommitted_writes_are_not_replayed_and_retry_overwrites_them() -> Result<()> {
        let root = tempfile::tempdir()?;
        let mut journal = Journal::new(root.path(), 10000)?;
        let first = journal.append(
            RecordData::Marker {
                data: "first".into(),
            },
            1,
        )?;
        journal
            .active
            .write_all_at(b"{\"type\":\"output\",\"data\":\"partial", journal.bytes)?;
        let mut snapshot = journal.snapshot(0)?;
        assert_eq!(snapshot.next_record()?, Some(first));
        assert_eq!(snapshot.next_record()?, None);
        journal.append(RecordData::Exit { exit_code: 7 }, 2)?;
        let mut tail = journal.snapshot(1)?;
        assert!(matches!(
            tail.next_record()?.unwrap().data,
            RecordData::Exit { exit_code: 7 }
        ));
        assert_eq!(tail.next_record()?, None);
        Ok(())
    }

    #[test]
    fn interrupted_rotation_is_retryable_without_duplicate_checkpoints() -> Result<()> {
        let root = tempfile::tempdir()?;
        let mut journal = Journal::new(root.path(), 10 * SEGMENT_BYTES)?;
        journal.append(
            RecordData::Output {
                data: "x".repeat(SEGMENT_BYTES as usize),
            },
            1,
        )?;
        let replacement = root.path().join("journal-next.tmp");
        fs::write(&replacement, "uncommitted stale contents")?;
        let mut stale = File::open(&replacement)?;
        fs::create_dir(root.path().join("retired-1.jsonl"))?;
        assert!(journal
            .append(
                RecordData::Marker {
                    data: "next".into()
                },
                2
            )
            .is_err());
        assert_eq!(fs::read(&replacement)?, b"");
        let mut retained = String::new();
        stale.read_to_string(&mut retained)?;
        assert_eq!(retained, "uncommitted stale contents");
        let mut snapshot = journal.snapshot(0)?;
        assert_eq!(snapshot.fence, 1);
        assert_eq!(snapshot.next_record()?.unwrap().sequence, 1);
        assert_eq!(snapshot.next_record()?, None);
        fs::remove_dir(root.path().join("retired-1.jsonl"))?;
        journal.append(
            RecordData::Marker {
                data: "next".into(),
            },
            2,
        )?;
        let mut recovered = journal.snapshot(0)?;
        assert_eq!(recovered.fence, 2);
        assert_eq!(recovered.next_record()?.unwrap().sequence, 1);
        assert_eq!(recovered.next_record()?.unwrap().sequence, 2);
        assert_eq!(recovered.next_record()?, None);
        Ok(())
    }

    #[test]
    fn checkpoint_end_is_validated_before_publishing_its_final_record() -> Result<()> {
        let root = tempfile::tempdir()?;
        let mut journal = Journal::new(root.path(), 100000)?;
        let record = journal.append(
            RecordData::Output {
                data: "x".repeat(64000),
            },
            1,
        )?;
        journal.compact()?;
        let checkpoint = &journal.checkpoints[0].0;
        let original = fs::read(checkpoint)?;
        let mut valid = journal.snapshot(0)?;
        assert_eq!(valid.next_record()?, Some(record.clone()));
        assert_eq!(valid.next_record()?, None);
        for truncate in [false, true] {
            let mut broken = original.clone();
            if truncate {
                broken.truncate(broken.len() - 4);
            } else {
                let crc = broken.len() - 8;
                broken[crc] ^= 1;
            }
            fs::write(checkpoint, broken)?;
            assert!(journal.snapshot(0)?.next_record().is_err());
        }
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut encoded = serde_json::to_vec(&record)?;
        encoded.push(b'\n');
        encoder.write_all(&encoded)?;
        let mut extra_member = original.clone();
        extra_member.extend(encoder.finish()?);
        fs::write(checkpoint, extra_member)?;
        assert!(journal.snapshot(0)?.next_record().is_err());
        fs::write(checkpoint, &original[..original.len() / 2])?;
        assert!(journal.snapshot(0)?.next_record().is_err());
        Ok(())
    }
}
