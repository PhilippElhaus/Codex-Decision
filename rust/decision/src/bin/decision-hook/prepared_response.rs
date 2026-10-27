//! Reuse validated projections within one invocation, including provider fallback.
use super::*;
use std::borrow::Cow;
use std::cell::{OnceCell, RefCell};
use std::rc::Rc;

pub(super) struct PreparedResponse<'a> {
    event: &'a Value,
    projections: ProjectionCache<'a>,
    source: OnceCell<Option<Cow<'a, str>>>,
}

impl<'a> PreparedResponse<'a> {
    pub(super) fn new(event: &'a Value) -> Self {
        Self {
            event,
            projections: ProjectionCache::new(&event["tool_response"]),
            source: OnceCell::new(),
        }
    }

    pub(super) fn source(&self) -> Option<&str> {
        self.source
            .get_or_init(|| project_response(self.event, &self.projections))
            .as_deref()
    }

    #[cfg(test)]
    pub(super) fn into_source(self) -> Option<Cow<'a, str>> {
        self.source();
        self.source.into_inner().flatten()
    }

    pub(super) fn protect(&self, lines: &mut [SourceLine]) {
        protect_cached_command_boundaries(self.event, &self.projections, lines);
        protect_cached_lab_streams(self.event, &self.projections, lines);
    }

    pub(super) fn replacement_supported(&self) -> bool {
        supports_replacement(self.event, &self.projections)
    }

    pub(super) fn supported_lab_command(&self) -> bool {
        supported_lab_view(self.event, || self.projections.direct.lab())
    }
}

pub(super) struct ProjectionCache<'a> {
    pub(super) direct: Envelope<'a>,
    serialized: RefCell<BTreeMap<&'a str, Rc<Envelope<'a>>>>,
}

impl<'a> ProjectionCache<'a> {
    pub(super) fn new(body: &'a Value) -> Self {
        Self {
            direct: Envelope::new(Some(Cow::Borrowed(body)), false),
            serialized: RefCell::new(BTreeMap::new()),
        }
    }

    pub(super) fn serialized(&self, text: &'a str) -> Rc<Envelope<'a>> {
        self.serialized
            .borrow_mut()
            .entry(text)
            .or_insert_with(|| {
                let (value, data_error) = match strict_json::parse(text.as_bytes()) {
                    Ok(value) => (Some(Cow::Owned(value)), false),
                    Err(error) => (None, error.is_data()),
                };
                Rc::new(Envelope::new(value, data_error))
            })
            .clone()
    }

    pub(super) fn preview(&self, text: &'a str) -> Cow<'a, str> {
        let envelope = self.serialized(text);
        match envelope.projection() {
            Some(source) => Cow::Owned(source.into()),
            None => Cow::Borrowed(text),
        }
    }
}

pub(super) struct Envelope<'a> {
    value: Option<Cow<'a, Value>>,
    data_error: bool,
    decoded: OnceCell<Option<Value>>,
    command: OnceCell<Option<CommandView>>,
    lab: OnceCell<Option<lab_result::LabView>>,
}

impl<'a> Envelope<'a> {
    fn new(value: Option<Cow<'a, Value>>, data_error: bool) -> Self {
        Self {
            value,
            data_error,
            decoded: OnceCell::new(),
            command: OnceCell::new(),
            lab: OnceCell::new(),
        }
    }

    pub(super) fn command(&self) -> Option<&CommandView> {
        self.command
            .get_or_init(|| {
                self.value
                    .as_deref()
                    .and_then(|value| command_view_preparsed(value, self.decoded().as_ref()))
            })
            .as_ref()
    }

    pub(super) fn lab(&self) -> Option<&lab_result::LabView> {
        self.lab
            .get_or_init(|| {
                self.value.as_deref().and_then(|value| {
                    lab_result::lab_view_preparsed(value, self.decoded().as_ref())
                })
            })
            .as_ref()
    }

    fn decoded(&self) -> &Option<Value> {
        self.decoded
            .get_or_init(|| self.value.as_deref().and_then(decode_envelope))
    }

    pub(super) fn projection(&self) -> Option<&str> {
        self.command()
            .map(|view| view.source.as_str())
            .or_else(|| self.lab().map(|view| view.source.as_str()))
    }

    pub(super) fn supports_text_replacement(&self) -> bool {
        if self.value.is_some() {
            self.projection().is_some()
        } else {
            !self.data_error
        }
    }
}

pub(super) fn decode_envelope(body: &Value) -> Option<Value> {
    let content = body.get("content")?.as_array()?;
    if content.len() != 1 || content[0]["type"] != "text" {
        return None;
    }
    let text = content[0]["text"].as_str()?;
    (text.len() <= 4_000_000)
        .then(|| strict_json::parse(text.as_bytes()).ok())
        .flatten()
}

#[cfg(test)]
#[path = "prepared_response_tests.rs"]
mod tests;
