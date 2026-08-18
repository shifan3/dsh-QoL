// dsh-QoL server half smoke: settings routes + /api settings/mutate interceptor.
// The fake settings provider below FAITHFULLY mirrors dsh-settings' applyPathOp
// (descent into an array silently no-ops `unset`; `set` corrupts the array into
// a plain object), so the class of bug that made the 1.4.0 toggle a silent
// no-op is actually exercised here instead of masked.
const routes = [];
const effects = [];
let section = {
  providers: {
    "danatech-101": {
      apiKeyEnv: "DANATECH_101_API_KEY",
      api: "openai-completions",
      baseURL: "http://10.33.10.101:7878/v1",
      models: [
        { id: "qwen3.8-27b-nvfp4", contextWindow: 500000, input: ["text", "image"], maxTokens: 256000 },
        { id: "text-only-model", contextWindow: 131072, maxTokens: 32768 }
      ]
    },
    "kimi-coding": {
      api: "openai-completions",
      baseURL: "http://kimi.local/v1",
      models: [{ id: "kimi-k2", contextWindow: 131072 }]
    }
  }
};
let revision = 42;

// --- faithful dsh-settings applyPathOp mirror ---------------------------------
function isPlainObject(v) {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
const deep = (v) => JSON.parse(JSON.stringify(v));
function applyOp(sec, op) {
  const [head, ...rest] = op.path;
  if (head === undefined) {
    if (op.op === "unset") return {};
    if (!isPlainObject(op.value)) throw new TypeError("root set must be a plain object");
    return deep(op.value);
  }
  if (rest.length === 0) {
    if (op.op === "set") return { ...sec, [head]: deep(op.value) };
    const kept = {};
    for (const key of Object.keys(sec)) if (key !== head) kept[key] = sec[key];
    return kept;
  }
  const child = sec[head];
  if (!isPlainObject(child)) {
    if (op.op === "unset") return sec; // array descent -> silent no-op
    return { ...sec, [head]: applyOp({}, { ...op, path: rest }) }; // array -> plain-object corruption
  }
  return { ...sec, [head]: applyOp(child, { ...op, path: rest }) };
}
// ---------------------------------------------------------------------------

const settings = {
  section: (ns) => (ns === "llm-pi-ai" ? deep(section) : undefined),
  mutate: async (ns, ops, expected) => {
    if (expected !== undefined && expected !== revision) {
      const e = new Error("conflict");
      e.name = "SettingsConflictError";
      e.expected = expected;
      e.actual = revision;
      throw e;
    }
    let cur = deep(section);
    for (const op of ops) cur = applyOp(cur, op);
    section = cur;
    revision += 1;
  },
  describe: () => [
    { ns: "llm-pi-ai", schema: {}, value: section, applies: "live", secrets: [], revision }
  ]
};
let interceptArgs = null;
const ctx = {
  webServer: { register: (route) => { routes.push(route); return () => routes.splice(routes.indexOf(route), 1); } },
  get: (name) => (name === "settings" ? settings : name === "connection" ? {
    rpc: { intercept: (ch, m, h, o) => { interceptArgs = { ch, m, h, o }; return () => (interceptArgs = null); } }
  } : undefined),
  effect: (fn) => effects.push(fn()),
  agents: undefined, agentPresets: undefined, fs: undefined
};
const mod = await import("file:///mnt/data5/dsh-plugins/dsh-QoL/lib/index.js");
console.log("name:", mod.name, "inject:", JSON.stringify(mod.inject));
mod.apply(ctx);
console.log("routes:", routes.map((r) => r.path).join(", "));
const { m, h, ch, o } = interceptArgs;
console.log("intercept channel:", ch, "authority:", JSON.stringify(o),
  "| matches settings.mutate:", m("settings.mutate"), "| matches settings/mutate:", m("settings/mutate"),
  "| matches session.list:", m("session.list"));

async function fakeHandler(route, method, url, body, headers) {
  const fr = { status: 0, body: undefined };
  fr.writeHead = (s) => { fr.status = s; };
  fr.end = (b) => { fr.body = b; };
  const req = {
    method, url: url ?? "/", headers: headers ?? { "x-dsh-qol": "1" },
    on: (ev, fn) => {
      if (ev === "data" && body !== undefined) fn(Buffer.from(body, "utf8"));
      if (ev === "end") fn();
    }
  };
  await route.handler(req, fr);
  return { status: fr.status, body: fr.body ? JSON.parse(fr.body) : undefined };
}
const mi = routes.find((r) => r.path === "/dsh-qol/model-input");
const inputOf = () => section.providers["danatech-101"].models.find((x) => x.id === "qwen3.8-27b-nvfp4")?.input;

let failures = 0;
function check(label, cond, extra) {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log((ok ? "PASS " : "FAIL ") + label, extra ?? "");
}

// [1] whole-profile save DROPS input (page editor doesn't re-serialise it) -> interceptor re-adopts.
{
  const r = await h("settings.mutate", {
    ns: "llm-pi-ai",
    ops: [{ op: "set", path: ["providers", "danatech-101"], value: {
      apiKeyEnv: "DANATECH_101_API_KEY", api: "openai-completions", baseURL: "http://10.33.10.101:7878/v1",
      models: [
        { id: "qwen3.8-27b-nvfp4", contextWindow: 500000, maxTokens: 256000 },
        { id: "text-only-model", contextWindow: 131072, maxTokens: 32768 }
      ]
    } }],
    expectedRevision: revision
  });
  check("[1] re-adopt on drop: ok+rev", r.ok === true && r.value && r.value.revision === revision, JSON.stringify(r.ok));
  check("[1] input preserved after drop", JSON.stringify(inputOf()) === '["text","image"]', JSON.stringify(inputOf()));
}

// [2] explicit shorter declaration in the draft wins (no re-adopt of [text,image]).
{
  const r = await h("settings.mutate", {
    ns: "llm-pi-ai",
    ops: [{ op: "set", path: ["providers", "danatech-101"], value: {
      apiKeyEnv: "DANATECH_101_API_KEY", api: "openai-completions", baseURL: "http://10.33.10.101:7878/v1",
      models: [
        { id: "qwen3.8-27b-nvfp4", contextWindow: 500000, input: ["text"], maxTokens: 256000 },
        { id: "text-only-model", contextWindow: 131072, maxTokens: 32768 }
      ]
    } }],
    expectedRevision: revision
  });
  check("[2] explicit wins", r.ok === true && JSON.stringify(inputOf()) === '["text"]', JSON.stringify(inputOf()));
  // restore [text,image] back for the toggle sequence
  await h("settings.mutate", {
    ns: "llm-pi-ai",
    ops: [{ op: "set", path: ["providers", "danatech-101"], value: {
      apiKeyEnv: "DANATECH_101_API_KEY", api: "openai-completions", baseURL: "http://10.33.10.101:7878/v1",
      models: [
        { id: "qwen3.8-27b-nvfp4", contextWindow: 500000, input: ["text", "image"], maxTokens: 256000 },
        { id: "text-only-model", contextWindow: 131072, maxTokens: 32768 }
      ]
    } }],
    expectedRevision: revision
  });
}

// [3] conflict mapping (dotted endpoint only).
{
  const bad = await h("settings.mutate", { ns: "llm-pi-ai", ops: [], expectedRevision: 1 });
  check("[3] conflict shape", bad.ok === false && bad.error && bad.error.code === "settings-conflict",
    JSON.stringify(bad.error && bad.error.code));
  check("[3] slash endpoint NOT matched (passes through to real handler)", m("settings/mutate") === false);
}

// [4] GET view shape.
{
  const g1 = await fakeHandler(mi, "GET");
  check("[4] GET view ok", g1.status === 200 && g1.body.ok === true);
  check("[4] GET carries input flags",
    g1.body.providers["danatech-101"].models.find((x) => x.id === "qwen3.8-27b-nvfp4").input
    === undefined ? "missing" : JSON.stringify(g1.body.providers["danatech-101"].models.find((x) => x.id === "qwen3.8-27b-nvfp4").input));
  const g2 = await fakeHandler(mi, "GET", undefined, undefined, {});
  check("[4] no header -> 403", g2.status === 403, String(g2.status));
}

// [5] toggle OFF -> lands (3-seg whole-array op, not the no-op 5-seg unset), permit armed.
{
  const before = revision;
  const p = await fakeHandler(mi, "POST", "x", JSON.stringify({ modelId: "qwen3.8-27b-nvfp4", image: false }));
  check("[5] toggle off ok", p.status === 200 && p.body.ok === true, JSON.stringify(p.status));
  check("[5] toggle off actually removed input on disk", inputOf() === undefined, JSON.stringify(inputOf()));
  check("[5] toggle off bumped revision", revision === before + 1, `${before} -> ${revision}`);
  const t1 = section.providers["danatech-101"].models;
  check("[5] models still an array (no object corruption)", Array.isArray(t1) && t1.length === 2, JSON.stringify(Array.isArray(t1)));

  // [5b] THE REGRESSION: a still-open page (draft captured before the toggle,
  // carrying input in its model state) saves -> without the permit this op would
  // re-add the removed declaration. Interceptor must strip it.
  const stale = await h("settings.mutate", {
    ns: "llm-pi-ai",
    ops: [{ op: "set", path: ["providers", "danatech-101"], value: {
      apiKeyEnv: "DANATECH_101_API_KEY", api: "openai-completions", baseURL: "http://10.33.10.101:7878/v1",
      models: [
        { id: "qwen3.8-27b-nvfp4", contextWindow: 500000, input: ["text", "image"], maxTokens: 256000 },
        { id: "text-only-model", contextWindow: 131072, maxTokens: 32768 }
      ]
    } }],
    expectedRevision: revision
  });
  check("[5b] stale page save ok", stale.ok === true, JSON.stringify(stale.ok));
  check("[5b] stale re-added input was STRIPPED (permit)", inputOf() === undefined, JSON.stringify(inputOf()));

  // [5c] a fresh page (draft with no input) confirms the removal and spends the permit.
  const fresh = await h("settings.mutate", {
    ns: "llm-pi-ai",
    ops: [{ op: "set", path: ["providers", "danatech-101"], value: {
      apiKeyEnv: "DANATECH_101_API_KEY", api: "openai-completions", baseURL: "http://10.33.10.101:7878/v1",
      models: [
        { id: "qwen3.8-27b-nvfp4", contextWindow: 500001, maxTokens: 256000 },
        { id: "text-only-model", contextWindow: 131072, maxTokens: 32768 }
      ]
    } }],
    expectedRevision: revision
  });
  check("[5c] fresh save ok", fresh.ok === true, JSON.stringify(fresh.ok));
  check("[5c] removal stays confirmed (no re-adopt, input absent)", inputOf() === undefined, JSON.stringify(inputOf()));
}

// [6] toggle ON -> re-declares input and clears the permit.
{
  const r = await fakeHandler(mi, "POST", "x", JSON.stringify({ modelId: "qwen3.8-27b-nvfp4", image: true }));
  check("[6] toggle on ok", r.status === 200 && r.body.ok === true, JSON.stringify(r.status));
  check("[6] toggle on re-declared input", JSON.stringify(inputOf()) === '["text","image"]', JSON.stringify(inputOf()));
  // after re-declare, a whole-profile save carrying input is now the user's own: kept.
  const keep = await h("settings.mutate", {
    ns: "llm-pi-ai",
    ops: [{ op: "set", path: ["providers", "danatech-101"], value: {
      apiKeyEnv: "DANATECH_101_API_KEY", api: "openai-completions", baseURL: "http://10.33.10.101:7878/v1",
      models: [
        { id: "qwen3.8-27b-nvfp4", contextWindow: 500000, input: ["text", "image"], maxTokens: 256000 },
        { id: "text-only-model", contextWindow: 131072, maxTokens: 32768 }
      ]
    } }],
    expectedRevision: revision
  });
  check("[6] save keeps input after re-declare", keep.ok === true && JSON.stringify(inputOf()) === '["text","image"]', JSON.stringify(inputOf()));
}

// [7] unknown model -> 404; toggle-on for a model that never had input -> whole-array op adds it.
{
  const p = await fakeHandler(mi, "POST", "x", JSON.stringify({ modelId: "does-not-exist", image: true }));
  check("[7] unknown model -> 404", p.status === 404, JSON.stringify(p.status));
  const q = await fakeHandler(mi, "POST", "x", JSON.stringify({ modelId: "text-only-model", image: true }));
  const to = section.providers["danatech-101"].models.find((x) => x.id === "text-only-model");
  check("[7] toggle-on for text-only adds input", q.status === 200 && JSON.stringify(to.input) === '["text","image"]', JSON.stringify(to ? to.input : null));
  // revert that so final state is clean
  await fakeHandler(mi, "POST", "x", JSON.stringify({ modelId: "text-only-model", image: false }));
  const to2 = section.providers["danatech-101"].models.find((x) => x.id === "text-only-model");
  check("[7] reverted text-only input", to2.input === undefined, JSON.stringify(to2.input));
}

// [8] a namespace we don't touch (kimi-coding lives under llm-pi-ai providers but
// a non-provider route) passes through untouched: save kimi-coding without input.
{
  const r = await h("settings.mutate", {
    ns: "llm-pi-ai",
    ops: [{ op: "set", path: ["providers", "kimi-coding"], value: {
      api: "openai-completions", baseURL: "http://kimi.local/v1",
      models: [{ id: "kimi-k2", contextWindow: 131072 }]
    } }],
    expectedRevision: revision
  });
  check("[8] unrelated route save ok (no exotic restore)", r.ok === true, JSON.stringify(r.ok));
  check("[8] kimi input stayed absent", section.providers["kimi-coding"].models[0].input === undefined);
}

// [9] cleanup: unmount intercept + routes.
for (const fn of effects) fn();
check("[9] after cleanup intercept unregistered", interceptArgs === null);
check("[9] after cleanup routes unmounted", routes.length === 0, "routes=" + routes.length);

console.log(failures === 0 ? "SMOKE OK (all green)" : `SMOKE FAILED (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
