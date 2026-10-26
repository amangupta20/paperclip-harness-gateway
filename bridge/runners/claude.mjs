// Claude Code: `claude -p --output-format stream-json`, resumed with --resume.

export default {
  name: "claude",
  bin: process.env.CLAUDE_BIN || "claude",
  // Claude discovers workspace/.claude/skills itself, so no explicit skill pointer.
  needsSkillPointer: false,

  args({ prompt, resumeId, extraDirs, model }) {
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"];
    for (const dir of extraDirs) args.push("--add-dir", dir);
    if (model) args.push("--model", model);
    if (resumeId) args.push("--resume", resumeId);
    return args;
  },

  parse(event, out) {
    if (event.type === "system" && event.subtype === "init") {
      out.session(event.session_id);
      out.model(event.model);
    } else if (event.type === "assistant") {
      for (const block of event.message?.content || []) {
        if (block.type === "text" && block.text) out.delta(`${block.text}\n`);
        else if (block.type === "tool_use") out.delta(`\n▸ ${block.name}: ${summarizeInput(block.input)}\n`);
      }
    } else if (event.type === "result") {
      out.session(event.session_id);
      const u = event.usage || {};
      out.result({
        output: event.result,
        isError: Boolean(event.is_error),
        costUsd: event.total_cost_usd,
        usage: {
          input_tokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0),
          cached_input_tokens: u.cache_read_input_tokens || 0,
          output_tokens: u.output_tokens || 0,
        },
      });
    }
  },
};

export function summarizeInput(input) {
  if (!input || typeof input !== "object") return "";
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description;
  const text = typeof v === "string" ? v : JSON.stringify(input);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
