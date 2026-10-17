/**
 * Host half of @local/dsh-px0-preview.
 *
 * Owns four things for the Client tab:
 *  1. The px0 binary: resolved from Config.px0Path, then the bundle's bin/
 *     cache, otherwise downloaded once from GitHub Releases for this
 *     platform/arch and sha256-verified against checksums.txt.
 *  2. The px0 process: spawned on 127.0.0.1 with a free port and
 *     -base-path /px0/, restarted after an update, killed on unload.
 *  3. The /px0/* web route: a loopback reverse proxy that streams requests
 *     to px0 (SSE included) and strips px0's hardcoded
 *     Content-Security-Policy (frame-ancestors 'none') and X-Frame-Options
 *     response headers so the same-origin iframe in the right sidebar can
 *     embed it. px0 itself stays bound to 127.0.0.1 and is unreachable
 *     except through this authenticated origin — the strip is deliberate
 *     and scoped to this route only.
 *  4. A Typert Remote namespace `px0Preview` (status/start/update) so the
 *     Client tab can observe and drive the above through `ctx.remote.px0Preview`.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { PX0_EXTRAS_SCRIPT } from './px0-extras.js';

const REPO = 'px0-ai/px0';
const BASE_PATH = '/px0/';
const BIN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'bin');
const BIN_NAME = process.platform === 'win32' ? 'px0.exe' : 'px0';
const BIN_PATH = join(BIN_DIR, BIN_NAME);
const VERSION_FILE = join(BIN_DIR, 'version.txt');

/** Plugin configuration schema. */
export const Config = {
  type: 'object',
  properties: {
    px0Path: {
      type: 'string',
      description: 'Absolute path to a user-provided px0 binary. Overrides the managed download.',
    },
  },
  additionalProperties: false,
};

function assetName(version) {
  const os = { win32: 'windows', darwin: 'darwin', linux: 'linux', freebsd: 'freebsd', openbsd: 'openbsd', netbsd: 'netbsd' }[process.platform];
  const arch = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm', riscv64: 'riscv64' }[process.arch];
  if (!os || !arch) throw new Error(`unsupported platform: ${process.platform}/${process.arch}`);
  const ext = process.platform === 'win32' ? '.exe' : '';
  return `px0-${version}-${os}-${arch}${ext}`;
}

async function fetchJson(url, signal) {
  const res = await fetch(url, { signal, headers: { 'user-agent': 'dsh-px0-preview' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function fetchText(url, signal) {
  const res = await fetch(url, { signal, headers: { 'user-agent': 'dsh-px0-preview' } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

async function latestRelease(signal) {
  try {
    const j = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`, signal);
    return { version: String(j.tag_name || '').replace(/^v/, ''), assets: j.assets || [] };
  } catch {
    const v = (await fetchText(`https://raw.githubusercontent.com/${REPO}/master/VERSION`, signal)).trim();
    return { version: v, assets: [] };
  }
}

async function downloadBinary(version, signal) {
  const name = assetName(version);
  const tmp = `${BIN_PATH}.download`;
  await fs.mkdir(BIN_DIR, { recursive: true });
  try {
    const res = await fetch(`https://github.com/${REPO}/releases/download/v${version}/${name}`, {
      signal, headers: { 'user-agent': 'dsh-px0-preview' },
    });
    if (!res.ok || !res.body) throw new Error(`download ${name} -> ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    // Verify against the release checksums when reachable; a checksums fetch
    // failure is tolerated, a proven mismatch is not.
    try {
      const sums = await fetchText(`https://github.com/${REPO}/releases/download/v${version}/checksums.txt`, signal);
      const line = sums.split(/\r?\n/).find(l => l.includes(name));
      const expected = line?.match(/[0-9a-f]{64}/)?.[0];
      if (expected) {
        const buf = await fs.readFile(tmp);
        const actual = createHash('sha256').update(buf).digest('hex');
        if (actual !== expected) throw new Error(`sha256 mismatch for ${name}`);
      }
    } catch (e) {
      if (String(e?.message).includes('mismatch')) throw e;
    }
    if (process.platform !== 'win32') await fs.chmod(tmp, 0o755);
    await fs.rename(tmp, BIN_PATH);
    await fs.writeFile(VERSION_FILE, version, 'utf8');
    return BIN_PATH;
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * Insert the context-menu extension script into px0's app document, just
 * before its closing body tag (or at the end when that tag is absent).
 * @param {string} html the app document as px0 served it
 */
function injectExtras(html) {
  const tag = `<script>${PX0_EXTRAS_SCRIPT}</script>`;
  const at = html.lastIndexOf('</body>');
  return at === -1 ? html + tag : html.slice(0, at) + tag + html.slice(at);
}

/**
 * Whether a request is one of px0's own sub-resources rather than the app
 * document. Sub-resources must never receive the HTML loading page.
 * @param {string} url request URL under the /px0 prefix
 */
function isSubResource(url) {
  const pathname = url.split('?')[0];
  if (pathname.startsWith('/px0/static/') || pathname.startsWith('/px0/api/')) return true;
  const last = pathname.slice(pathname.lastIndexOf('/') + 1);
  return last.includes('.');
}

/**
 * The transient page an iframe shows while px0 is starting or restarting.
 * Self-contained: px0 is not serving anything yet, so it cannot borrow px0's
 * assets. Polls the control plane and reloads into px0 once it is ready.
 * @param {string} state current service state
 * @param {string} [error] last failure message, when the state is a failure
 */
function loadingPage(state, error) {
  const message = state === 'downloading' ? '正在下载 px0…'
    : state === 'updating' ? '正在更新 px0…'
      : state === 'failed' ? 'px0 启动失败'
        : '正在启动 px0…';
  const detail = error ? String(error).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) : '';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>px0</title>
<style>
  html,body{height:100%;margin:0}
  body{display:grid;place-items:center;background:#1e1e2e;color:#cdd6f4;
       font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  .box{display:flex;flex-direction:column;align-items:center;gap:14px}
  .mark{font-size:30px;font-weight:600;letter-spacing:.05em;color:#f9e2af}
  .spin{width:22px;height:22px;border:2px solid #45475a;border-top-color:#89b4fa;
        border-radius:50%;animation:r .8s linear infinite}
  @keyframes r{to{transform:rotate(360deg)}}
  .msg{color:#a6adc8}
  .err{color:#f38ba8;max-width:480px;text-align:center;word-break:break-all;font-size:12px}
</style></head>
<body><div class="box">
  <div class="mark">px0</div>
  <div class="spin"></div>
  <div class="msg">${message}</div>
  ${detail ? `<div class="err">${detail}</div>` : ''}
</div>
<script>
  (function poll() {
    fetch('/px0-api/status', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (s && s.state === 'ready' && s.port) { location.reload(); return; }
        setTimeout(poll, 700);
      })
      .catch(function () { setTimeout(poll, 1200); });
  })();
</script>
</body></html>`;
}

class Px0PreviewService {
  static inject = ['webServer', 'subprocess'];
  constructor(ctx, config) {
    this.ctx = ctx;
    this.name = 'px0Preview';
    this.config = config;
    this.status = { state: 'idle', managed: true };
    this.handle = null;
    this.inflight = null;

    // A Service subclass registers itself as `ctx.px0Preview`; a plain class
    // must publish explicitly for other plugins.
    const disposeProvide = ctx.provide('px0Preview', this);
    ctx.effect(() => disposeProvide, 'px0: service provide');

    // JSON control plane for the Client tab. Typert Remote namespaces only
    // reach the browser when the package ships a generated `./typert` face,
    // so this plugin speaks plain HTTP under its own webServer prefix
    // instead: /px0-api/status, /px0-api/start, /px0-api/update,
    // /px0-api/openRoot.
    const disposeApi = ctx.webServer.register({
      kind: 'prefix',
      path: '/px0-api',
      handler: (req, res) => this.api(req, res),
    });
    ctx.effect(() => () => disposeApi(), 'px0: /px0-api route');

    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: '/px0',
      handler: (req, res) => this.proxy(req, res),
    });
    ctx.effect(() => () => disposeRoute(), 'px0: /px0 route');
    ctx.logger?.info?.('px0: registered /px0 prefix route');
    ctx.effect(() => () => {
      if (this.handle) { this.handle.terminate(); this.handle = null; }
    }, 'px0: process teardown');

    // Warm up in the background so the first tab opens fast.
    this.start();
  }

  /** The directory px0 is currently serving, for the status snapshot. */
  snapshot() {
    return { ...this.status, root: this.rootHint ?? null };
  }

  async resolveBinary(signal) {
    if (this.config.px0Path) {
      this.status.managed = false;
      return this.config.px0Path;
    }
    try {
      await fs.access(BIN_PATH);
      return BIN_PATH;
    } catch { /* fall through to download */ }
    const rel = await latestRelease(signal);
    this.status.latestVersion = rel.version;
    this.status = { ...this.status, state: 'downloading' };
    const p = await downloadBinary(rel.version, signal);
    this.status.currentVersion = rel.version;
    return p;
  }

  async awaitPort(handle) {
    // px0 logs its listening address on stderr (not stdout) as
    // `url: http://127.0.0.1:<port>`; with -verbose it also narrates on stdout.
    // Parse both streams for that exact address. Never probe a guessed port:
    // another process (or a stale px0) could answer and poison the proxy.
    let text = '';
    const decoder = new TextDecoder();
    const deadline = Date.now() + 25000;
    const scan = async (stream) => {
      if (!stream) return undefined;
      try {
        for await (const chunk of stream) {
          text += decoder.decode(chunk, { stream: true });
          const m = text.match(/https?:\/\/127\.0\.0\.1:(\d+)/);
          if (m) return Number(m[1]);
          if (Date.now() > deadline) break;
        }
      } catch { /* stream closed */ }
      return undefined;
    };
    const port = await Promise.race([scan(handle.stdout), scan(handle.stderr)]);
    if (port) return port;
    throw new Error('could not determine px0 port from its startup output');
  }

  /**
   * The directory px0 roots itself at. The Client names it through openRoot;
   * px0 fixes its root for the process lifetime, so one process serves one
   * workspace.
   */
  async workspaceRoot() {
    if (this.rootHint) return this.rootHint;
    const wd = this.ctx.get('workingDirectory');
    return wd?.defaultDirectory || process.cwd();
  }

  async start() {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const wasUpdating = this.status.state === 'updating';
        this.status = { ...this.status, state: wasUpdating ? 'updating' : 'starting', error: undefined };
        const bin = await this.resolveBinary();
        const cwd = await this.workspaceRoot();
        if (this.handle) { this.handle.terminate(); await this.handle.waitForExit().catch(() => {}); this.handle = null; }
        const handle = this.ctx.subprocess.spawn({
          argv: [bin, '-port', '0', '-host', '127.0.0.1', '-no-open', '-no-update',
                 '-no-telemetry', '-no-agent', '-base-path', BASE_PATH, cwd],
          cwd,
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
          graceMs: 3000,
        });
        this.handle = handle;
        handle.done.then(() => {
          if (this.handle === handle && this.status.state === 'ready') {
            this.status = { ...this.status, state: 'failed', error: 'px0 exited' };
          }
        }).catch(() => {});
        const port = await this.awaitPort(handle);
        if (!this.status.currentVersion) {
          this.status.currentVersion = await fs.readFile(VERSION_FILE, 'utf8').then(v => v.trim()).catch(() => undefined);
        }
        this.status = { ...this.status, state: 'ready', port };
        // One update check per plugin run; silent on failure or unmanaged binary.
        if (this.status.managed) {
          latestRelease().then(rel => {
            if (rel.version && rel.version !== this.status.currentVersion) {
              this.status = { ...this.status, latestVersion: rel.version };
            }
          }).catch(() => {});
        }
      } catch (e) {
        this.status = { ...this.status, state: this.status.state === 'idle' ? 'missing' : 'failed', error: String(e?.message || e) };
      } finally {
        this.inflight = null;
      }
      return this.snapshot();
    })();
    return this.inflight;
  }

  async applyUpdate() {
    if (!this.status.managed) return { ...this.status, error: 'px0 is user-managed (px0Path); update it manually' };
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        this.status = { ...this.status, state: 'updating' };
        const rel = await latestRelease();
        await downloadBinary(rel.version);
        this.status.currentVersion = rel.version;
        this.status.latestVersion = undefined;
        this.inflight = null;
        return this.start(); // restart with the new binary
      } catch (e) {
        this.status = { ...this.status, state: 'failed', error: String(e?.message || e) };
        this.inflight = null;
        return this.snapshot();
      }
    })();
    return this.inflight;
  }

  /**
   * Same-origin reverse proxy: /px0/<rest> -> http://127.0.0.1:<port>/px0/<rest>.
   * Streams both ways (SSE passes through untouched) and removes px0's
   * frame-ancestors 'none' CSP and X-Frame-Options so the sidebar iframe can
   * embed it. Deliberate and scoped to this route; px0 stays loopback-only.
   *
   * A browser that navigates away or closes the iframe resets this socket
   * mid-stream. That surfaces as an unhandled `terminated` rejection inside
   * the piped Readable and would take down the whole Host process, so every
   * error path here (client disconnect, upstream abort, pipe failure) is
   * caught and the response is simply dropped.
   */
  async proxy(req, res) {
    if (this.status.state !== 'ready' || !this.status.port) {
      // A document request during a restart must get a page it can render,
      // not a JSON error the iframe shows as "fetch failed". Sub-resources
      // (anything with an extension or a /static or /api path) keep the JSON
      // failure so px0's own code sees a clean error instead of HTML.
      const wantsDocument = !isSubResource(req.url ?? '/');
      if (wantsDocument) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(loadingPage(this.status.state, this.status.error));
      } else {
        res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ state: this.status.state, error: this.status.error || null }));
      }
      return;
    }
    // The client can vanish at any point; never let that escape as a throw.
    res.on('error', () => {});
    req.on('error', () => {});

    const upstreamAbort = new AbortController();
    const fail = (status, error) => {
      if (res.writableEnded || res.destroyed) return;
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error }));
      } else {
        res.destroy();
      }
    };

    try {
      // Strip the public /px0 prefix: px0 serves its UI at /px0/ (it was
      // started with -base-path) but its own JSON API and assets live at the
      // root of that same prefix, so /px0/api/x must reach /px0/api/x and
      // /px0/static/x must reach /px0/static/x — which is exactly the
      // unprefixed remainder appended to the base path.
      const raw = req.url ?? '/';
      const withoutPrefix = raw.startsWith('/px0') ? raw.slice('/px0'.length) : raw;
      const target = `http://127.0.0.1:${this.status.port}${BASE_PATH.replace(/\/$/, '')}${withoutPrefix.startsWith('/') ? '' : '/'}${withoutPrefix}`;
      const headers = { ...req.headers };
      delete headers.host;
      delete headers.connection;
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
        duplex: 'half',
        signal: upstreamAbort.signal,
      });
      const out = {};
      upstream.headers.forEach((v, k) => {
        const lk = k.toLowerCase();
        if (lk === 'content-security-policy' || lk === 'x-frame-options' || lk === 'content-length' || lk === 'content-encoding' || lk === 'transfer-encoding') return;
        out[k] = v;
      });
      if (res.writableEnded || res.destroyed) { upstreamAbort.abort(); return; }
      const contentType = String(upstream.headers.get('content-type') || '');
      if (contentType.includes('text/html') && upstream.body) {
        // px0 has no extension API, so its own document is rewritten in flight
        // to carry the context-menu additions. Only the app document is HTML;
        // its assets and API replies stream through untouched.
        const html = await upstream.text();
        res.writeHead(upstream.status, out);
        res.end(injectExtras(html));
        return;
      }
      res.writeHead(upstream.status, out);
      if (!upstream.body) { res.end(); return; }
      const body = Readable.fromWeb(upstream.body);
      // Closing the iframe must stop the upstream stream rather than reject it
      // into an unhandled Promise.
      res.on('close', () => {
        upstreamAbort.abort();
        body.destroy();
      });
      body.on('error', () => { upstreamAbort.abort(); if (!res.writableEnded) res.destroy(); });
      body.pipe(res);
    } catch (e) {
      // A restart window (old px0 gone, new one not listening yet) surfaces
      // here as a connection failure. A document request gets the loading
      // page; anything else keeps the plain failure.
      if (upstreamAbort.signal.aborted) return;
      if (!isSubResource(req.url ?? '/') && !res.headersSent) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(loadingPage(this.status.state, this.status.error || String(e?.message || e)));
        return;
      }
      fail(502, String(e?.message || e));
    }
  }

  // --- Typert Remote endpoints (Client calls ctx.remote.px0Preview.*) ---

  /** Current status snapshot. */
  async status() {
    return this.snapshot();
  }

  /**
   * Root px0 at one absolute directory, restarting it when the root changes.
   *
   * px0 fixes its root for the process lifetime (it is a directory argument,
   * not a query), so a changed root means a restart. An idle Session has no
   * live agent to ask, so the caller passes the directory it already knows
   * rather than a Session id.
   * @param {string} root absolute directory to serve
   */
  async openRoot(root) {
    if (typeof root !== 'string' || root.length === 0) return this.snapshot();
    let isDir = false;
    try { isDir = (await fs.stat(root)).isDirectory(); } catch { isDir = false; }
    if (!isDir) return { ...this.snapshot(), error: `not a directory: ${root}` };
    const resolved = (await fs.realpath(root).catch(() => root));
    if (this.rootHint === resolved && this.status.state === 'ready') return this.snapshot();
    this.rootHint = resolved;
    if (this.handle) { this.handle.terminate(); await this.handle.waitForExit().catch(() => {}); this.handle = null; }
    this.status = { ...this.status, state: 'starting', port: undefined };
    return this.start();
  }

  /** Ensure px0 is running (download + spawn as needed). */
  async startRemote() {
    return this.start();
  }

  /** Download the latest px0 and restart. */
  async update() {
    return this.applyUpdate();
  }

  /**
   * The JSON control plane the Client tab polls and drives.
   * Every response is `application/json` and never throws to the socket.
   */
  async api(req, res) {
    const url = new URL(req.url ?? '/', 'http://px0.invalid');
    const action = url.pathname.slice('/px0-api'.length).replace(/^\/+/, '').replace(/\/+$/, '');
    const send = (code, body) => {
      if (res.headersSent) return;
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      switch (action) {
        case 'status':
          send(200, this.snapshot());
          return;
        case 'start':
          send(200, await this.start());
          return;
        case 'update':
          send(200, await this.applyUpdate());
          return;
        case 'openRoot': {
          const root = url.searchParams.get('root');
          send(200, await this.openRoot(root));
          return;
        }
        default:
          send(404, { error: `unknown px0 control action: ${action}` });
      }
    } catch (e) {
      send(500, { state: 'failed', error: String(e?.message || e) });
    }
  }
}

export default Px0PreviewService;
