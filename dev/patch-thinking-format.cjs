#!/usr/bin/env node
// dsh-QoL dev: one-line whitelist patch for dsh-llm-pi-ai.
//
// Why: vLLM-served Qwen models are controllable only through the request body
// field `chat_template_kwargs.enable_thinking` (verified live: top-level
// enable_thinking / thinking / reasoning_effort / thinking_budget are all
// ignored by vLLM 0.27.1). pi-ai core's openai-completions dispatch speaks that
// dialect natively as `thinkingFormat: "qwen-chat-template"` (sends exactly
// `chat_template_kwargs: { enable_thinking: <bool>, preserve_thinking: true }`).
// dsh-llm-pi-ai's settings schema, however, restricts thinkingFormat to a
// curated dict (SUPPORTED_THINKING_FORMATS) that omits it — so a QoL/dsh
// configuration can never declare the only dialect that works.
//
// This script inserts "qwen-chat-template" into that dict, in place, in every
// found dsh install tree (~/.npm/_npx/*/node_modules and any path you pass).
// Idempotent: already-patched trees are skipped. A .dsh-qol-backup copy of the
// pristine file is kept next to it on first patch.
//
// Re-apply after `npx @deepseek-ai/dsh` installs a newer dsh (npx keeps the
// hash-named cache dir only while the spec is unchanged; a version bump
// re-downloads pristine files). Then RESTART dsh web so the patched module is
// loaded. Until the restart, settings writes naming the format are rejected by
// the in-memory schema (dsh-settings keeps the last good section; nothing is
// corrupted).
//
// Once the format is accepted, declare per route in .dsh/settings.yaml:
//   llm-pi-ai:
//     providers:
//       <route>:
//         compat: { thinkingFormat: qwen-chat-template }   # or per-model compat
//         reasoning: high                                    # default selected level
//         models:
//           - id: <model>
//             reasoningEfforts: { off: null, high: "high" }  # any wire string; dispatch only uses on/off
// The dsh composer picker then offers the model's thinking off/high; selecting
// a level streams enable_thinking:true, off/none streams enable_thinking:false.
//
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const REL = path.join("@deepseek-ai", "dsh-llm-pi-ai", "lib", "index.js");
const MARKER = '"qwen-chat-template": true';
const DICT_START = "const SUPPORTED_THINKING_FORMATS = Object.keys({";

function treesFromCli() {
  const args = process.argv.slice(2);
  const roots = args.length > 0 ? args : [path.join(os.homedir(), ".npm", "_npx")];
  const trees = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    if (path.basename(root) === "dsh-llm-pi-ai") {
      trees.push(root);
      continue;
    }
    for (const entry of fs.readdirSync(root)) {
      const candidate = path.join(root, entry, "node_modules", REL);
      if (fs.existsSync(candidate)) trees.push(path.dirname(path.dirname(candidate)));
    }
    const direct = path.join(root, "node_modules", REL);
    if (fs.existsSync(direct)) trees.push(path.dirname(path.dirname(direct)));
  }
  return trees;
}

for (const tree of treesFromCli()) {
  const file = path.join(tree, REL);
  let source;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    console.log("skip (unreadable):", tree);
    continue;
  }
  if (source.includes(MARKER)) {
    console.log("already patched:", file);
    continue;
  }
  const start = source.indexOf(DICT_START);
  if (start === -1) {
    console.log("NOT PATCHABLE (format dict not found; dsh layout may have changed):", file);
    continue;
  }
  const end = source.indexOf("})", start);
  if (end === -1) {
    console.log("NOT PATCHABLE (unterminated format dict):", file);
    continue;
  }
  const backup = file + ".dsh-qol-backup";
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, source.slice(0, end) + `\t${MARKER},\n` + source.slice(end));
  console.log("patched:", file, "(backup:", backup + ")");
}
console.log("done. restart dsh web to load the patched module.");
