//! Borrow command metadata and preserve the exact readable output projection.
use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use serde_json::{Map, Value};

struct Metadata<'a>(&'a Map<String, Value>);

impl Serialize for Metadata<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut metadata = serializer.serialize_map(Some(self.0.len().saturating_sub(1)))?;
        for (name, value) in self.0 {
            if name != "output" {
                metadata.serialize_entry(name, value)?;
            }
        }
        metadata.end()
    }
}

pub(crate) fn command_projection(object: &Map<String, Value>) -> String {
    const PREFIX: &str = "Command result metadata: ";
    let output = object["output"].as_str().expect("validated command output");
    let mut text = serde_json::to_string(&Metadata(object)).expect("command metadata encoding");
    text.reserve_exact(output.len() + PREFIX.len() + 1);
    text.insert_str(0, PREFIX);
    text.push('\n');
    text.push_str(output);
    text
}

#[cfg(test)]
#[path = "projection_tests.rs"]
pub(crate) mod tests;
