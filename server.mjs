/**
 * 代理体检台 —— 零依赖本地服务
 * 一键测：出口 IP / IP 纯净度 / 代理下载速度（并与直连对比）
 *
 * 启动： node server.mjs   然后打开 http://127.0.0.1:8787
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIM = []; // 调试用：记录各阶段耗时

/* ------------------------------------------------------------------ */
/* 代理隧道                                                            */
/* ------------------------------------------------------------------ */

function parseProxy(s) {
  if (!s || !String(s).trim()) return null;
  let t = String(s).trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = 'http://' + t;
  let u;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (!u.hostname) return null;
  if (u.protocol !== 'http:') return { error: '目前只支持 HTTP 代理（Clash/V2RayN 的 7890 混合端口就是 HTTP），不支持 ' + u.protocol };
  const auth = u.username
    ? Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)).toString('base64')
    : null;
  return { host: u.hostname, port: Number(u.port) || 8080, auth, label: `${u.hostname}:${Number(u.port) || 8080}` };
}

function connectViaProxy(proxy, host, port, timeout) {
  const T0 = Date.now();
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    let done = false;
    const fail = (e) => {
      if (done) return;
      done = true;
      sock.destroy();
      reject(e);
    };
    sock.setTimeout(timeout, () => fail(new Error(`连不上代理 ${proxy.host}:${proxy.port}（${timeout}ms 超时）`)));
    sock.once('error', fail);
    sock.once('connect', () => {
      let head = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Connection: keep-alive\r\n`;
      if (proxy.auth) head += `Proxy-Authorization: Basic ${proxy.auth}\r\n`;
      sock.write(head + '\r\n');
      let buf = Buffer.alloc(0);
      const onData = (d) => {
        buf = Buffer.concat([buf, d]);
        if (buf.length > 65536) return fail(new Error('代理返回的响应头过大'));
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        sock.removeListener('data', onData);
        const firstLine = buf.slice(0, idx).toString('latin1').split('\r\n')[0];
        const code = Number((firstLine.split(' ')[1] || '0'));
        if (code !== 200) return fail(new Error(`代理拒绝 CONNECT：${firstLine}`));
        done = true;
        sock.setTimeout(0);
        sock.on('error', () => {});
        TIM.push(['proxy-tcp', Date.now() - T0]);
        TIM.push(['connect-head', Date.now() - T0]);
        resolve(sock);
      };
      sock.on('data', onData);
    });
  });
}

/** 发一个请求，直连或经 HTTP 代理隧道，返回 IncomingMessage */
function requestThrough(target, proxy, { method = 'GET', headers = {}, timeout = 20000, body = null } = {}) {
  const u = new URL(target);
  const isHttps = u.protocol === 'https:';
  const port = Number(u.port) || (isHttps ? 443 : 80);
  const mod = isHttps ? https : http;
  const baseHeaders = {
    Host: u.host,
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Encoding': 'identity',
    Connection: 'close',
    ...headers,
  };

  return new Promise((resolve, reject) => {
    const go = (createConnection) => {
      const opts = {
        host: u.hostname,
        port,
        path: u.pathname + u.search,
        method,
        headers: baseHeaders,
        agent: false,
      };
      if (createConnection) opts.createConnection = createConnection;
      const req = mod.request(opts);
      req.setTimeout(timeout, () => req.destroy(new Error(`请求超时 ${timeout}ms`)));
      req.once('response', resolve);
      req.once('error', reject);
      if (body != null) req.write(body);
      req.end();
    };

    if (!proxy) return go(null);

    connectViaProxy(proxy, u.hostname, port, timeout).then((raw) => {
      // CONNECT 握手期间 socket 处于 flowing 模式，交给 TLS 前先暂停，
      // 否则数据会被 'data' 事件提前吃掉/延迟，实测能慢 3~5 倍
      try {
        raw.removeAllListeners('data');
        raw.setNoDelay(true);
      } catch {}
      go((_o, cb) => {
        if (!isHttps) return cb(null, raw);
        const T1 = Date.now();
        const t = tls.connect({ socket: raw, servername: u.hostname, ALPNProtocols: ['http/1.1'] });
        t.once('secureConnect', () => {
          TIM.push(['tls-handshake', Date.now() - T1]);
          cb(null, t);
        });
        t.once('error', (e) => cb(e));
      });
    }, reject);
  });
}

async function readText(res, limit = 3_000_000) {
  const chunks = [];
  let n = 0;
  for await (const c of res) {
    chunks.push(c);
    n += c.length;
    if (n > limit) {
      res.destroy();
      break;
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function getJson(url, proxy, timeout = 15000, headers = {}) {
  const res = await requestThrough(url, proxy, { timeout, headers });
  const text = await readText(res);
  if (res.statusCode >= 400) throw new Error(`HTTP ${res.statusCode}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('返回不是 JSON：' + text.slice(0, 120));
  }
}

const safe = async (fn, label) => {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    return { ok: false, error: `${label}: ${e.message}` };
  }
};

/* ------------------------------------------------------------------ */
/* 数据源                                                              */
/* ------------------------------------------------------------------ */

const CLOUD_ASN = /(amazon|aws|google|microsoft|azure|cloudflare|digitalocean|vultr|linode|akamai|hetzner|ovh|oracle|alibaba|aliyun|tencent|huawei cloud|leaseweb|contabo|choopa|hostinger|racknerd|colocrossing|psychz|kamatera|scaleway|upcloud|ionos|godaddy|m247|datacamp|hostwinds|cogent)/i;

function cfTrace(text) {
  const o = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return o;
}

/* ------------------------------------------------------------------ */
/* 测速                                                                */
/* ------------------------------------------------------------------ */

const SPEED_TARGETS = {
  // 国内测速点：量的是你家的真实带宽上限（移动/电信/联通到自己人的 CDN 最快）
  huawei: {
    name: '华为云镜像（国内）',
    kind: 'cn',
    range: true,
    url: () => 'https://mirrors.huaweicloud.com/ubuntu-releases/22.04/ubuntu-22.04.5-live-server-amd64.iso',
  },
  ustc: {
    name: '中科大镜像（国内）',
    kind: 'cn',
    range: true,
    url: () => 'https://mirrors.ustc.edu.cn/ubuntu-releases/22.04/ubuntu-22.04.5-live-server-amd64.iso',
  },
  // 海外测速点：量的是代理/机场的真实带宽
  cloudflare: {
    name: 'Cloudflare（海外）',
    kind: 'intl',
    range: false,
    url: (mb) => `https://speed.cloudflare.com/__down?bytes=${Math.round(mb * 1048576)}`,
  },
  ovh: {
    name: 'OVH 法国（海外）',
    kind: 'intl',
    range: true,
    url: () => 'https://proof.ovh.net/files/100Mb.dat',
  },
  vultr: {
    // 新加坡 Vultr 的标准测速文件，支持 8MB 分段、不限并发，最稳的一个
    name: 'Vultr 新加坡（海外）',
    kind: 'intl',
    range: true,
    url: () => 'https://sgp-ping.vultr.com/vultr.com.100MB.bin',
  },
};

/* 跟着重定向走（GitHub 的 release 会 302 到 release-assets.githubusercontent.com），
   返回最终那条响应，并把跳转过程记下来——跳转本身也是国内访问 GitHub 的痛点之一 */
async function openUrl(url, proxy, opts = {}, maxHops = 5) {
  let cur = url;
  const chain = [];
  const t0 = Date.now();
  for (let i = 0; i <= maxHops; i++) {
    const res = await requestThrough(cur, proxy, opts);
    const code = res.statusCode;
    const loc = res.headers.location;
    if (code >= 300 && code < 400 && loc) {
      chain.push({ from: cur, status: code, to: loc });
      try {
        res.resume();
      } catch {}
      cur = new URL(loc, cur).href;
      continue;
    }
    return { res, finalUrl: cur, chain, redirectMs: Date.now() - t0 };
  }
  throw new Error('重定向次数过多（>5）');
}

/* 用 flowing 模式把响应体读干。
   注意：别用 for await —— 异步迭代会在每个 chunk 之间 pause/resume，
   在这条代理隧道上实测窗口被压到 16KB/200ms（≈0.6 Mbps），而 curl 能跑 2~3 Mbps。
   改成一直挂着 data 监听后，窗口保持打开，速度才和 curl 对齐。 */
function drain(res, { bytesWanted = Infinity, maxSec = 8, onBytes = null } = {}) {
  return new Promise((resolve) => {
    let got = 0;
    let reason = null;
    let done = false;
    let watchdog = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (r && !reason) reason = r;
      if (watchdog) clearTimeout(watchdog);
      try {
        res.destroy();
      } catch {}
      resolve({ got, reason });
    };
    watchdog = setTimeout(() => finish('timeout'), maxSec * 1000);
    res.on('data', (c) => {
      got += c.length;
      const keep = onBytes ? onBytes(c.length) : true;
      if (keep === false || got >= bytesWanted) finish('capped');
    });
    res.on('end', () => finish(null));
    res.on('close', () => finish(null));
    res.on('error', () => finish(null));
  });
}

/* 下面这一套是「测速专用」的裸 HTTP 客户端。
   为什么要自己写：同样走 127.0.0.1:7890 隧道，Node 的 https.request + createConnection
   只跑 0.02~0.05 MB/s，而直接往 TLS socket 写 GET 能跑 0.16~0.30 MB/s（= curl 的数），
   差 8~10 倍。测速必须用后者，否则结论全是错的。 */
function readHead(sock, requestText, timeout) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(to);
      sock.removeListener('data', onData);
      sock.removeListener('error', onErr);
      fn(v);
    };
    const to = setTimeout(() => {
      try {
        sock.destroy();
      } catch {}
      finish(reject, new Error(`连接超时（${timeout}ms 没等到响应头）`));
    }, timeout);
    const onErr = (e) => {
      try {
        sock.destroy();
      } catch {}
      finish(reject, e);
    };
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) {
        if (buf.length > 65536) onErr(new Error('响应头过大'));
        return;
      }
      const head = buf.slice(0, i).toString('latin1');
      const rest = buf.slice(i + 4);
      const lines = head.split('\r\n');
      const m = /^HTTP\/1\.[01]\s+(\d{3})/.exec(lines[0] || '');
      const headers = {};
      for (const ln of lines.slice(1)) {
        const j = ln.indexOf(':');
        if (j < 0) continue;
        headers[ln.slice(0, j).trim().toLowerCase()] = ln.slice(j + 1).trim();
      }
      finish(resolve, { sock, status: m ? Number(m[1]) : 0, headers, rest });
    };
    sock.on('data', onData);
    sock.on('error', onErr);
    sock.write(requestText);
  });
}

/* 建立连接（直连或经代理隧道）并把请求头写出去，读到响应头就返回 */
function rawOpen(target, proxy, { method = 'GET', headers = {}, timeout = 20000 } = {}) {
  const u = new URL(target);
  const isHttps = u.protocol === 'https:';
  const port = Number(u.port) || (isHttps ? 443 : 80);
  const h = {
    Host: u.host,
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Encoding': 'identity',
    Connection: 'close',
    ...headers,
  };
  let text = `${method} ${u.pathname || '/'}${u.search || ''} HTTP/1.1\r\n`;
  for (const k of Object.keys(h)) if (h[k] != null) text += `${k}: ${h[k]}\r\n`;
  text += '\r\n';

  const t0 = Date.now();
  const s = !proxy
    ? isHttps
      ? new Promise((resolve, reject) => {
          const t = tls.connect({ host: u.hostname, port, servername: u.hostname, ALPNProtocols: ['http/1.1'] });
          t.once('secureConnect', () => resolve(t));
          t.once('error', reject);
        })
      : new Promise((resolve, reject) => {
          const n = net.connect({ host: u.hostname, port });
          n.once('connect', () => resolve(n));
          n.once('error', reject);
        })
    : connectViaProxy(proxy, u.hostname, port, timeout).then((raw) => {
        if (!isHttps) return raw;
        return new Promise((resolve, reject) => {
          const t = tls.connect({ socket: raw, servername: u.hostname, ALPNProtocols: ['http/1.1'] });
          t.once('secureConnect', () => resolve(t));
          t.once('error', reject);
        });
      });

  return s.then((sock) => readHead(sock, text, timeout)).then((r) => ({ ...r, ttfb: Date.now() - t0 }));
}

/* 只数流量、不解码 body：测速要的就是「线路上流过来多少字节」 */
function rawPump(sock, rest, { bytesWanted = Infinity, maxSec = 8, onBytes = null } = {}) {
  return new Promise((resolve) => {
    let got = 0;
    let reason = null;
    let done = false;
    let wd = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (r && !reason) reason = r;
      if (wd) clearTimeout(wd);
      try {
        sock.destroy();
      } catch {}
      resolve({ got, reason });
    };
    const take = (n) => {
      got += n;
      const keep = onBytes ? onBytes(n) : true;
      if (keep === false || got >= bytesWanted) finish('capped');
    };
    wd = setTimeout(() => finish('timeout'), maxSec * 1000);
    sock.on('data', (c) => take(c.length));
    sock.on('end', () => finish(null));
    sock.on('close', () => finish(null));
    sock.on('error', () => finish(null));
    if (rest && rest.length) take(rest.length);
  });
}

/* 逐跳解析 302（GitHub 的 release 下载会跳两次），只读响应头不读 body */
async function resolveFinal(url, proxy, headers, maxHops = 5) {
  let cur = url;
  const chain = [];
  let redirectMs = 0;
  for (let i = 0; i < maxHops; i++) {
    const t = Date.now();
    const o = await rawOpen(cur, proxy, { headers });
    const dt = Date.now() - t;
    try {
      o.sock.destroy();
    } catch {}
    if (o.status >= 300 && o.status < 400 && o.headers.location) {
      const next = new URL(o.headers.location, cur).href;
      chain.push({ status: o.status, from: cur, to: next });
      redirectMs += dt;
      cur = next;
      continue;
    }
    return { finalUrl: cur, chain, redirectMs, status: o.status };
  }
  return { finalUrl: cur, chain, redirectMs };
}

/* 单条连接下一段，够数/超时就停。给多头测速复用，也是「单线程限速」诊断的基础 */
async function streamOnce({ url, proxy, offsetBytes = null, bytesWanted, maxSec, onBytes }) {
  const headers = { 'Cache-Control': 'no-cache', Pragma: 'no-cache' };
  if (offsetBytes != null) headers.Range = `bytes=${offsetBytes}-${offsetBytes + bytesWanted - 1}`;

  const t0 = Date.now();
  let finalUrl = url;
  let chain = [];
  let redirectMs = 0;
  if (/^https?:\/\/github\.com\//i.test(url)) {
    const r = await resolveFinal(url, proxy, { ...headers, Range: 'bytes=0-0' });
    finalUrl = r.finalUrl;
    chain = r.chain;
    redirectMs = r.redirectMs;
  }
  const o = await rawOpen(finalUrl, proxy, { headers });
  if (o.status >= 400) {
    try {
      o.sock.destroy();
    } catch {}
    if (o.status === 429) throw new Error('测速点限流了（HTTP 429，Cloudflare 常见），等一分钟或换 Vultr / OVH');
    throw new Error(`HTTP ${o.status}`);
  }
  const ttfb = Date.now() - t0;
  const p = await rawPump(o.sock, o.rest, { bytesWanted, maxSec, onBytes });
  return { got: p.got, ttfb, finalUrl, redirectMs, redirects: chain };
}

/* 多头并发测速：机场常把「单条 TCP 连接」限在 2 Mbps 上下，
   浏览器/curl 下载单文件就是单条连接，所以必须同时看单流和多流两个数 */
async function measureParallel({ proxy, mb, target, conns = 4, emit, maxSec = 8 }) {
  const totalBytes = Math.round(mb * 1024 * 1024);
  const def = SPEED_TARGETS[target] || { name: '自定义地址', kind: 'custom', range: true, url: () => target };
  const url = def.url(mb);
  const isRange = !!def.range;

  const start = performance.now();
  let total = 0;
  let lastBytes = 0;
  let lastTs = start;
  let peak = 0;
  const samples = [];
  let ttfb = 0;
  let opened = null;

  const ticker = setInterval(() => {
    const now = performance.now();
    const dt = (now - lastTs) / 1000;
    const inst = dt > 0 ? ((total - lastBytes) * 8) / dt / 1e6 : 0;
    lastBytes = total;
    lastTs = now;
    if (inst > peak) peak = inst;
    samples.push(Math.round(inst * 10) / 10);
    emit({
      type: 'progress',
      mbps: Math.round(inst * 10) / 10,
      gotMB: Math.round((total / 1048576) * 100) / 100,
      totalMB: Math.round(totalBytes / 1048576),
      elapsed: Math.round((now - start) / 100) / 10,
      conns,
    });
  }, 250);

  const per = isRange ? Math.ceil(totalBytes / conns) : totalBytes;
  const jobs = [];
  for (let i = 0; i < conns; i++) {
    jobs.push(
      streamOnce({
        url,
        proxy,
        offsetBytes: isRange ? i * per : null,
        bytesWanted: per,
        maxSec,
        onBytes: (n) => {
          total += n;
          return total < totalBytes;
        },
      }).catch(() => null)
    );
  }
  const rs = await Promise.all(jobs);
  clearInterval(ticker);

  const secs = (performance.now() - start) / 1000;
  const first = rs.find((r) => r);
  if (first) {
    ttfb = first.ttfb;
    opened = first;
  }
  if (total < 30 * 1024) throw new Error(`几乎没速度：${secs.toFixed(1)} 秒 ${conns} 路一共只下了 ${(total / 1024).toFixed(0)} KB —— 要么测速点限流，要么这条线路在掉包`);
  const avgMbps = (total * 8) / secs / 1e6;

  return {
    url,
    target: SPEED_TARGETS[target] ? target : 'custom',
    targetName: def.name,
    kind: def.kind,
    conns,
    bytes: total,
    requestedBytes: totalBytes,
    totalSize: null,
    partial: total < totalBytes,
    maxSec,
    secs: Math.round(secs * 100) / 100,
    ttfb,
    redirectMs: opened ? opened.redirectMs : 0,
    redirects: opened
      ? opened.redirects.map((c) => {
          const u = new URL(c.to, c.from);
          return { status: c.status, host: u.host, path: u.pathname.slice(0, 60) };
        })
      : [],
    avgMbps: Math.round(avgMbps * 10) / 10,
    peakMbps: Math.round(peak * 10) / 10,
    samples,
  };
}

async function measureSpeed({ proxy, mb, target, emit, maxSec = 8 }) {
  const bytesWanted = Math.round(mb * 1024 * 1024);
  const def = SPEED_TARGETS[target] || { name: '自定义地址', kind: 'custom', range: true, url: () => target };
  const url = def.url(mb);
  if (!/^https?:\/\//i.test(url)) throw new Error('测速地址不合法');

  const headers = { 'Cache-Control': 'no-cache', Pragma: 'no-cache' };
  if (def.range) headers.Range = `bytes=0-${bytesWanted - 1}`;

  const t0 = Date.now();
  let finalUrl = url;
  let chain = [];
  let redirectMs = 0;
  if (/^https?:\/\/github\.com\//i.test(url)) {
    const rr = await resolveFinal(url, proxy, { ...headers, Range: 'bytes=0-0' });
    finalUrl = rr.finalUrl;
    chain = rr.chain;
    redirectMs = rr.redirectMs;
  }
  const opened = await rawOpen(finalUrl, proxy, { headers, timeout: 20000 });
  const ttfb = Date.now() - t0;
  if (opened.status >= 400) {
    try {
      opened.sock.destroy();
    } catch {}
    if (opened.status === 429) throw new Error('测速点限流了（HTTP 429，Cloudflare 常见），等一分钟或换 Vultr / OVH');
    throw new Error(`测速点返回 HTTP ${opened.status}`);
  }

  const total = Number(opened.headers['content-length'] || 0) || null;
  // Range 请求时能从 Content-Range 里读到文件真实总大小：bytes 0-8388607/30213120
  const cr = String(opened.headers['content-range'] || '');
  const totalSize = cr.includes('/') ? Number(cr.split('/')[1]) || null : total;
  const start = performance.now();
  let got = 0;
  let peak = 0;
  let chunkN = 0;
  let chunkMin = 1e9;
  let chunkMax = 0;
  let lastBytes = 0;
  let lastTs = start;
  const samples = [];

  const ticker = setInterval(() => {
    const now = performance.now();
    const dt = (now - lastTs) / 1000;
    const inst = dt > 0 ? ((got - lastBytes) * 8) / dt / 1e6 : 0;
    lastBytes = got;
    lastTs = now;
    if (inst > peak) peak = inst;
    samples.push(Math.round(inst * 10) / 10);
    emit({
      type: 'progress',
      mbps: Math.round(inst * 10) / 10,
      gotMB: Math.round((got / 1048576) * 100) / 100,
      totalMB: total ? Math.round((total / 1048576) * 100) / 100 : null,
      elapsed: Math.round((now - start) / 100) / 10,
    });
  }, 250);

  // 到时见好就收：慢线路也给出一个真实数字，而不是干等到超时
  let stopReason = null; // null=自然下完  'timeout'=超时截断  'capped'=够数了
  const r = await rawPump(opened.sock, opened.rest, {
    bytesWanted,
    maxSec,
    onBytes: (n) => {
      got += n;
      chunkN++;
      if (n < chunkMin) chunkMin = n;
      if (n > chunkMax) chunkMax = n;
    },
  });
  stopReason = r.reason; // 'timeout' | 'capped' | null
  clearInterval(ticker);

  const secs = (performance.now() - start) / 1000;
  if (got < 30 * 1024) throw new Error(`几乎没速度：${secs.toFixed(1)} 秒只下了 ${(got / 1024).toFixed(0)} KB`);
  const avgMbps = (got * 8) / secs / 1e6;

  return {
    url: finalUrl,
    urlOriginal: url,
    redirects: chain.map((c) => {
      const u = new URL(c.to, c.from);
      return { status: c.status, host: u.host, path: u.pathname.slice(0, 60) };
    }),
    redirectMs,
    target: SPEED_TARGETS[target] ? target : 'custom',
    targetName: def.name,
    kind: def.kind,
    bytes: got,
    requestedBytes: bytesWanted,
    totalSize,
    partial: stopReason === 'timeout',
    maxSec,
    secs: Math.round(secs * 100) / 100,
    ttfb,
    avgMbps: Math.round(avgMbps * 10) / 10,
    peakMbps: Math.round(peak * 10) / 10,
    samples,
    dbg: { chunkN, chunkMin: chunkMin === 1e9 ? 0 : chunkMin, chunkMax, tim: TIM.slice() },
  };
}

/* ------------------------------------------------------------------ */
/* 纯净度                                                              */
/* ------------------------------------------------------------------ */

function buildPurity({ cf, ipapi, pc, ipinfo, ipwho, sfsp, exitIp }) {
  const flags = {};
  const deductions = [];
  let score = 100;

  // 机房 / 代理判定：优先 ip-api 的 hosting/proxy 字段，proxycheck 做交叉验证
  const ipapiData = ipapi?.ok ? ipapi.data : null;
  const pcData = pc?.ok ? pc.data?.[exitIp] || (pc.data && Object.values(pc.data).find((v) => v && v.proxy)) : null;

  flags.hosting = typeof ipapiData?.hosting === 'boolean' ? ipapiData.hosting : null;
  flags.proxy = ipapiData?.proxy === true || pcData?.proxy === 'yes' ? true : ipapiData?.proxy === false && pcData?.proxy === 'no' ? false : null;
  flags.mobile = typeof ipapiData?.mobile === 'boolean' ? ipapiData.mobile : null;
  flags.provider = pcData?.provider || ipapiData?.isp || ipwho?.connection?.isp || ipinfo?.org || '';
  flags.asn = ipapiData?.as || ipwho?.connection?.asn || ipinfo?.org || '';

  const looksCloud = CLOUD_ASN.test(String(flags.asn) + ' ' + String(flags.provider));

  if (flags.hosting === true) {
    score -= 40;
    deductions.push({ name: '机房 / 托管 IP', delta: -40, detail: 'ip-api 判定为 hosting，风控最敏感的一项' });
  }
  if (flags.proxy === true) {
    score -= 30;
    deductions.push({ name: '被识别为代理 / VPN', delta: -30, detail: 'ip-api 或 proxycheck 标了 proxy' });
  }
  if (pcData && pcData.type && /^(business|hosting|vpn|proxy)$/i.test(String(pcData.type)) && String(pcData.type).toLowerCase() !== 'business') {
    // 仅作为提示，不重复扣分
  }
  if (sfsp?.ok && Number(sfsp.data?.frequency || 0) > 0) {
    score -= 20;
    deductions.push({ name: '垃圾信息黑名单有记录', delta: -20, detail: `stopforumspam 命中 ${sfsp.data.frequency} 次` });
  }
  if (pcData && pcData.risk >= 66) {
    score -= 10;
    deductions.push({ name: 'proxycheck 风险分偏高', delta: -10, detail: `risk=${pcData.risk}` });
  }
  if (looksCloud && flags.hosting === null) {
    score -= 15;
    deductions.push({ name: 'ASN 属于云厂商', delta: -15, detail: '从 ASN 名称看是机房段（其他源未给结论）' });
  }
  if (flags.mobile === true) {
    deductions.push({ name: '移动网络（4G/5G）', delta: 0, detail: '不算脏，但共享出口多，容易被风控' });
  }
  if (!deductions.length) {
    deductions.push({ name: '未发现明显问题', delta: 0, detail: '家宽段、未被标为代理、无黑名单记录' });
  }
  score = Math.max(0, Math.min(100, score));

  const grade = score >= 85 ? '干净' : score >= 65 ? '可用' : score >= 40 ? '一般' : '较脏';

  return {
    score,
    grade,
    flags,
    deductions,
    colo: cf?.colo || null,
    cfCountry: cf?.loc || null,
    geoCountry: ipapiData?.country || ipwho?.country || ipinfo?.country || null,
    warp: cf?.warp || null,
  };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function runTest({ proxyRaw, mb = 20, target = '', skipSpeed = false, skipPurity = false, maxSec = 8, skipIp = false, conns = 1 }, emit) {
  const started = Date.now();
  const proxy = parseProxy(proxyRaw);
  if (proxyRaw && !proxy) throw new Error('代理地址看不懂，格式应为 http://127.0.0.1:7890');
  if (proxy && proxy.error) throw new Error(proxy.error);

  // 没指定就自动挑：走代理 → 海外点；直连 → 国内点
  const tgt = target || (proxy ? 'cloudflare' : 'huawei');

  // 只测速（对比模式里复用已测到的 IP / 纯净度，省时间）
  if (skipSpeed === false && skipIp) {
    emit({ type: 'stage', stage: 'speed', msg: `正在下载 ${mb} MB 测速（${conns} 路）…` });
    const speed = conns > 1
      ? await measureParallel({ proxy, mb, target: tgt, conns, emit, maxSec })
      : await measureSpeed({ proxy, mb, target: tgt, emit, maxSec });
    return { meta: { proxy: proxy ? proxy.label : '直连', proxyRaw: proxy ? `http://${proxy.label}` : '', startedAt: new Date(started).toISOString(), durationMs: Date.now() - started }, ip: null, ipDetail: {}, purity: null, speed };
  }

  emit({ type: 'stage', stage: 'ip', msg: proxy ? `走代理 ${proxy.label} 查出口 IP…` : '直连查出口 IP…' });

  // 1) 并行抓 IP / 归属
  const [cfR, ipapiR, ipinfoR, ipwhoR] = await Promise.all([
    safe(async () => cfTrace(await readText(await requestThrough('https://www.cloudflare.com/cdn-cgi/trace', proxy, { timeout: 12000 }))), 'cloudflare'),
    safe(() => getJson('http://ip-api.com/json/?fields=status,country,regionName,city,isp,org,as,asname,mobile,proxy,hosting,query', proxy, 12000), 'ip-api'),
    safe(() => getJson('https://ipinfo.io/json', proxy, 12000, { 'User-Agent': 'curl/8.21.0' }), 'ipinfo'),
    safe(() => getJson('https://ipwho.is/', proxy, 12000), 'ipwho.is'),
  ]);

  const cf = cfR.ok ? cfR.data : null;
  const ipapi = ipapiR.ok ? ipapiR.data : null;
  const ipinfo = ipinfoR.ok ? ipinfoR.data : null;
  const ipwho = ipwhoR.ok ? ipwhoR.data : null;

  const exitIp = cf?.ip || ipapi?.query || ipinfo?.ip || ipwho?.ip || null;
  if (!exitIp) {
    const errs = [cfR, ipapiR, ipinfoR, ipwhoR].filter((r) => !r.ok).map((r) => r.error).join('；');
    throw new Error('一个 IP 源都拿不到，代理可能没通。' + errs);
  }

  emit({
    type: 'ip',
    ip: exitIp,
    country: ipapi?.country || ipwho?.country || ipinfo?.country || cf?.loc || '',
    city: ipapi?.city || ipwho?.city || ipinfo?.city || '',
    region: ipapi?.regionName || ipwho?.region || ipinfo?.region || '',
    asn: ipapi?.as || ipwho?.connection?.org || ipinfo?.org || '',
    isp: ipapi?.isp || ipwho?.connection?.isp || ipinfo?.org || '',
    colo: cf?.colo || '',
    warp: cf?.warp || '',
    proxy: !!proxy,
  });

  // 2) 依赖 IP 的检测（快速模式跳过，只留 ip-api 的机检结论）
  let pcR = { ok: false, error: 'skipped' };
  let sfspR = { ok: false, error: 'skipped' };
  if (!skipPurity) {
    emit({ type: 'stage', stage: 'purity', msg: '查纯净度（机检 / 代理 / 黑名单）…' });
    [pcR, sfspR] = await Promise.all([
      safe(() => getJson(`https://proxycheck.io/v2/${encodeURIComponent(exitIp)}?vpn=1&asn=1&risk=1`, proxy, 15000), 'proxycheck'),
      safe(() => getJson(`https://api.stopforumspam.com/api?ip=${encodeURIComponent(exitIp)}&f=json`, proxy, 15000), 'stopforumspam'),
    ]);
  }

  const purity = buildPurity({
    cf,
    ipapi: { ok: !!ipapi, data: ipapi },
    pc: pcR.ok && pcR.data?.status === 'ok' ? { ok: true, data: pcR.data } : { ok: false },
    ipinfo: ipinfo || {},
    ipwho: ipwho || {},
    sfsp: sfspR.ok ? { ok: true, data: sfspR.data } : { ok: false },
    exitIp,
  });
  purity.lite = !!skipPurity;

  emit({ type: 'purity', purity, raw: { cf, ipapi, ipinfo, ipwho, proxycheck: pcR.ok ? pcR.data : null, sfsp: sfspR.ok ? sfspR.data : null }, errors: [cfR, ipapiR, ipinfoR, ipwhoR, pcR, sfspR].filter((r) => !r.ok && r.error !== 'skipped').map((r) => r.error) });

  // 3) 测速
  let speed = null;
  if (!skipSpeed) {
    emit({ type: 'stage', stage: 'speed', msg: `正在下载 ${mb} MB 测速（${conns} 路）…` });
    speed = conns > 1
      ? await measureParallel({ proxy, mb, target: tgt, conns, emit, maxSec })
      : await measureSpeed({ proxy, mb, target: tgt, emit, maxSec });
  }

  return {
    meta: {
      proxy: proxy ? proxy.label : '直连',
      proxyRaw: proxy ? `http://${proxy.label}` : '',
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
    },
    ip: exitIp,
    ipDetail: {
      country: ipapi?.country || ipwho?.country || ipinfo?.country || '',
      city: ipapi?.city || ipwho?.city || ipinfo?.city || '',
      region: ipapi?.regionName || ipwho?.region || ipinfo?.region || '',
      asn: ipapi?.as || ipinfo?.org || '',
      isp: ipapi?.isp || ipwho?.connection?.isp || '',
    },
    purity,
    speed,
  };
}

/* ------------------------------------------------------------------ */
/* GitHub 专测                                                          */
/* ------------------------------------------------------------------ */

// yt-dlp 的资产名不带版本号，用 latest/download 永远指向最新，适合当长期测速靶子（约 30MB）
const GITHUB_ASSET = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';

function ghRate(mbps) {
  if (!mbps) return { label: '测不出来', cls: 'neg' };
  if (mbps >= 40) return { label: '很快，随便下', cls: 'pos' };
  if (mbps >= 16) return { label: '正常，几十秒能下完', cls: 'pos' };
  if (mbps >= 6) return { label: '能下，得等一会儿', cls: 'warn' };
  if (mbps >= 1.5) return { label: '很慢，忍着等', cls: 'warn' };
  return { label: '基本没法用', cls: 'neg' };
}

async function probeGithub({ proxy, mb = 8, maxSec = 6, conns = 1, emit }) {
  const route = proxy ? `走代理 ${proxy.label}` : '直连';
  const out = { route, proxy: !!proxy, asset: 'yt-dlp.exe' };

  // ① 网页通道：单纯打开 github.com 要多久（TCP + TLS + 首字节）
  emit({ type: 'stage', stage: 'gh-web', msg: `① 打开 github.com（${route}）…` });
  const t0 = Date.now();
  try {
    const o = await openUrl('https://github.com/robots.txt', proxy, { timeout: 15000, headers: { 'User-Agent': UA } });
    const ttfb = Date.now() - t0;
    if (o.res.statusCode >= 400) throw new Error('HTTP ' + o.res.statusCode);
    await readText(o.res, 4096);
    out.web = { ok: true, ttfb, status: o.res.statusCode };
  } catch (e) {
    out.web = { ok: false, ttfb: Date.now() - t0, error: e.message };
  }
  emit({ type: 'gh-web', web: out.web });

  // ② 真实下载：GitHub 会 302 到 release-assets.githubusercontent.com，跳转和下载都算在内
  emit({ type: 'stage', stage: 'gh-dl', msg: `② 真实下载 yt-dlp.exe（${route}，${conns} 路）…` });
  try {
    const dl = conns > 1
      ? await measureParallel({ proxy, mb, target: GITHUB_ASSET, conns, emit, maxSec })
      : await measureSpeed({ proxy, mb, target: GITHUB_ASSET, emit, maxSec });
    const bps = (dl.avgMbps * 1e6) / 8;
    out.download = {
      ok: true,
      conns: dl.conns || 1,
      mbps: dl.avgMbps,
      mbPerSec: Math.round((dl.avgMbps / 8) * 100) / 100,
      ttfb: dl.ttfb,
      redirectMs: dl.redirectMs,
      redirects: dl.redirects,
      bytes: dl.bytes,
      secs: dl.secs,
      partial: dl.partial,
      totalSize: dl.totalSize,
      etaAssetSec: dl.totalSize ? Math.round(dl.totalSize / bps) : null,
      eta70Sec: Math.round((70 * 1048576) / bps),
      eta200Sec: Math.round((200 * 1048576) / bps),
      samples: dl.samples,
    };
    out.verdict = ghRate(dl.avgMbps);
  } catch (e) {
    out.download = { ok: false, error: e.message };
    out.verdict = { label: '下载失败', cls: 'neg' };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* HTTP 服务                                                           */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('找不到 index.html：' + e.message);
    }
  }

  if (url.pathname === '/api/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('{"ok":true,"app":"proxylab"}');
  }

  if (url.pathname === '/favicon.ico') {
    const ico = path.join(__dirname, 'icon.ico');
    if (fs.existsSync(ico)) {
      res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'max-age=86400' });
      return res.end(fs.readFileSync(ico));
    }
    res.writeHead(204);
    return res.end();
  }

  if (url.pathname === '/api/run') {
    const proxyRaw = url.searchParams.get('proxy') || '';
    const mb = Math.max(2, Math.min(200, Number(url.searchParams.get('mb')) || 20));
    const target = url.searchParams.get('target') || '';
    const skipSpeed = url.searchParams.get('skipSpeed') === '1';
    const skipPurity = url.searchParams.get('skipPurity') === '1';
    const maxSec = Math.max(3, Math.min(30, Number(url.searchParams.get('sec')) || 8));
    const skipIp = url.searchParams.get('skipIp') === '1';
    const conns = Math.max(1, Math.min(16, Number(url.searchParams.get('conns')) || 1));

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': hello\n\n');

    let closed = false;
    req.on('close', () => (closed = true));
    const emit = (obj) => {
      if (closed) return;
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch {}
    };

    try {
      const result = await runTest({ proxyRaw, mb, target, skipSpeed, skipPurity, maxSec, skipIp, conns }, emit);
      emit({ type: 'done', result });
    } catch (e) {
      emit({ type: 'error', message: e.message });
    }
    res.end();
    return;
  }

  // GitHub 专测：网页通道 + 真实下载 release 资产
  if (url.pathname === '/api/github') {
    const proxyRaw = url.searchParams.get('proxy') || '';
    const mb = Math.max(4, Math.min(64, Number(url.searchParams.get('mb')) || 8));
    const maxSec = Math.max(3, Math.min(20, Number(url.searchParams.get('sec')) || 6));
    const ghConns = Math.max(1, Math.min(16, Number(url.searchParams.get('conns')) || 1));

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': hello\n\n');

    let closed = false;
    req.on('close', () => (closed = true));
    const emit = (obj) => {
      if (closed) return;
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch {}
    };

    try {
      const proxy = parseProxy(proxyRaw);
      if (proxyRaw && !proxy) throw new Error('代理地址看不懂，格式应为 http://127.0.0.1:7890');
      if (proxy && proxy.error) throw new Error(proxy.error);
      const result = await probeGithub({ proxy, mb, maxSec, conns: ghConns, emit });
      emit({ type: 'done', result });
    } catch (e) {
      emit({ type: 'error', message: e.message });
    }
    res.end();
    return;
  }

  if (url.pathname === '/api/quit') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('bye');
    setTimeout(() => process.exit(0), 100);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`代理体检台已启动： http://127.0.0.1:${PORT}`);
});
