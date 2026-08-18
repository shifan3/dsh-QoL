// dsh-QoL server half smoke: settings routes + /api settings/mutate interceptor
// (fake composition ctx; no real node_modules imports needed).
const routes = [];
const effects = [];
const section = {
  providers: {
    "danatech-101": {
      apiKeyEnv: "DANATECH_101_API_KEY",
      api: "openai-completions",
      baseURL: "http://10.33.10.101:7878/v1",
      models: [
        { id: "qwen3.8-27b-nvfp4", contextWindow: 500000, input: ["text", "image"], maxTokens: 256000 }
      ]
    }
  }
};
let revision = 42;
const settings = {
  section: (ns) => (ns === "llm-pi-ai" ? JSON.parse(JSON.stringify(section)) : undefined),
  mutate: async (ns, ops, expected) => {
    if (expected !== undefined && expected !== revision) {
      const e = new Error("conflict");
      e.name = "SettingsConflictError";
      e.expected = expected;
      e.actual = revision;
      throw e;
    }
    for (const op of ops) {
      const seg = op.path.slice();
      let cur = section;
      for (const part of seg.slice(0, -1)) {
        if (!Object.prototype.hasOwnProperty.call(cur, part)) cur[part] = {};
        cur = cur[part];
      }
      const last = seg[seg.length - 1];
      if (op.op === "set") cur[last] = JSON.parse(JSON.stringify(op.value));
      else delete cur[last];
    }
    revision += 1;
  },
  describe: () => [{ ns: "llm-pi-ai", schema: {}, value: section, applies: "live", secrets: [], revision }]
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
console.log("effects registered:", effects.length);
const { m, h, ch, o } = interceptArgs;
console.log("intercept channel:", ch, "authority:", JSON.stringify(o),
  "| matches mutate:", m("settings.mutate"), "| matches session.list:", m("session.list"));

async function fakeHandler(route, method, url, body) {
  const fr = { status: 0, body: undefined };
  fr.writeHead = (s) => { fr.status = s; };
  fr.end = (b) => { fr.body = b; };
  const reqBody = body === undefined ? undefined : body;
  const req = {
    method, url: url ?? "/",
    headers: { "x-dsh-qol": "1" },
    on: (ev, fn) => {
      if (ev === "data" && reqBody !== undefined) fn(Buffer.from(reqBody, "utf8"));
      if (ev === "end") fn();
    }
  };
  await route.handler(req, fr);
  return { status: fr.status, body: fr.body ? JSON.parse(fr.body) : undefined };
}

const mi = routes.find((r) => r.path === "/dsh-qol/model-input");

// 1. UI save drops input -> interceptor restores it (whole-profile op)
const saved = {
  apiKeyEnv: "DANATECH_101_API_KEY",
  api: "openai-completions",
  baseURL: "http://10.33.10.101:7878/v1",
  models: [{ id: "qwen3.8-27b-nvfp4", contextWindow: 500000, maxTokens: 256000 }]
};
const res = await h("settings/mutate", {
  ns: "llm-pi-ai",
  ops: [{ op: "set", path: ["providers", "danatech-101"], value: saved }],
  expectedRevision: revision
});
console.log("[1] merge on save:", res.ok === true, "| input preserved:", JSON.stringify(section.providers["danatech-101"].models[0].input), "| view.rev:", res.value && res.value.revision === revision);

// 2. explicit declaration in the draft wins (no restore)
const res2 = await h("settings/mutate", {
  ns: "llm-pi-ai",
  ops: [{ op: "set", path: ["providers", "danatech-101", "models", "0"], value: { id: "qwen3.8-27b-nvfp4", input: ["text"], contextWindow: 500000 } }],
  expectedRevision: res.value.revision
});
console.log("[2] explicit wins:", res2.ok === true, JSON.stringify(section.providers["danatech-101"].models[0].input));

// 3. conflict mapping
const res3 = await h("settings/mutate", { ns: "llm-pi-ai", ops: [], expectedRevision: 1 });
console.log("[3] conflict shape:", JSON.stringify(res3));

// 4. GET view
const g1 = await fakeHandler(mi, "GET");
console.log("[4] GET view:", g1.status === 200 && g1.body.ok, JSON.stringify(g1.body.providers["danatech-101"].models));
const g2 = await fakeHandler(mi, "GET", undefined, undefined); // no-header guard is in requireHeader:
// re-do with missing header explicitly:
{
  const fr = { status: 0, body: "" };
  fr.writeHead = (s) => { fr.status = s; };
  fr.end = (b) => { fr.body = b; };
  await mi.handler({ method: "GET", headers: {} }, fr);
  console.log("[4] no header ->", fr.status, fr.body);
}

// 5. POST toggle on/off
const p1 = await fakeHandler(mi, "POST", "x", JSON.stringify({ modelId: "qwen3.8-27b-nvfp4", image: true }));
console.log("[5] toggle on:", p1.status === 200 && p1.body.ok, JSON.stringify(p1.body.input), "section:", JSON.stringify(section.providers["danatech-101"].models[0].input));
const p2 = await fakeHandler(mi, "POST", "x", JSON.stringify({ modelId: "qwen3.8-27b-nvfp4", image: false }));
console.log("[5] toggle off:", p2.status === 200 && p2.body.ok, "input resp:", p2.body.input === undefined ? "removed" : JSON.stringify(p2.body.input), "section input gone:", section.providers["danatech-101"].models[0].input === undefined);
const p3 = await fakeHandler(mi, "POST", "x", JSON.stringify({ modelId: "does-not-exist", image: true }));
console.log("[5] unknown model ->", p3.status, p3.body.error);

// 6. cleanup effects
for (const fn of effects) fn();
console.log("[6] after cleanup: intercept:", interceptArgs === null, "| routes:", routes.length);
console.log("SMOKE OK");
