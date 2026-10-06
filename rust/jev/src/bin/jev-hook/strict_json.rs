//! Reject ambiguous objects instead of choosing their last duplicate field.
use serde::de::{Error, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Number, Value};

struct UniqueValue(Value);

impl<'de> Deserialize<'de> for UniqueValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(UniqueVisitor).map(Self)
    }
}

struct UniqueVisitor;

impl<'de> Visitor<'de> for UniqueVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("JSON with unique object fields")
    }

    fn visit_bool<E: Error>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E: Error>(self, value: i64) -> Result<Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_u64<E: Error>(self, value: u64) -> Result<Value, E> {
        Ok(Value::Number(value.into()))
    }

    fn visit_f64<E: Error>(self, value: f64) -> Result<Value, E> {
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| E::custom("invalid JSON number"))
    }

    fn visit_str<E: Error>(self, value: &str) -> Result<Value, E> {
        Ok(Value::String(value.into()))
    }

    fn visit_string<E: Error>(self, value: String) -> Result<Value, E> {
        Ok(Value::String(value))
    }

    fn visit_unit<E: Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Value, A::Error> {
        let mut result = Vec::new();
        while let Some(UniqueValue(value)) = sequence.next_element()? {
            result.push(value);
        }
        Ok(Value::Array(result))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut object: A) -> Result<Value, A::Error> {
        let mut result = Map::new();
        while let Some((key, UniqueValue(value))) = object.next_entry::<String, UniqueValue>()? {
            if result.insert(key, value).is_some() {
                return Err(A::Error::custom("duplicate JSON field"));
            }
        }
        Ok(Value::Object(result))
    }
}

pub(super) fn parse(bytes: &[u8]) -> Result<Value, serde_json::Error> {
    serde_json::from_slice::<UniqueValue>(bytes).map(|value| value.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_json_keeps_its_values_and_numeric_types() {
        let cases = [
            r#"{"model":"jev-1.13.0","answers":{"line_1":{"type":"noul","noul":0.05}}}"#,
            r#"[null,true,false,-12,0,18446744073709551615,1.25,-0.0,1e-10,"\ud83c\udf0d","\"\\\n"]"#,
        ];
        for source in cases {
            assert_eq!(
                parse(source.as_bytes()).unwrap(),
                serde_json::from_str::<Value>(source).unwrap()
            );
        }
    }

    #[test]
    fn duplicate_keys_are_rejected_at_every_object_depth() {
        for source in [
            r#"{"model":"other-model","model":"jev-1.13.0"}"#,
            r#"{"answers":{"line_1":{},"line_1":{}}}"#,
            r#"{"answers":{"line_1":{"type":"noul","noul":0.99,"noul":0.01}}}"#,
            r#"[{"probabilities":{"prose":0.99,"prose":0.01}}]"#,
            r#"{"noul":0.99,"\u006eoul":0.01}"#,
        ] {
            assert!(parse(source.as_bytes()).is_err());
        }
        for source in ["{} {}", "[1,]", "{broken", "1e999"] {
            assert!(parse(source.as_bytes()).is_err());
        }
    }
}
