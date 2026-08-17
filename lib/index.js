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
export const inject = ["webServer", "agents", "agentPresets"];

const API_PATH = "/dsh-qol/rewrite";
const MAX_BODY_BYTES = 1_000_000;

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

export function apply(ctx) {
  const log = (...args) => console.log("[dsh-qol]", ...args);

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
  log("QoL route mounted at " + API_PATH);
}
