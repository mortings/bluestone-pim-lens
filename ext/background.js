/*
 * Background service worker.
 *
 * The toolbar button and the right-click menu item switch the Lens on for the
 * current page: the page is read and marked only after that click (Chrome's
 * "activeTab" permission), the extension has no standing access to the sites
 * you visit. The on-page view then asks this worker for everything it shows;
 * this worker is the only part that talks to Bluestone PIM (src/service.js).
 *
 * The side panel is the detail view: the on-page box opens it when a count is
 * clicked or the product is opened in the PIM, and the right-click menu has it too.
 */
importScripts('src/page-extract.js', 'src/match.js', 'src/trace.js', 'src/pim.js', 'src/inspect.js', 'src/imagehash.js', 'src/service.js');

// What the extension remembers (which product a page is, your label links, who gets
// suggestions) is for the extension's own pages and this worker only: scripts that run
// inside web pages cannot read or change it.
try {
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
} catch (e) {
  /* an older Chrome: the default stays */
}

const MENU_LENS = 'lens-show';
const MENU_PANEL = 'bsi-trace';
const MENU_IMAGES = 'lens-images';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_LENS, title: 'Show Bluestone PIM data on this page', contexts: ['page', 'selection', 'link', 'image'] });
    chrome.contextMenus.create({ id: MENU_PANEL, title: 'Open in the side panel instead', contexts: ['page', 'selection', 'link', 'image'] });
    chrome.contextMenus.create({ id: MENU_IMAGES, title: 'Allow comparing pictures on this page', contexts: ['page', 'selection', 'link', 'image'] });
  });
});

// ---- the on-page Lens -------------------------------------------------------

const TITLE = 'Bluestone PIM Lens: show PIM data on this page';
const TITLE_UNREADABLE = 'The Lens cannot read this page. It works on ordinary web pages, not on browser pages, the Chrome Web Store or files.';

async function showLens(tab, type) {
  if (!tab || tab.id == null) return;
  const message = { type: type || 'lens:toggle' };
  // A "!" on the button when the page cannot be read; cleared again when it can.
  const mark = (unreadable) => {
    chrome.action.setBadgeText({ tabId: tab.id, text: unreadable ? '!' : '' }).catch(() => {});
    chrome.action.setTitle({ tabId: tab.id, title: unreadable ? TITLE_UNREADABLE : TITLE }).catch(() => {});
  };
  const ask = () => chrome.tabs.sendMessage(tab.id, message).then((r) => !!(r && r.ok), () => false);
  // Already on this page: just switch it.
  if (await ask()) return mark(false);
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/page-extract.js', 'content/lens.js'] });
    if (await ask()) return mark(false);
  } catch (e) {
    /* Chrome does not let extensions into this page: see below */
  }
  // Chrome doesn't inject into an extension's own pages (the bundled demo shop, which
  // loads the Lens itself) or into browser pages. The demo shop answers this message.
  const answer = await chrome.runtime.sendMessage(Object.assign({ tabId: tab.id }, message)).catch(() => null);
  mark(!(answer && answer.ok));
}

// A double click on the button would switch the Lens on and straight off again.
const lastClick = new Map();
chrome.action.onClicked.addListener((tab) => {
  const now = Date.now();
  if (tab && now - (lastClick.get(tab.id) || 0) < 600) return;
  if (tab) lastClick.set(tab.id, now);
  showLens(tab, 'lens:toggle');
});

// ---- switching organisation -------------------------------------------------
// The PIM does it by sending the browser to its login address with the
// organisation, which re-issues the session. Done in a background tab that
// closes when the PIM app is back; if it needs the user (an extra sign-in step),
// the tab is brought to the front instead.
const PIM_HOSTS = BSI.service.HOSTS;

async function switchOrganisation(base, orgId) {
  if (!PIM_HOSTS.includes(base) || !/^[\w-]{1,80}$/.test(String(orgId))) return { ok: false };
  const tab = await chrome.tabs.create({ url: `${base}/login?organization=${encodeURIComponent(orgId)}`, active: false });
  return new Promise((resolve) => {
    let done = false;
    const finish = (result, close) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      if (close) chrome.tabs.remove(tab.id).catch(() => {});
      resolve(result);
    };
    const onUpdated = (tabId, info, t) => {
      if (tabId !== tab.id || info.status !== 'complete' || !t.url) return;
      try {
        const u = new URL(t.url);
        if (u.origin === base && !u.pathname.startsWith('/login')) finish({ ok: true }, true);
      } catch (e) {
        /* not a readable address yet */
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    const timer = setTimeout(() => {
      chrome.tabs.update(tab.id, { active: true }).catch(() => {});
      finish({ ok: false, needsUser: true }, false);
    }, 20000);
  });
}

// ---- pictures ---------------------------------------------------------------
// A shop serves its pictures from its own image host. The extension may read them
// only after the user allows that host (asked once, from the on-page box or the
// right-click menu). The PIM's own thumbnails come with the signed-in session.

// tab id -> image hosts the page needs permission for. Also kept in session storage:
// Chrome stops this worker when it is idle, and the list must survive that.
const HOSTS_KEY = 'lens:image-hosts';
const imageHosts = new Map();
const hostsLoaded = chrome.storage.session
  .get(HOSTS_KEY)
  .then((stored) => {
    for (const [tabId, origins] of Object.entries(stored[HOSTS_KEY] || {})) {
      if (!imageHosts.has(Number(tabId)) && Array.isArray(origins)) imageHosts.set(Number(tabId), origins);
    }
  })
  .catch(() => {});
const saveImageHosts = () => chrome.storage.session.set({ [HOSTS_KEY]: Object.fromEntries(imageHosts) }).catch(() => {});
chrome.tabs.onRemoved.addListener((tabId) => {
  lastClick.delete(tabId);
  scans.delete(tabId);
  if (imageHosts.delete(tabId)) saveImageHosts();
});
// Another page in the tab: the previous page's image hosts no longer apply.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && imageHosts.delete(tabId)) saveImageHosts();
});

// How often one tab may ask for a comparison. A person does this a few times a minute;
// a page that keeps changing its address to make the Lens read it again is cut off.
const scans = new Map(); // tab id -> times of recent scans
function tooManyScans(tabId) {
  const now = Date.now();
  const recent = (scans.get(tabId) || []).filter((t) => now - t < 60000);
  recent.push(now);
  scans.set(tabId, recent);
  return recent.length > 20;
}

/** "https://images.shop.com" -> "https://images.shop.com/*"; anything else -> null. */
function originPattern(origin) {
  try {
    const u = new URL(String(origin));
    return /^https?:$/.test(u.protocol) && u.origin === String(origin) ? u.origin + '/*' : null;
  } catch (e) {
    return null;
  }
}

async function readImage(url, options) {
  let target;
  try {
    target = new URL(url);
  } catch (e) {
    return { error: 'failed' };
  }
  const inline = target.protocol === 'data:';
  if (!inline && !/^https?:$/.test(target.protocol)) return { error: 'failed' };
  // The signed-in session only ever goes to the PIM itself.
  if (options.session && !PIM_HOSTS.includes(target.origin)) return { error: 'failed' };
  if (!inline && !options.session) {
    const allowed = await chrome.permissions.contains({ origins: [target.origin + '/*'] });
    if (!allowed) return { error: 'permission', origin: target.origin };
  }
  try {
    return await BSI.imagehash.read(url, { credentials: options.session ? 'include' : 'omit', dataUrl: !!options.thumb });
  } catch (e) {
    return { error: 'failed' };
  }
}

/**
 * Ask Chrome's own permission question for the image hosts of a tab. Only hosts this
 * worker found itself while comparing that tab's pictures are asked for, never a list
 * handed over by a page.
 */
async function askForImageHosts(tabId) {
  if (!imageHosts.has(tabId)) await hostsLoaded;
  const patterns = [...new Set((imageHosts.get(tabId) || []).map(originPattern).filter(Boolean))].slice(0, 4);
  if (!patterns.length) return false;
  return chrome.permissions.request({ origins: patterns });
}

const service = BSI.service.createService({
  storage: { get: (defaults) => chrome.storage.local.get(defaults), set: (values) => chrome.storage.local.set(values) },
  transport: (base) => BSI.pim.sessionTransport(base),
  switchOrg: switchOrganisation,
  readImage,
});

// ---- the side panel (the earlier view) --------------------------------------

async function capture(tab) {
  const base = { tabId: tab.id, at: Date.now() };
  try {
    let page;
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: bsiExtractPage });
      page = res.result;
    } catch (e) {
      page = await chrome.tabs.sendMessage(tab.id, { type: 'bsi:extract' });
      if (!page) throw e;
    }
    // Checked and cut to size like everything else that comes from a page.
    await chrome.storage.session.set({ 'bsi:capture': Object.assign(base, { page: BSI.service.cleanPage(page) }) });
  } catch (e) {
    await chrome.storage.session.set({
      'bsi:capture': Object.assign(base, { error: 'This page cannot be read from here. Chrome gives the extension a page when you click its button on that page: click it there first. Browser pages and the Chrome Web Store cannot be read at all.' }),
    });
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  if (info.menuItemId === MENU_LENS) showLens(tab, 'lens:show');
  if (info.menuItemId === MENU_IMAGES) {
    // Asked straight from the click: Chrome only shows its permission question then.
    askForImageHosts(tab.id)
      .then((granted) => granted && chrome.tabs.sendMessage(tab.id, { type: 'lens:images-again' }).catch(() => chrome.runtime.sendMessage({ type: 'lens:images-again', tabId: tab.id }).catch(() => {})))
      .catch(() => {});
  }
  if (info.menuItemId === MENU_PANEL) {
    // Open first: Chrome only allows it directly inside the click.
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
    capture(tab);
  }
});

const PANEL_FILTERS = ['', 'all', 'match', 'differs', 'unsure', 'unknown', 'empty'];

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  // Only this extension's own parts are listened to.
  if (!sender || sender.id !== chrome.runtime.id) return;
  const ownPage = String(sender.url || '').startsWith(chrome.runtime.getURL(''));
  // The on-page view lives in the page itself, never in a frame inside it.
  if (sender.tab && sender.frameId) return;

  // The on-page box asks for the side panel: a count was clicked, or "Open in Bluestone PIM".
  if (msg.type === 'lens:open-panel') {
    const tab = sender.tab;
    if (!tab || tab.id == null) return;
    // Open first: Chrome only allows it directly inside the click that sent this message.
    // For the whole window, so the panel stays beside the PIM's tab too.
    const opened = chrome.sidePanel.open({ windowId: tab.windowId }).then(() => true, () => false);
    const filter = PANEL_FILTERS.includes(msg.filter) ? msg.filter : '';
    chrome.storage.session.set({ 'bsi:panel-filter': { status: filter, at: Date.now() } });
    Promise.all([opened, capture(tab).catch(() => {})]).then(([ok]) => reply({ ok }));
    return true;
  }
  // The on-page box's "Allow it" for the shop's pictures.
  if (msg.type === 'lens:allow-images') {
    if (!sender.tab || sender.tab.id == null) return;
    askForImageHosts(sender.tab.id).then(
      (granted) => reply({ ok: !!granted, error: granted ? '' : 'Not allowed, so the pictures stay uncompared.' }),
      () => reply({ ok: false, error: 'Chrome only takes this from its own menu: right-click the page and choose “Allow comparing pictures on this page”.' })
    );
    return true;
  }
  // The on-page Lens.
  if (service.handles(msg.type)) {
    if (msg.type === 'lens:scan' && sender.tab && sender.tab.id != null && tooManyScans(sender.tab.id)) {
      reply({ ok: false, error: 'This page has been read many times in the last minute. Wait a moment, then try again.' });
      return;
    }
    // Where the message really came from, so a page cannot speak for another site.
    const from = sender.tab && typeof sender.url === 'string' ? { url: sender.url } : null;
    service.handle(msg, from).then((result) => {
      // Remember which image hosts this tab still needs, for "Allow it" and the right-click menu item.
      if (msg.type === 'lens:images' && sender.tab && sender.tab.id != null && result && Array.isArray(result.needPermission)) {
        imageHosts.set(sender.tab.id, result.needPermission.slice(0, 4));
        saveImageHosts();
      }
      reply(result);
    }, () => reply({ ok: false, error: 'Something went wrong.' }));
    return true;
  }
  // The side panel: only the extension's own pages may ask for these.
  if (!ownPage) return;
  if (msg.type === 'bsi:switch-org') {
    // The session is another one after this: the on-page service must not keep the old one.
    switchOrganisation(msg.base, msg.orgId).then((r) => { service.reset(); reply(r); }, () => { service.reset(); reply({ ok: false }); });
    return true;
  }
  if (msg.type === 'bsi:recapture') {
    if (!Number.isInteger(msg.tabId)) return;
    chrome.tabs.get(msg.tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) return reply({ ok: false });
      capture(tab).then(() => reply({ ok: true }));
    });
    return true;
  }
});
