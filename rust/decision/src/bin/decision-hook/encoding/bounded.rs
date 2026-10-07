//! Bounded serialization buffers and optional timestamp byte positions.
use serde::Serialize;
use std::cell::Cell;
use std::io::Write;
pub(super) struct BoundedRecord<'a> {
    pub(super) bytes: Vec<u8>,
    pub(super) limit: usize,
    pub(super) overflow: bool,
    pub(super) offset: Option<&'a Cell<usize>>,
}

impl Write for BoundedRecord<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            self.overflow = true;
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "record size bound",
            ));
        }
        let required = self.bytes.len() + bytes.len();
        if required > self.bytes.capacity() {
            let capacity = self
                .bytes
                .capacity()
                .saturating_mul(2)
                .max(required)
                .min(self.limit);
            self.bytes.reserve_exact(capacity - self.bytes.len());
        }
        self.bytes.extend_from_slice(bytes);
        if let Some(offset) = self.offset {
            offset.set(self.bytes.len());
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub(crate) fn encode<T: Serialize>(
    value: &T,
    limit: usize,
    encoding: &str,
    oversized: &str,
) -> Result<Vec<u8>, String> {
    encode_with_offset(value, limit, encoding, oversized, None, 128)
}

#[cfg(test)]
pub(crate) fn encode_marked<T: Serialize>(
    value: &T,
    limit: usize,
    encoding: &str,
    oversized: &str,
    offset: &Cell<usize>,
) -> Result<Vec<u8>, String> {
    encode_marked_with_capacity(value, limit, encoding, oversized, offset, 128)
}

pub(crate) fn encode_marked_with_capacity<T: Serialize>(
    value: &T,
    limit: usize,
    encoding: &str,
    oversized: &str,
    offset: &Cell<usize>,
    capacity: usize,
) -> Result<Vec<u8>, String> {
    encode_with_offset(value, limit, encoding, oversized, Some(offset), capacity)
}

fn encode_with_offset<T: Serialize>(
    value: &T,
    limit: usize,
    encoding: &str,
    oversized: &str,
    offset: Option<&Cell<usize>>,
    capacity: usize,
) -> Result<Vec<u8>, String> {
    let mut writer = BoundedRecord {
        bytes: Vec::with_capacity(capacity.min(limit)),
        limit,
        overflow: false,
        offset,
    };
    if serde_json::to_writer(&mut writer, value).is_err() {
        return Err(if writer.overflow { oversized } else { encoding }.into());
    }
    Ok(writer.bytes)
}
