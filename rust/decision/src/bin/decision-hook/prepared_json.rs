//! Encode bulk data before locking and insert only its publication timestamp.
use super::*;
use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use std::cell::Cell;

#[derive(Default)]
pub(super) struct TimestampMarker {
    pub(super) offset: Cell<usize>,
    range: Cell<Option<(usize, usize)>>,
}

pub(super) struct TimestampField<'a>(pub(super) &'a TimestampMarker);

impl Serialize for TimestampField<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let start = self.0.offset.get();
        let result = serializer.serialize_str("")?;
        self.0.range.set(Some((start, self.0.offset.get())));
        Ok(result)
    }
}

pub(super) struct TimestampMap<'a> {
    object: &'a serde_json::Map<String, Value>,
    marker: &'a TimestampMarker,
}

impl<'a> TimestampMap<'a> {
    pub(super) fn new(value: &'a Value, marker: &'a TimestampMarker) -> Result<Self, String> {
        let object = value.as_object().ok_or("invalid record timestamp map")?;
        if !object.get("at").is_some_and(Value::is_string) {
            return Err("missing record timestamp".into());
        }
        Ok(Self { object, marker })
    }
}

impl Serialize for TimestampMap<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut object = serializer.serialize_map(Some(self.object.len()))?;
        for (name, value) in self.object {
            if name == "at" {
                object.serialize_entry(name, &TimestampField(self.marker))?;
            } else {
                object.serialize_entry(name, value)?;
            }
        }
        object.end()
    }
}

pub(super) struct PreparedJson {
    bytes: Vec<u8>,
    range: (usize, usize),
    limit: usize,
    oversized: &'static str,
}

impl PreparedJson {
    pub(super) fn new(
        mut bytes: Vec<u8>,
        marker: &TimestampMarker,
        limit: usize,
        oversized: &'static str,
    ) -> Result<Self, String> {
        let range = marker.range.get().ok_or("missing record timestamp")?;
        if bytes.get(range.0..range.1) != Some(b"\"\"".as_slice()) {
            return Err("invalid record timestamp range".into());
        }
        // UTC timestamps need less than 64 extra bytes. Reserve before locking.
        bytes.reserve_exact(64.min(limit.saturating_sub(bytes.len())));
        Ok(Self {
            bytes,
            range,
            limit,
            oversized,
        })
    }

    // Consuming preparation prevents publishing an unstamped or reused buffer.
    pub(super) fn finish(mut self, timestamp: &str) -> Result<Vec<u8>, String> {
        let encoded = serde_json::to_vec(timestamp).map_err(|_| "timestamp encoding")?;
        if self
            .bytes
            .len()
            .saturating_sub(self.range.1 - self.range.0)
            .saturating_add(encoded.len())
            > self.limit
        {
            return Err(self.oversized.into());
        }
        self.bytes.splice(self.range.0..self.range.1, encoded);
        Ok(self.bytes)
    }
}

#[cfg(test)]
pub(super) fn prepare_snapshot(value: &Value) -> Result<PreparedJson, String> {
    let marker = TimestampMarker::default();
    let value = TimestampMap::new(value, &marker)?;
    let bytes = super::encoding::encode_marked(
        &value,
        PANEL_SNAPSHOT_MAX_BYTES,
        "snapshot encoding",
        "panel snapshot too large",
        &marker.offset,
    )?;
    PreparedJson::new(
        bytes,
        &marker,
        PANEL_SNAPSHOT_MAX_BYTES,
        "panel snapshot too large",
    )
}

#[cfg(test)]
#[path = "prepared_json_tests.rs"]
mod tests;
