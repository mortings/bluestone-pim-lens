// Runs the real on-page Lens (ext/content/lens.js) on a test shop page, with the
// real background service (ext/src/service.js) answering from the stand-in PIM.
// Nothing here reaches a real PIM. Address options: ?lens (switch it on at once),
// ?signedOut, ?viewer (a role that cannot edit), ?notasks (a role that cannot create tasks).
// The repository's root, wherever it is served from.
const LENS_ROOT = new URL('../../', document.currentScript.src).href;
(async () => {
  if (window.top !== window) return; // inside the side-panel simulator: leave the page alone
  const v = Date.now();
  const load = (src) =>
    new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = `${LENS_ROOT}${src}?v=${v}`;
      s.onload = ok;
      s.onerror = fail;
      document.head.append(s);
    });
  for (const f of ['ext/src/match.js', 'ext/src/trace.js', 'ext/src/pim.js', 'ext/src/inspect.js', 'ext/src/imagehash.js', 'ext/src/service.js', 'test/mock-pim.js', 'ext/src/page-extract.js']) await load(f);

  const params = new URLSearchParams(location.search);
  const mock = BSI.mock.createMock({ signedOut: params.has('signedOut'), readOnlyUser: params.has('viewer'), noTasks: params.has('notasks') });
  const data = {};
  const copy = (x) => JSON.parse(JSON.stringify(x));
  const storage = {
    get: async (defaults) => Object.fromEntries(Object.entries(defaults).map(([k, d]) => [k, k in data ? copy(data[k]) : d])),
    set: async (values) => void Object.assign(data, copy(values)),
  };
  // Pictures: the stand-in PIM's thumbnails are files in test/shop/img; the shop's pictures are
  // read as Chrome would, and only after "Allow it" when the page is opened with ?askimages.
  let imagesAllowed = !params.has('askimages');
  const readImage = async (url, options) => {
    try {
      if (options.session) {
        const m = /\/api\/assets\/([^?]+)/.exec(url);
        return await BSI.imagehash.read(`${LENS_ROOT}test/shop/img/${m ? decodeURIComponent(m[1]) : 'missing'}?v=${v}`, { dataUrl: true });
      }
      if (!imagesAllowed) return { error: 'permission', origin: new URL(url, location.href).origin };
      return await BSI.imagehash.read(url, {});
    } catch (e) {
      return { error: 'failed' };
    }
  };
  const service = BSI.service.createService({ storage, transport: () => mock.request, switchOrg: async (base, id) => ({ ok: mock.switchOrg(id) }),
    // Signing out: the stand-in PIM forgets its user (?keepsession: it does not, as a PIM that refuses would).
    signOut: async (hosts, stillSignedIn) => {
      if (!params.has('keepsession')) mock.signOut();
      const left = await stillSignedIn();
      return left ? { ok: false, needsUser: true, base: left } : { ok: true };
    },
    readImage });
  const listeners = [];
  window.chrome = Object.assign(window.chrome || {}, {
    runtime: {
      id: 'lens-harness',
      // Like Chrome: messages are copied, never shared.
      sendMessage: async (msg) => {
        // Chrome would open the side panel here; the simulator just notes that it was asked.
        if (msg && msg.type === 'lens:allow-images') {
          imagesAllowed = true; // Chrome would show its permission question here
          return { ok: true };
        }
        if (msg && msg.type === 'lens:open-panel') {
          window.__panelAsked = copy(msg);
          return { ok: true };
        }
        return copy(await service.handle(copy(msg)));
      },
      onMessage: { addListener: (l) => listeners.push(l) },
    },
    storage: { local: storage },
  });
  window.__LENS_HARNESS = true;
  window.__mock = mock;
  await load('ext/content/lens.js');
  const toggle = () => listeners.forEach((l) => l({ type: 'lens:toggle' }, {}, () => {}));
  window.__lens = { toggle, service, data };

  // Stands in for the extension's toolbar button.
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'lens-toolbar-button';
  button.textContent = 'Toolbar button: Bluestone PIM Lens';
  button.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;font:600 12px -apple-system,Segoe UI,Arial,sans-serif;padding:6px 10px;border-radius:6px;border:1px solid #5b6275;background:#272d3b;color:#fff;cursor:pointer';
  button.addEventListener('click', toggle);
  document.body.append(button);
  if (params.has('lens')) toggle();
})();
