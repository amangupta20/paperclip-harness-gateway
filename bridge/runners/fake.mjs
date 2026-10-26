// Test-only runner driving test/fake-harness.mjs. Registered only when BRIDGE_TEST=1.

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fake-harness.mjs");

export default {
  name: "fake",
  bin: process.execPath,
  provider: "fake",
  needsSkillPointer: true,
  knownEvents: new Set(["session", "thinking", "tool", "text", "done"]),

  args({ prompt, resumeId }) {
    return [script, ...(resumeId ? ["--resume", resumeId] : []), prompt];
  },

  parse(event, out) {
    if (event.type === "session") out.session(event.id);
    else if (event.type === "thinking") out.reasoning(event.text);
    else if (event.type === "tool") out.tool(event.name, event.input);
    else if (event.type === "text") {
      out.delta(event.text);
      out.lastText(event.text);
    } else if (event.type === "done") {
      out.model("fake-1");
      out.addUsage({ input_tokens: event.usage.input, output_tokens: event.usage.output, cache_read_tokens: event.usage.cacheRead, cost_usd: event.cost });
      out.result({ output: event.output });
    }
  },
};
