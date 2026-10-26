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
  needsSkillPointer: true,

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
        if (block.type === "toolCall") out.delta(`\n▸ ${block.name}: ${summarizeInput(block.arguments)}\n`);
      }
      out.model(m.model && m.provider ? `${m.provider}/${m.model}` : m.model);
      out.addUsage({
        input_tokens: m.usage?.input || 0,
        cached_input_tokens: m.usage?.cacheRead || 0,
        output_tokens: m.usage?.output || 0,
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
