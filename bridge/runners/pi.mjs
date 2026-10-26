// pi: `pi -p --mode json`. Sessions use --session-id, which creates the session when
// missing, so a deterministic id derived from Paperclip's session key gives
// per-issue continuity without any bookkeeping.

import { createHash } from "node:crypto";
import { summarizeInput } from "./claude.mjs";

function uuidFrom(key) {
  const h = createHash("sha256").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export default {
  name: "pi",
  bin: process.env.PI_BIN || "pi",
  provider: "pi",
  needsSkillPointer: true,
  knownEvents: new Set([
    "session", "agent_start", "agent_end", "agent_settled", "turn_start", "turn_end",
    "message_start", "message_update", "message_end",
    "tool_execution_start", "tool_execution_update", "tool_execution_end",
    "auto_compaction_start", "auto_compaction_end", "auto_retry_start", "auto_retry_end",
  ]),

  args({ prompt, sessionKey, model }) {
    const args = ["-p", "--mode", "json"];
    args.push(...(sessionKey ? ["--session-id", uuidFrom(sessionKey)] : ["--no-session"]));
    if (model) args.push("--model", model);
    args.push(prompt);
    return args;
  },

  parse(event, out) {
    if (event.type === "session") {
      out.session(event.id);
    } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      out.delta(event.assistantMessageEvent.delta);
    } else if (event.type === "message_end" && event.message?.role === "assistant") {
      const m = event.message;
      for (const block of m.content || []) {
        if (block.type === "thinking" && block.thinking) out.reasoning(block.thinking);
        else if (block.type === "toolCall") out.tool(block.name, summarizeInput(block.arguments));
      }
      out.model(m.model);
      out.provider(m.provider);
      out.addUsage({
        input_tokens: m.usage?.input || 0,
        output_tokens: m.usage?.output || 0,
        cache_read_tokens: m.usage?.cacheRead || 0,
        cache_write_tokens: m.usage?.cacheWrite || 0,
        cost_usd: m.usage?.cost?.total || 0,
      });
      const text = (m.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      if (text) out.lastText(text);
      if (m.stopReason === "error") out.result({ isError: true, output: m.errorMessage || text });
    } else if (event.type === "agent_settled") {
      out.result({ isError: Boolean(event.aborted) });
    }
  },
};
