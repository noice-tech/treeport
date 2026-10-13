use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;
// The startup envelope can contain both launch arguments/environment and an
// independently updated metadata string. It is not a socket frame.
pub const MAX_MANIFEST_BYTES: usize = 2 * MAX_FRAME_BYTES;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

// Invalid commands cannot become retryable storage faults: increasing quota or
// repairing disk space can never make an over-budget encoded record fit.
#[derive(Debug)]
pub struct FrameLimitExceeded;
impl std::fmt::Display for FrameLimitExceeded {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Session frame exceeds the frame limit")
    }
}
impl std::error::Error for FrameLimitExceeded {}

struct FrameBuffer<const LIMIT: usize>(Vec<u8>);
impl<const LIMIT: usize> std::io::Write for FrameBuffer<LIMIT> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        // Refuse the next fragment before copying it, rather than allocating
        // an oversized encoded value first. JSONL callers reserve the delimiter.
        let next = self.0.len().saturating_add(bytes.len());
        if next > LIMIT {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Session frame exceeds the frame limit",
            ));
        }
        if next > self.0.capacity() {
            let capacity = next.max(self.0.capacity().saturating_mul(2)).min(LIMIT);
            self.0.reserve_exact(capacity - self.0.len());
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
// Shared socket/journal encoding: no bytes are published until the complete
// line, including escaped strings and its delimiter, fits the v1 frame budget.
pub fn encode_jsonl(value: &impl serde::Serialize) -> Result<Vec<u8>> {
    let mut buffer = FrameBuffer::<{ MAX_FRAME_BYTES - 1 }>(Vec::new());
    if let Err(error) = serde_json::to_writer(&mut buffer, value) {
        if error.io_error_kind() == Some(std::io::ErrorKind::InvalidData) {
            return Err(FrameLimitExceeded.into());
        }
        return Err(error.into());
    }
    // Do not let Vec's final push double a near-limit raw-value buffer.
    if buffer.0.len() == buffer.0.capacity() {
        buffer.0.reserve_exact(1);
    }
    buffer.0.push(b'\n');
    Ok(buffer.0)
}

// Discovery writes must remain readable by the bounded startup reader. Encode
// before opening/truncating a temporary file, including opaque string escaping.
pub fn encode_metadata_json(value: &impl serde::Serialize) -> Result<Vec<u8>> {
    let mut buffer = FrameBuffer::<MAX_MANIFEST_BYTES>(Vec::new());
    if let Err(error) = serde_json::to_writer(&mut buffer, value) {
        if error.io_error_kind() == Some(std::io::ErrorKind::InvalidData) {
            bail!("Session storage metadata exceeds the byte limit");
        }
        return Err(error.into());
    }
    Ok(buffer.0)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: u32,
    pub token: String,
    pub socket_path: String,
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: BTreeMap<String, String>,
    pub cols: u32,
    pub rows: u32,
    pub metadata: OpaqueString,
    pub journal_limit_bytes: u64,
}
impl Manifest {
    pub fn read(reader: impl std::io::Read) -> Result<Self> {
        use std::io::BufReader;
        // Bound the descriptor read too: a regular file can grow after stat.
        // Buffer only a small window, not an entire encoded manifest copy.
        let mut reader = BufReader::new(reader.take((MAX_MANIFEST_BYTES + 1) as u64));
        let parsed = serde_json::from_reader::<_, Self>(&mut reader);
        if reader.get_ref().limit() == 0 {
            bail!("Session manifest exceeds the byte limit");
        }
        let manifest = parsed?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn validate(&self) -> Result<()> {
        if self.version != 1
            || self.token.chars().map(char::len_utf16).sum::<usize>() < 32
            || self.socket_path.is_empty()
            || self.argv.is_empty()
            || self.cols == 0
            || self.rows == 0
            || !(1..=MAX_SAFE_INTEGER).contains(&self.journal_limit_bytes)
        {
            bail!("Invalid session manifest");
        }
        // Native PTYs use unsigned 16-bit winsize fields. Refuse truncation.
        if self.cols > u16::MAX as u32 || self.rows > u16::MAX as u32 {
            bail!("Session dimensions exceed the native PTY limit");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub version: u32,
    pub owner_pid: u32,
    pub pid: u32,
    pub process: String,
    pub cols: u32,
    pub rows: u32,
    pub sequence: u64,
    pub processed_sequence: u64,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
    pub incomplete: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum RecordData {
    Output {
        data: String,
    },
    Resize {
        cols: u32,
        rows: u32,
    },
    Marker {
        data: OpaqueString,
    },
    Exit {
        #[serde(rename = "exitCode")]
        exit_code: i32,
    },
}
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Record {
    pub at: u64,
    pub sequence: u64,
    #[serde(flatten)]
    pub data: RecordData,
}
impl<'de> Deserialize<'de> for Record {
    fn deserialize<D: serde::Deserializer<'de>>(decoder: D) -> std::result::Result<Self, D::Error> {
        use serde::de::Error;
        // serde's flattened/tagged enum decoder buffers fields as scalar
        // strings before our byte visitor, losing lone UTF-16 surrogates.
        // Decode the stable wire fields directly, then select the record kind.
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Fields {
            at: u64,
            sequence: u64,
            #[serde(rename = "type")]
            kind: String,
            data: Option<Box<serde_json::value::RawValue>>,
            cols: Option<Box<serde_json::value::RawValue>>,
            rows: Option<Box<serde_json::value::RawValue>>,
            exit_code: Option<Box<serde_json::value::RawValue>>,
        }
        let fields = Fields::deserialize(decoder)?;
        let data = match fields.kind.as_str() {
            "output" => RecordData::Output {
                data: serde_json::from_str(
                    fields
                        .data
                        .ok_or_else(|| D::Error::missing_field("data"))?
                        .get(),
                )
                .map_err(D::Error::custom)?,
            },
            "marker" => RecordData::Marker {
                data: serde_json::from_str(
                    fields
                        .data
                        .ok_or_else(|| D::Error::missing_field("data"))?
                        .get(),
                )
                .map_err(D::Error::custom)?,
            },
            "resize" => RecordData::Resize {
                cols: serde_json::from_str(
                    fields
                        .cols
                        .ok_or_else(|| D::Error::missing_field("cols"))?
                        .get(),
                )
                .map_err(D::Error::custom)?,
                rows: serde_json::from_str(
                    fields
                        .rows
                        .ok_or_else(|| D::Error::missing_field("rows"))?
                        .get(),
                )
                .map_err(D::Error::custom)?,
            },
            "exit" => RecordData::Exit {
                exit_code: serde_json::from_str(
                    fields
                        .exit_code
                        .ok_or_else(|| D::Error::missing_field("exitCode"))?
                        .get(),
                )
                .map_err(D::Error::custom)?,
            },
            _ => return Err(D::Error::custom("Invalid session record type")),
        };
        Ok(Self {
            at: fields.at,
            sequence: fields.sequence,
            data,
        })
    }
}
impl Record {
    pub fn validate(&self) -> Result<()> {
        if !(1..=MAX_SAFE_INTEGER).contains(&self.sequence) || self.at > MAX_SAFE_INTEGER {
            bail!("Invalid journal sequence or timestamp");
        }
        if let RecordData::Resize { cols, rows } = self.data {
            if cols == 0 || rows == 0 {
                bail!("Invalid journal dimensions");
            }
        }
        Ok(())
    }
}

// IDs are opaque JavaScript strings, not terminal text. Retain their validated
// JSON literal so lone UTF-16 surrogates round-trip without lossy replacement.
#[derive(Debug, Serialize)]
#[serde(transparent)]
pub struct RequestId(Box<serde_json::value::RawValue>);

#[derive(Debug)]
pub struct Request {
    pub id: RequestId,
    pub command: Command,
}
// JavaScript input is UTF-16, not necessarily a Unicode scalar string. Keep
// code units until the requested Buffer encoding is applied at input admission.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteData(Vec<u16>);
impl<'de> Deserialize<'de> for WriteData {
    fn deserialize<D: serde::Deserializer<'de>>(decoder: D) -> std::result::Result<Self, D::Error> {
        struct Input;
        impl serde::de::Visitor<'_> for Input {
            type Value = WriteData;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a JavaScript input string")
            }
            fn visit_str<E: serde::de::Error>(
                self,
                value: &str,
            ) -> std::result::Result<Self::Value, E> {
                self.visit_bytes(value.as_bytes())
            }
            fn visit_bytes<E: serde::de::Error>(
                self,
                mut bytes: &[u8],
            ) -> std::result::Result<Self::Value, E> {
                let mut units = Vec::new();
                loop {
                    match std::str::from_utf8(bytes) {
                        Ok(text) => {
                            units.extend(text.encode_utf16());
                            break;
                        }
                        Err(error) => {
                            let prefix = error.valid_up_to();
                            let text = std::str::from_utf8(&bytes[..prefix]).map_err(E::custom)?;
                            units.extend(text.encode_utf16());
                            bytes = &bytes[prefix..];
                            // serde_json's byte visitor decodes \u escapes into
                            // WTF-8, preserving lone surrogate code units. Only
                            // those three-byte sequences extend normal UTF-8;
                            // malformed literal byte strings are still refused.
                            if bytes.len() < 3
                                || bytes[0] != 0xed
                                || !(0xa0..=0xbf).contains(&bytes[1])
                                || !(0x80..=0xbf).contains(&bytes[2])
                            {
                                return Err(E::custom("Invalid JavaScript input encoding"));
                            }
                            units.push(
                                ((bytes[0] as u16 & 0x0f) << 12)
                                    | ((bytes[1] as u16 & 0x3f) << 6)
                                    | (bytes[2] as u16 & 0x3f),
                            );
                            bytes = &bytes[3..];
                        }
                    }
                }
                Ok(WriteData(units))
            }
        }
        // No sequence visitor: a JSON array of byte values is not a v1 string.
        decoder.deserialize_bytes(Input)
    }
}
impl WriteData {
    pub fn into_bytes(self, encoding: Encoding) -> Result<Vec<u8>> {
        match encoding {
            // Buffer.from(str, 'utf8') replaces each unpaired code unit once.
            Encoding::Utf8 => Ok(String::from_utf16_lossy(&self.0).into_bytes()),
            // Node truncates UTF-16 code units to their low byte before base64
            // alphabet filtering, including surrogate units and non-ASCII BMP.
            Encoding::Base64 => decode_base64(self.0.into_iter().map(|unit| unit as u8)),
        }
    }
}

// Markers and metadata belong to TypeScript. Unlike terminal text, replacing
// unpaired code units would silently change engine-owned recovery state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpaqueString(Vec<u16>);
impl<'de> Deserialize<'de> for OpaqueString {
    fn deserialize<D: serde::Deserializer<'de>>(decoder: D) -> std::result::Result<Self, D::Error> {
        WriteData::deserialize(decoder).map(|data| Self(data.0))
    }
}
impl From<&str> for OpaqueString {
    fn from(value: &str) -> Self {
        Self(value.encode_utf16().collect())
    }
}
impl From<String> for OpaqueString {
    fn from(value: String) -> Self {
        Self::from(value.as_str())
    }
}
impl Serialize for OpaqueString {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::Error;
        use serde_json::ser::{CharEscape, CompactFormatter, Formatter};
        use std::io::Write;
        // A validated string never expands beyond its source JSON literal.
        // Bound even internal serialization so admission cannot allocate an
        // unbounded second encoded copy; manifests have the larger envelope.
        let mut buffer = FrameBuffer::<MAX_MANIFEST_BYTES>(Vec::new());
        let mut formatter = CompactFormatter;
        let encoded = (|| -> std::io::Result<()> {
            formatter.begin_string(&mut buffer)?;
            for decoded in char::decode_utf16(self.0.iter().copied()) {
                match decoded {
                    Err(surrogate) => {
                        write!(&mut buffer, "\\u{:04x}", surrogate.unpaired_surrogate())?
                    }
                    Ok(character) => {
                        let escape = match character {
                            '"' => Some(CharEscape::Quote),
                            '\\' => Some(CharEscape::ReverseSolidus),
                            '\u{8}' => Some(CharEscape::Backspace),
                            '\u{c}' => Some(CharEscape::FormFeed),
                            '\n' => Some(CharEscape::LineFeed),
                            '\r' => Some(CharEscape::CarriageReturn),
                            '\t' => Some(CharEscape::Tab),
                            '\0'..='\u{1f}' => Some(CharEscape::AsciiControl(character as u8)),
                            _ => None,
                        };
                        if let Some(escape) = escape {
                            formatter.write_char_escape(&mut buffer, escape)?;
                        } else {
                            let mut bytes = [0; 4];
                            formatter.write_string_fragment(
                                &mut buffer,
                                character.encode_utf8(&mut bytes),
                            )?;
                        }
                    }
                }
            }
            formatter.end_string(&mut buffer)
        })();
        encoded.map_err(S::Error::custom)?;
        let literal = String::from_utf8(buffer.0).map_err(S::Error::custom)?;
        serde_json::value::RawValue::from_string(literal)
            .map_err(S::Error::custom)?
            .serialize(serializer)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "method", rename_all = "lowercase")]
pub enum Command {
    Attach {
        token: String,
        #[serde(rename = "journalLimitBytes")]
        journal_limit_bytes: Option<u64>,
    },
    Inspect {
        token: String,
    },
    Write {
        data: WriteData,
        encoding: Encoding,
    },
    Resize {
        cols: u32,
        rows: u32,
    },
    Signal {
        signal: Signal,
    },
    Pause {
        paused: bool,
    },
    Status,
    Terminate {
        token: Option<String>,
    },
    Processed {
        sequence: u64,
    },
    Marker {
        data: OpaqueString,
    },
    Metadata {
        metadata: OpaqueString,
    },
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Encoding {
    Utf8,
    Base64,
}
#[derive(Debug, Clone, Deserialize)]
pub enum Signal {
    SIGINT,
    SIGTERM,
    SIGKILL,
    SIGHUP,
}
impl Signal {
    pub fn number(&self) -> i32 {
        match self {
            Self::SIGINT => libc::SIGINT,
            Self::SIGTERM => libc::SIGTERM,
            Self::SIGKILL => libc::SIGKILL,
            Self::SIGHUP => libc::SIGHUP,
        }
    }
}
impl Request {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_FRAME_BYTES {
            bail!("Session request exceeds the frame limit");
        }
        use serde::{
            de::{MapAccess, Visitor},
            Deserializer,
        };
        use serde_json::value::RawValue;
        struct Fields;
        impl<'de> Visitor<'de> for Fields {
            type Value = BTreeMap<String, &'de RawValue>;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a session request object")
            }
            fn visit_map<M: MapAccess<'de>>(
                self,
                mut map: M,
            ) -> std::result::Result<Self::Value, M::Error> {
                let mut fields = BTreeMap::new();
                while let Some(key) = map.next_key::<&RawValue>()? {
                    // RawValue validates JSON grammar without decoding Unicode
                    // code units or overflowing unused numbers. Borrow slices
                    // from the bounded input; do not allocate unknown subtrees.
                    let value = map.next_value::<&RawValue>()?;
                    if let Ok(key) = serde_json::from_str::<String>(key.get()) {
                        if matches!(
                            key.as_str(),
                            "id" | "method"
                                | "token"
                                | "journalLimitBytes"
                                | "cols"
                                | "rows"
                                | "data"
                                | "encoding"
                                | "signal"
                                | "paused"
                                | "sequence"
                                | "metadata"
                        ) {
                            // Like JSON.parse: the last duplicate property wins.
                            fields.insert(key, value);
                        }
                    }
                }
                Ok(fields)
            }
        }
        let mut decoder = serde_json::Deserializer::from_slice(bytes);
        let mut fields = decoder.deserialize_map(Fields)?;
        decoder.end()?;
        let id = fields
            .remove("id")
            .ok_or_else(|| anyhow::anyhow!("Missing session request ID"))?;
        if !id.get().starts_with('"') {
            bail!("Invalid session request ID");
        }
        let id = RequestId(id.to_owned());
        let method = fields
            .get("method")
            .and_then(|value| serde_json::from_str::<String>(value.get()).ok())
            .unwrap_or_default();
        if method == "write" {
            // Decode input directly from its validated raw field: Value/String
            // would reject lone surrogates before the byte visitor sees them.
            let data = fields
                .get("data")
                .ok_or_else(|| anyhow::anyhow!("Missing input data"))?;
            let encoding = fields
                .get("encoding")
                .ok_or_else(|| anyhow::anyhow!("Missing input encoding"))?;
            return Ok(Self {
                id,
                command: Command::Write {
                    data: serde_json::from_str(data.get())?,
                    encoding: serde_json::from_str(encoding.get())?,
                },
            });
        }
        if method == "marker" || method == "metadata" {
            let key = if method == "marker" {
                "data"
            } else {
                "metadata"
            };
            let literal = fields
                .get(key)
                .ok_or_else(|| anyhow::anyhow!("Missing opaque session string {key}"))?;
            let value = serde_json::from_str::<OpaqueString>(literal.get())?;
            return Ok(Self {
                id,
                command: if method == "marker" {
                    Command::Marker { data: value }
                } else {
                    Command::Metadata { metadata: value }
                },
            });
        }
        // Zod strips extensions, including known names unused by this method.
        // Do not reject a legal request just because unused values contain lone
        // surrogates, deeply nested data, or numbers outside Rust's f64 range.
        let allowed: &[&str] = match method.as_str() {
            "attach" => &["token", "journalLimitBytes"],
            "inspect" | "terminate" => &["token"],
            "write" => &["data", "encoding"],
            "resize" => &["cols", "rows"],
            "signal" => &["signal"],
            "pause" => &["paused"],
            "processed" => &["sequence"],
            "marker" => &["data"],
            "metadata" => &["metadata"],
            _ => &[],
        };
        let mut object = serde_json::Map::new();
        for (key, value) in fields {
            if key == "method" || allowed.contains(&key.as_str()) {
                object.insert(key, serde_json::from_str::<serde_json::Value>(value.get())?);
            }
        }
        // JSON.parse/Zod accept integral JSON numbers written as 1.0 or 1e2.
        // Preserve that v1 contract while rejecting null optional properties
        // (serde's Option alone would wrongly accept explicit null).
        let numbers: &[&str] = match method.as_str() {
            "resize" => &["cols", "rows"],
            "processed" => &["sequence"],
            "attach" => &["journalLimitBytes"],
            _ => &[],
        };
        for key in numbers {
            if let Some(number) = object.get_mut(*key) {
                let parsed = number
                    .as_f64()
                    .filter(|number| {
                        number.is_finite()
                            && number.fract() == 0.0
                            && *number >= 0.0
                            && *number <= MAX_SAFE_INTEGER as f64
                    })
                    .ok_or_else(|| anyhow::anyhow!("Invalid request integer {key}"))?;
                *number = serde_json::json!(parsed as u64);
            }
        }
        if method == "terminate" && object.get("token").is_some_and(|token| token.is_null()) {
            bail!("Invalid termination token");
        }
        let request = Self {
            id,
            command: serde_json::from_value(serde_json::Value::Object(object))?,
        };
        match &request.command {
            Command::Resize { cols, rows }
                if !(1..=10000).contains(cols) || !(1..=10000).contains(rows) =>
            {
                bail!("Invalid session dimensions");
            }
            Command::Processed { sequence } if *sequence > MAX_SAFE_INTEGER => {
                bail!("Invalid engine processing fence");
            }
            Command::Attach {
                journal_limit_bytes: Some(limit),
                ..
            } if !(1..=MAX_SAFE_INTEGER).contains(limit) => {
                bail!("Invalid session journal quota");
            }
            _ => {}
        }
        Ok(request)
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Frame {
    Response {
        id: RequestId,
        status: Option<Status>,
        error: Option<String>,
    },
    Ready {
        sequence: u64,
    },
    Fault {
        message: String,
    },
}

// Buffer.from(data, 'base64') accepts URL-safe alphabets, omitted padding,
// ignored non-alphabet bytes, and a final single sextet. Keep v1 writes compatible.
pub fn decode_base64(data: impl IntoIterator<Item = u8>) -> Result<Vec<u8>> {
    use base64::{
        alphabet,
        engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
        Engine,
    };
    let mut bytes: Vec<u8> = data
        .into_iter()
        .take_while(|byte| *byte != b'=')
        .filter_map(|byte| match byte {
            b'-' => Some(b'+'),
            b'_' => Some(b'/'),
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' => Some(byte),
            _ => None,
        })
        .collect();
    if bytes.len() % 4 == 1 {
        bytes.pop();
    }
    let decoder = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    Ok(decoder.decode(bytes)?)
}

// Like Node's StringDecoder: incomplete codepoints survive read boundaries;
// invalid input is replaced without consuming a following valid byte.
#[derive(Default)]
pub struct Decoder {
    tail: Vec<u8>,
}
impl Decoder {
    pub fn push(&mut self, bytes: &[u8], eof: bool) -> String {
        self.tail.extend_from_slice(bytes);
        let mut output = String::new();
        let mut offset = 0;
        while offset < self.tail.len() {
            match std::str::from_utf8(&self.tail[offset..]) {
                Ok(text) => {
                    output.push_str(text);
                    offset = self.tail.len();
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    // valid_up_to is guaranteed to be a valid UTF-8 prefix.
                    output
                        .push_str(std::str::from_utf8(&self.tail[offset..offset + valid]).unwrap());
                    offset += valid;
                    if let Some(invalid) = error.error_len() {
                        output.push('\u{fffd}');
                        offset += invalid;
                    } else if eof {
                        output.push('\u{fffd}');
                        offset = self.tail.len();
                    } else {
                        break;
                    }
                }
            }
        }
        self.tail.drain(..offset);
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_reader_bounds_growing_input_and_accepts_the_exact_boundary() -> Result<()> {
        use std::io::{self, Cursor, Read};
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let manifest = serde_json::to_vec(&serde_json::json!({
            "version": 1, "token": "a".repeat(32), "socketPath": "/isolated/socket",
            "argv": ["true"], "cwd": "/isolated", "env": {}, "cols": 80,
            "rows": 24, "metadata": "{}", "journalLimitBytes": 1024
        }))?;
        struct Growing {
            prefix: Cursor<Vec<u8>>,
            count: Arc<AtomicUsize>,
            remaining: usize,
        }
        impl Read for Growing {
            fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
                let count = self.prefix.read(bytes)?;
                let count = if count == 0 {
                    let count = bytes.len().min(self.remaining);
                    bytes[..count].fill(b' ');
                    self.remaining -= count;
                    count
                } else {
                    count
                };
                self.count.fetch_add(count, Ordering::Relaxed);
                Ok(count)
            }
        }
        for size in [MAX_MANIFEST_BYTES, MAX_MANIFEST_BYTES + 1, usize::MAX] {
            let count = Arc::new(AtomicUsize::new(0));
            let input = Growing {
                remaining: size - manifest.len(),
                prefix: Cursor::new(manifest.clone()),
                count: count.clone(),
            };
            let result = Manifest::read(input);
            assert_eq!(
                count.load(Ordering::Relaxed),
                size.min(MAX_MANIFEST_BYTES + 1)
            );
            if size == MAX_MANIFEST_BYTES {
                assert_eq!(result?.metadata, OpaqueString::from("{}"));
            } else {
                assert!(result.unwrap_err().to_string().contains("byte limit"));
            }
        }
        // Parsing and validation remain mandatory even for a small file.
        for input in [b"{}".as_slice(), b"null", b"{}{}", b"{\"version\":"] {
            assert!(Manifest::read(input).is_err());
        }
        Ok(())
    }

    #[test]
    fn decodes_every_utf8_boundary_and_invalid_tail() {
        let bytes = "ASCII 🌲 café 日本\u{1b}[6n".as_bytes();
        for split in 0..=bytes.len() {
            let mut decoder = Decoder::default();
            let mut actual = decoder.push(&bytes[..split], false);
            actual.push_str(&decoder.push(&bytes[split..], true));
            assert_eq!(actual, std::str::from_utf8(bytes).unwrap());
        }
        let mut decoder = Decoder::default();
        assert_eq!(decoder.push(&[0xf0, 0x9f], false), "");
        assert_eq!(decoder.push(b"A\xffB\xe2", false), "\u{fffd}A\u{fffd}B");
        assert_eq!(decoder.push(&[], true), "\u{fffd}");
    }
}
