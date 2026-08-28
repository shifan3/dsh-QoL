// 功能 7（read_image 工具行「查看」按钮 + 图片预览模态框）冒烟测试：
// 从 lib/client.js 切出功能 7 代码段，在伪造 DOM 上验证：
//   - 路径解析：收起摘要 "read_image · <路径>"（相对/绝对）、错误行
//     "cannot read \"<路径>\""、流式期截断 JSON / 裸 callId 拒绝、
//     summarySuffix 跳过；
//   - 按钮注入与自愈：不重复注入、路径变化刷新 dataset.path、
//     不可解析时撤按钮；
//   - 模态框：点击（捕获处理器）→ fetch 带 X-DSH-QoL 头 + 相对路径按 cwd
//     解析、blob objectURL 挂到 <img>、HTTP 错误回显宿主错误文案、
//     Esc 关闭并释放 objectURL。
// 运行：node dev/image-view-test.cjs

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const clientSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "client.js"), "utf8");

// ---- 切出功能 7 代码段（IMAGE_VIEW 常量起、apply 注释块前） ----
const startMark = 'const IMAGE_VIEW = "/dsh-qol/image";';
const endMark = "    // =====================================================================\n    // apply";
const start = clientSrc.indexOf(startMark);
const end = clientSrc.indexOf(endMark, start);
if (start === -1 || end === -1) throw new Error("feature-7 code section not found");
const featureCode = clientSrc.slice(start, end);

// ---- 最小 fake DOM（扩展自 simpleview-test：style/remove/类属性同步/
//      复合选择器 tag[attr*=v]） ----
class FakeElement {}

function makeEl(tag, attrs) {
  const el = {
    tagName: tag,
    attrs: attrs || {},
    children: [],
    parentNode: null,
    _classes: new Set(),
    innerHTML: "",
    textContent: "",
    title: "",
    dataset: {},
    style: {},
    isConnected: true,
  };
  Object.setPrototypeOf(el, FakeElement.prototype);
  el.classList = {
    add: (c) => el._classes.add(c),
    remove: (c) => el._classes.delete(c),
    contains: (c) => el._classes.has(c),
    toggle: (c, on) => (on ? el._classes.add(c) : el._classes.delete(c)),
  };
  el.getAttribute = (name) => {
    if (name === "class") return el.className;
    return name in el.attrs ? el.attrs[name] : null;
  };
  el.hasAttribute = (name) => (name === "class" ? el._classes.size > 0 : name in el.attrs);
  el.setAttribute = (name, value) => { el.attrs[name] = value; };
  el.removeAttribute = (name) => { delete el.attrs[name]; };
  // className 字符串赋值与 _classes 双向同步（真实 DOM 语义）
  Object.defineProperty(el, "className", {
    get: () => [...el._classes].join(" "),
    set: (value) => { el._classes = new Set(String(value).split(/\s+/).filter(Boolean)); },
    configurable: true,
  });
  el.appendChild = (child) => { child.parentNode = el; el.children.push(child); return child; };
  el.prepend = (child) => { child.parentNode = el; el.children.unshift(child); return child; };
  el.removeChild = (child) => {
    const i = el.children.indexOf(child);
    if (i >= 0) el.children.splice(i, 1);
    child.parentNode = null;
    return child;
  };
  el.remove = () => { if (el.parentNode) el.parentNode.removeChild(el); };
  el.addEventListener = () => {};
  el.querySelector = (sel) => querySelectorAllOnEl(el, sel).find(Boolean) || null; // 真实 DOM 无匹配时返回 null
  el.querySelectorAll = (sel) => querySelectorAllOnEl(el, sel);
  el.matches = (sel) => matches(el, sel);
  el.closest = (sel) => {
    let node = el;
    while (node) { if (matches(node, sel)) return node; node = node.parentNode; }
    return null;
  };
  el.contains = (node) => {
    let n = node;
    while (n) { if (n === el) return true; n = n.parentNode; }
    return false;
  };
  el.getBoundingClientRect = () => ({ top: el.__rectTop || 0, height: el.__height || 0 });
  return el;
}

function collectAll(root) {
  const out = [];
  (function walk(node) {
    for (const child of node.children) {
      out.push(child);
      walk(child);
    }
  })(root);
  return out;
}

// 属性片段：[name] / [name="value"] / [name*="value"]
function parseAttrSpec(spec) {
  const m = /^\[([^\]=*]+)(?:(\*?)="([^"]*)")?\]$/.exec(spec);
  if (!m) return null;
  return { name: m[1], op: m[2] === "*" ? "*=" : "=", value: m[3] };
}

function matchAttr(el, spec) {
  const actual = el.getAttribute(spec.name);
  if (actual === null) return false;
  if (spec.value === undefined) return true; // [name] 存在性
  if (spec.op === "*=") return actual.includes(spec.value);
  return actual === spec.value;
}

function matches(el, selector) {
  selector = selector.trim();
  if (selector.startsWith(".")) return el._classes.has(selector.slice(1));
  // 复合：tag + 属性列表（如 span[class*="summary"]）
  const compound = /^([a-zA-Z][a-zA-Z0-9]*)(.+)$/.exec(selector);
  if (compound) {
    if (el.tagName !== compound[1]) return false;
    let rest = compound[2];
    let ok = true;
    while (rest.length > 0) {
      const m = /^\[([^\]]+)\]/.exec(rest);
      if (!m) return false;
      const spec = parseAttrSpec(m[0]);
      if (!spec || !matchAttr(el, spec)) { ok = false; break; }
      rest = rest.slice(m[0].length);
    }
    return ok && rest === "";
  }
  if (/^[a-z]+$/i.test(selector)) return el.tagName === selector;
  const spec = parseAttrSpec(selector);
  if (spec) return matchAttr(el, spec);
  return false;
}

function querySelectorAllOnEl(el, selector) {
  const m = /^:scope > (.+)$/.exec(selector);
  if (m) return el.children.filter((child) => matches(child, m[1]));
  return collectAll(el).filter((child) => matches(child, selector));
}

// ---- 文档与 read_image 行构造 ----

function buildDoc() {
  const body = makeEl("body");
  const doc = {
    body,
    createElement: (tag) => makeEl(tag),
    querySelectorAll: (sel) => querySelectorAllOnEl(body, sel),
    querySelector: (sel) => querySelectorAllOnEl(body, sel).find(Boolean) || null,
  };
  return doc;
}

// 构造一行 read_image ToolRow DOM（与原生渲染同构：
// [data-tool][data-state] > [data-disclosure-row] > span.*_summary）
function makeReadImageRow(doc, summaryText, state) {
  const row = makeEl("div", { "data-tool": "read_image", "data-state": state || "ok" });
  const disclosure = makeEl("div", { "data-disclosure-row": "", "data-expandable": "", role: "button", tabindex: "0" });
  const leading = makeEl("span"); leading.className = "Xq2f1z_leading";
  const title = makeEl("span"); title.className = "Xq2f1z_title"; title.textContent = "Tool call";
  const sep = makeEl("span"); sep.className = "Xq2f1z_sep";
  const summary = makeEl("span"); summary.className = "o3BgMG_summary"; summary.textContent = summaryText;
  disclosure.appendChild(leading);
  disclosure.appendChild(title);
  disclosure.appendChild(sep);
  disclosure.appendChild(summary);
  row.appendChild(disclosure);
  doc.body.appendChild(row);
  return { row, disclosure, summary };
}

// ---- 在 vm 中执行功能 7 代码段，暴露内部状态/函数 ----
function makeHarness(doc, extraSandbox) {
  // vm 脚本内只能引用 sandbox 上的名字：fetchCalls/revoked 是共享数组
  // （脚本里 push 的条目测试侧可见），fetchImpl 用对象持有以便脚本内替换。
  const fetchCalls = [];
  const revoked = [];
  const fetchImpl = { fn: () => Promise.resolve({ ok: true, blob: () => Promise.resolve({}) }) };
  let blobSeq = 0;
  const sandbox = Object.assign({
    document: doc,
    Element: FakeElement,
    URL: {
      createObjectURL: () => "blob:fake-" + (++blobSeq),
      revokeObjectURL: (u) => { revoked.push(u); }
    },
    fetch: (url, opts) => { fetchCalls.push({ url, headers: opts && opts.headers }); return fetchImpl.fn(url, opts); },
    // 真实代码里由外层闭包提供（相对路径按当前会话 cwd 拼绝对）
    resolvePathForFile: (p) => (p.startsWith("/") ? p : "/cwd/" + p),
    fetchCalls,
    fetchImpl,
    revoked,
    console,
  }, extraSandbox || {});
  const script = new vm.Script(
    featureCode +
      "\n;this.__api = { syncReadImageRows, readImagePath, isImagePathText, ensureImageModal," +
      " onImageViewClickCapture, onImageViewKeydownCapture, showImageView, closeImageView, isImageModalOpen," +
      " get imageModal(){return imageModal}, get imageModalImg(){return imageModalImg}, get imageModalMsg(){return imageModalMsg}," +
      " get imageModalTitle(){return imageModalTitle}, get imageModalObjUrl(){return imageModalObjUrl}," +
      " __fetchCalls: fetchCalls, __revoked: revoked, __setFetch: (fn) => { fetchImpl.fn = fn; } };"
  );
  script.runInNewContext(sandbox);
  return sandbox.__api;
}

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log("  ok  " + name);
  } else {
    failures += 1;
    console.log("FAIL  " + name);
  }
}

function fakeEvent(target, extra) {
  return Object.assign({ target, preventDefault: () => {}, stopPropagation: () => {} }, extra || {});
}

// ============ 场景 1：路径解析 ============
console.log("场景 1：readImagePath 解析（相对 / 绝对 / 错误行 / 拒绝形态 / Suffix 跳过）");
{
  const doc = buildDoc();
  const api = makeHarness(doc);

  const rel = makeReadImageRow(doc, "read_image · dsh-src/packages/foo.png");
  check("相对路径（cwd 前缀已剥离的显示文本）", api.readImagePath(rel.row) === "dsh-src/packages/foo.png");

  const abs = makeReadImageRow(doc, "read_image · /tmp/screenshot.webp");
  check("绝对路径", api.readImagePath(abs.row) === "/tmp/screenshot.webp");

  const errRow = makeReadImageRow(doc,
    'cannot read "/mnt/data/x.png" as an image: no attachment service is mounted', "error");
  check("错误行：从失败首行提取路径", api.readImagePath(errRow.row) === "/mnt/data/x.png");

  const partial = makeReadImageRow(doc, 'read_image · {"file_path": "/a/b', "running");
  check("流式期截断 JSON 拒绝", api.readImagePath(partial.row) === null);

  const callId = makeReadImageRow(doc, "read_image · call_01HXYZ123", "running");
  check("裸 callId 拒绝（无 / 无图片扩展名）", api.readImagePath(callId.row) === null);

  const noDisc = makeEl("div", { "data-tool": "read_image" });
  doc.body.appendChild(noDisc);
  check("无 [data-disclosure-row] 的行返回 null", api.readImagePath(noDisc) === null);

  // summarySuffix（+n）排在摘要 span 之前时跳过
  const suffixed = makeEl("div", { "data-tool": "read_image", "data-state": "ok" });
  const suffDisclosure = makeEl("div", { "data-disclosure-row": "" });
  const suffCount = makeEl("span"); suffCount.className = "o3BgMG_summarySuffix"; suffCount.textContent = "+2";
  const suffSummary = makeEl("span"); suffSummary.className = "o3BgMG_summary"; suffSummary.textContent = "read_image · a/b.png";
  suffDisclosure.appendChild(suffCount);
  suffDisclosure.appendChild(suffSummary);
  suffixed.appendChild(suffDisclosure);
  doc.body.appendChild(suffixed);
  check("summarySuffix 跳过、取真实摘要 span", api.readImagePath(suffixed) === "a/b.png");

  check("isImagePathText：普通路径 true", api.isImagePathText("/a b/c.png") === true);
  check("isImagePathText：含引号 false", api.isImagePathText('/a "b".png') === false);
  check("isImagePathText：含反斜杠（JSON 转义）false", api.isImagePathText("/a\\nb.png") === false);
  check("isImagePathText：URL false", api.isImagePathText("https://x/y.png") === false);
}

// ============ 场景 2：按钮注入与自愈 ============
console.log("场景 2：syncReadImageRows 注入 / 刷新 / 撤销");
{
  const doc = buildDoc();
  const api = makeHarness(doc);
  const { row, disclosure, summary } = makeReadImageRow(doc, "read_image · dsh-src/packages/foo.png");

  api.syncReadImageRows(doc);
  const buttons = disclosure.children.filter((c) => c._classes.has("dsh-qol-imgbtn"));
  check("行尾注入一个「查看」按钮", buttons.length === 1);
  check("按钮文案 = 查看", buttons[0] && buttons[0].textContent === "查看");
  check("dataset.path = 解析出的显示路径", buttons[0] && buttons[0].dataset.path === "dsh-src/packages/foo.png");
  check("title = 路径（悬停提示）", buttons[0] && buttons[0].title === "dsh-src/packages/foo.png");

  api.syncReadImageRows(doc);
  const again = disclosure.children.filter((c) => c._classes.has("dsh-qol-imgbtn"));
  check("重复 sync 不重复注入", again.length === 1 && again[0] === buttons[0]);

  // 摘要变化（流式期 → 定型）：dataset.path 刷新
  summary.textContent = "read_image · other/bar.png";
  api.syncReadImageRows(doc);
  check("摘要变化后 dataset.path 刷新（同一按钮）", buttons[0].dataset.path === "other/bar.png");

  // 摘要退化为不可解析：按钮撤掉
  summary.textContent = 'read_image · {"file_path": "/x';
  api.syncReadImageRows(doc);
  check("不可解析时撤销已注入按钮", disclosure.children.filter((c) => c._classes.has("dsh-qol-imgbtn")).length === 0);

  // root 本身即行（MutationObserver addedNodes 情形）
  const { row: row2 } = makeReadImageRow(doc, "read_image · solo/one.gif");
  api.syncReadImageRows(row2);
  check("addedNode 即行时也能注入", row2.querySelector(".dsh-qol-imgbtn") !== null);

  // 非 read_image 行不受影响
  const otherRow = makeEl("div", { "data-tool": "read", "data-state": "ok" });
  doc.body.appendChild(otherRow);
  api.syncReadImageRows(doc);
  check("read 工具行不注入", otherRow.querySelector(".dsh-qol-imgbtn") === null);
}

// ============ 场景 3：点击 → fetch → 模态框渲染 ============
async function scenario3() {
  console.log("场景 3：点击「查看」→ fetch（头/相对解析）→ blob 渲染 + 错误回显 + Esc 关闭");
  const doc = buildDoc();
  const api = makeHarness(doc);
  const { row, disclosure, summary } = makeReadImageRow(doc, "read_image · dsh-src/packages/foo.png");
  api.syncReadImageRows(doc);
  const button = disclosure.children.find((c) => c._classes.has("dsh-qol-imgbtn"));

  // 成功路径
  api.__setFetch(() => Promise.resolve({ ok: true, blob: () => Promise.resolve({ tag: "blob" }) }));
  let pd = false, sp = false;
  api.onImageViewClickCapture(fakeEvent(button, { preventDefault: () => { pd = true; }, stopPropagation: () => { sp = true; } }));
  check("点击被捕获处理器拦截（preventDefault + stopPropagation）", pd && sp);
  check("模态框已打开", api.isImageModalOpen() === true);
  check("加载中占位文案", api.imageModalMsg.textContent === "加载中…" && !api.imageModalMsg._classes.has("err"));
  check("fetch URL 携带 cwd 解析后的绝对路径（与原生 openFile 解析语义一致）",
    api.__fetchCalls.length === 1
    && api.__fetchCalls[0].url === "/dsh-qol/image?path=" + encodeURIComponent("/cwd/dsh-src/packages/foo.png"));
  check("fetch 头带 X-DSH-QoL", api.__fetchCalls[0].headers["X-DSH-QoL"] === "1");
  await sleepFor(() => { const s = api.imageModalImg.getAttribute("src"); return s !== null && s !== ""; });
  check("<img> 挂到 blob: objectURL", api.imageModalImg.getAttribute("src") === "blob:fake-1" && api.imageModalImg.style.display === "block");
  check("标题 = cwd 解析后的绝对路径", api.imageModalTitle.textContent === "/cwd/dsh-src/packages/foo.png");
  check("模态框 DOM 挂在 body 下", api.imageModal.parentNode === doc.body);

  // 非按钮 target 不拦截
  const pd2 = { v: false };
  api.onImageViewClickCapture(fakeEvent(summary, { preventDefault: () => { pd2.v = true; } }));
  check("摘要 span 点击不被拦截（交给原生展开）", pd2.v === false);

  // 关闭时释放 objectURL
  check("关闭前未释放任何 URL", api.__revoked.length === 0);
  api.closeImageView();
  check("关闭后模态框隐藏", api.isImageModalOpen() === false);
  check("objectURL 已释放", api.__revoked.length === 1 && api.__revoked[0] === "blob:fake-1" && api.imageModalObjUrl === null);

  // HTTP 错误 → 回显宿主错误文案
  api.__setFetch(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ ok: false, error: "path not found: /cwd/foo.png" }) }));
  api.showImageView("/missing/x.png");
  await sleepFor(() => api.imageModalMsg.textContent.includes("path not found"));
  check("HTTP 错误回显宿主 error 文案", api.imageModalMsg.textContent === "path not found: /cwd/foo.png");
  check("错误文案带 err 样式类", api.imageModalMsg._classes.has("err"));
  check("失败请求不产生新 objectURL", api.__revoked.length === 1 && api.imageModalObjUrl === null);

  // fetch 网络异常
  api.__setFetch(() => Promise.reject(new Error("network down")));
  api.showImageView("/x/y.png");
  await sleepFor(() => api.imageModalMsg.textContent.includes("network down"));
  check("网络异常显示错误", api.imageModalMsg.textContent === "加载失败：network down");

  // 重新打开（同一模态框复用，不重复建 overlay）
  api.__setFetch(() => Promise.resolve({ ok: true, blob: () => Promise.resolve({}) }));
  api.showImageView("/a/b.png");
  await sleepFor(() => api.imageModalObjUrl === "blob:fake-2");
  check("模态框复用（仍只有一个 overlay）", api.imageModal.parentNode === doc.body
    && doc.body.children.filter((c) => c._classes.has("dsh-qol-imgmodal")).length === 1);
  check("新图片挂到第二个 objectURL", api.imageModalObjUrl === "blob:fake-2");

  // Esc 捕获处理器关闭（连带释放当前 objectURL）
  api.onImageViewKeydownCapture(fakeEvent(doc.body, { key: "Escape" }));
  check("Esc 关闭模态框", api.isImageModalOpen() === false);
  check("Esc 关闭释放当前 objectURL", api.__revoked.length === 2 && api.imageModalObjUrl === null);

  // 模态框未打开时 Esc 不拦截
  const escPd = { v: false };
  api.onImageViewKeydownCapture(fakeEvent(doc.body, { key: "Escape", preventDefault: () => { escPd.v = true; } }));
  check("未打开时 Esc 放行原生处理", escPd.v === false);

  // Enter 落在按钮上：stopPropagation（阻止行原生 keydown 的展开切换）
  let enterSp = false;
  api.onImageViewKeydownCapture(fakeEvent(button, { key: "Enter", stopPropagation: () => { enterSp = true; } }));
  check("Enter 在「查看」按钮上被截停", enterSp === true);
  let otherEnterSp = false;
  api.onImageViewKeydownCapture(fakeEvent(summary, { key: "Enter", stopPropagation: () => { otherEnterSp = true; } }));
  check("Enter 在其他元素上不截停", otherEnterSp === false);

  // 空路径守卫
  api.showImageView("");
  check("空路径不打开模态框", api.isImageModalOpen() === false);
}

function sleepFor(predicate, timeoutMs) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    (function poll() {
      if (predicate()) return resolve();
      if (Date.now() - t0 > (timeoutMs || 3000)) return reject(new Error("sleepFor timeout"));
      setTimeout(poll, 5);
    })();
  });
}

scenario3().then(() => {
  console.log(failures === 0 ? "\nALL PASSED" : "\n" + failures + " FAILURES");
  process.exit(failures === 0 ? 0 : 1);
}).catch((error) => {
  console.error("scenario3 crashed:", error);
  process.exit(1);
});
