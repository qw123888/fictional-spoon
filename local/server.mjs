/**
 * 本地开发服务器（wrangler 的轻量替代品）
 * ------------------------------------------------------------
 * 用法：npm run dev   然后打开 http://127.0.0.1:8787
 * 它把 Node 的 http 请求包装成 fetch Request，直接交给 src/index.js 的 Worker，
 * 所以本地跑通的逻辑，部署到 Cloudflare 上完全一致。
 * KV 用一个写穿到 local/data/kv.json 的文件实现代替（已在 .gitignore 里）。
 * 凭据从 .dev.vars 读（KEY=VALUE，一行一个）。
 */
import http from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(__dirname, "data");
const KV_FILE = path.join(DATA_DIR, "kv.json");
const PORT = Number(process.env.PORT || 8787);

// ---------- .dev.vars ----------
async function loadDevVars() {
  const file = path.join(ROOT, ".dev.vars");
  if (!existsSync(file)) return {};
  const text = await readFile(file, "utf8");
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k) env[k] = v;
  }
  return env;
}

// ---------- 文件 KV ----------
class FileKV {
  constructor(file) {
    this.file = file;
    this.cache = new Map();
    this.ready = this.#load();
    this.pending = Promise.resolve();
  }

  async #load() {
    try {
      const text = await readFile(this.file, "utf8");
      for (const [k, v] of Object.entries(JSON.parse(text))) this.cache.set(k, v);
    } catch {
      /* 首次运行没有文件 */
    }
  }

  async get(key) {
    await this.ready;
    return this.cache.has(key) ? this.cache.get(key) : null;
  }

  async put(key, value) {
    await this.ready;
    this.cache.set(key, value);
    this.#flush();
  }

  async delete(key) {
    await this.ready;
    this.cache.delete(key);
    this.#flush();
  }

  #flush() {
    this.pending = this.pending.then(async () => {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(this.file, JSON.stringify(Object.fromEntries(this.cache), null, 2));
    });
  }
}

// ---------- 静态资源 ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json"
};

async function serveStatic(pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.join(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR)) return new Response("Forbidden", { status: 403 });
  try {
    const info = await stat(target);
    if (info.isDirectory()) return serveStatic(path.join(rel, "index.html"));
    const body = await readFile(target);
    return new Response(body, { headers: { "Content-Type": MIME[path.extname(target)] || "application/octet-stream" } });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

// ---------- 主循环 ----------
const devVars = await loadDevVars();
const env = { ...devVars, NOTIFY_KV: new FileKV(KV_FILE) };

const server = http.createServer(async (req, res) => {
  const url = `http://${req.headers.host || `127.0.0.1:${PORT}`}${req.url}`;
  let body;
  if (!["GET", "HEAD"].includes(req.method)) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = Buffer.concat(chunks);
  }
  const request = new Request(url, {
    method: req.method,
    headers: req.headers,
    body: body && body.length ? body : undefined
  });

  const pathname = new URL(url).pathname;
  let response;
  try {
    response = pathname === "/api" || pathname.startsWith("/api/") ? await worker.fetch(request, env) : await serveStatic(pathname);
  } catch (err) {
    response = new Response(JSON.stringify({ ok: false, error: "server_error", detail: String(err && err.stack || err) }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }

  res.writeHead(response.status, Object.fromEntries(response.headers));
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
});

server.listen(PORT, "127.0.0.1", () => {
  const keyState = env.SPUG_APP_KEY ? "已从 .dev.vars 载入 App Key" : "未配置 SPUG_APP_KEY";
  console.log(`[phone-notify] 本地服务已启动: http://127.0.0.1:${PORT}  (${keyState})`);
  console.log(`[phone-notify] 配置/日志存储: ${KV_FILE}`);
});
