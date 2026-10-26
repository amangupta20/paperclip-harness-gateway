// Codex: `codex exec --json`, resumed with `codex exec resume <thread_id>`.
// Not yet exercised end to end on this machine (codex was logged out when written).

import { summarizeInput } from "./claude.mjs";

export default {
  name: "codex",
  bin: process.env.CODEX_BIN || "codex",
  provider: "openai",
  needsSkillPointer: true,
  knownEvents: new Set(["thread.started", "turn.started", "turn.completed", "turn.failed", "item.started", "item.updated", "item.completed", "error"]),

  args({ prompt, resumeId, workspace, extraDirs, model }) {
    // exec-level flags go before the `resume` subcommand.
    const args = ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-C", workspace];
    for (const dir of extraDirs) args.push("--add-dir", dir);
    if (model) args.push("-m", model);
    if (resumeId) args.push("resume", resumeId);
    args.push(prompt);
    return args;
  },

  parse(event, out) {
    if (event.type === "thread.started") {
      out.session(event.thread_id);
    } else if (event.type === "item.completed") {
      const item = event.item || {};
      if (item.type === "agent_message" && item.text) {
        out.delta(`${item.text}\n`);
        out.lastText(item.text);
      } else if (item.type === "reasoning" && item.text) {
        out.reasoning(item.text);
      } else if (item.type === "command_execution") {
        out.tool("shell", `${summarizeInput({ command: item.command })} (exit ${item.exit_code ?? "?"})`);
      } else if (item.type === "file_change") {
        out.tool("edit", (item.changes || []).map((c) => c.path).join(", "));
      }
    } else if (event.type === "turn.completed") {
      const u = event.usage || {};
      // codex's input_tokens includes the cached part; the gateway counts them separately.
      const cached = u.cached_input_tokens || 0;
      out.addUsage({ input_tokens: Math.max(0, (u.input_tokens || 0) - cached), cache_read_tokens: cached, output_tokens: u.output_tokens || 0 });
      out.result({ isError: false });
    } else if (event.type === "turn.failed") {
      out.result({ isError: true, output: event.error?.message });
    }
  },
};
