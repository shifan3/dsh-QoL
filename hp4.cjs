"use strict";
// hp4: selection-popup (Ctrl/⌘+M) behavior harness.
// Loads the REAL lib/client.js in a vm sandbox with a micro-DOM and fake
// sessions/workspaces host stores, then exercises the selpop flows.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const fails = [];
let count = 0;
function ok(name, cond, extra) {
  count++;
  if (!cond) { fails.push(name + (extra ? "  [" + extra + "]" : "")); console.log("FAIL  " + name + (extra ? "  [" + extra + "]" : "")); }
  else console.log("PASS  " + name);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ---------------- selector matching ---------------- */
function camelData(name) { return name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }
function getAttr(el, name) {
  if (!el || el.nodeType !== 1) return undefined;
  if (Object.prototype.hasOwnProperty.call(el._attrs, name)) return el._attrs[name];
  if (name.indexOf("data-") === 0 && el.dataset) {
    const k = camelData(name);
    if (Object.prototype.hasOwnProperty.call(el.dataset, k)) return String(el.dataset[k]);
  }
  return undefined;
}
function parseCompound(sel) {
  const c = { tag: null, classes: [], attrs: [] };
  let s = sel;
  s = s.replace(/\[([a-zA-Z0-9_-]+)\*="([^"]*)"\]/g, (_, n, v) => { c.attrs.push({ name: n, sub: v }); return ""; });
  s = s.replace(/\[([a-zA-Z0-9_-]+)="([^"]*)"\]/g, (_, n, v) => { c.attrs.push({ name: n, val: v }); return ""; });
  s = s.replace(/\[([a-zA-Z0-9_-]+)\]/g, (_, n) => { c.attrs.push({ name: n, exists: true }); return ""; });
  s = s.replace(/\.([a-zA-Z0-9_-]+)/g, (_, cl) => { c.classes.push(cl); return ""; });
  s = s.trim();
  if (s) c.tag = s.toUpperCase();
  return c;
}
function elMatchesCompound(el, c) {
  if (!el || el.nodeType !== 1) return false;
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.classes.length) {
    const cls = (el.className || "").split(/\s+/);
    for (const cl of c.classes) if (cls.indexOf(cl) === -1) return false;
  }
  for (const a of c.attrs) {
    const v = getAttr(el, a.name);
    if (a.exists && v === undefined) return false;
    if (a.val !== undefined && (v === undefined || String(v) !== a.val)) return false;
    if (a.sub !== undefined && (v === undefined || String(v).indexOf(a.sub) === -1)) return false;
  }
  return true;
}
function matchesChain(el, parts) {
  let node = el;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (i === parts.length - 1) { if (!elMatchesCompound(node, parts[i])) return false; continue; }
    let a = node.parentNode;
    let found = null;
    while (a && a.nodeType === 1) { if (elMatchesCompound(a, parts[i])) { found = a; break; } a = a.parentNode; }
    if (!found) return false;
    node = found;
  }
  return true;
}
function matchesAny(el, selector) {
  for (const part of selector.split(",")) {
    const sel = part.trim();
    if (!sel) continue;
    if (matchesChain(el, sel.split(/\s+/).map(parseCompound))) return true;
  }
  return false;
}
function collectAll(root, out) {
  for (const ch of root.children || []) out.push(ch);
  return out;
}

/* ---------------- fake DOM ---------------- */
class FakeNode {
  constructor() {
    this.nodeType = 1;
    this.tagName = "DIV";
    this.children = [];
    this.parentNode = null;
    this._attrs = {};
    this.dataset = {};
    this.style = {};
    this._lis = new Map();
    this.textContent = "";
    this.innerHTML = "";
    this.ownerDoc = null;
    this.disabled = false;
    this.readOnly = false;
    this.selectionStart = 0;
    this.selectionEnd = 0;
  }
  get className() { return (this._attrs["class"] !== undefined) ? this._attrs["class"] : ""; }
  set className(v) { this._attrs["class"] = String(v); }
  get classList() {
    const self = this;
    const words = () => (self._attrs["class"] || "").split(/\s+/).filter(Boolean);
    const setBack = (xs) => { self._attrs["class"] = xs.join(" "); };
    return {
      add: (...xs) => { const s = new Set(words()); xs.forEach((x) => s.add(x)); setBack([...s]); },
      remove: (...xs) => { const s = new Set(words()); xs.forEach((x) => s.delete(x)); setBack([...s]); },
      contains: (x) => words().indexOf(x) !== -1,
      toggle: (x) => { const s = new Set(words()); if (s.has(x)) s.delete(x); else s.add(x); setBack([...s]); },
    };
  }
  get isConnected() {
    let n = this;
    while (n) {
      if (n.nodeType === 9) return true;
      const d = n.ownerDoc;
      if (d && d.nodeType === 9 && (n === d.body || n === d.head)) return true;
      n = n.parentNode;
    }
    return false;
  }
  get nextSibling() {
    const p = this.parentNode;
    if (!p) return null;
    const i = p.children.indexOf(this);
    if (i < 0) return null;
    return p.children[i + 1] || null;
  }
  get previousSibling() {
    const p = this.parentNode;
    if (!p) return null;
    const i = p.children.indexOf(this);
    if (i <= 0) return null;
    return p.children[i - 1] || null;
  }
  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get childNodes() { return this.children; }
  appendChild(ch) {
    if (ch.parentNode && ch.parentNode !== this) ch.parentNode.removeChild(ch);
    if (ch.parentNode === this) return ch;
    ch.parentNode = this;
    this.children.push(ch);
    return ch;
  }
  insertBefore(ch, ref) {
    if (ref && ref.parentNode !== this) throw new Error("insertBefore: ref not in parent");
    if (ch.parentNode && ch.parentNode !== this) ch.parentNode.removeChild(ch);
    const i = ref ? this.children.indexOf(ref) : -1;
    ch.parentNode = this;
    if (i < 0) this.children.push(ch);
    else this.children.splice(i, 0, ch);
    return ch;
  }
  removeChild(ch) {
    const i = this.children.indexOf(ch);
    if (i < 0) throw new Error("removeChild: not a child of " + this.tagName);
    this.children.splice(i, 1);
    ch.parentNode = null;
    return ch;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(other) {
    if (!other) return false;
    let n = other;
    while (n) { if (n === this) return true; n = n.parentNode; }
    return false;
  }
  setAttribute(n, v) { this._attrs[n] = String(v); if (n.indexOf("data-") === 0) this.dataset[camelData(n)] = String(v); }
  getAttribute(n) { const v = getAttr(this, n); return v === undefined ? null : String(v); }
  hasAttribute(n) { return getAttr(this, n) !== undefined; }
  removeAttribute(n) { delete this._attrs[n]; }
  addEventListener(type, fn, opt) {
    const cap = (typeof opt === "object" && opt !== null) ? !!opt.capture : !!opt;
    if (!this._lis.has(type)) this._lis.set(type, []);
    this._lis.get(type).push({ fn, cap });
  }
  removeEventListener(type, fn, opt) {
    const cap = (typeof opt === "object" && opt !== null) ? !!opt.capture : !!opt;
    const arr = this._lis.get(type);
    if (!arr) return;
    const i = arr.findIndex((L) => L.fn === fn && L.cap === cap);
    if (i >= 0) arr.splice(i, 1);
  }
  dispatchEvent(ev) {
    if (ev.target === null) ev.target = this;
    const chain = [];
    let n = this;
    while (n && n.nodeType === 1) { chain.push(n); n = n.parentNode; }
    const topdown = ((this.ownerDoc && this.ownerDoc.nodeType === 9) ? [this.ownerDoc] : []).concat(chain.reverse());
    const fire = (node, wantCap, all) => {
      const arr = node._lis && node._lis.get(ev.type);
      if (!arr) return;
      for (const L of arr) {
        if (all || (wantCap && L.cap) || (!wantCap && !L.cap)) {
          L.fn(ev);
          if (ev._imp) break;
        }
      }
    };
    for (let i = 0; i < topdown.length - 1; i++) { if (ev._stop) return ev; fire(topdown[i], true, false); }
    if (!ev._stop) fire(topdown[topdown.length - 1], null, true);
    for (let i = topdown.length - 2; i >= 0; i--) { if (ev._stop) return ev; fire(topdown[i], false, false); }
    return ev;
  }
  click() { const ev = new FakeEvent("click", { bubbles: true }); this.dispatchEvent(ev); return ev; }
  insertAdjacentElement(position, node) {
    if (this.parentNode === null) throw new Error("insertAdjacentElement: no parent");
    if (position === "afterend") this.parentNode.insertBefore(node, this.nextSibling);
    else if (position === "beforebegin") this.parentNode.insertBefore(node, this);
    else if (position === "beforeend") throw new Error("misposition");
    else throw new Error("unsupported position " + position);
    return node;
  }
  focus() { this.isFocused = true; }
  blur() { this.isFocused = false; }
  closest(sel) { let n = this; while (n && n.nodeType === 1) { if (matchesAny(n, sel)) return n; n = n.parentNode; } return null; }
  matches(sel) { return matchesAny(this, sel); }
  querySelectorAll(sel) {
    const out = [];
    const walk = (node) => { for (const ch of node.children) { if (ch.nodeType !== 1) continue; if (matchesAny(ch, sel)) out.push(ch); walk(ch); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
}
class Element extends FakeNode {}
class HTMLElement extends Element {}
class HTMLTextAreaElement extends HTMLElement {
  constructor() { super(); this.tagName = "TEXTAREA"; this._v = ""; }
}
class HTMLInputElement extends HTMLElement {
  constructor() { super(); this.tagName = "INPUT"; this._v = ""; }
}
Object.defineProperty(HTMLTextAreaElement.prototype, "value", {
  get() { return this._v; },
  set(v) { this._v = String(v); },
  configurable: true,
});
Object.defineProperty(HTMLInputElement.prototype, "value", {
  get() { return this._v; },
  set(v) { this._v = String(v); },
  configurable: true,
});
class FakeEvent {
  constructor(type, opts) {
    opts = opts || {};
    this.type = type;
    this.bubbles = !!opts.bubbles;
    this.cancelable = opts.cancelable !== false;
    this.target = null;
    this.isComposing = opts.isComposing || false;
    this._stop = false;
    this._imp = false;
    this.defaultPrevented = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._stop = true; }
  stopImmediatePropagation() { this._stop = true; this._imp = true; }
}
class MutationObserver { constructor(cb) { this._cb = cb; } observe() {} disconnect() {} }

/* ---------------- document & plugin loader ---------------- */
function makeDocument() {
  const body = new HTMLElement();
  body.tagName = "BODY";
  const head = new HTMLElement();
  head.tagName = "HEAD";
  const _docRef = { body, head };
  body.ownerDoc = null;
  head.ownerDoc = null;
  const doc = {
    nodeType: 9,
    documentElement: body,
    body,
    head,
    _lis: new Map(),
    ownerDoc: null,
    createElement(tag) {
      const el = tag === "textarea" ? new HTMLTextAreaElement() : tag === "input" ? new HTMLInputElement() : new HTMLElement();
      el.tagName = String(tag).toUpperCase();
      el.ownerDoc = doc;
      return el;
    },
    addEventListener(type, fn, opt) {
      const cap = (typeof opt === "object" && opt !== null) ? !!opt.capture : !!opt;
      if (!this._lis.has(type)) this._lis.set(type, []);
      this._lis.get(type).push({ fn, cap });
    },
    removeEventListener(type, fn, opt) {
      const cap = (typeof opt === "object" && opt !== null) ? !!opt.capture : !!opt;
      const arr = this._lis.get(type);
      if (!arr) return;
      const i = arr.findIndex((L) => L.fn === fn && L.cap === cap);
      if (i >= 0) arr.splice(i, 1);
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => { for (const ch of node.children) { if (ch.nodeType !== 1) continue; if (matchesAny(ch, sel)) out.push(ch); walk(ch); } };
      walk(head);
      walk(body);
      return out;
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    addEventListenerX: null,
  };
  delete doc.addEventListenerX;
  body.ownerDoc = doc;
  head.ownerDoc = doc;
  return doc;
}

let CODE = null;
function loadPlugin(st) {
  if (!CODE) CODE = fs.readFileSync(path.join(__dirname, "lib/client.js"), "utf8");
  const doc = st.doc || makeDocument();
  const win = {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { href: "http://127.0.0.1:3080/" },
  };
  let loadedMod = null;
  win.__ModuleLoader__ = { load: (d) => { loadedMod = d; } };
  const sandbox = {
    window: win,
    document: doc,
    console,
    Event: FakeEvent,
    MutationObserver,
    Element,
    HTMLElement,
    HTMLTextAreaElement,
    HTMLInputElement,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    navigator: { userAgent: "hp4-test" },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
  };
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: "client.js" });
  if (!loadedMod) throw new Error("plugin module did not load");
  const mod = loadedMod.factory(() => { throw new Error("unexpected require"); });
  const effects = [];
  mod.apply({
    sessions: st.sessions,
    workspaces: st.workspaces,
    effect: (fn) => effects.push(fn),
  });
  const editorInput = doc.querySelector(".dsh-qol-editor-input");
  const editorPath = doc.querySelector(".dsh-qol-editor-path");
  if (!editorInput) throw new Error("editor input not found");
  if (st.editorFile && editorPath) editorPath.value = st.editorFile;
  const h = {
    doc,
    win,
    effects,
    editorInput,
    editorPath,
    sessions: st.sessions,
    workspaces: st.workspaces,
    cleanup() { effects.forEach((fn) => { try { fn(); } catch (e) {} }); },
  };
  return h;
}

function makeStores(st) {
  const sessions = {
    list: { getSnapshot: () => ({ current: st.current, byId: st.byId }) },
    create: (opts) => {
      st.createdOpts.push(opts);
      if (st.resolveCreate) return new Promise((resolve) => { st.resolveCreate = () => resolve("s-new"); });
      return Promise.resolve("s-new");
    },
    open: (id) => { st.openedIds.push(id); if (st.onOpen) st.onOpen(id, st); },
  };
  const workspaces = { list: { getSnapshot: () => ({ items: st.wsItems }) } };
  return { sessions, workspaces };
}

/* ---------------- fixtures ---------------- */
function newComposerCard(doc, id) {
  const card = doc.createElement("div");
  card.setAttribute("data-composer-card", "");
  const modes = doc.createElement("div");
  modes.className = "uV2eYG_modes";
  const perm = doc.createElement("button");
  perm.setAttribute("aria-label", "Access mode, current: Plan");
  modes.appendChild(perm);
  const ta = doc.createElement("textarea");
  ta.setAttribute("data-phase", "user");
  const send = doc.createElement("button");
  send.setAttribute("aria-label", "Send message");
  card.appendChild(modes);
  card.appendChild(ta);
  card.appendChild(send);
  return { el: card, textarea: ta, send, perm, modes, id };
}
function makeHome(doc) {
  const home = doc.createElement("div");
  home.id = "home";
  doc.body.appendChild(home);
  return home;
}
function makeEvent(type, target, props) {
  const ev = new FakeEvent(type, { bubbles: true });
  Object.assign(ev, props || {});
  return ev;
}
function pressM(h) { h.editorInput.dispatchEvent(makeEvent("keydown", h.editorInput, { key: "m", ctrlKey: true })); }
function keydown(h, target, key, props) { target.dispatchEvent(makeEvent("keydown", target, Object.assign({ key }, props || {}))); }
function pointerdown(h, target) { target.dispatchEvent(makeEvent("pointerdown", target, {})); }
function clickSendCard(h, card) { card.send.dispatchEvent(makeEvent("click", card.send, {})); }

/* store template */
const BASE_ST = () => ({
  current: "s-0",
  byId: { "s-0": { id: "s-0", cwd: "/proj/src/app.js", running: false, blank: false } },
  wsItems: [
    { workspaceId: "ws-1", path: "/proj", title: "proj", sessionIds: ["s-0"] },
    { workspaceId: "ws-2", path: "/other", title: "other", sessionIds: [] },
  ],
  createdOpts: [],
  openedIds: [],
  onOpen: null,
  resolveCreate: null,
});

/* ---------------- tests ---------------- */
async function main() {
  {
    // G0: no selection -> popup must not open, status hint shown
    const st = BASE_ST();
    const { sessions, workspaces } = makeStores(st);
    const h = loadPlugin({ sessions, workspaces, editorFile: "/proj/app.js" });
    const home = makeHome(h.doc);
    home.appendChild(newComposerCard(h.doc, "s-0").el);
    h.editorInput.value = "line1\nline2\nline3";
    h.editorInput.selectionStart = 0;
    h.editorInput.selectionEnd = 0;
    pressM(h);
    await sleep(20);
    const status = h.doc.querySelector(".dsh-qol-editor-status");
    ok("G0 status hint when no selection", status && status.textContent.indexOf("先选中一段文字") !== -1, "status=" + (status && status.textContent));
    const shell = h.doc.querySelector(".dsh-qol-selpop");
    ok("G0 popup not shown", !shell || shell.style.display !== "flex");
    ok("G0 home card untouched", home.querySelectorAll("[data-composer-card]").length === 1);
    h.cleanup();
  }

  {
    // G1: with selection -> open popup, card MOVED into shell (桩层), home emptied,
    // pill "2 lines selected" travels with the card, textarea enabled, nothing created
    const st = BASE_ST();
    const { sessions, workspaces } = makeStores(st);
    const h = loadPlugin({ sessions, workspaces, editorFile: "/proj/app.js" });
    const home = makeHome(h.doc);
    const card = newComposerCard(h.doc, "s-0");
    home.appendChild(card.el);
    h.editorInput.value = "aa\nbb\ncc\ndd";
    h.editorInput.selectionStart = 3; // start of "bb"
    h.editorInput.selectionEnd = 8;   // end of "cc" (L2-L3)
    pressM(h);
    await sleep(50);
    const shell = h.doc.querySelector(".dsh-qol-selpop");
    const host = shell ? shell.querySelector(".dsh-qol-selpop-host") : null;
    const moved = host ? host.querySelectorAll("[data-composer-card]") : [];
    ok("G1 shell exists & visible", !!shell && shell.style.display === "flex");
    ok("G1 card moved into shell host", moved.length === 1 && moved[0] === card.el, "in-shell=" + moved.length);
    ok("G1 home seat emptied", home.querySelectorAll("[data-composer-card]").length === 0);
    const ta = card.textarea;
    ok("G1 textarea not disabled (visible/typeable)", ta && !ta.disabled && !ta.readOnly);
    const pill = h.doc.querySelector(".dsh-qol-selpill");
    ok("G1 pill present with label", !!pill && pill.textContent === "2 lines selected", "pill=" + (pill && pill.textContent));
    ok("G1 pill inside moved card", !!pill && card.el.contains(pill));
    ok("G1 no session created on open", st.createdOpts.length === 0, "creates=" + st.createdOpts.length);
    const hint = shell ? shell.querySelector(".dsh-qol-selpop-hint") : null;
    ok("G1 hint shows card counts", !!hint && hint.textContent.indexOf("弹层1 / 页面1") !== -1, "hint=" + (hint && hint.textContent));
    h.cleanup();
  }

  {
    // G2: rapid re-press while open -> still exactly one card, nothing created
    const st = BASE_ST();
    const { sessions, workspaces } = makeStores(st);
    const h = loadPlugin({ sessions, workspaces, editorFile: "/proj/app.js" });
    const home = makeHome(h.doc);
    const card = newComposerCard(h.doc, "s-0");
    home.appendChild(card.el);
    h.editorInput.value = "aa\nbb\ncc\ndd";
    h.editorInput.selectionStart = 3;
    h.editorInput.selectionEnd = 8;
    pressM(h);
    await sleep(200);
    pressM(h);
    await sleep(400);
    const shell = h.doc.querySelector(".dsh-qol-selpop");
    const host = shell ? shell.querySelector(".dsh-qol-selpop-host") : null;
    const inShell = host ? host.querySelectorAll("[data-composer-card]").length : -1;
    const total = h.doc.querySelectorAll("[data-composer-card]").length;
    ok("G2 re-press: exactly 1 card in shell", inShell === 1, "in-shell=" + inShell);
    ok("G2 re-press: exactly 1 card on page", total === 1, "total=" + total);
    ok("G2 re-press: nothing created", st.createdOpts.length === 0, "creates=" + st.createdOpts.length);
    const pill = h.doc.querySelector(".dsh-qol-selpill");
    ok("G2 pill still present", !!pill && pill.textContent === "2 lines selected");
    h.cleanup();
  }

  {
    // G3: external session swap while open (React unmounts the moved card and
    // mounts a fresh one at home) -> the 150ms poll converges to the fresh card
    const st = BASE_ST();
    const { sessions, workspaces } = makeStores(st);
    const h = loadPlugin({ sessions, workspaces, editorFile: "/proj/app.js" });
    const home = makeHome(h.doc);
    const cardA = newComposerCard(h.doc, "s-0");
    home.appendChild(cardA.el);
    h.editorInput.value = "aa\nbb\ncc\ndd";
    h.editorInput.selectionStart = 3;
    h.editorInput.selectionEnd = 8;
    pressM(h);
    await sleep(200);
    let shell = h.doc.querySelector(".dsh-qol-selpop");
    let host = shell ? shell.querySelector(".dsh-qol-selpop-host") : null;
    ok("G3 card A moved into shell", host && host.contains(cardA.el));
    // Simulate React: unmount moved card, mount fresh card at home
    cardA.el.remove();
    const cardB = newComposerCard(h.doc, "s-1");
    home.appendChild(cardB.el);
    // Poll (150ms) must evict A (its map entry clears on parentNode null) and move B in;
    // the 1s repair interval re-places the pill (it vanished with unmounted card A)
    await sleep(1500);
    shell = h.doc.querySelector(".dsh-qol-selpop");
    host = shell ? shell.querySelector(".dsh-qol-selpop-host") : null;
    const inShell = host ? host.querySelectorAll("[data-composer-card]") : [];
    ok("G3 converged to exactly 1 card in shell", inShell.length === 1, "in-shell=" + inShell.length);
    ok("G3 fresh card B is the one in shell", inShell.length === 1 && inShell[0] === cardB.el);
    ok("G3 home seat empty again", home.querySelectorAll("[data-composer-card]").length === 0);
    const total = h.doc.querySelectorAll("[data-composer-card]").length;
    ok("G3 single card on page, no duplicates", total === 1, "total=" + total);
    ok("G3 nothing created", st.createdOpts.length === 0, "creates=" + st.createdOpts.length);
    // pill must have been re-placed onto card B (repair / move brings anchor)
    const pill = h.doc.querySelector(".dsh-qol-selpill");
    ok("G3 pill present (possibly re-placed)", !!pill, "pill=" + !!pill);
    h.cleanup();
  }

  {
    // G4: Esc closes; card returned to home with draft intact; pending disarmed;
    // subsequent plain send in home is NOT prefixed
    const st = BASE_ST();
    const { sessions, workspaces } = makeStores(st);
    const h = loadPlugin({ sessions, workspaces, editorFile: "/proj/app.js" });
    const home = makeHome(h.doc);
    const card = newComposerCard(h.doc, "s-0");
    home.appendChild(card.el);
    h.editorInput.value = "aa\nbb\ncc\ndd";
    h.editorInput.selectionStart = 3;
    h.editorInput.selectionEnd = 8;
    pressM(h);
    await sleep(200);
    let shell = h.doc.querySelector(".dsh-qol-selpop");
    let host = shell ? shell.querySelector(".dsh-qol-selpop-host") : null;
    ok("G4 opened with card in shell", host && host.contains(card.el));
    // type a draft in the (moved) card
    card.textarea.value = "user draft";
    // Esc
    keydown(h, host ? host : h.doc.body, "Escape", {});
    await sleep(20);
    shell = h.doc.querySelector(".dsh-qol-selpop");
    host = shell ? shell.querySelector(".dsh-qol-selpop-host") : null;
    ok("G4 close: shell detached/display none", !shell || shell.parentNode === null || shell.style.display === "none");
    ok("G4 close: card returned to home", home.querySelectorAll("[data-composer-card]").length === 1);
    ok("G4 close: shell has no card", !host || host.querySelectorAll("[data-composer-card]").length === 0);
    ok("G4 close: pill removed", h.doc.querySelector(".dsh-qol-selpill") === null);
    // pending must be disarmed: a home send (Ctrl+Enter) must NOT prefix
    const ta = card.textarea;
    const before = ta.value;
    ta.dispatchEvent(makeEvent("keydown", ta, { key: "Enter", ctrlKey: true }));
    await sleep(10);
    ok("G4 close: later home send not prefixed", ta.value === before, "value=" + JSON.stringify(ta.value));
    h.cleanup();
  }

  {
    // G5: send inside the open popup -> reroute: card returned home, new session
    // created with workspaceId of current workspace + opened, fresh home card is
    // ready and moved into the shell, composite (block + user text) injected,
    // pill gone, popup auto-closes leaving the fresh card's draft at home.
    const st = BASE_ST();
    const { sessions, workspaces } = makeStores(st);
    const h = loadPlugin({ sessions, workspaces, editorFile: "/proj/app.js" });
    const home = makeHome(h.doc);
    const card = newComposerCard(h.doc, "s-0");
    home.appendChild(card.el);
    st.onOpen = (id) => {
      // React view swap: old home card unmounts, fresh card mounts
      const old = home.querySelectorAll("[data-composer-card]")[0];
      if (old) old.remove();
      const fresh = newComposerCard(h.doc, id);
      home.appendChild(fresh.el);
      st.freshCard = fresh;
    };
    h.editorInput.value = "aa\nbb\ncc\ndd";
    h.editorInput.selectionStart = 3;
    h.editorInput.selectionEnd = 8;
    pressM(h);
    await sleep(200);
    const ta = card.textarea;
    ok("G5 shell card is current session's, editable", !ta.disabled && !ta.readOnly);
    ta.value = "explain this";
    const ev = ta.dispatchEvent(makeEvent("keydown", ta, { key: "Enter", ctrlKey: true }));
    ok("G5 ctrl+enter intercepted", ev.defaultPrevented === true);
    await sleep(300); // create resolves (microtask), retry moves fresh card
    const shell = h.doc.querySelector(".dsh-qol-selpop");
    const host = shell ? shell.querySelector(".dsh-qol-selpop-host") : null;
    const inShell = host ? host.querySelectorAll("[data-composer-card]") : [];
    ok("G5 exactly 1 card in shell after reroute", inShell.length === 1, "n=" + inShell.length);
    ok("G5 in-shell card is the fresh session's", inShell.length === 1 && st.freshCard && inShell[0] === st.freshCard.el);
    const fta = st.freshCard ? st.freshCard.textarea : null;
    const v = fta ? fta.value : "(none)";
    ok("G5 composite injected: block + user text",
       v.indexOf("文件: /proj/app.js") === 0 && v.indexOf("行号: L2-L3") !== -1 && v.endsWith("explain this"),
       "v=" + JSON.stringify(String(v).slice(0, 90)));
    ok("G5 new session created via workspaceId only",
       st.createdOpts.length === 1 && st.createdOpts[0].workspaceId === "ws-1" && !("cwd" in st.createdOpts[0]),
       "opts=" + JSON.stringify(st.createdOpts));
    ok("G5 opened the new session", st.openedIds.indexOf("s-new") !== -1, "opened=" + JSON.stringify(st.openedIds));
    ok("G5 pill cleared after send", h.doc.querySelector(".dsh-qol-selpill") === null);
    const hint = shell ? shell.querySelector(".dsh-qol-selpop-hint") : null;
    ok("G5 shell still visible during final swap", !!hint && shell && shell.style.display === "flex", "display=" + (shell && shell.style.display));
    await sleep(800); // 600ms auto-close
    const shell2 = h.doc.querySelector(".dsh-qol-selpop");
    ok("G5 popup auto-closed after send", !shell2 || shell2.parentNode === null || shell2.style.display === "none");
    const v2 = st.freshCard ? st.freshCard.textarea.value : "";
    ok("G5 fresh card returned home with composite intact", v2 === v, "v2=" + JSON.stringify(String(v2).slice(0, 40)));
    h.cleanup();
  }

  {
    // G6: user closes (Esc) while the new-session create is still in flight ->
    // reroute abandons; the freshly opened session's card must stay clean (no
    // silent composite), original draft preserved, popup never reappears.
    const st = BASE_ST();
    st.resolveCreate = true; // sentinel: make create() defer
    const { sessions, workspaces } = makeStores(st);
    const h = loadPlugin({ sessions, workspaces, editorFile: "/proj/app.js" });
    const home = makeHome(h.doc);
    const card = newComposerCard(h.doc, "s-0");
    home.appendChild(card.el);
    st.onOpen = (id) => {
      const fresh = newComposerCard(h.doc, id);
      home.appendChild(fresh.el);
      st.freshCard = fresh;
    };
    h.editorInput.value = "aa\nbb\ncc\ndd";
    h.editorInput.selectionStart = 3;
    h.editorInput.selectionEnd = 8;
    pressM(h);
    await sleep(200);
    const ta = card.textarea;
    ta.value = "draft in shell";
    ta.dispatchEvent(makeEvent("keydown", ta, { key: "Enter", ctrlKey: true }));
    const finishCreate = st.resolveCreate; // now the resolver function
    ok("G6 create deferred (resolver captured)", typeof finishCreate === "function");
    // Esc during the swap window
    keydown(h, h.doc.body, "Escape", {});
    await sleep(20);
    const shell = h.doc.querySelector(".dsh-qol-selpop");
    ok("G6 popup closed by Esc", !shell || shell.parentNode === null || shell.style.display === "none");
    finishCreate(); // let the in-flight create settle
    await sleep(60); // create resolves -> open() -> rerouteRetry must abort
    ok("G6 session was created (1x)", st.createdOpts.length === 1, "n=" + st.createdOpts.length);
    ok("G6 new session opened but reroute abandoned", st.openedIds.indexOf("s-new") !== -1);
    const host = shell ? (shell.querySelector(".dsh-qol-selpop-host") || null) : null;
    ok("G6 no card parked in closed shell", !host || host.querySelectorAll("[data-composer-card]").length === 0);
    ok("G6 fresh card never received composite", st.freshCard && st.freshCard.textarea.value === "",
       "fresh=" + JSON.stringify(st.freshCard && st.freshCard.textarea.value));
    const homeCards = home.querySelectorAll("[data-composer-card]");
    const origCard = homeCards.find((c) => c === card.el);
    ok("G6 original draft card still home with text", !!origCard && card.textarea.value === "draft in shell",
       "home=" + homeCards.length);
    h.cleanup();
  }

  {
    // G7: pointerdown outside the popup closes it (pill cleared, card home)
    const st = BASE_ST();
    const { sessions, workspaces } = makeStores(st);
    const h = loadPlugin({ sessions, workspaces, editorFile: "/proj/app.js" });
    const home = makeHome(h.doc);
    const card = newComposerCard(h.doc, "s-0");
    home.appendChild(card.el);
    h.editorInput.value = "aa\nbb\ncc\ndd";
    h.editorInput.selectionStart = 3;
    h.editorInput.selectionEnd = 8;
    pressM(h);
    await sleep(200);
    let shell = h.doc.querySelector(".dsh-qol-selpop");
    let host = shell ? shell.querySelector(".dsh-qol-selpop-host") : null;
    ok("G7 opened (card in shell)", host && host.contains(card.el));
    pointerdown(h, home); // click outside the popup
    await sleep(20);
    shell = h.doc.querySelector(".dsh-qol-selpop");
    host = shell ? shell.querySelector(".dsh-qol-selpop-host") : null;
    ok("G7 outside click closes popup", !shell || shell.parentNode === null || shell.style.display === "none");
    ok("G7 card returned home", home.querySelectorAll("[data-composer-card]").length === 1);
    ok("G7 pill cleared", h.doc.querySelector(".dsh-qol-selpill") === null);
    h.cleanup();
  }

  {
    // G8: React re-render drops the injected pill (our button is not React state);
    // the 1s repair interval must re-place it on the (moved) shell card
    const st = BASE_ST();
    const { sessions, workspaces } = makeStores(st);
    const h = loadPlugin({ sessions, workspaces, editorFile: "/proj/app.js" });
    const home = makeHome(h.doc);
    const card = newComposerCard(h.doc, "s-0");
    home.appendChild(card.el);
    h.editorInput.value = "aa\nbb\ncc\ndd";
    h.editorInput.selectionStart = 3;
    h.editorInput.selectionEnd = 8;
    pressM(h);
    await sleep(200);
    let pill = h.doc.querySelector(".dsh-qol-selpill");
    ok("G8 pill initially placed", !!pill, "pill=" + !!pill);
    if (pill) pill.remove(); // simulate React re-render dropping it
    await sleep(1300); // 1s repair interval
    pill = h.doc.querySelector(".dsh-qol-selpill");
    ok("G8 pill re-placed by repair loop", !!pill, "pill=" + !!pill);
    const shell = h.doc.querySelector(".dsh-qol-selpop");
    ok("G8 re-placed pill is inside the shell card", !!pill && shell && shell.contains(pill));
    h.cleanup();
  }

  {
    // G9: edit (pencil) flow with the CURRENT DSH row shape:
    // wrapper > userRow > userStack > [bubble], plus an actions row.
    // The inline editor must open IN the bubble's seat (same line), not
    // appended after the whole row (old bug: wrapper.insertBefore(editor, null)).
    const doc9 = makeDocument();
    const st9 = BASE_ST();
    const stores9 = makeStores(st9);
    const home9 = doc9.createElement("div");
    doc9.body.appendChild(home9);
    // message row (built BEFORE loadPlugin so the startup scan decorates it)
    const uuid9 = "6a1f2c00-0000-4000-8000-000000000001";
    const wrapper = doc9.createElement("div");
    wrapper.setAttribute("data-chat-flow-kind", "user");
    wrapper.setAttribute("data-chat-anchor-key", "13:input-message" + uuid9);
    wrapper.className = "X_flowItem";
    const userRow = doc9.createElement("div");
    userRow.className = "X_userRow";
    const userStack = doc9.createElement("div");
    userStack.className = "X_userStack";
    const bubble = doc9.createElement("div");
    bubble.className = "X_bubble";
    bubble.innerText = "hello old line";
    userStack.appendChild(bubble);
    const actionsRow = doc9.createElement("div");
    actionsRow.className = "X_actions";
    const copyBtn = doc9.createElement("button");
    copyBtn.className = "X_action";
    copyBtn.setAttribute("aria-label", "Copy");
    actionsRow.appendChild(copyBtn);
    userRow.appendChild(userStack);
    userRow.appendChild(actionsRow);
    wrapper.appendChild(userRow);
    home9.appendChild(wrapper);
    const h9 = loadPlugin({ sessions: stores9.sessions, workspaces: stores9.workspaces, editorFile: "/proj/app.js", doc: doc9 });
    const pencil = wrapper.querySelector(".dsh-qol-edit");
    ok("G9 pencil injected by startup scan", !!pencil);
    if (pencil) pencil.click();
    await sleep(5);
    const editor = wrapper.querySelector(".dsh-qol-editor");
    ok("G9 editor opened", !!editor);
    ok("G9 bubble hidden while editing", bubble.style.display === "none");
    ok("G9 editor sits in the bubble's parent (same line), NOT the wrapper",
       !!editor && editor.parentNode === userStack && editor.parentNode !== wrapper,
       "parent=" + (editor && editor.parentNode && (editor.parentNode.className || editor.parentNode.tagName)));
    ok("G9 editor inserted at the bubble's seat (right after bubble)", !!editor && editor.previousSibling === bubble);
    const ta9 = editor ? editor.querySelector(".dsh-qol-textarea") : null;
    ok("G9 textarea pre-filled with original text", !!ta9 && ta9.value === "hello old line", "value=" + JSON.stringify(ta9 && ta9.value));
    ok("G9 textarea focused", !!ta9 && ta9.isFocused === true);
    const cancel9 = editor ? editor.querySelector(".dsh-qol-cancel") : null;
    if (cancel9) cancel9.click();
    await sleep(5);
    ok("G9 cancel removes editor and restores bubble", wrapper.querySelector(".dsh-qol-editor") === null && bubble.style.display === "");
    const ta9b = wrapper.querySelector(".dsh-qol-textarea");
    ok("G9 no stale textarea after cancel", ta9b === null);
    h9.cleanup();
    doc9.body.children.length;
  }

  if (fails.length) {
    console.log("\nFAILURES(" + fails.length + "):\n" + fails.map((f) => "  - " + f).join("\n"));
    process.exit(1);
  }
  console.log("\nALL " + count + " ASSERTIONS PASSED");
  process.exit(0);
}

main().catch((err) => { console.error("HARNESS ERROR", err); process.exit(2); });
