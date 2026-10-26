#!/usr/bin/env node
// Test-only harness CLI. Reads directives from the prompt (last argv) and prints
// JSONL events for runners/fake.mjs:
//   SLEEP <s>   sleep before answering (spawns a child `sleep`, to test group kill)
//   THINK       emit a reasoning block
//   TOOL        emit a tool call
//   TOKENS      stream the answer one character per event
//   FAIL        print to stderr and exit 3
//   ECHOKEY     print $PAPERCLIP_API_KEY in the answer (to test redaction)

import { spawnSync } from "node:child_process";

const prompt = process.argv.at(-1) || "";
const resume = process.argv.includes("--resume") ? process.argv[process.argv.indexOf("--resume") + 1] : null;
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

say({ type: "session", id: resume || `fake-${process.pid}` });
if (/\bTHINK\b/.test(prompt)) say({ type: "thinking", text: "considering the task" });
if (/\bTOOL\b/.test(prompt)) say({ type: "tool", name: "Bash", input: "ls -la" });
const sleep = prompt.match(/\bSLEEP (\d+)\b/);
if (sleep) spawnSync("sleep", [sleep[1]]);
if (/\bFAIL\b/.test(prompt)) {
  process.stderr.write("fake-harness: boom (simulated failure)\n");
  process.exit(3);
}
const answer = /\bECHOKEY\b/.test(prompt) ? `key is ${process.env.PAPERCLIP_API_KEY}` : `OK resume=${resume ?? "none"} task=${process.env.PAPERCLIP_TASK_ID ?? "-"}`;
if (/\bTOKENS\b/.test(prompt)) for (const ch of answer) say({ type: "text", text: ch });
else say({ type: "text", text: answer });
say({ type: "done", output: answer, usage: { input: 100, output: 20, cacheRead: 50 }, cost: 0.001 });
