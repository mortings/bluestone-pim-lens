// Stand-ins for the chrome.* APIs the side panel uses, so the real panel can run
// in an ordinary page next to the demo shop (see sim.html).
(function () {
  const areas = { local: {}, session: {} };
  const listeners = { local: [], session: [] };
  function area(name) {
    return {
      get(keys) {
        const out = {};
        if (typeof keys === 'string') { if (keys in areas[name]) out[keys] = areas[name][keys]; }
        else if (Array.isArray(keys)) { for (const k of keys) if (k in areas[name]) out[k] = areas[name][k]; }
        else for (const k of Object.keys(keys || {})) out[k] = k in areas[name] ? areas[name][k] : keys[k];
        return Promise.resolve(out);
      },
      set(obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: areas[name][k], newValue: v };
          areas[name][k] = v;
        }
        setTimeout(() => listeners[name].forEach((l) => l(changes)), 0);
        return Promise.resolve();
      },
      onChanged: { addListener: (l) => listeners[name].push(l) },
    };
  }
  window.chrome = {
    storage: { local: area('local'), session: area('session') },
    runtime: {
      id: 'inspector-harness',
      sendMessage: (msg) => {
        // Switching organisation: the stand-in PIM just changes its current one.
        if (msg && msg.type === 'bsi:switch-org') return Promise.resolve({ ok: window.__mock.switchOrg(msg.orgId) });
        window.parent.postMessage(msg, '*');
        return Promise.resolve({ ok: true });
      },
    },
  };
  // sim.html hands the panel a page capture, as background.js would.
  window.__setCapture = (capture) => chrome.storage.session.set({ 'bsi:capture': capture });
})();
