# Pi CLI findings

Captured on 2026-06-14 with `@mariozechner/pi-coding-agent` 0.73.1 installed globally via:

```powershell
npm install -g @mariozechner/pi-coding-agent
```

Scratch runs used `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_SKIP_VERSION_CHECK=1`, and `PI_TELEMETRY=0` under `%TEMP%\ak-pi-cli-findings`. The available `OPENAI_API_KEY` was rejected by OpenAI with a 401, so schema captures used a scratch Pi extension registering a deterministic local `ak-faux` provider. The JSONL below is still emitted by the real Pi CLI/runtime in `--mode json`.

## Answers

- **Session ID field**: the first JSON line is a session header: `{"type":"session","version":3,"id":"...","timestamp":"...","cwd":"..."}`. Use `session.id` as the provider resume id. `pi --session <id> -p ... --mode json` resumed the captured session and emitted the same header `id`. `pi --continue -p ... --mode json` also worked headlessly and resumed the latest session in the configured session dir.
- **MCP support**: current Pi docs state "No MCP." There is no Claude-style `--mcp-config` equivalent in 0.73.1. Board MCP access would require a Pi extension/tool package, not config plumbing.
- **Hook pre-tool veto**: Pi extensions can block pre-execution via `pi.on("tool_call", ...)` returning `{ block: true, reason }`. Runtime evidence: `tool_execution_start` emitted, the `tool_call` handler ran before the file was written, and `tool_execution_end` returned `isError: true`; `blocked.txt` was not created.
- **Auth/profile shape**: Pi provider/model selection is explicit (`--provider`, `--model`, `--api-key`) or stored in settings (`defaultProvider`, `defaultModel`). Credentials resolve from provider env vars/auth storage, and `PI_CODING_AGENT_DIR` selects the config/auth/settings root. A board "Pi profile" should likely include both the config dir and provider/model defaults.
- **Working directory mechanism**: spawn `cwd` is sufficient. The session header `cwd` matched the process working directory, and built-in `read` resolved `sample.txt` relative to that directory. No explicit cwd flag exists in 0.73.1.
- **Rate-limit/usage event**: there is no separate rate-limit event in the observed stream. Usage appears on assistant messages under `message.usage` with `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, and `cost`. Provider failures surface as assistant messages with `stopReason: "error"` and `errorMessage`; retry/compaction events are documented separately but not rate-limit-specific.
- **Trust/`--approve` effect**: `--approve` is not a valid option in 0.73.1. Project-local `.pi/extensions` loaded in non-interactive `--mode json -p` without any approve flag. That contradicts Decision 007's assumption that project-local `.pi` resources are silently ignored without `--approve`.

## Gotchas

- `pi --help` / `pi --version` did not return within short non-interactive timeouts in this environment, but `pi --list-models openai` and `pi --mode json -p ...` worked.
- `--approve` fails fast with `Error: Unknown option: --approve`; the Pi provider must not add it for 0.73.1.
- PowerShell's global `pi.ps1` wrapper formats stderr as `node.exe : ...` records when using `*>`; a parser should consume stdout JSON lines only. In the samples below, `AK_*` lines are extension stderr diagnostics, not JSONL events.
- Explicit `--extension <path>` is additive with discovered `.pi/extensions`. Use `--no-extensions --extension <path>` for isolated runs.
- `--continue` chooses the most recent session in the configured session dir, so tests should isolate `PI_CODING_AGENT_SESSION_DIR`.

## One-shot JSONL

Command:

```powershell
pi --no-extensions --extension $scratch\ak-faux-provider.ts --provider ak-faux --model ak-faux-1 --mode json -p "one-shot schema capture"
```

```jsonl
{"type":"session","version":3,"id":"019ec69d-bed7-75ad-9b25-2b19161227d5","timestamp":"2026-06-14T14:51:27.320Z","cwd":"C:\\Users\\pwegner\\AppData\\Local\\Temp\\ak-pi-cli-findings\\work"}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"one-shot schema capture"}],"timestamp":1781448687447}}
{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"one-shot schema capture"}],"timestamp":1781448687447}}
{"type":"message_start","message":{"role":"assistant","content":[],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1329,"output":3,"cacheRead":0,"cacheWrite":1329,"totalTokens":2661,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1781448687453}}
{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":0,"partial":{"role":"assistant","content":[{"type":"text","text":"one-shot-ok"}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1329,"output":3,"cacheRead":0,"cacheWrite":1329,"totalTokens":2661,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1781448687453}},"message":{"role":"assistant","content":[{"type":"text","text":"one-shot-ok"}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1329,"output":3,"cacheRead":0,"cacheWrite":1329,"totalTokens":2661,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1781448687453}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"one-shot-ok","partial":{"role":"assistant","content":[{"type":"text","text":"one-shot-ok"}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1329,"output":3,"cacheRead":0,"cacheWrite":1329,"totalTokens":2661,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1781448687453}},"message":{"role":"assistant","content":[{"type":"text","text":"one-shot-ok"}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1329,"output":3,"cacheRead":0,"cacheWrite":1329,"totalTokens":2661,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1781448687453}}
{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"one-shot-ok","partial":{"role":"assistant","content":[{"type":"text","text":"one-shot-ok"}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1329,"output":3,"cacheRead":0,"cacheWrite":1329,"totalTokens":2661,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1781448687453}},"message":{"role":"assistant","content":[{"type":"text","text":"one-shot-ok"}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1329,"output":3,"cacheRead":0,"cacheWrite":1329,"totalTokens":2661,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1781448687453}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"one-shot-ok"}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1329,"output":3,"cacheRead":0,"cacheWrite":1329,"totalTokens":2661,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1781448687453}}
{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"one-shot-ok"}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1329,"output":3,"cacheRead":0,"cacheWrite":1329,"totalTokens":2661,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1781448687453},"toolResults":[]}
{"type":"agent_end","messages":[{"role":"user","content":[{"type":"text","text":"one-shot schema capture"}],"timestamp":1781448687447},{"role":"assistant","content":[{"type":"text","text":"one-shot-ok"}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1329,"output":3,"cacheRead":0,"cacheWrite":1329,"totalTokens":2661,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1781448687453}]}
```

## Resume JSONL

Command:

```powershell
pi --no-extensions --extension $scratch\ak-faux-provider.ts --provider ak-faux --model ak-faux-1 --mode json --session 019ec69d-bed7-75ad-9b25-2b19161227d5 -p "resume schema capture"
```

```jsonl
{"type":"session","version":3,"id":"019ec69d-bed7-75ad-9b25-2b19161227d5","timestamp":"2026-06-14T14:51:27.320Z","cwd":"C:\\Users\\pwegner\\AppData\\Local\\Temp\\ak-pi-cli-findings\\work"}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"resume schema capture"}],"timestamp":1781448703086}}
{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"resume schema capture"}],"timestamp":1781448703086}}
{"type":"message_start","message":{"role":"assistant","content":[],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1341,"output":3,"cacheRead":0,"cacheWrite":1341,"totalTokens":2685,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1781448703091}}
{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":0,"partial":{"role":"assistant","content":[{"type":"text","text":"resume-ok"}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1341,"output":3,"cacheRead":0,"cacheWrite":1341,"totalTokens":2685,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1781448703091}},"message":{"role":"assistant","content":[{"type":"text","text":"resume-ok"}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1341,"output":3,"cacheRead":0,"cacheWrite":1341,"totalTokens":2685,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1781448703091}}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"resume-ok","partial":{"role":"assistant","content":[{"type":"text","text":"resume-ok"}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1341,"output":3,"cacheRead":0,"cacheWrite":1341,"totalTokens":2685,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1781448703091}},"message":{"role":"assistant","content":[{"type":"text","text":"resume-ok"}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1341,"output":3,"cacheRead":0,"cacheWrite":1341,"totalTokens":2685,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1781448703091}}
{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"resume-ok","partial":{"role":"assistant","content":[{"type":"text","text":"resume-ok"}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1341,"output":3,"cacheRead":0,"cacheWrite":1341,"totalTokens":2685,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1781448703091}},"message":{"role":"assistant","content":[{"type":"text","text":"resume-ok"}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1341,"output":3,"cacheRead":0,"cacheWrite":1341,"totalTokens":2685,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1781448703091}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"resume-ok"}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1341,"output":3,"cacheRead":0,"cacheWrite":1341,"totalTokens":2685,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1781448703091}}
{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"resume-ok"}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1341,"output":3,"cacheRead":0,"cacheWrite":1341,"totalTokens":2685,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1781448703091},"toolResults":[]}
{"type":"agent_end","messages":[{"role":"user","content":[{"type":"text","text":"resume schema capture"}],"timestamp":1781448703086},{"role":"assistant","content":[{"type":"text","text":"resume-ok"}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1341,"output":3,"cacheRead":0,"cacheWrite":1341,"totalTokens":2685,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":1781448703091}]}
```

## Tool call JSONL

Command:

```powershell
pi --no-extensions --extension $scratch\ak-faux-provider.ts --provider ak-faux --model ak-faux-1 --mode json -p "tool-read schema capture"
```

The sample includes a provider exhaustion error after the successful tool result because the scratch faux provider was intentionally minimal. The tool event sequence before that error is the part to map.

```jsonl
{"type":"session","version":3,"id":"019ec6a1-b911-750c-8f2e-c604c70e1831","timestamp":"2026-06-14T14:55:47.986Z","cwd":"C:\\Users\\pwegner\\AppData\\Local\\Temp\\ak-pi-cli-findings\\work"}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"tool-read schema capture"}],"timestamp":1781448948019}}
{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"tool-read schema capture"}],"timestamp":1781448948019}}
{"type":"message_start","message":{"role":"assistant","content":[],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1329,"output":7,"cacheRead":0,"cacheWrite":1329,"totalTokens":2665,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1781448948022}}
{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","contentIndex":0,"partial":{"role":"assistant","content":[{"type":"toolCall","id":"tool-call-read-sample","name":"read","arguments":{"path":"sample.txt"}}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1329,"output":7,"cacheRead":0,"cacheWrite":1329,"totalTokens":2665,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1781448948022}},"message":{"role":"assistant","content":[{"type":"toolCall","id":"tool-call-read-sample","name":"read","arguments":{"path":"sample.txt"}}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1329,"output":7,"cacheRead":0,"cacheWrite":1329,"totalTokens":2665,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1781448948022}}
{"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta","contentIndex":0,"delta":"{\"path\":\"sam","partial":{"role":"assistant","content":[{"type":"toolCall","id":"tool-call-read-sample","name":"read","arguments":{"path":"sample.txt"}}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1329,"output":7,"cacheRead":0,"cacheWrite":1329,"totalTokens":2665,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1781448948022}},"message":{"role":"assistant","content":[{"type":"toolCall","id":"tool-call-read-sample","name":"read","arguments":{"path":"sample.txt"}}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1329,"output":7,"cacheRead":0,"cacheWrite":1329,"totalTokens":2665,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1781448948022}}
{"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta","contentIndex":0,"delta":"ple.txt\"}","partial":{"role":"assistant","content":[{"type":"toolCall","id":"tool-call-read-sample","name":"read","arguments":{"path":"sample.txt"}}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1329,"output":7,"cacheRead":0,"cacheWrite":1329,"totalTokens":2665,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1781448948022}},"message":{"role":"assistant","content":[{"type":"toolCall","id":"tool-call-read-sample","name":"read","arguments":{"path":"sample.txt"}}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1329,"output":7,"cacheRead":0,"cacheWrite":1329,"totalTokens":2665,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1781448948022}}
{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","contentIndex":0,"toolCall":{"type":"toolCall","id":"tool-call-read-sample","name":"read","arguments":{"path":"sample.txt"}},"partial":{"role":"assistant","content":[{"type":"toolCall","id":"tool-call-read-sample","name":"read","arguments":{"path":"sample.txt"}}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1329,"output":7,"cacheRead":0,"cacheWrite":1329,"totalTokens":2665,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1781448948022}},"message":{"role":"assistant","content":[{"type":"toolCall","id":"tool-call-read-sample","name":"read","arguments":{"path":"sample.txt"}}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1329,"output":7,"cacheRead":0,"cacheWrite":1329,"totalTokens":2665,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1781448948022}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tool-call-read-sample","name":"read","arguments":{"path":"sample.txt"}}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1329,"output":7,"cacheRead":0,"cacheWrite":1329,"totalTokens":2665,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1781448948022}}
{"type":"tool_execution_start","toolCallId":"tool-call-read-sample","toolName":"read","args":{"path":"sample.txt"}}
{"type":"tool_execution_end","toolCallId":"tool-call-read-sample","toolName":"read","result":{"content":[{"type":"text","text":"pi scratch sample file\r\n"}]},"isError":false}
{"type":"message_start","message":{"role":"toolResult","toolCallId":"tool-call-read-sample","toolName":"read","content":[{"type":"text","text":"pi scratch sample file\r\n"}],"isError":false,"timestamp":1781448948041}}
{"type":"message_end","message":{"role":"toolResult","toolCallId":"tool-call-read-sample","toolName":"read","content":[{"type":"text","text":"pi scratch sample file\r\n"}],"isError":false,"timestamp":1781448948041}}
{"type":"turn_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"tool-call-read-sample","name":"read","arguments":{"path":"sample.txt"}}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1329,"output":7,"cacheRead":0,"cacheWrite":1329,"totalTokens":2665,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1781448948022},"toolResults":[{"role":"toolResult","toolCallId":"tool-call-read-sample","toolName":"read","content":[{"type":"text","text":"pi scratch sample file\r\n"}],"isError":false,"timestamp":1781448948041}]}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":729,"output":0,"cacheRead":620,"cacheWrite":730,"totalTokens":2079,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"error","errorMessage":"No more faux responses queued","timestamp":1781448948042}}
{"type":"message_end","message":{"role":"assistant","content":[],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":729,"output":0,"cacheRead":620,"cacheWrite":730,"totalTokens":2079,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"error","errorMessage":"No more faux responses queued","timestamp":1781448948042}}
{"type":"turn_end","message":{"role":"assistant","content":[],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":729,"output":0,"cacheRead":620,"cacheWrite":730,"totalTokens":2079,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"error","errorMessage":"No more faux responses queued","timestamp":1781448948042},"toolResults":[]}
{"type":"agent_end","messages":[{"role":"user","content":[{"type":"text","text":"tool-read schema capture"}],"timestamp":1781448948019},{"role":"assistant","content":[{"type":"toolCall","id":"tool-call-read-sample","name":"read","arguments":{"path":"sample.txt"}}],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":1329,"output":7,"cacheRead":0,"cacheWrite":1329,"totalTokens":2665,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"toolUse","timestamp":1781448948022},{"role":"toolResult","toolCallId":"tool-call-read-sample","toolName":"read","content":[{"type":"text","text":"pi scratch sample file\r\n"}],"isError":false,"timestamp":1781448948041},{"role":"assistant","content":[],"api":"ak-faux-api","provider":"ak-faux","model":"ak-faux-1","usage":{"input":729,"output":0,"cacheRead":620,"cacheWrite":730,"totalTokens":2079,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"error","errorMessage":"No more faux responses queued","timestamp":1781448948042}]}
```

## Veto JSONL

Relevant pre-tool veto sequence from a `write` call blocked by `tool_call`:

```jsonl
{"type":"tool_execution_start","toolCallId":"tool-call-write-blocked","toolName":"write","args":{"path":"blocked.txt","content":"blocked"}}
{"type":"tool_execution_end","toolCallId":"tool-call-write-blocked","toolName":"write","result":{"content":[{"type":"text","text":"blocked by ak faux extension"}],"details":{}},"isError":true}
{"type":"message_start","message":{"role":"toolResult","toolCallId":"tool-call-write-blocked","toolName":"write","content":[{"type":"text","text":"blocked by ak faux extension"}],"details":{},"isError":true,"timestamp":1781448795355}}
{"type":"message_end","message":{"role":"toolResult","toolCallId":"tool-call-write-blocked","toolName":"write","content":[{"type":"text","text":"blocked by ak faux extension"}],"details":{},"isError":true,"timestamp":1781448795355}}
```

`%TEMP%\ak-pi-cli-findings\work\blocked.txt` did not exist after the run.
