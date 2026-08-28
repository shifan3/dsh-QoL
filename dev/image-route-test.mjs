// 功能 7 宿主路由（GET /dsh-qol/image）冒烟测试：
// 用假 ctx（webServer 路由捕获 + 内存版 fs）驱动 lib/index.js 的 apply，
// 覆盖鉴权头、扩展名白名单、stat 分支（不存在/目录/超限）、字节下发头与
// readBytes 竞态（FS_TOO_LARGE / 通用错误）。
// 运行：node dev/image-route-test.mjs

import { apply } from "../lib/index.js";

// ---- 内存版 fs 后端（与 FileSystem 抽象同形） ----

function makeFakeFs() {
  const files = new Map(); // displayPath -> { type, bytes }
  return {
    files,
    async resolve(path) {
      return { displayPath: path, targetKey: path };
    },
    async stat(target) {
      const entry = files.get(target.displayPath);
      if (entry === undefined) return undefined;
      const size = entry.bytes !== undefined ? entry.bytes.length : undefined;
      return { version: "v1", type: entry.type, ...(size === undefined ? {} : { size }) };
    },
    async readBytes(target, signal, maxBytes) {
      const entry = files.get(target.displayPath);
      if (entry === undefined) {
        const error = new Error(`cannot read "${target.displayPath}": file not found`);
        error.code = "FS_NOT_FOUND";
        throw error;
      }
      if (entry.bytes !== undefined && entry.bytes.length > maxBytes) {
        const error = new Error(`file exceeds ${maxBytes} bytes`);
        error.code = "FS_TOO_LARGE";
        throw error;
      }
      return entry.bytes;
    }
  };
}

// ---- 假 web server / ctx ----

const routes = new Map();
let effectCount = 0;

const ctx = {
  webServer: {
    register: (spec) => {
      routes.set(spec.path, spec.handler);
      return () => routes.delete(spec.path);
    }
  },
  agents: { get: () => undefined },
  agentPresets: undefined,
  fs: makeFakeFs(),
  get: () => undefined,
  effect: () => { effectCount += 1; }
};

apply(ctx);

const imageHandler = routes.get("/dsh-qol/image");
if (typeof imageHandler !== "function") {
  console.error("FAIL  /dsh-qol/image 路由未注册");
  process.exit(1);
}

// ---- 假 req/res ----

function makeReq(url, headers = { "x-dsh-qol": "1" }) {
  return { method: "GET", url, headers };
}

function makeRes() {
  const res = { status: 0, headers: null, body: null, headersSent: false };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers || {}; res.headersSent = true; };
  res.end = (body) => { res.body = body; res.headersSent = true; };
  res.on = () => {};
  return res;
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let failures = 0;
function check(name, cond) {
  if (cond) console.log("  ok  " + name);
  else { failures += 1; console.log("FAIL  " + name); }
}

// ============ 场景 1：鉴权与参数 ============
console.log("场景 1：鉴权头与参数校验");
{
  const res = makeRes();
  await imageHandler(makeReq("/dsh-qol/image?path=/a.png", {}), res);
  check("缺少 X-DSH-QoL → 403", res.status === 403 && res.body.includes("missing X-DSH-QoL"));

  const res2 = makeRes();
  await imageHandler(makeReq("/dsh-qol/image"), res2);
  check("缺少 path → 400", res2.status === 400 && res2.body.includes("path query parameter is required"));

  const res3 = makeRes();
  await imageHandler(makeReq("/dsh-qol/image?path=/a/b.txt"), res3);
  check("非图片扩展名 → 400", res3.status === 400 && res3.body.includes("not a supported image type"));
}

// ============ 场景 2：stat 分支 ============
console.log("场景 2：stat 分支（不存在 / 目录 / 超限 / 成功）");
{
  const fs = ctx.fs;

  const resMissing = makeRes();
  await imageHandler(makeReq("/dsh-qol/image?path=" + encodeURIComponent("/no/such.png")), resMissing);
  check("文件不存在 → 404", resMissing.status === 404 && resMissing.body.includes("path not found"));

  fs.files.set("/dir.png", { type: "directory" });
  const resDir = makeRes();
  await imageHandler(makeReq("/dsh-qol/image?path=" + encodeURIComponent("/dir.png")), resDir);
  check("目录 → 400", resDir.status === 400 && resDir.body.includes("not a regular file"));

  fs.files.set("/big.png", { type: "file", bytes: Buffer.alloc(10_000_001, 0) });
  const resBig = makeRes();
  await imageHandler(makeReq("/dsh-qol/image?path=" + encodeURIComponent("/big.png")), resBig);
  check("stat 超限（>10MB）→ 413", resBig.status === 413 && resBig.body.includes("too large"));

  fs.files.set("/ok.png", { type: "file", bytes: PNG_BYTES });
  const resOk = makeRes();
  await imageHandler(makeReq("/dsh-qol/image?path=" + encodeURIComponent("/ok.png")), resOk);
  check("成功 → 200", resOk.status === 200);
  check("Content-Type = image/png", resOk.headers["Content-Type"] === "image/png");
  check("Content-Length 正确", resOk.headers["Content-Length"] === PNG_BYTES.length);
  check("Cache-Control no-store", resOk.headers["Cache-Control"] === "no-store");
  check("Content-Disposition 携带文件名", (resOk.headers["Content-Disposition"] || "").includes("ok.png"));
  check("响应体 = 原始字节", Buffer.isBuffer(resOk.body) && resOk.body.equals(PNG_BYTES));

  // 其余白名单扩展名
  fs.files.set("/a.jpeg", { type: "file", bytes: PNG_BYTES });
  fs.files.set("/b.webp", { type: "file", bytes: PNG_BYTES });
  fs.files.set("/c.gif", { type: "file", bytes: PNG_BYTES });
  const expectType = { "/a.jpeg": "image/jpeg", "/b.webp": "image/webp", "/c.gif": "image/gif" };
  for (const [p, type] of Object.entries(expectType)) {
    const r = makeRes();
    await imageHandler(makeReq("/dsh-qol/image?path=" + encodeURIComponent(p)), r);
    check("扩展名 " + p + " → " + type, r.status === 200 && r.headers["Content-Type"] === type);
  }
  // 大写扩展名
  fs.files.set("/d.PNG", { type: "file", bytes: PNG_BYTES });
  const rUpper = makeRes();
  await imageHandler(makeReq("/dsh-qol/image?path=" + encodeURIComponent("/d.PNG")), rUpper);
  check("大写扩展名 .PNG 亦识别", rUpper.status === 200 && rUpper.headers["Content-Type"] === "image/png");
}

// ============ 场景 3：readBytes 竞态与通用错误 ============
console.log("场景 3：readBytes 竞态（FS_TOO_LARGE）与通用错误");
{
  const fs = ctx.fs;
  const origReadBytes = fs.readBytes;

  fs.files.set("/race.png", { type: "file", bytes: PNG_BYTES });
  fs.readBytes = async (target, signal, maxBytes) => {
    const error = new Error(`file exceeds ${maxBytes} bytes`);
    error.code = "FS_TOO_LARGE";
    throw error;
  };
  const resRace = makeRes();
  await imageHandler(makeReq("/dsh-qol/image?path=" + encodeURIComponent("/race.png")), resRace);
  check("stat 未超限但 readBytes FS_TOO_LARGE → 413", resRace.status === 413);
  fs.readBytes = origReadBytes;

  fs.readBytes = async () => {
    const error = new Error("sandbox: file access denied under workspace-write mode");
    error.code = "FS_SANDBOX_DENIED";
    throw error;
  };
  const resErr = makeRes();
  await imageHandler(makeReq("/dsh-qol/image?path=" + encodeURIComponent("/race.png")), resErr);
  check("通用 readBytes 错误 → 500 + 错误文案", resErr.status === 500 && resErr.body.includes("sandbox: file access denied"));
  fs.readBytes = origReadBytes;
}

// ============ 汇总 ============
console.log(failures === 0 ? "\nALL PASSED" : "\n" + failures + " FAILURES");
process.exit(failures === 0 ? 0 : 1);
