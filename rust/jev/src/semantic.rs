//! Classification followed by relevance batches bounded by Jev's context limits.
use crate::{Action, Batch, LineDecision, SourceLine};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const KINDS: [&str; 8] = [
    "repetitive_log",
    "progress_output",
    "independent_matches",
    "independent_records",
    "exact_content",
    "prose",
    "structured_payload",
    "mixed_or_unknown",
];

mod budget;
mod classification;
mod packing;
mod relevance;
pub use budget::{
    request_budget, validate_request_budget, RequestBudget, JEV_REQUEST_TOKENS,
    JEV_STATE_QUESTION_TOKENS, TOKEN_HEADROOM,
};
use classification::probability;
pub use classification::{classification, classification_request, validate_response};
pub use packing::relevance_requests;
pub use relevance::{apply_relevance, apply_relevance_batches, relevance_answers};
