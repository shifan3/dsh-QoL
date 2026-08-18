// dsh-qol — host half (display name: dsh-QoL).
//
// Route: POST /dsh-qol/rewrite
// Body: { sessionId, messageId, text }
//
// Behaviour:
// 1. Locate the live source agent/session.
// 2. Find the user/message event with the given message id.
// 3. Cut the session log just before the turn containing that message.
// 4. Create a new child agent seeded with that prefix (same cwd, same preset,
//    same latest logged model route) and send the edited text as a new user
//    message. The old reply and everything after it are therefore discarded.

import { randomUUID } from "node:crypto";

export const name = "dsh-qol";
export const inject = ["webServer", "agents", "agentPresets", "fs", "settings", "connection"];

const API_PATH = "/dsh-qol/rewrite";
const FS_READ_PATH = "/dsh-qol/fs/read";
const FS_LIST_PATH = "/dsh-qol/fs/list";
const FS_WRITE_PATH = "/dsh-qol/fs/write";
const MAX_BODY_BYTES = 1_000_000;
const MAX_FILE_BYTES = 5_000_000;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function findUserMessage(events, messageId) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== "user/message") continue;
    if (event.data && String(event.data.id) === messageId) return event;
  }
  return undefined;
}

/** Return the turn/start event that opens the turn containing `seq`. */
function turnStartAtOrBefore(events, seq) {
  for (let index = Math.min(seq, events.length - 1); index >= 0; index -= 1) {
    const event = events[index];
    if (event && event.type === "turn/start") return event;
  }
  return undefined;
}

/** The preset a session actually runs: latest logged selection wins over header. */
function resolvePresetId(session) {
  const events = session.events;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && event.type === "agent-preset/selected" && event.data && typeof event.data.agentPreset === "string") {
      return event.data.agentPreset;
    }
  }
  return session.header.agentPreset;
}

function queryParam(req, name) {
  try {
    return new URL(req.url ?? "/", "http://x").searchParams.get(name);
  } catch {
    return undefined;
  }
}

function fsError(error) {
  return error && error.message ? error.message : String(error);
}

export function apply(ctx) {
  const log = (...args) => console.log("[dsh-qol]", ...args);

  const requireHeader = (req, res) => {
    if (req.headers["x-dsh-qol"] !== "1") {
      sendJson(res, 403, { ok: false, error: "missing X-DSH-QoL header" });
      return false;
    }
    return true;
  };

  // ---- Filesystem editor routes ----

  const unrouteFsRead = ctx.webServer.register({
    kind: "exact",
    path: FS_READ_PATH,
    handler: async (req, res) => {
      if (req.method !== "GET" || !requireHeader(req, res)) return;
      const path = queryParam(req, "path");
      if (!path) {
        sendJson(res, 400, { ok: false, error: "path query parameter is required" });
        return;
      }
      try {
        const target = await ctx.fs.resolve(path);
        const info = await ctx.fs.stat(target);
        if (info === undefined) {
          sendJson(res, 404, { ok: false, error: "path not found: " + path });
          return;
        }
        if (info.type !== "file") {
          sendJson(res, 400, { ok: false, error: "not a regular file: " + path });
          return;
        }
        if (info.size !== undefined && info.size > MAX_FILE_BYTES) {
          sendJson(res, 413, { ok: false, error: "file too large to open in the editor" });
          return;
        }
        const content = await ctx.fs.readText(target);
        sendJson(res, 200, { ok: true, path: target.displayPath, content });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: fsError(error) });
      }
    }
  });

  const unrouteFsList = ctx.webServer.register({
    kind: "exact",
    path: FS_LIST_PATH,
    handler: async (req, res) => {
      if (req.method !== "GET" || !requireHeader(req, res)) return;
      const path = queryParam(req, "path") || "";
      try {
        const target = await ctx.fs.resolve(path || ".");
        const info = await ctx.fs.stat(target);
        if (info === undefined) {
          sendJson(res, 404, { ok: false, error: "path not found: " + path });
          return;
        }
        if (info.type !== "directory") {
          sendJson(res, 400, { ok: false, error: "not a directory: " + path });
          return;
        }
        const entries = await ctx.fs.listDir(target);
        sendJson(res, 200, {
          ok: true,
          path: target.displayPath,
          entries: entries.map((entry) => ({
            name: entry.name,
            type: entry.type,
            size: entry.size,
            path: entry.target.displayPath
          }))
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: fsError(error) });
      }
    }
  });

  const unrouteFsWrite = ctx.webServer.register({
    kind: "exact",
    path: FS_WRITE_PATH,
    handler: async (req, res) => {
      if (req.method !== "POST" || !requireHeader(req, res)) return;
      let raw;
      try {
        raw = await readBody(req);
      } catch (error) {
        sendJson(res, 413, { ok: false, error: fsError(error) });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(raw || "{}");
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid JSON body" });
        return;
      }
      const path = String(payload.path || "").trim();
      const content = String(payload.content ?? "");
      if (!path) {
        sendJson(res, 400, { ok: false, error: "path is required" });
        return;
      }
      if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
        sendJson(res, 413, { ok: false, error: "file content too large to save" });
        return;
      }
      try {
        const target = await ctx.fs.resolve(path);
        const info = await ctx.fs.stat(target);
        if (info !== undefined && info.type !== "file") {
          sendJson(res, 400, { ok: false, error: "not a regular file: " + path });
          return;
        }
        await ctx.fs.writeText(target, content);
        sendJson(res, 200, { ok: true, path: target.displayPath });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: fsError(error) });
      }
    }
  });

  // ---- Feature: custom LLM image-input declaration (settings UI gap) ----
  //
  // .dsh/settings.yaml allows per-model `input: [text, image]` under the
  // `llm-pi-ai` namespace (providers.<route>.models.<i>.input), but the models
  // settings page edits provider profiles from a React draft that ignores that
  // field — every ordinary save silently drops a hand-written image declaration.
  // This half fixes both directions:
  //   * /dsh-qol/model-input serves the UI a read of the declarations and
  //     persists a single-model image toggle with a path-addressed op;
  //   * a /api interceptor over `settings/mutate` restores any `input`
  //     declaration the draft omitted before the write lands, so saving the
  //     provider form never erases them.

  const MODEL_INPUT_PATH = "/dsh-qol/model-input";
  const LLM_NS = "llm-pi-ai";
  const NS_PATTERN = /^[a-z][a-z0-9-]*$/; // dsh-settings NAMESPACE_PATTERN
  const TEXT_IMAGE = ["text", "image"];

  const settingsService = () => ctx.get("settings");

  function plainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function cloneJson(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return undefined;
    }
  }

  function apiOk(value) {
    return { ok: true, value };
  }

  function apiErr(code, message, details) {
    return { ok: false, error: { code, message, details } };
  }

  /** dsh-host-apiproxy namespaceView mirrored exactly — the client parses this shape. */
  function namespaceView(descriptor) {
    const view = {
      ns: String(descriptor.ns),
      schema: descriptor.schema,
      value: descriptor.value,
      applies: descriptor.applies,
      secrets: (descriptor.secrets ?? []).map((secret) => ({ path: [...secret.path], set: secret.set })),
      revision: descriptor.revision
    };
    if (descriptor.base !== undefined) view.base = descriptor.base;
    if (descriptor.user !== undefined) view.user = descriptor.user;
    return view;
  }

  function readSection(settings, ns) {
    try {
      return typeof settings.section === "function" ? settings.section(ns) : undefined;
    } catch {
      return undefined;
    }
  }

  function describeRevision(settings, ns) {
    try {
      const list = settings.describe({ redactSecrets: true });
      const descriptor = Array.isArray(list) ? list.find((candidate) => candidate && candidate.ns === ns) : undefined;
      return { descriptor };
    } catch {
      return { descriptor: undefined };
    }
  }

  /**
   * Walk a new provider subtree and re-attach the `input` array stored for the
   * same model `id` in the old subtree, but only when the incoming entry carries
   * no input of its own. An explicit (even shorter) declaration always wins.
   * Returns the number of declarations restored.
   */
  function restoreModelInputs(newProviders, oldProviders) {
    let restored = 0;
    if (!plainObject(newProviders) || !plainObject(oldProviders)) return restored;
    for (const route of Object.keys(newProviders)) {
      const profile = newProviders[route];
      if (!plainObject(profile) || !Array.isArray(profile.models)) continue;
      const oldProfile = oldProviders[route];
      if (!plainObject(oldProfile) || !Array.isArray(oldProfile.models)) continue;
      const oldById = new Map();
      for (const entry of oldProfile.models) {
        if (plainObject(entry) && typeof entry.id === "string" && Array.isArray(entry.input)) {
          if (!oldById.has(entry.id)) oldById.set(entry.id, entry.input);
        }
      }
      if (oldById.size === 0) continue;
      for (const entry of profile.models) {
        if (plainObject(entry) && typeof entry.id === "string" && entry.input === undefined) {
          const kept = oldById.get(entry.id);
          if (Array.isArray(kept) && kept.length > 0) {
            entry.input = cloneJson(kept);
            restored += 1;
          }
        }
      }
    }
    return restored;
  }

  /**
   * In-place merge over one settings.mutate ops array: provider-profile sets
   * (whole `providers.<route>`, the `...models` array, or a single model entry)
   * get their dropped `input` declarations restored from `oldSection`.
   */
  function mergeMutateOps(ops, oldSection) {
    const oldProviders = plainObject(oldSection) && plainObject(oldSection.providers) ? oldSection.providers : undefined;
    if (!plainObject(oldProviders)) return 0;
    let restored = 0;
    for (const op of ops) {
      if (op === null || typeof op !== "object" || op.op !== "set") continue;
      const path = op.path;
      if (!Array.isArray(path) || path.length < 2 || path[0] !== "providers" || typeof path[1] !== "string") continue;
      const value = op.value;
      if (value === undefined || value === null) continue;
      if (path.length === 2 && plainObject(value)) {
        restored += restoreModelInputs({ [path[1]]: value }, oldProviders);
      } else if (path.length === 3 && path[2] === "models" && Array.isArray(value)) {
        restored += restoreModelInputs({ [path[1]]: { models: value } }, oldProviders);
      } else if (path.length === 4 && path[2] === "models" && plainObject(value) && typeof value.id === "string" && value.input === undefined) {
        restored += restoreModelInputs({ [path[1]]: { models: [value] } }, oldProviders);
      }
    }
    return restored;
  }

  // The connection service owns the single /api interceptor slot; claims it once
  // for settings.mutate and passes every other endpoint to the real handler.
  let uninterceptApi = null;
  try {
    const connection = ctx.get("connection");
    if (connection && connection.rpc && typeof connection.rpc.intercept === "function") {
      uninterceptApi = connection.rpc.intercept(
        "/api",
        (endpoint) => endpoint === "settings.mutate",
        async (_endpoint, payload) => {
          const settings = settingsService();
          if (settings === undefined) return apiErr("internal", "settings service is unavailable", {});
          const ns = payload && typeof payload.ns === "string" ? payload.ns : "";
          if (!NS_PATTERN.test(ns)) return apiErr("settings-rejected", `settings namespace "${ns}" is not valid`, {});
          if (!Array.isArray(payload.ops)) return apiErr("settings-rejected", "settings mutate payload must carry an ops array", {});
          // Keep `input` image declarations alive across UI saves.
          mergeMutateOps(payload.ops, readSection(settings, ns));
          let writeError = undefined;
          try {
            await settings.mutate(ns, payload.ops, payload.expectedRevision);
          } catch (error) {
            writeError = error;
          }
          if (writeError !== undefined) {
            if (writeError && writeError.name === "SettingsConflictError") {
              return apiErr("settings-conflict", String(writeError.message || writeError), {
                ns,
                expected: writeError.expected,
                actual: writeError.actual
              });
            }
            return apiErr("settings-rejected", writeError instanceof Error ? writeError.message : String(writeError), { ns });
          }
          const { descriptor } = describeRevision(settings, ns);
          if (descriptor === undefined) {
            return apiErr("internal", `settings namespace "${ns}" was disposed after the mutate`, {});
          }
          return apiOk(namespaceView(descriptor));
        },
        { authority: "external" }
      );
      log("/api settings/mutate interceptor mounted (preserves model `input` declarations)");
    } else {
      log("connection service unavailable: `input` preservation disabled (UI saves may drop image declarations)");
    }
  } catch (error) {
    uninterceptApi = null;
    log("failed to claim the /api settings/mutate interceptor:", error && error.message ? error.message : error);
  }

  const unrouteModelInput = ctx.webServer.register({
    kind: "exact",
    path: MODEL_INPUT_PATH,
    handler: async (req, res) => {
      if (!requireHeader(req, res)) return;
      if (req.method === "GET") {
        const settings = settingsService();
        if (settings === undefined) {
          sendJson(res, 503, { ok: false, error: "settings service is unavailable" });
          return;
        }
        const section = readSection(settings, LLM_NS);
        const providers = plainObject(section) && plainObject(section.providers) ? section.providers : {};
        const out = {};
        for (const route of Object.keys(providers)) {
          const profile = providers[route];
          if (!plainObject(profile)) continue;
          const models = Array.isArray(profile.models) ? profile.models : [];
          out[route] = {
            api: typeof profile.api === "string" ? profile.api : undefined,
            baseURL: typeof profile.baseURL === "string" ? profile.baseURL : undefined,
            defaultInput: Array.isArray(profile.defaultInput) ? cloneJson(profile.defaultInput) : undefined,
            models: models
              .filter((model) => plainObject(model) && typeof model.id === "string")
              .map((model) => ({
                id: model.id,
                name: typeof model.name === "string" ? model.name : undefined,
                input: Array.isArray(model.input) ? cloneJson(model.input) : undefined
              }))
          };
        }
        const { descriptor } = describeRevision(settings, LLM_NS);
        sendJson(res, 200, {
          ok: true,
          ns: LLM_NS,
          revision: descriptor ? descriptor.revision : undefined,
          providers: out
        });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      let raw;
      try {
        raw = await readBody(req);
      } catch (error) {
        sendJson(res, 413, { ok: false, error: error && error.message ? error.message : "failed to read request body" });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(raw || "{}");
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid JSON body" });
        return;
      }
      const modelId = String(payload.modelId ?? "").trim();
      if (!modelId) {
        sendJson(res, 400, { ok: false, error: "modelId is required" });
        return;
      }
      const image = Boolean(payload.image);
      const settings = settingsService();
      if (settings === undefined) {
        sendJson(res, 503, { ok: false, error: "settings service is unavailable" });
        return;
      }
      const section = readSection(settings, LLM_NS);
      const providers = plainObject(section) && plainObject(section.providers) ? section.providers : {};
      let found = null;
      for (const route of Object.keys(providers)) {
        const profile = providers[route];
        if (!plainObject(profile) || !Array.isArray(profile.models)) continue;
        const index = profile.models.findIndex((model) => plainObject(model) && model.id === modelId);
        if (index >= 0) {
          found = { route, index };
          break;
        }
      }
      if (found === null) {
        sendJson(res, 404, { ok: false, error: `model "${modelId}" not found under the llm-pi-ai providers` });
        return;
      }
      const { descriptor } = describeRevision(settings, LLM_NS);
      const ops = [
        image
          ? { op: "set", path: ["providers", found.route, "models", String(found.index), "input"], value: TEXT_IMAGE }
          : { op: "unset", path: ["providers", found.route, "models", String(found.index), "input"] }
      ];
      try {
        await settings.mutate(LLM_NS, ops, descriptor ? descriptor.revision : undefined);
      } catch (error) {
        if (error && error.name === "SettingsConflictError") {
          sendJson(res, 409, {
            ok: false,
            error: "settings changed while saving; reload the models page and retry",
            details: { expected: error.expected, actual: error.actual }
          });
          return;
        }
        sendJson(res, 500, { ok: false, error: "image-input save failed: " + (error && error.message ? error.message : String(error)) });
        return;
      }
      const after = describeRevision(settings, LLM_NS);
      sendJson(res, 200, {
        ok: true,
        ns: LLM_NS,
        route: found.route,
        index: found.index,
        input: image ? TEXT_IMAGE : undefined,
        revision: after.descriptor ? after.descriptor.revision : undefined
      });
    }
  });

  const unroute = ctx.webServer.register({
    kind: "exact",
    path: API_PATH,
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      if (req.headers["x-dsh-qol"] !== "1") {
        sendJson(res, 403, { ok: false, error: "missing X-DSH-QoL header" });
        return;
      }

      let raw;
      try {
        raw = await readBody(req);
      } catch (error) {
        sendJson(res, 413, { ok: false, error: error && error.message ? error.message : "failed to read request body" });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(raw || "{}");
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid JSON body" });
        return;
      }

      const sessionId = String(payload.sessionId || "").trim();
      const messageId = String(payload.messageId || "").trim();
      const text = String(payload.text || "");
      // "rewrite" cancels the source's current work after forking;
      // "branch" leaves the source session (and its later replies) untouched.
      const mode = payload.mode === "branch" ? "branch" : "rewrite";
      if (!sessionId || !messageId || text.trim() === "") {
        sendJson(res, 400, { ok: false, error: "sessionId, messageId and non-empty text are required" });
        return;
      }

      const sourceAgent = ctx.agents.get(sessionId);
      if (sourceAgent === undefined) {
        sendJson(res, 404, { ok: false, error: "会话未在运行：请先打开该会话再编辑" });
        return;
      }
      const source = sourceAgent.session;
      if (source.header.origin === "subagent") {
        sendJson(res, 400, { ok: false, error: "暂不支持编辑 subagent 会话" });
        return;
      }

      const target = findUserMessage(source.events, messageId);
      if (target === undefined) {
        sendJson(res, 404, { ok: false, error: "找不到要编辑的消息" });
        return;
      }

      // Keep every event before the turn that contains the edited message.
      const turnStart = turnStartAtOrBefore(source.events, target.seq);
      const cut = turnStart === undefined ? 0 : turnStart.seq;

      // Preserve the session's preset (latest logged selection wins).
      let resolvedPresetId;
      if (ctx.agentPresets) {
        try {
          const preset = await ctx.agentPresets.resolve(resolvePresetId(source));
          resolvedPresetId = preset.id;
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: "agent preset unavailable: " + (error && error.message ? error.message : String(error))
          });
          return;
        }
      }

      // Preserve the latest logged model route; fall back to the live agent's
      // declared route. The agent loop re-reads request/header from the seed,
      // so reasoning effort and adapter defaults survive the cut.
      const requestHeader = typeof source.requestHeader === "function" ? source.requestHeader() : undefined;
      const persistedConfig = requestHeader && requestHeader.config;
      const declared = sourceAgent.options || {};
      let provider = (persistedConfig && persistedConfig.provider) || declared.provider;
      let model = (persistedConfig && persistedConfig.model) || declared.model;
      const maxTokens = declared.maxTokens;

      if ((!provider || !model) && ctx.get("agentDefaultModel")) {
        try {
          const fallback = ctx.get("agentDefaultModel").currentSelection();
          if (fallback) {
            provider = provider || fallback.provider;
            model = model || fallback.model;
          }
        } catch {
          // keep whatever we have
        }
      }

      const childId = "session-" + randomUUID();
      try {
        const handle = await ctx.agents.create({
          sessionId: childId,
          seed: source.events.slice(0, cut),
          meta: {
            ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
            parentSession: source.id,
            seedLength: cut,
            ...(resolvedPresetId === undefined ? {} : { agentPreset: resolvedPresetId })
          },
          ...(provider && model ? {
            agentOptions: {
              provider,
              model,
              ...(maxTokens === undefined ? {} : { maxTokens })
            }
          } : {}),
          setup: async (agentCtx) => {
            if (ctx.agentPresets) {
              await ctx.agentPresets.mount(agentCtx, resolvedPresetId);
            }
          }
        });

        const childAgent = handle.agent;

        // "rewrite": stop the old session's current work so the discarded reply
        // does not keep running beside the new child (queued work preserved).
        // "branch": leave the source session completely untouched.
        if (mode === "rewrite") {
          try {
            sourceAgent.cancel({ kind: "user" }, { keepInbox: true });
          } catch (error) {
            log("cancel source agent failed:", error && error.message ? error.message : error);
          }
        }

        childAgent.followup({
          id: "edit-" + randomUUID(),
          role: "user",
          content: [{ type: "text", text: text }],
          source: { kind: "user" }
        });

        // Attach the child to the same workspace when one owns the source.
        try {
          const registry = ctx.get("workspaceRegistry");
          if (registry && typeof registry.list === "function") {
            const workspace = registry.list().find((candidate) => candidate.sessionIds.includes(sessionId));
            if (workspace && typeof workspace.attachSession === "function") {
              await workspace.attachSession(childId);
            }
          }
        } catch (error) {
          log("workspace attach skipped:", error && error.message ? error.message : error);
        }

        sendJson(res, 200, { ok: true, childSessionId: childId });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: "rewrite failed: " + (error && error.message ? error.message : String(error))
        });
      }
    }
  });

  ctx.effect(() => unroute);
  ctx.effect(() => unrouteFsRead);
  ctx.effect(() => unrouteFsList);
  ctx.effect(() => unrouteFsWrite);
  ctx.effect(() => unrouteModelInput);
  ctx.effect(() => () => {
    if (typeof uninterceptApi === "function") uninterceptApi();
    uninterceptApi = null;
  });
  log("QoL routes mounted at " + API_PATH + ", " + FS_READ_PATH + ", " + FS_LIST_PATH + ", " + FS_WRITE_PATH + ", " + MODEL_INPUT_PATH);
}
