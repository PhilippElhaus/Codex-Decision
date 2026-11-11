use super::*;

fn tools() -> Value {
    let candidate = json!({"type":"object","additionalProperties":false,"required":["id","text"],
        "properties":{"id":{"type":"string","maxLength":128},"text":{"type":"string","maxLength":24000}}});
    json!([
        {"name":"rank_context","description":"Rank supplied source/search blocks against a task using Decision scores. Returns every exact original, including low-ranked blocks. Does not read files or execute commands.",
        "inputSchema":{"type":"object","additionalProperties":false,"required":["query","candidates"],"properties":{
            "query":{"type":"string","maxLength":4096},"candidates":{"type":"array","minItems":1,"maxItems":96,"items":candidate},
            "cache_reference":{"type":"string","maxLength":16384}}},"annotations":{"readOnlyHint":true,"openWorldHint":true}},
        {"name":"triage_failure","description":"Suggest likely cause and review priority from supplied failure evidence. Advisory only; never selects or skips tests.",
        "inputSchema":{"type":"object","additionalProperties":false,"required":["failure"],"properties":{
            "failure":{"type":"object","additionalProperties":false,"required":["name","output"],"properties":{
                "name":{"type":"string","maxLength":512},"output":{"type":"string","maxLength":24000}}}}},"annotations":{"readOnlyHint":true,"openWorldHint":true}},
        {"name":"verify_completion","description":"Check supplied completion claims against supplied diffs/test observations. Distinguishes missing evidence from contradiction. Advisory only.",
        "inputSchema":{"type":"object","additionalProperties":false,"required":["claims","evidence"],"properties":{
            "claims":{"type":"array","minItems":1,"maxItems":16,"items":{"type":"string","maxLength":8192}},
            "evidence":{"type":"array","minItems":1,"maxItems":32,"items":{"type":"object","additionalProperties":false,
                "required":["kind","content"],"properties":{"kind":{"enum":["diff","test","observation"]},"content":{"type":"string","maxLength":24000}}}}}},
            "annotations":{"readOnlyHint":true,"openWorldHint":true}}
    ])
}

fn dispatch(data_dir: &Path, request: &Value) -> Result<Value, (i32, &'static str)> {
    match request["method"].as_str() {
        Some("initialize") => Ok(
            json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}},
            "serverInfo":{"name":"codex-decision","version":env!("CARGO_PKG_VERSION")},
            "instructions":"Judgments are advisory. Keep exact originals. Test selection uses coverage, never model scores."}),
        ),
        Some("ping") => Ok(json!({})),
        Some("tools/list") => Ok(json!({"tools":tools()})),
        Some("tools/call") => {
            let name = request["params"]["name"]
                .as_str()
                .filter(|n| ["rank_context", "triage_failure", "verify_completion"].contains(n))
                .ok_or((-32602, "Unknown Decision tool"))?;
            let mut args = request["params"]["arguments"]
                .as_object()
                .cloned()
                .ok_or((-32602, "Expected tool arguments"))?;
            if args.contains_key("workflow") || args.contains_key("session_id") {
                return Err((-32602, "Unexpected tool arguments"));
            }
            args.insert("workflow".into(), json!(name));
            match judge(data_dir, &Value::Object(args)) {
                Ok(result) => Ok(
                    json!({"content":[{"type":"text","text":result.to_string()}],"structuredContent":result,"isError":false}),
                ),
                Err(_) => Ok(
                    json!({"content":[{"type":"text","text":"Decision could not evaluate this evidence. Check input size, privacy guards, provider configuration, and availability. Keep the original evidence."}],"isError":true}),
                ),
            }
        }
        _ => Err((-32601, "Method not found")),
    }
}

pub(crate) fn mcp() -> Result<(), String> {
    let data_dir = data_directory()?;
    let mut reader = BufReader::new(std::io::stdin().lock());
    let mut output = std::io::stdout().lock();
    loop {
        let mut bytes = Vec::new();
        let count = reader
            .by_ref()
            .take((assistance::MAX_INPUT + 1) as u64)
            .read_until(b'\n', &mut bytes)
            .map_err(|_| "MCP input read")?;
        if count == 0 {
            return Ok(());
        }
        if bytes.len() > assistance::MAX_INPUT {
            return Err("MCP message too large".into());
        }
        let response = match strict_json::parse(&bytes) {
            Err(_) => {
                json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}})
            }
            Ok(request) => {
                if request["jsonrpc"] != "2.0"
                    || !request["method"].is_string()
                    || request
                        .get("id")
                        .is_some_and(|id| !id.is_string() && !id.is_i64() && !id.is_u64())
                {
                    json!({"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid request"}})
                } else if request.get("id").is_none() {
                    continue;
                } else {
                    match dispatch(&data_dir, &request) {
                        Ok(result) => json!({"jsonrpc":"2.0","id":request["id"],"result":result}),
                        Err((code, message)) => {
                            json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":code,"message":message}})
                        }
                    }
                }
            }
        };
        writeln!(output, "{response}").map_err(|_| "MCP output write")?;
        output.flush().map_err(|_| "MCP output flush")?;
    }
}
