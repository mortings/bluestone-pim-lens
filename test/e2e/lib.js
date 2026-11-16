// Helpers for run.js: the extension, unchanged, in a real Chromium.
// The PIM's hostnames are pointed at a local stand-in PIM (test/mock-pim.js) and the
// shop at the test pages in test/shop, so nothing here reaches a real PIM or a real shop.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const { chromium } = require('playwright-core');

const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const WORK = path.join(__dirname, '.work');
const { createMock } = require(path.join(ROOT, 'test/mock-pim.js'));
const { SERVICE_PREFIX } = require(path.join(ROOT, 'ext/src/pim.js'));
// The browser: Playwright's own Chromium (npx playwright-core install chromium), or the one named in LENS_CHROME.
// Google Chrome itself will not do: it no longer loads an extension from the command line.
const CHROME = process.env.LENS_CHROME || chromium.executablePath();

/** A throw-away certificate for the stand-in PIM (the browser is told to accept it). */
function certificate() {
  fs.mkdirSync(WORK, { recursive: true });
  const key = path.join(WORK, 'key.pem');
  const cert = path.join(WORK, 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '30', '-subj', '/CN=demo-ui.test.bluestonepim.com',
      '-addext', 'subjectAltName=DNS:demo-ui.test.bluestonepim.com,DNS:app.test.bluestonepim.com'], { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

function startPim(state) {
  const prefixes = Object.entries(SERVICE_PREFIX).sort((a, b) => b[1].length - a[1].length);
  const server = https.createServer(certificate(), async (req, res) => {
    const host = req.headers.host;
    const url = new URL(req.url, `https://${host}`);
    state.requests.push(`${req.method} ${host}${url.pathname}`);
    const mock = state.mocks[host.split(':')[0]];
    if (state.hang) return; // never answers
    // The PIM's own thumbnails.
    const thumb = /^\/api\/assets\/(.+)$/.exec(url.pathname);
    if (thumb && req.method === 'GET') {
      const file = path.join(ROOT, 'test/shop/img', decodeURIComponent(thumb[1]));
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(fs.readFileSync(file));
    }
    // The sign-in service both PIMs share: its end-of-session address answers as the real one does,
    // with a form that sends itself.
    if (host.split(':')[0] === 'idp.test.bluestonepim.com') {
      if (url.pathname === '/op/session/end' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<!doctype html><title>Submitting Callback</title><form method="post" action="/op/session/end/confirm"><input type="hidden" name="logout" value="yes"></form><script>document.forms[0].submit()</script>');
      }
      if (url.pathname === '/op/session/end/confirm' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<!doctype html><title>Signed out</title><h1>Signed out</h1>');
      }
      res.writeHead(404);
      return res.end();
    }
    // The PIM app's sign-out address (state.keepSession: a PIM that does not let go).
    if (url.pathname === '/logout') {
      if (mock && !state.keepSession) mock.signOut();
      res.writeHead(302, { location: '/login' });
      return res.end();
    }
    if (url.pathname === '/' || url.pathname.startsWith('/products') || url.pathname.startsWith('/login') || url.pathname.startsWith('/tasks')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<!doctype html><title>Stand-in PIM</title><h1>Stand-in PIM ${url.pathname}</h1>`);
    }
    const hit = prefixes.find(([, p]) => url.pathname.startsWith(p + '/'));
    if (!hit || !mock) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"message":"no such route"}'); }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      const r = await mock.request({
        service: hit[0], method: req.method, path: url.pathname.slice(hit[1].length),
        query: Object.fromEntries(url.searchParams), body: raw ? JSON.parse(raw) : undefined, context: req.headers.context,
      });
      const headers = { 'content-type': 'application/json' };
      if (r.resourceId) headers['resource-id'] = r.resourceId;
      if (r.status === 204 || r.data == null) { delete headers['content-type']; res.writeHead(r.status || 200, headers); return res.end(); }
      res.writeHead(r.status || 200, headers);
      res.end(JSON.stringify(r.data));
    } catch (e) {
      res.writeHead(e.status || 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: e.message }));
    }
  });
  return new Promise((ok) => server.listen(8443, '127.0.0.1', () => ok(server)));
}

function startShop(state) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://shop.example');
    state.requests.push(`${req.method} ${req.headers.host}${url.pathname}`);
    // A site fed straight from the PIM keeps the PIM's product id in its address.
    const pathname = /^\/product\/[0-9a-f]{24}$/.test(url.pathname) ? '/content-store.html' : url.pathname;
    const file = path.join(ROOT, 'test/shop', decodeURIComponent(pathname));
    if (!file.startsWith(path.join(ROOT, 'test/shop')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    if (file.endsWith('.html')) {
      let html = fs.readFileSync(file, 'utf8');
      html = html.replace(/<script src="\.\.\/harness\/lens-boot\.js"><\/script>/, ''); // the real extension is under test, not the simulator
      html = html.replace(/src="img\//g, 'src="http://img.shop.example/img/'); // pictures on their own host, as shops do
      if (state.shopExtra) html = html.replace('</body>', state.shopExtra + '</body>');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    res.writeHead(200, { 'content-type': file.endsWith('.png') ? 'image/png' : 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((ok) => server.listen(8770, '127.0.0.1', () => ok(server)));
}

/** A copy of the extension. Only the manifest differs: the test cannot click the toolbar
 *  button (which is what grants access to the page), so the shop's address is granted up front. */
function copyExtension(extraHosts) {
  const dir = path.join(WORK, 'ext');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, 'ext'), dir, { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  m.host_permissions.push('http://shop.example/*', ...(extraHosts || []));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  return dir;
}

async function launch(extDir, headless) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-e2e-'));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: CHROME, headless: false, viewport: { width: 1280, height: 900 },
    args: [
      ...(headless ? ['--headless=new'] : []),
      `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
      '--host-resolver-rules=MAP demo-ui.test.bluestonepim.com 127.0.0.1:8443, MAP app.test.bluestonepim.com 127.0.0.1:8443, MAP idp.test.bluestonepim.com 127.0.0.1:8443, MAP shop.example 127.0.0.1:8770, MAP img.shop.example 127.0.0.1:8770',
      '--ignore-certificate-errors', '--remote-debugging-port=9333', '--no-first-run', '--no-default-browser-check',
    ],
  });
  let sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker', { timeout: 15000 }));
  return { context, sw, profile };
}

/** Looks inside the Lens's closed shadow root through the browser's debugger (a page cannot). */
function lensView(page, cdp) {
  // The Lens draws its text from data-t attributes (so the page cannot search or select it); read it from there.
  const own = (node) => {
    const at = (node.attributes || []).indexOf('data-t');
    return at >= 0 && at % 2 === 0 ? node.attributes[at + 1] : '';
  };
  const textOf = (node) => (node.nodeType === 3 ? (node.parentTag === 'STYLE' ? '' : node.nodeValue) : own(node) + (node.children || []).map(textOf).join(''));
  const walk = (node, visit) => {
    visit(node);
    for (const c of node.children || []) walk(c, visit);
    for (const s of node.shadowRoots || []) walk(s, visit);
  };
  const attrs = (node) => {
    const out = {};
    for (let i = 0; i < (node.attributes || []).length; i += 2) out[node.attributes[i]] = node.attributes[i + 1];
    return out;
  };
  async function root() {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    let host = null;
    walk(root, (n) => { if (n.nodeType === 1 && 'data-bluestone-lens' in attrs(n)) host = n; });
    return host;
  }
  async function all(pred) {
    const host = await root();
    const out = [];
    if (host) walk(host, (n) => { if (n.nodeType === 1 && pred(n, textOf(n).replace(/\s+/g, ' ').trim(), attrs(n))) out.push(n); });
    return out;
  }
  async function text() {
    const host = await root();
    if (!host) return null;
    const parts = [];
    walk(host, (n) => {
      if (n.nodeType === 1 && own(n).trim()) parts.push(own(n).trim());
      else if (n.nodeType === 3 && n.nodeValue.trim() && n.nodeValue.length < 300) parts.push(n.nodeValue.trim()); // option texts
    });
    return parts.join(' | ');
  }
  async function box(node) {
    await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendNodeId }).catch(() => {});
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId });
    const q = model.content;
    return { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2 };
  }
  async function click(pred, nth) {
    // The Lens may redraw between finding the element and measuring it: look again then.
    for (let attempt = 0; ; attempt++) {
      const nodes = await all(pred);
      const node = nodes[nth || 0];
      if (!node) throw new Error('nothing to click');
      try {
        const at = await box(node);
        await page.mouse.click(at.x, at.y);
        return node;
      } catch (e) {
        if (attempt >= 2) throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
  const button = (label) => (n, t) => (n.nodeName === 'BUTTON' || n.nodeName === 'A') && (label instanceof RegExp ? label.test(t) : t === label);
  async function waitFor(re, ms) {
    const until = Date.now() + (ms || 8000);
    let last = '';
    while (Date.now() < until) {
      last = (await text()) || '';
      if (re.test(last)) return last;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`waited for ${re} but the Lens shows: ${last.slice(0, 600)}`);
  }
  return { root, all, text, click, button, waitFor, attrs };
}

module.exports = { ROOT, CHROME, createMock, startPim, startShop, copyExtension, launch, lensView };
