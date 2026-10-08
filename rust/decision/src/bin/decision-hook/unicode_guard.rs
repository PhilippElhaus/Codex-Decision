//! Decode only JSON Unicode codepoints in temporary credential-guard text.
use super::source_marker_sensitive_path;
use std::borrow::Cow;

pub(super) fn sensitive_escapes(text: &str, depth: usize, budget: &mut usize, path: bool) -> bool {
    if !text.contains("\\u") {
        return false;
    }
    let mut current = Cow::Borrowed(text);
    for _ in depth..8 {
        let Some(decoded) = decode(&current) else {
            return false;
        };
        if decoded.len() > *budget {
            return true;
        }
        *budget -= decoded.len();
        if source_marker_sensitive_path(&decoded, path) {
            return true;
        }
        current = Cow::Owned(decoded);
    }
    // Further encoded interpretation exceeds the same bounded privacy budget.
    decode(&current).is_some()
}

fn decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut output: Option<String> = None;
    let mut copied = 0;
    let mut index = 0;
    while index < bytes.len() {
        let Some(first) = unit(bytes, index) else {
            index += 1;
            continue;
        };
        let (point, consumed) = if (0xd800..=0xdbff).contains(&first) {
            let Some(second) = unit(bytes, index + 6).filter(|low| (0xdc00..=0xdfff).contains(low))
            else {
                index += 6;
                continue;
            };
            (
                0x10000 + ((u32::from(first) - 0xd800) << 10) + u32::from(second) - 0xdc00,
                12,
            )
        } else {
            (u32::from(first), 6)
        };
        let Some(character) = char::from_u32(point) else {
            index += consumed;
            continue;
        };
        let output = output.get_or_insert_with(|| String::with_capacity(text.len()));
        output.push_str(&text[copied..index]);
        output.push(character);
        index += consumed;
        copied = index;
    }
    output.map(|mut output| {
        output.push_str(&text[copied..]);
        output
    })
}

fn unit(bytes: &[u8], index: usize) -> Option<u16> {
    let escape = bytes.get(index..index.checked_add(6)?)?;
    if escape[..2] != *b"\\u" {
        return None;
    }
    escape[2..].iter().try_fold(0, |value, byte| {
        let digit = match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            b'A'..=b'F' => byte - b'A' + 10,
            _ => return None,
        };
        Some(value * 16 + u16::from(digit))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_decoding_matches_json_codepoints_and_preserves_other_escape_bytes() {
        for encoded in [
            r"\u005f",
            r"\u0041\u0062",
            r"\ud83d\ude00",
            r"\ud800\udc00",
            r"\udbff\udfff",
            r"\u0000",
            r"\u005c",
        ] {
            let json = format!("\"{encoded}\"");
            let expected: String = serde_json::from_str(&json).unwrap();
            assert_eq!(decode(encoded).unwrap(), expected);
        }
        assert_eq!(decode(r"\n\t\u0041\r\x42").unwrap(), r"\n\tA\r\x42");
        for encoded in [
            r"C:\users\safe.txt",
            r"\u005",
            r"\uZZZZ",
            r"\ud800",
            r"\udc00",
            "\\u🌍",
        ] {
            assert!(decode(encoded).is_none(), "{encoded}");
        }
        assert_eq!(decode(r"\ud800\u0041").unwrap(), r"\ud800A");
    }

    #[test]
    fn every_single_unicode_codepoint_agrees_with_the_json_decoder() {
        for point in 0..=u16::MAX {
            let encoded = format!("\\u{point:04x}");
            let json = format!("\"{encoded}\"");
            let expected: Option<String> = serde_json::from_str(&json).ok();
            assert_eq!(decode(&encoded), expected, "{encoded}");
        }
    }

    #[test]
    fn unicode_guard_is_bounded_and_never_mutates_source() {
        let source = r"INFO API\u005fKEY=synthetic-sentinel";
        let original = source.to_owned();
        assert!(sensitive_escapes(source, 0, &mut 16_000_000, false));
        assert_eq!(source, original);
        assert!(sensitive_escapes(r"INFO safe \u0041", 0, &mut 1, false));
        assert!(!sensitive_escapes(
            r"INFO safe \ud83d\ude00",
            0,
            &mut 16_000_000,
            false
        ));
        assert!(sensitive_escapes(
            r"INFO \u005cu005cu005cu005cu005cu005cu005cu005cu0041",
            0,
            &mut 16_000_000,
            false
        ));
    }
}
