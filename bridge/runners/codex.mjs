// Codex: `codex exec --json`, resumed with `codex exec resume <thread_id>`.
// Not yet exercised end to end on this machine (codex was logged out when written).

import { summarizeInput } from "./claude.mjs";

export default {
  name: "codex",
  bin: process.env.CODEX_BIN || "codex",
  needsSkillPointer: true,

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
      } else if (item.type === "command_execution") {
        out.delta(`\n▸ shell: ${summarizeInput({ command: item.command })} (exit ${item.exit_code ?? "?"})\n`);
      } else if (item.type === "file_change") {
        out.delta(`\n▸ edit: ${(item.changes || []).map((c) => c.path).join(", ")}\n`);
      }
    } else if (event.type === "turn.completed") {
      const u = event.usage || {};
      out.addUsage({ input_tokens: u.input_tokens || 0, cached_input_tokens: u.cached_input_tokens || 0, output_tokens: u.output_tokens || 0 });
      out.result({ isError: false });
    } else if (event.type === "turn.failed") {
      out.result({ isError: true, output: event.error?.message });
    }
  },
};
