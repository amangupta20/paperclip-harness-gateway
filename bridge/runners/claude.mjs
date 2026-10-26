// Claude Code: `claude -p --output-format stream-json`, resumed with --resume.

export default {
  name: "claude",
  bin: process.env.CLAUDE_BIN || "claude",
  provider: "anthropic",
  // Claude discovers workspace/.claude/skills itself, so no explicit skill pointer.
  needsSkillPointer: false,
  knownEvents: new Set(["system", "assistant", "user", "result", "rate_limit_event", "stream_event"]),

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
        if (block.type === "text" && block.text) {
          out.delta(`${block.text}\n`);
          out.lastText(block.text);
        } else if (block.type === "thinking" && block.thinking) out.reasoning(block.thinking);
        else if (block.type === "tool_use") out.tool(block.name, summarizeInput(block.input));
      }
    } else if (event.type === "result") {
      out.session(event.session_id);
      const u = event.usage || {};
      out.result({
        output: event.result,
        isError: Boolean(event.is_error),
        costUsd: event.total_cost_usd,
        usage: {
          input_tokens: u.input_tokens || 0,
          output_tokens: u.output_tokens || 0,
          cache_read_tokens: u.cache_read_input_tokens || 0,
          cache_write_tokens: u.cache_creation_input_tokens || 0,
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
