/*
 * Bluestone PIM Lens: the on-page view.
 *
 * Injected into the page only after the user clicks the extension. It marks each
 * fact on the page with a small pill that says whether the value comes from the
 * PIM, and opens a card on the pill to see where the value is kept and to change
 * it (Edit mode) or send a suggestion as a task (Suggest mode).
 *
 * It never talks to the PIM itself: it asks the extension's background worker.
 * Everything it draws lives in one closed shadow root on top of the page, so the
 * page's own elements are not changed and its scripts cannot read PIM values.
 */
(function () {
  'use strict';
  // Already on this page and still connected to the extension: nothing to do. An earlier
  // copy that lost its extension (it was reloaded or updated) is cleared away first.
  const alive = () => {
    try {
      return !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  };
  // (A page can plant things under these names, so nothing about them is taken on trust.)
  const earlier = window.__bluestoneLens;
  try {
    if (earlier && typeof earlier.alive === 'function' && earlier.alive() === true) return;
    if (earlier && typeof earlier.stop === 'function') earlier.stop();
  } catch (e) {
    /* not ours, or gone already */
  }
  window.__bluestoneLens = { alive, stop: () => stop() };

  // The simulator (test/harness) clicks with scripts; on a real page only a real click,
  // key press or choice by the user is acted on. Only the simulator's own `true` counts:
  // a page element that happens to be called __LENS_HARNESS does not.
  const HARNESS = window.__LENS_HARNESS === true;
  const trusted = (fn) => (e) => (e && (e.isTrusted || HARNESS) ? fn(e) : undefined);

  // ---- buttons that change something in the PIM -----------------------------
  // They act only once Chrome reports that the button has been fully showing, with
  // nothing drawn over it, for a moment. So a page cannot cover the card and steer a
  // click onto "Save", or slide the card under a click that was meant for the page.
  const SHOWN_FOR = 500;
  const shownSince = new WeakMap();
  let watcher = null;
  function watch(el) {
    if (HARNESS || typeof IntersectionObserver === 'undefined') return;
    if (!watcher) {
      try {
        watcher = new IntersectionObserver((entries) => {
          for (const e of entries) {
            const showing = e.isIntersecting && e.intersectionRatio >= 0.99 && e.isVisible !== false;
            if (!showing) shownSince.delete(e.target);
            else if (!shownSince.has(e.target)) shownSince.set(e.target, Date.now());
          }
        }, { threshold: [0, 0.99, 1], trackVisibility: true, delay: 100 });
      } catch (e) {
        return; // a browser without it: the review step and real clicks still stand
      }
    }
    watcher.observe(el);
  }
  const ready = (el) => HARNESS || !watcher || (shownSince.has(el) && Date.now() - shownSince.get(el) >= SHOWN_FOR);
  function notYet(el) {
    const row = el.closest('.row') || el;
    if (row.nextElementSibling && row.nextElementSibling.classList.contains('wait')) return;
    row.after(h('div', { class: 'note warn small wait', role: 'status' }, 'Nothing was sent: the button had only just appeared, or something on the page is covering it. Make sure the whole card is showing, then click again.'));
  }

  const STATUS = {
    match: { pill: 'PIM', chip: 'From the PIM', title: 'This value comes from Bluestone PIM' },
    differs: { pill: 'Differs', chip: 'Differs from the PIM', title: 'The PIM holds a different value' },
    unsure: { pill: 'PIM?', chip: 'Probably from the PIM', title: 'Probably from Bluestone PIM' },
    unknown: { pill: 'Not in PIM', chip: 'Not found in the PIM', title: 'No matching value in Bluestone PIM' },
    empty: { pill: 'Empty in PIM', chip: 'Empty in the PIM', title: 'The attribute exists in the PIM but has no value' },
    unchecked: { pill: 'PIM picture?', chip: 'Not compared yet', title: 'This picture has not been compared with the PIM yet' },
    saved: { pill: 'Saved', chip: 'Saved to the PIM', title: 'You saved a new value to Bluestone PIM' },
    suggested: { pill: 'Suggested', chip: 'Suggestion sent', title: 'You sent a suggestion as a task' },
  };

  const state = {
    on: false, page: null, result: null, phase: 'idle', message: '', mode: 'suggest',
    pref: 'suggest', // the mode the user chose; `mode` is what this PIM and role allow of it
    env: null, // { id, name } of the PIM in use: Test or Production
    pimNote: '',
    open: null, view: null, done: {}, details: {}, settings: false, orgs: null, assignees: null, confirmOrg: null, small: false, closed: 0,
    images: null, imageNote: '', confirmOut: false, signedOut: false, busy: '',
  };
  let host = null;
  let rootEl = null;
  let layer = null;
  let dock = null;
  let pop = null;
  let hl = null;
  const pills = new Map();
  const marks = new Map();
  let observers = [];
  let layoutQueued = false;

  // ---- small helpers --------------------------------------------------------

  /**
   * Text is not put into the page as text. Each piece goes into an attribute and is drawn
   * by the style sheet (.t::before), so the page's scripts cannot find it with a text
   * search or by selecting it, which reach even into a closed part of the page.
   */
  const RAW_TEXT = /^(OPTION|STYLE|TEXTAREA)$/;
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    const write = !!(props && props.write);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false || k === 'write') continue;
      if (k === 'class') el.className = v;
      else if (k === 'onclick' && write) el.addEventListener('click', trusted((e) => (ready(el) ? v(e) : notYet(el))));
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), trusted(v));
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false || kid === '') continue;
      if (kid.nodeType) el.append(kid);
      else if (RAW_TEXT.test(el.tagName)) el.append(document.createTextNode(String(kid)));
      else {
        const t = document.createElement('span');
        t.className = 't';
        t.setAttribute('data-t', String(kid));
        el.append(t);
      }
    }
    if (write) watch(el);
    return el;
  }
  const clip = (s, n) => (String(s || '').length > n ? String(s).slice(0, n - 1) + '…' : String(s || ''));

  // Everything that follows a scan says which PIM, organisation and language that scan was
  // made with, so a save can never land in another language or organisation than the one shown.
  const BOUND = new Set(['lens:details', 'lens:preview', 'lens:apply', 'lens:suggest', 'lens:images', 'lens:facts']);
  async function send(type, rest) {
    const session = state.result && state.result.session;
    const at = BOUND.has(type) && session ? { at: { base: session.base, org: session.org.id, context: session.context.id } } : {};
    try {
      const r = (await chrome.runtime.sendMessage(Object.assign({ type }, at, rest))) || { ok: false, error: 'No answer from the extension.' };
      if (r.base) state.pimBase = r.base;
      const env = (r.session && r.session.environment) || r.environment;
      if (env && typeof env === 'object') state.env = { id: env.id === 'production' ? 'production' : 'test', name: env.id === 'production' ? 'Production' : 'Test' };
      if (r.state === 'stale' && state.on) {
        // The PIM session moved on (another organisation, PIM or language): nothing here can be trusted any more.
        Object.assign(state, { phase: 'error', message: r.error, open: null, view: null });
        render();
      }
      return r;
    } catch (e) {
      return { ok: false, error: 'The extension was updated or switched off. Reload this page and click the Lens again.' };
    }
  }

  // ---- the page -------------------------------------------------------------

  // "#/product/12" is a page of its own on some shops; "#reviews" is only a place on a page.
  const addressNow = () => location.origin + location.pathname + location.search + (/^#[/!]/.test(location.hash) ? location.hash : '');

  /**
   * What the page says it is showing: its heading, and a product number right beside it.
   * A page that swaps one variant for another keeps its address, but not this.
   */
  function showingNow() {
    const heading = state.page && state.page.headingEl;
    if (!heading) return '';
    if (!heading.isConnected) return null; // the page drew its heading anew
    const code = (el) => {
      const text = el && !el.children.length ? el.textContent.replace(/\s+/g, ' ').trim() : '';
      return /^[A-Za-z0-9][A-Za-z0-9._\-/]{2,39}$/.test(text) && /\d/.test(text) ? text : '';
    };
    return [heading.textContent.replace(/\s+/g, ' ').trim(), code(heading.previousElementSibling), code(heading.nextElementSibling)].join(' | ');
  }

  function readPage() {
    try {
      state.page = bsiExtractPage(true);
    } catch (e) {
      // A page that cannot be read still gets the box, where a product can be looked up by hand.
      state.page = { url: location.href, host: location.host, title: document.title, lang: '', name: document.title, heading: '', headingEl: null, brand: '', ids: [], pairs: [], blocks: [], images: [], selection: null };
    }
    state.address = addressNow();
    state.path = location.pathname + (/^#[/!]/.test(location.hash) ? location.hash : '');
    state.showing = showingNow();
    state.moved = false;
    movedAt = 0;
    readAt = Date.now();
  }

  /**
   * A shop that changes page without reloading (most modern shops) leaves the Lens
   * looking at the previous product. Once the address has changed, or the page shows
   * another product under the same address (another variant), and the new page has
   * had a moment to draw itself, read it again.
   */
  let movedAt = 0;
  let readAt = 0; // when the page was last read
  let gestureAt = 0; // the user's last real click or key press on the page
  function checkAddress() {
    if (!state.on || !state.page || state.phase === 'loading') return;
    const sameProduct = showingNow() === state.showing;
    if (addressNow() === state.address && sameProduct) {
      movedAt = 0;
      if (state.moved) {
        state.moved = false;
        renderDock();
      }
      return;
    }
    const otherPage = !sameProduct || location.pathname + (/^#[/!]/.test(location.hash) ? location.hash : '') !== state.path;
    // Only the part after "?" changed while a card is open: let the user finish first.
    if (state.open && !otherPage) return;
    if (!movedAt) {
      movedAt = Date.now();
      return;
    }
    if (Date.now() - movedAt < 1200) return;
    // Read the new page by itself only when the user did something since the last read (a
    // click on a link, a key press). A page that changes its own address over and over gets
    // a "read again" button instead of an endless stream of comparisons.
    if (gestureAt <= readAt) {
      if (!state.moved) {
        state.moved = true;
        if (state.open) closePop();
        else renderDock();
      }
      return;
    }
    rereadPage();
  }

  function rereadPage() {
    state.done = {};
    readPage();
    scan();
  }

  /** What goes to the background worker: text only, no page elements. */
  function pageData() {
    const p = state.page;
    return {
      url: p.url, host: p.host, title: p.title, lang: p.lang, name: p.name, heading: p.heading, brand: p.brand, ids: p.ids, selection: p.selection,
      pairs: p.pairs.map(({ label, value }) => ({ label, value })),
      blocks: (p.blocks || []).map((b) => ({ text: b.text })),
    };
  }

  /** Every marked fact: key -> { item, el }. */
  function entries() {
    const out = new Map();
    const r = state.result;
    if (!r || r.state !== 'ready') return out;
    // A fact shown in two places gets a pill in each: "pair:3" and "pair:3~1" are the same fact.
    const add = (base, item, els) => (els || []).forEach((el, n) => el && out.set(n ? `${base}~${n}` : base, { item, el, base }));
    for (const it of r.items) add('pair:' + it.i, it, state.page.pairs[it.i] && state.page.pairs[it.i].els);
    if (r.name) add('name', Object.assign({ label: 'Name' }, r.name), [state.page.headingEl]);
    for (const b of r.blocks || []) add('block:' + b.i, Object.assign({ label: 'Text' }, b), [state.page.blocks[b.i] && state.page.blocks[b.i].el]);
    // The product's pictures, once they have been compared with the PIM's.
    const im = state.images;
    (state.page.images || []).forEach((p, i) => {
      const it = im && im.items.find((x) => x.i === i);
      if (!it) return;
      add('img:' + i, {
        kind: 'image', label: 'Picture', value: p.src, alt: p.alt, w: p.w, h: p.h, status: it.status, why: it.why,
        asset: it.asset == null ? null : im.assets[it.asset], fact: null, others: [],
      }, [p.el]);
    });
    return out;
  }
  const baseOf = (key) => String(key).split('~')[0];
  const statusOf = (key, item) => state.done[baseOf(key)] || item.status;

  // ---- start, stop, scan ----------------------------------------------------

  /** Put the Lens on the page. False when this page cannot take it (no body, an odd document). */
  function begin() {
    state.on = true;
    state.small = innerWidth < 600;
    try {
      // Left behind by an earlier copy of the Lens on this page.
      document.querySelectorAll('[data-bluestone-lens]').forEach((x) => x.remove());
      build();
      readPage();
      render();
      return true;
    } catch (e) {
      stop();
      return false;
    }
  }

  async function start() {
    const prefs = await send('lens:prefs', {});
    if (!state.on) return;
    state.pref = prefs.mode === 'edit' ? 'edit' : 'suggest';
    state.mode = state.pref;
    await scan();
  }

  function stop() {
    state.on = false;
    for (const o of observers) o();
    observers = [];
    pills.clear();
    marks.clear();
    if (host) host.remove();
    host = null;
    Object.assign(state, { result: null, open: null, view: null, done: {}, details: {}, settings: false, phase: 'idle' });
  }

  let scanCount = 0;
  async function scan(extra) {
    const mine = ++scanCount; // a later scan makes this one's answer out of date
    Object.assign(state, { phase: 'loading', open: null, view: null, details: {}, message: '', images: null, imageNote: '', panelNote: '', pimNote: '', signedOut: false, busy: '', confirmOut: false });
    // Another product: what was saved or suggested belongs to the previous one.
    if (extra && (extra.productId || extra.fresh || extra.query)) state.done = {};
    render();
    const r = await send('lens:scan', Object.assign({ page: pageData() }, extra || {}));
    if (!state.on || mine !== scanCount) return;
    state.result = r;
    if (r.ok) state.phase = r.state;
    else if (r.state === 'auth' || r.state === 'access') state.phase = r.state;
    else {
      state.phase = 'error';
      state.message = r.error || 'Something went wrong.';
    }
    if (r.ok && r.session) {
      // A role that cannot edit starts in Suggest, and the other way round. So does a PIM
      // where saving is switched off (Production); the user's own choice is kept for Test.
      state.mode = state.pref;
      if (state.mode === 'edit' && !r.session.canEdit) state.mode = 'suggest';
      if (state.mode === 'suggest' && !r.session.canSuggest && r.session.canEdit) state.mode = 'edit';
    }
    render();
    if (state.phase === 'ready') loadImages();
  }

  /** Compare the page's product pictures with the PIM's. The text pills are already showing by now. */
  async function loadImages() {
    const list = (state.page.images || []).map(({ src, alt, w, h }) => ({ src, alt, w, h }));
    if (!list.length || !state.result || state.result.state !== 'ready') return;
    const productId = state.result.product.id;
    const r = await send('lens:images', { productId, images: list });
    if (!state.on || !state.result || state.result.state !== 'ready' || state.result.product.id !== productId) return;
    state.images = r.ok ? r : null;
    render();
  }

  /** Ask Chrome for permission to read the shop's pictures, then compare again. */
  async function allowImages() {
    const origins = (state.images && state.images.needPermission) || [];
    if (!origins.length) return;
    const r = await send('lens:allow-images', { origins });
    state.imageNote = r.ok ? '' : r.error || 'Chrome did not allow it.';
    if (r.ok) await loadImages();
    else render();
  }

  // ---- drawing --------------------------------------------------------------

  function build() {
    // A plain element, not a custom one: a page can define custom elements and would get a
    // way into their shadow root. Nothing on the page can open this one.
    host = document.createElement('div');
    host.setAttribute('data-bluestone-lens', '');
    host.style.cssText = 'all:initial;position:absolute;top:0;left:0;width:0;height:0;z-index:2147483646;';
    const shadow = host.attachShadow({ mode: 'closed' });
    if (window.__LENS_HARNESS) window.__lensRoot = shadow; // the simulator looks inside; real pages cannot
    rootEl = h('div', { class: 'root' });
    layer = h('div', { class: 'layer' });
    hl = h('div', { class: 'hl', hidden: true });
    pop = h('div', { class: 'pop', role: 'dialog', 'aria-label': 'Bluestone PIM value', hidden: true });
    dock = h('div', { class: 'dock', role: 'region', 'aria-label': 'Bluestone PIM Lens' });
    rootEl.append(layer, hl, dock, pop);
    shadow.append(h('style', {}, CSS), rootEl);
    mount();

    // On the next frame; or shortly after, when the browser is not drawing frames (a tab in the background).
    const queue = () => {
      if (layoutQueued) return;
      layoutQueued = true;
      const run = () => {
        if (!layoutQueued) return;
        layoutQueued = false;
        try {
          layout();
        } catch (e) {
          /* the page changed under us: the next pass places things again */
        }
      };
      requestAnimationFrame(run);
      setTimeout(run, 150);
    };
    const mo = new MutationObserver((list) => {
      if (list.every((m) => host.contains(m.target))) return;
      queue();
    });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-expanded'] });
    window.addEventListener('scroll', queue, true);
    window.addEventListener('resize', queue);
    const timer = setInterval(() => {
      if (!alive()) return stop(); // the extension was reloaded: leave the page clean
      checkAddress();
      queue();
    }, 1500);
    const onKey = (e) => {
      if (e.key === 'Escape' && state.open) {
        closePop();
        e.stopPropagation();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const onDown = (e) => {
      if (state.open && !e.composedPath().includes(host)) closePop();
    };
    document.addEventListener('mousedown', onDown, true);
    const onGesture = (e) => {
      if (e.isTrusted) gestureAt = Date.now();
    };
    document.addEventListener('pointerdown', onGesture, true);
    document.addEventListener('keydown', onGesture, true);
    window.addEventListener('popstate', onGesture, true);
    observers.push(
      () => mo.disconnect(),
      () => window.removeEventListener('scroll', queue, true),
      () => window.removeEventListener('resize', queue),
      () => clearInterval(timer),
      () => document.removeEventListener('keydown', onKey, true),
      () => document.removeEventListener('mousedown', onDown, true),
      () => document.removeEventListener('pointerdown', onGesture, true),
      () => document.removeEventListener('keydown', onGesture, true),
      () => window.removeEventListener('popstate', onGesture, true)
    );
  }

  /**
   * Where the overlay lives. Normally on top of the whole page. While the page
   * shows a modal dialog (a specification drawer, a lightbox), the browser blocks
   * everything outside that dialog, so the overlay moves inside it until it closes.
   */
  function mount() {
    const modals = [...document.querySelectorAll('dialog[open]')].filter((d) => {
      try {
        return d.matches(':modal');
      } catch (e) {
        return false;
      }
    });
    const want = modals.length ? modals[modals.length - 1] : document.documentElement;
    if (host.parentNode !== want) want.append(host);
  }

  /** The overlay's own top-left corner in the viewport: everything is placed relative to it. */
  const origin = () => host.getBoundingClientRect();

  function render() {
    if (!host) return;
    try {
      renderPills();
      renderDock();
      renderPop();
      layout();
    } catch (e) {
      // Never leave a half-drawn Lens on someone's page: say so in the box instead.
      try {
        Object.assign(state, { phase: 'error', message: 'The Lens ran into a problem on this page. Try again, or reload the page.', open: null, view: null });
        pop.hidden = true;
        renderDock();
      } catch (e2) {
        stop();
      }
    }
  }

  function renderPills() {
    const all = entries();
    for (const [key, pill] of pills) {
      if (!all.has(key)) {
        pill.remove();
        pills.delete(key);
        if (marks.has(key)) marks.get(key).remove();
        marks.delete(key);
      }
    }
    for (const [key, { item, el }] of all) {
      if (!el) continue;
      let pill = pills.get(key);
      if (!pill) {
        pill = h('button', {
          type: 'button', class: 'pill',
          onclick: () => (state.open === key ? closePop() : openPop(key)),
          onmouseenter: () => showHighlight(key),
          onmouseleave: () => showHighlight(state.open),
          onfocus: () => showHighlight(key),
          onblur: () => showHighlight(state.open),
        });
        pills.set(key, pill);
        // A soft marker over the value itself, under its pill; clicks go through it to the page.
        const mark = h('div', { class: 'mark', hidden: true });
        marks.set(key, mark);
        layer.prepend(mark);
        layer.append(pill);
      }
      const status = statusOf(key, item);
      const s = STATUS[status] || STATUS.unknown;
      pill.className = `pill s-${status}` + (state.open === key ? ' on' : '');
      pill.setAttribute('data-t', s.pill); // drawn by the style sheet, like all other text
      pill.title = `${s.title}${item.fact ? `: ${item.fact.label}` : ''}`;
      pill.setAttribute('aria-label', `${item.label || 'Value'}: ${s.title}`);
      pill.setAttribute('aria-expanded', state.open === key ? 'true' : 'false');
    }
  }

  /** The last line of an element's text, in viewport coordinates; null when it is not showing. */
  function anchor(el) {
    if (!el || !el.isConnected) return null;
    if (el.tagName === 'IMG') return anchorPicture(el);
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
    if (!rects.length) return null;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
    const last = rects[rects.length - 1];
    // Clipped or covered (a closed accordion, a tab that is not showing)?
    const x = Math.min(last.right - 2, Math.max(last.left + 2, last.left + last.width / 2));
    const y = last.top + last.height / 2;
    if (x >= 0 && y >= 0 && x < innerWidth && y < innerHeight) {
      const top = document.elementFromPoint(x, y);
      if (top && top !== host && !el.contains(top) && !top.contains(el)) return null;
    }
    return last;
  }

  /** A picture's box, or null when it is not showing (another slide of a gallery, a closed dialog). */
  function anchorPicture(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 60) return null;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
    const x = r.left + r.width / 2;
    const y = r.top + Math.min(r.height / 2, 80);
    if (x >= 0 && y >= 0 && x < innerWidth && y < innerHeight) {
      const top = document.elementFromPoint(x, y);
      if (top && top !== host && top !== el && !top.contains(el)) {
        // Something lies over it. A see-through zoom layer in the same frame is fine; another picture is not.
        const frame = el.parentElement && el.parentElement.parentElement;
        const overlay = frame && frame.contains(top) && top.tagName !== 'IMG' && !top.querySelector('img');
        if (!overlay) return null;
      }
    }
    return r;
  }

  /**
   * Mark the value on the page in the colour of its pill: a tinted underline box for
   * a short value, a bar down the side for a long text. Values the PIM does not
   * hold get no marker, only their pill.
   */
  function placeMark(mark, entry, status, o) {
    if (!mark) return;
    if (entry.item.kind !== 'image' && (status === 'unknown' || status === 'empty')) {
      mark.hidden = true;
      return;
    }
    if (entry.item.kind === 'image') {
      const r = entry.el.getBoundingClientRect();
      mark.hidden = status === 'unchecked';
      mark.className = `mark frame m-${status}`;
      mark.style.left = `${Math.round(r.left - 3 - o.left)}px`;
      mark.style.top = `${Math.round(r.top - 3 - o.top)}px`;
      mark.style.width = `${Math.round(r.width + 6)}px`;
      mark.style.height = `${Math.round(r.height + 6)}px`;
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(entry.el);
    const box = range.getBoundingClientRect();
    if (!box.width || !box.height) {
      mark.hidden = true;
      return;
    }
    const tall = box.height > 64;
    mark.hidden = false;
    mark.className = `mark m-${status}` + (tall ? ' bar' : '');
    mark.style.left = `${Math.round((tall ? box.left - 10 : box.left - 3) - o.left)}px`;
    mark.style.top = `${Math.round((tall ? box.top : box.top - 1) - o.top)}px`;
    mark.style.width = tall ? '4px' : `${Math.round(box.width + 6)}px`;
    mark.style.height = `${Math.round(tall ? box.height : box.height + 3)}px`;
  }

  /** Is this spot on the page empty: no text, picture or control under it? */
  function isFree(x, y, w, hgt) {
    const cx = x + w / 2;
    const cy = y + hgt / 2;
    if (cx < 0 || cy < 0 || cx >= innerWidth || cy >= innerHeight) return true; // off screen: nothing to check against
    const spot = document.elementFromPoint(cx, cy);
    if (!spot || spot === host) return false;
    if (/^(IMG|SVG|VIDEO|CANVAS|INPUT|SELECT|TEXTAREA|BUTTON|A|IFRAME)$/i.test(spot.tagName) || spot.closest('a, button')) return false;
    const range = document.createRange();
    range.selectNodeContents(spot);
    const rects = range.getClientRects();
    for (let i = 0; i < rects.length && i < 400; i++) {
      const r = rects[i];
      if (r.right > x - 2 && r.left < x + w + 2 && r.bottom > y && r.top < y + hgt) return false;
    }
    return true;
  }

  function layout() {
    if (!host) return;
    mount();
    let all = entries();
    // The page redrew itself and dropped our elements: read it again and re-attach by label and value.
    if ([...all.values()].some((e) => !e.el.isConnected)) {
      relink();
      renderPills();
      all = entries();
    }
    const o = origin();
    const docWidth = document.documentElement.clientWidth;
    const showing = new Set();
    // While measuring, the overlay must not count as "something at this spot".
    host.style.pointerEvents = 'none';
    for (const [key, pill] of pills) {
      const entry = all.get(key);
      const rect = entry && anchor(entry.el);
      const mark = marks.get(key);
      if (!rect) {
        pill.hidden = true;
        if (mark) mark.hidden = true;
        continue;
      }
      pill.hidden = false;
      showing.add(entry.base);
      placeMark(mark, entry, statusOf(key, entry.item), o);
      const w = pill.offsetWidth || 40;
      const ph = pill.offsetHeight || 18;
      const mid = rect.top + rect.height / 2;
      let left = rect.right + 6;
      let top = mid - ph / 2;
      if (entry.item.kind === 'image') {
        // In the picture's top-left corner.
        left = rect.left + 8;
        top = rect.top + 8;
      } else if (left + w > docWidth - 6) {
        // No room after the text. A value set against the right edge has room before it;
        // otherwise the pill goes under the end of the line.
        const before = rect.left - w - 6;
        if (before >= 6 && isFree(before, mid - ph / 2, w, ph)) left = before;
        else {
          left = Math.max(6, Math.min(rect.right - w, docWidth - w - 6));
          top = rect.bottom + 2;
        }
      }
      pill.style.left = `${Math.round(left - o.left)}px`;
      pill.style.top = `${Math.round(top - o.top)}px`;
    }
    host.style.pointerEvents = '';
    // Facts the page holds but is not showing right now (a closed tab or drawer).
    const bases = new Set([...all.values()].map((e) => e.base));
    const closed = [...bases].filter((b) => !showing.has(b)).length;
    if (closed !== state.closed) {
      state.closed = closed;
      renderDock();
    }
    showHighlight(state.hover || state.open);
    placePop();
  }

  function relink() {
    const old = state.page;
    let fresh;
    try {
      fresh = bsiExtractPage(true);
    } catch (e) {
      return;
    }
    for (const p of old.pairs) {
      const again = fresh.pairs.find((x) => x.label === p.label && x.value === p.value);
      p.els = again ? again.els : [];
    }
    old.headingEl = fresh.headingEl || null;
    for (const im of old.images || []) {
      const again = (fresh.images || []).find((x) => x.src === im.src);
      im.el = again ? again.el : null;
    }
    for (const b of old.blocks || []) {
      const again = (fresh.blocks || []).find((x) => x.text === b.text);
      b.el = again ? again.el : null;
    }
  }

  function showHighlight(key) {
    state.hover = key && key !== state.open ? key : null;
    const entry = key && entries().get(key);
    const el = entry && entry.el;
    if (!el || !el.isConnected || (pills.get(key) && pills.get(key).hidden)) {
      hl.hidden = true;
      return;
    }
    let r = el.getBoundingClientRect();
    if (el.tagName !== 'IMG') {
      const range = document.createRange();
      range.selectNodeContents(el);
      r = range.getBoundingClientRect();
    }
    if (!r.width || !r.height) {
      hl.hidden = true;
      return;
    }
    const o = origin();
    hl.hidden = false;
    hl.style.left = `${Math.round(r.left - o.left - 4)}px`;
    hl.style.top = `${Math.round(r.top - o.top - 3)}px`;
    hl.style.width = `${Math.round(r.width + 8)}px`;
    hl.style.height = `${Math.round(r.height + 6)}px`;
  }

  // ---- the dock (bottom-right) ----------------------------------------------

  function renderDock() {
    const r = state.result || {};
    const session = r.session;
    const head = h('div', { class: 'dock-head' },
      h('img', { class: 'logo', src: ICON, alt: '', width: '20', height: '20' }),
      h('strong', {}, 'Bluestone PIM Lens'),
      session ? h('span', { class: 'org', title: 'Organisation' }, clip(session.org.name, 26)) : null,
      h('button', { type: 'button', class: 'icon', title: state.small ? 'Show more' : 'Show less', 'aria-label': state.small ? 'Show more' : 'Show less', 'aria-expanded': String(!state.small), onclick: () => { state.small = !state.small; state.settings = false; renderDock(); } }, state.small ? '▴' : '▾'),
      h('button', { type: 'button', class: 'icon', title: 'Settings', 'aria-label': 'Settings', 'aria-expanded': String(state.settings), onclick: toggleSettings }, '⚙'),
      h('button', { type: 'button', class: 'icon', title: 'Close the Lens', 'aria-label': 'Close the Lens', onclick: stop }, '×')
    );
    const body = h('div', { class: 'dock-body' });
    // Node.append() would write the word "null" for an absent part: drop those first.
    const add = (...parts) => body.append(...parts.flat(Infinity).filter((x) => x != null && x !== false));
    // Live data: said in the box for as long as the Lens works on Production.
    const band = envBand();
    const pimAddress = (u) => (typeof u === 'string' && /^https:\/\/[a-z0-9.-]+\.bluestonepim\.com$/.test(u) ? u : null);
    const env = state.env || { id: 'test', name: 'Test' };
    const other = r.other && pimAddress(r.other.base) ? { base: r.other.base, name: r.other.name === 'Production' ? 'Production' : 'Test' } : null;
    const pimNote = state.pimNote ? h('p', { class: 'note warn small', role: 'alert' }, state.pimNote) : null;

    if (state.phase === 'loading') {
      add(h('p', { class: 'muted' }, h('span', { class: 'spin' }), state.busy || 'Reading the page and finding the product…'));
    } else if (state.phase === 'auth') {
      // The PIMs of the chosen environment (the list is fixed in the extension).
      const hosts = (Array.isArray(r.hosts) ? r.hosts : []).filter(pimAddress);
      // "demo-ui.test" and "app.test"; Production by its whole address.
      const short = (u) => (/\.test\.bluestonepim\.com$/.test(u) ? u.replace('https://', '').replace('.bluestonepim.com', '') : u.replace('https://', ''));
      add(
        h('p', {}, state.signedOut
          ? `You are signed out of Bluestone PIM (${env.name}) in this browser. Sign in again, as the same user or another one, then try again here.`
          : `Sign in to Bluestone PIM first. The Lens uses your own PIM session, in the ${env.name} environment.`),
        h('div', { class: 'row' },
          hosts.map((u) => h('a', { class: 'btn' + (u === r.base ? ' primary' : ''), href: u, target: '_blank', rel: 'noopener' }, `Open ${short(u)}`)),
          // Looks on every PIM above, whichever one you signed in to. Never on the other environment.
          h('button', { type: 'button', class: 'btn', onclick: () => scan({ anyHost: true }) }, 'Try again')),
        other ? h('p', { class: 'muted small' },
          other.name === 'Production' ? 'Working with production data? ' : 'Meant to work in Test? ',
          h('button', { type: 'button', class: 'link', onclick: () => choosePim(other.base) }, `Use ${other.name}`),
          other.name === 'Production' ? '. Chrome asks you to allow its address first. There the Lens reads and sends suggestions; it does not save.' : '.') : null,
        pimNote
      );
    } else if (state.phase === 'access') {
      add(
        h('p', {}, `Chrome has not been told to let the Lens reach Bluestone PIM ${env.name}. It asks you once.`),
        h('div', { class: 'row' },
          pimAddress(r.base) ? h('button', { type: 'button', class: 'btn primary', onclick: () => choosePim(r.base) }, `Allow ${env.name}`) : null,
          other ? h('button', { type: 'button', class: 'btn', onclick: () => choosePim(other.base) }, `Use ${other.name}`) : null),
        pimNote
      );
    } else if (state.phase === 'error') {
      const pimUrl = /^https:\/\/[a-z0-9.-]+\.bluestonepim\.com$/.test(state.pimBase || '') ? state.pimBase : null;
      add(h('p', { class: 'note bad' }, state.message),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn', onclick: () => scan() }, 'Try again'),
          // A way out when the problem is in the PIM itself (the wrong organisation, a missing language).
          pimUrl ? h('a', { class: 'btn', href: pimUrl, target: '_blank', rel: 'noopener' }, 'Open the PIM ↗') : null));
    } else if (state.phase === 'notfound' || state.phase === 'pick') {
      add(
        h('p', {}, state.phase === 'pick' ? 'Which product is this?' : `No product in ${session.org.name} matches this page.`),
        ...(r.candidates || []).slice(0, 5).map((c) =>
          h('button', { type: 'button', class: 'cand', onclick: () => scan({ productId: c.id }) },
            h('b', {}, clip(c.name, 60)), h('span', { class: 'muted' }, `${c.level} · ${c.number} · ${c.evidence}`))),
        findForm()
      );
    } else if (state.phase === 'ready') {
      const c = r.count;
      const chip = (kinds, label) => {
        const n = kinds.reduce((sum, k) => sum + (c[k] || 0), 0);
        return n ? h('button', { type: 'button', class: `chip s-${kinds[0]}`, title: 'Show these in the side panel', onclick: () => openPanel(kinds[0]) }, `${n} ${label}`) : null;
      };
      if (state.small) {
        dock.replaceChildren(...[head, band, h('div', { class: 'dock-body' }, h('div', { class: 'chips' }, chip(['match'], 'from the PIM'), chip(['differs'], c.differs === 1 ? 'differs' : 'differ'), chip(['unsure'], 'unsure'), chip(['unknown', 'empty'], 'not in the PIM')))].filter(Boolean));
        return;
      }
      add(
        state.moved ? h('div', { class: 'note warn small' }, 'The page has changed since it was read. ', h('button', { type: 'button', class: 'link', onclick: rereadPage }, 'Read it again')) : null,
        h('div', { class: 'product' },
          // Opens the product in the PIM in a new tab, with the comparison in the side panel beside it.
          h('a', { href: r.product.url, target: '_blank', rel: 'noopener', title: 'Open in Bluestone PIM, with the comparison in the side panel', onclick: () => openPanel('') }, clip(r.product.name, 44), ' ↗'),
          h('span', { class: 'muted' }, `${r.product.level} · ${r.product.number}`)),
        h('div', { class: 'chips' },
          chip(['match'], 'from the PIM'), chip(['differs'], c.differs === 1 ? 'differs' : 'differ'), chip(['unsure'], 'unsure'), chip(['unknown', 'empty'], 'not in the PIM'),
          !r.items.length ? h('span', { class: 'muted' }, 'No label and value pairs were found on this page.') : null),
        picturesLine(),
        state.closed ? h('p', { class: 'muted small' }, `${state.closed} of these ${state.closed === 1 ? 'is' : 'are'} in a part of the page that is closed. Open it to see ${state.closed === 1 ? 'its pill' : 'their pills'}, or click a count above to list them in the side panel.`) : null,
        h('p', { class: 'small' }, h('button', { type: 'button', class: 'link', onclick: () => openPanel('all') }, 'Show the details in the side panel')),
        state.panelNote ? h('p', { class: 'note warn small' }, state.panelNote) : null,
        modeSwitch(session),
        h('p', { class: 'muted small' }, r.via ? r.via + ' · ' : '', h('button', { type: 'button', class: 'link', onclick: () => scan({ fresh: true }) }, 'Not this product?'))
      );
    }
    if (state.settings && session) add(settingsPanel(session));
    dock.replaceChildren(...[head, band, body].filter(Boolean));
  }

  /** A band across the box while the Lens works on Production: these are live data. */
  function envBand() {
    if (!state.env || state.env.id !== 'production') return null;
    return h('div', { class: 'env-band', role: 'note' }, h('b', {}, 'PRODUCTION'), h('span', { class: 'sub' }, 'Live data. Suggestions only.'));
  }
  const envChip = () => (state.env && state.env.id === 'production' ? h('span', { class: 'chip env-prod' }, 'Production') : null);

  /**
   * Move the Lens to another PIM. For Production the background worker first puts Chrome's
   * own question for its address; until the answer is yes, nothing changes.
   */
  async function choosePim(base) {
    state.pimNote = '';
    const r = await send('lens:settings', { base });
    if (!state.on) return;
    if (!r.ok) {
      state.pimNote = r.error || 'The PIM was not changed.';
      return renderDock();
    }
    state.orgs = null;
    state.assignees = null;
    scan();
  }

  /** One line about the product's pictures, under the counts. */
  function picturesLine() {
    const im = state.images;
    if (!im || !im.items.length) return null;
    const n = (status) => im.items.filter((x) => (state.done['img:' + x.i] || x.status) === status).length;
    const parts = [];
    if (n('match')) parts.push(`${n('match')} from the PIM`);
    if (n('unknown')) parts.push(`${n('unknown')} not in the PIM`);
    if (n('suggested')) parts.push(`${n('suggested')} suggested`);
    const line = [parts.length ? `Pictures: ${parts.join(', ')}.` : ''];
    if (im.extra) line.push(` The PIM has ${im.extra} more that this page does not show.`);
    const out = [h('p', { class: 'small' }, line)];
    if (n('unchecked')) {
      const hosts = im.needPermission.map((o) => o.replace(/^https?:\/\//, '')).join(', ');
      out.push(h('div', { class: 'note info small' },
        im.needPermission.length
          ? [`${n('unchecked')} ${n('unchecked') === 1 ? 'picture is' : 'pictures are'} not compared yet. To compare, the Lens has to read pictures from ${hosts}. `,
            h('button', { type: 'button', class: 'link', onclick: allowImages }, 'Allow it')]
          : `${n('unchecked')} ${n('unchecked') === 1 ? 'picture' : 'pictures'} could not be read, so ${n('unchecked') === 1 ? 'it is' : 'they are'} not compared.`,
        state.imageNote ? h('div', { class: 'bad-text' }, state.imageNote) : null));
    }
    return out;
  }

  function findForm() {
    const input = h('input', { type: 'text', placeholder: 'Product number or name', 'aria-label': 'Product number or name' });
    const go = () => input.value.trim() && scan({ query: input.value.trim() });
    input.addEventListener('keydown', trusted((e) => e.key === 'Enter' && go()));
    return h('div', { class: 'row find' }, input, h('button', { type: 'button', class: 'btn', onclick: go }, 'Find'));
  }

  function modeSwitch(session) {
    const set = (mode) => {
      state.mode = mode;
      state.pref = mode;
      send('lens:prefs', { mode });
      if (state.view) state.view = newView(state.open);
      render();
    };
    const option = (mode, label, can, why) =>
      h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(state.mode === mode), class: state.mode === mode ? 'on' : '',
        disabled: !can, title: can ? '' : why, onclick: () => set(mode),
      }, label);
    return h('div', { class: 'mode' },
      h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Mode' },
        option('suggest', 'Suggest', session.canSuggest, 'Your role cannot create tasks in this organisation'),
        option('edit', 'Edit', session.canEdit, session.editLocked ? 'Saving is switched off on Production in this version of the Lens' : 'Your role cannot change products in this organisation')),
      h('span', { class: 'muted small' }, state.mode === 'edit' ? 'Changes are saved to the PIM.' : session.editLocked ? 'On Production the Lens does not save. Suggestions go to a colleague as a task.' : 'Suggestions go to a colleague as a task.'));
  }

  async function toggleSettings() {
    state.settings = !state.settings;
    state.small = false;
    state.confirmOrg = null;
    state.confirmOut = false;
    renderDock();
    if (state.settings && !state.assignees) {
      const a = await send('lens:assignees');
      if (a.ok) state.assignees = a;
      renderDock();
    }
  }

  function assigneeSelect(onPick) {
    const a = state.assignees;
    if (!a) return h('span', { class: 'muted' }, 'Loading…');
    const current = a.current && a.current.id;
    const select = h('select', { 'aria-label': 'Who gets suggestions' },
      h('option', { value: '' }, 'Choose who gets suggestions…'),
      a.groups.length ? h('optgroup', { label: 'Groups' }, a.groups.map((g) => h('option', { value: 'userGroup:' + g.id, selected: g.id === current }, g.name))) : null,
      h('optgroup', { label: 'People' }, a.users.map((u) => h('option', { value: 'user:' + u.id, selected: u.id === current }, u.name + (u.id === a.me ? ' (you)' : '')))));
    select.addEventListener('change', trusted(() => {
      const at = select.value.indexOf(':');
      const type = select.value.slice(0, at);
      const id = select.value.slice(at + 1);
      if (!id) return;
      const row = (type === 'userGroup' ? a.groups : a.users).find((x) => x.id === id);
      const picked = { id, type, name: row ? row.name : '' };
      a.current = picked;
      send('lens:assignee', { assignee: picked });
      if (onPick) onPick(picked);
    }));
    return select;
  }

  function settingsPanel(session) {
    const lang = h('select', { 'aria-label': 'Language' }, session.contexts.map((c) => h('option', { value: c.id, selected: c.id === session.context.id }, c.name)));
    lang.addEventListener('change', trusted(async () => {
      await send('lens:settings', { contextId: lang.value });
      scan();
    }));
    const pims = Array.isArray(session.pims) ? session.pims : session.hosts.map((u) => ({ base: u, label: u.replace('https://', '').replace('.bluestonepim.com', '') }));
    const pim = h('select', { 'aria-label': 'PIM' }, pims.map((x) => h('option', { value: x.base, selected: x.base === session.base }, x.label)));
    // Choosing Production puts Chrome's question for its address first; see choosePim().
    pim.addEventListener('change', trusted(() => choosePim(pim.value)));
    return h('div', { class: 'settings' },
      h('label', {}, h('span', {}, 'Organisation'), orgPicker(session)),
      h('label', {}, h('span', {}, 'Language'), lang),
      h('label', {}, h('span', {}, 'PIM'), pim),
      state.pimNote ? h('p', { class: 'note warn small', role: 'alert' }, state.pimNote) : null,
      h('label', {}, h('span', {}, 'Suggestions go to'), assigneeSelect()),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'link', onclick: () => { readPage(); scan(); } }, 'Read the page again')),
      signOutRow(session));
  }

  /** Who is signed in, and a way out: the Lens uses the browser's PIM session, so this ends that. */
  function signOutRow(session) {
    if (state.confirmOut) {
      return h('div', { class: 'confirm who' },
        h('p', {}, 'Sign out of Bluestone PIM? Your open PIM tabs are signed out too. After that you can sign in as someone else.'),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn primary', write: true, onclick: signOut }, 'Sign out'),
          h('button', { type: 'button', class: 'btn', onclick: () => { state.confirmOut = false; renderDock(); } }, 'Cancel')));
    }
    return h('p', { class: 'muted small who' },
      session.user ? `Signed in as ${clip(session.user, 40)}. ` : '',
      h('button', { type: 'button', class: 'link', onclick: () => { state.confirmOut = true; state.confirmOrg = null; renderDock(); } }, 'Sign out'));
  }

  async function signOut() {
    const mine = ++scanCount; // whatever is still being read belongs to the session that is ending
    Object.assign(state, { confirmOut: false, settings: false, phase: 'loading', busy: 'Signing out of Bluestone PIM…', open: null, view: null });
    render();
    const r = await send('lens:sign-out');
    if (!state.on || mine !== scanCount) return; // the page was read again meanwhile: that reading says where things stand
    Object.assign(state, { busy: '', orgs: null, assignees: null });
    if (r.ok) {
      // Nothing from the PIM stays on the page once nobody is signed in.
      Object.assign(state, { phase: 'auth', signedOut: true, result: { ok: false, state: 'auth', base: r.base, hosts: r.hosts, environment: r.environment, other: r.other }, done: {}, details: {}, images: null });
    } else {
      Object.assign(state, { phase: 'error', message: r.error || 'Could not sign out. Open the PIM and sign out there.' });
    }
    render();
  }

  function orgPicker(session) {
    if (state.confirmOrg) {
      const o = state.confirmOrg;
      return h('div', { class: 'confirm' },
        h('p', {}, `Switch to ${o.name}? Your open PIM tabs switch too.`),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn primary', write: true, onclick: async () => {
            state.confirmOrg = null;
            state.phase = 'loading';
            renderDock();
            const r = await send('lens:switch-org', { orgId: o.id });
            state.orgs = null;
            state.assignees = null;
            if (!r.ok) {
              state.phase = 'error';
              state.message = r.error || 'Could not switch organisation.';
              render();
            } else scan();
          } }, 'Switch'),
          h('button', { type: 'button', class: 'btn', onclick: () => { state.confirmOrg = null; renderDock(); } }, 'Cancel')));
    }
    if (!state.orgs) {
      return h('button', { type: 'button', class: 'btn', onclick: async () => {
        const r = await send('lens:orgs');
        state.orgs = r.ok ? r.orgs : [];
        renderDock();
      } }, clip(session.org.name, 30), ' ▾');
    }
    const list = h('div', { class: 'list' });
    const fill = (q) => {
      const rows = state.orgs.filter((o) => o.name.toLowerCase().includes(q.toLowerCase())).slice(0, 80);
      list.replaceChildren(...rows.map((o) => h('button', { type: 'button', class: o.id === session.org.id ? 'cur' : '', onclick: () => {
        if (o.id === session.org.id) return;
        state.confirmOrg = o;
        renderDock();
      } }, o.name, o.id === session.org.id ? ' (current)' : '')));
      if (!rows.length) list.append(h('span', { class: 'muted' }, 'No organisation by that name.'));
    };
    const filter = h('input', { type: 'text', placeholder: 'Search organisations', 'aria-label': 'Search organisations' });
    filter.addEventListener('input', trusted(() => fill(filter.value)));
    fill('');
    return h('div', { class: 'orgs' }, filter, list);
  }

  /**
   * Open the extension's side panel beside the page: the full comparison, differences
   * first. It stays open when you move to the PIM's own tab. filter: a pill status to
   * show ('differs', 'match', …), 'all' for the whole list, '' to leave the panel as it is.
   */
  async function openPanel(filter) {
    // Sent straight from the click: Chrome only opens the panel then.
    const r = await send('lens:open-panel', { filter: filter || '' });
    const note = r.ok ? '' : 'The side panel did not open. Right-click the page and choose “Open in the side panel instead”.';
    if (state.on && note !== (state.panelNote || '')) {
      state.panelNote = note;
      renderDock();
    }
  }

  // ---- the card on a pill ---------------------------------------------------

  function newView(key) {
    const entry = key && entries().get(key);
    if (!entry) return null;
    const f = entry.item.fact;
    const status = entry.item.status;
    const fromPage = status === 'differs' || status === 'unknown' || status === 'empty';
    return {
      step: 'form', asSuggest: false, error: '', busy: false, note: '', forceVla: false, preview: null, sent: null, facts: null,
      // Editing starts from what the PIM holds; a suggestion starts from what the page shows when the two differ.
      editInput: f ? f.input : '',
      suggestInput: fromPage || !f ? (entry.item.value || '') : f.options ? f.display : f.input,
      target: f && f.can.owner ? 'owner' : 'holder',
    };
  }

  function openPop(key) {
    state.open = key;
    state.view = newView(key);
    render();
    const entry = entries().get(key);
    if (entry && entry.item.fact && !state.details[baseOf(key)]) {
      const scanned = scanCount;
      send('lens:details', { productId: state.result.product.id, factKey: entry.item.fact.key, pageValue: entry.item.value }).then((d) => {
        if (scanned !== scanCount) return; // the page was read again meanwhile: this belongs to the earlier product
        state.details[baseOf(key)] = d.ok ? d : { failed: true };
        if (state.open === key && state.view && state.view.step === 'form') renderPopKeepingInput();
      });
    }
    if ((state.mode === 'suggest' || (entry && entry.item.kind === 'image')) && !state.assignees) {
      send('lens:assignees').then((a) => {
        if (a.ok) state.assignees = a;
        if (state.open === key) renderPopKeepingInput();
      });
    }
  }

  function closePop() {
    state.open = null;
    state.view = null;
    render();
  }

  /** Redraw the card without losing what is being typed. */
  function renderPopKeepingInput() {
    const active = pop.querySelector('[data-field]:focus');
    const field = active && active.getAttribute('data-field');
    renderPop();
    placePop();
    if (field) {
      const again = pop.querySelector(`[data-field="${field}"]`);
      if (again) again.focus();
    }
  }

  function fmtDate(ms) {
    try {
      return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) {
      return '';
    }
  }

  function renderPop() {
    const key = state.open;
    const entry = key && entries().get(key);
    if (!entry || !state.view) {
      pop.hidden = true;
      pop.replaceChildren();
      return;
    }
    const { item } = entry;
    const f = item.fact;
    const v = state.view;
    const session = state.result.session;
    const status = statusOf(key, item);
    const d = state.details[baseOf(key)];
    pop.hidden = false;
    if (item.kind === 'image') {
      pop.replaceChildren(...picturePop(key, item, status, session).flat(Infinity).filter((x) => x != null && x !== false));
      return;
    }

    const head = h('div', { class: 'pop-head' },
      h('span', { class: 'chips' }, h('span', { class: `chip s-${status}` }, (STATUS[status] || STATUS.unknown).chip), envChip()),
      h('button', { type: 'button', class: 'icon', 'aria-label': 'Close', onclick: closePop }, '×'));
    const title = h('h2', {}, f ? f.label : item.label || 'Value', f && item.label && item.label !== f.label && key.startsWith('pair') ? h('span', { class: 'muted' }, ` · “${item.label}” on this page`) : null);

    const rows = h('dl', {},
      h('dt', {}, 'On this page'), h('dd', {}, clip(item.value, 260)),
      h('dt', {}, 'In the PIM'), h('dd', { class: f && !f.empty ? '' : 'muted' }, f ? (f.empty ? 'No value' : clip(f.display, 260)) : 'Not found'));
    if (f) {
      const kept = f.where && f.where.inherited
        ? [`${f.owner.level} “${clip(f.owner.name, 40)}”`, h('span', { class: 'sub' }, `Inherited by this ${f.holder.level.toLowerCase()}${f.where.overridden ? ', which has its own value' : ''}${f.where.locked ? ' · locked' : ''}`)]
        : [`${f.owner.level} “${clip(f.owner.name, 40)}”`];
      rows.append(h('dt', {}, 'Kept on'), h('dd', {}, kept));
      if (d && d.lastChange) {
        rows.append(h('dt', {}, 'Last changed'), h('dd', {}, fmtDate(d.lastChange.date), d.lastChange.userName ? ` by ${d.lastChange.userName}` : '',
          d.lastChange.wholeProduct ? h('span', { class: 'sub' }, 'Latest change to the product') : d.lastChange.oldValue ? h('span', { class: 'sub' }, `Was: ${d.lastChange.oldValue}`) : null));
      }
    }

    const parts = [head, title, rows];
    if (v.step === 'choose') parts.push(chooser(key, item));
    else if (v.step === 'done') parts.push(doneNote(v, f));
    else if (v.step === 'review') parts.push(review(key, item));
    else {
      if (item.status === 'unsure' && f && key.startsWith('pair')) {
        parts.push(h('div', { class: 'note info' }, `Is “${item.label}” the attribute ${f.label}? `,
          h('button', { type: 'button', class: 'link', onclick: () => linkTo(key, item, f.key) }, 'Yes, remember that'), ' · ',
          h('button', { type: 'button', class: 'link', onclick: () => startChoose() }, 'No, choose another')));
      }
      if (!f && key.startsWith('pair')) {
        parts.push(h('div', { class: 'note info' }, 'Nothing in the PIM matches this value. ',
          h('button', { type: 'button', class: 'link', onclick: () => startChoose() }, 'Choose the attribute it belongs to')));
      }
      // Which side to fix: what the PIM's own history says about this difference.
      if (d && d.origin && (item.status === 'differs' || item.status === 'empty')) {
        parts.push(h('div', { class: 'note origin' }, h('b', {}, d.origin.title), ' ', d.origin.text));
      }
      const suggesting = state.mode === 'suggest' || v.asSuggest;
      if (suggesting) parts.push(session.canSuggest ? suggestForm(key, item) : h('div', { class: 'note warn' }, 'Your role in this organisation cannot create tasks.'));
      else parts.push(editForm(key, item));
      if (f && key.startsWith('pair') && item.status !== 'unsure') {
        parts.push(h('p', { class: 'muted small' }, item.linked ? 'Linked by you. ' : item.status === 'match' && item.why ? `Matched: ${item.why}. ` : '', h('button', { type: 'button', class: 'link', onclick: () => startChoose() }, 'Wrong attribute?')));
      }
    }
    pop.replaceChildren(...parts);
  }

  /** The card on a picture: the page's picture beside the PIM's, and a suggestion form. */
  function picturePop(key, item, status, session) {
    const v = state.view;
    const im = state.images || { assets: [], needPermission: [] };
    const size = (w, hgt) => (w && hgt ? `${w} × ${hgt} px` : '');
    const figure = (title, src, caption) => h('figure', {},
      h('figcaption', {}, title),
      src ? h('img', { src, alt: '' }) : h('div', { class: 'nopic' }, 'No picture'),
      caption ? h('span', { class: 'muted small' }, caption) : null);
    const parts = [
      h('div', { class: 'pop-head' },
        h('span', { class: 'chips' }, h('span', { class: `chip s-${status}` }, (STATUS[status] || STATUS.unknown).chip), envChip()),
        h('button', { type: 'button', class: 'icon', 'aria-label': 'Close', onclick: closePop }, '×')),
      h('h2', {}, 'Product picture'),
      h('div', { class: 'pics' },
        figure('On this page', item.value, size(item.w, item.h)),
        item.asset ? figure('In the PIM', item.asset.thumb, [item.asset.name, size(item.asset.width, item.asset.height)].filter(Boolean).join(' · ')) : figure('In the PIM', '', status === 'unchecked' ? 'Not compared yet' : 'No match')),
    ];
    if (status === 'unchecked') {
      parts.push(h('div', { class: 'note info' },
        im.needPermission.length ? ['To compare, the Lens has to read this picture from the shop’s image host. ', h('button', { type: 'button', class: 'link', onclick: allowImages }, 'Allow it')] : item.why + '.',
        state.imageNote ? h('div', { class: 'bad-text' }, state.imageNote) : null));
    }
    if (!item.asset && im.assets.length) {
      parts.push(h('div', {},
        h('p', { class: 'muted small' }, status === 'unchecked' ? 'The PIM’s pictures of this product:' : 'None of the PIM’s pictures of this product looks like it:'),
        h('div', { class: 'thumbs' }, im.assets.map((a) => (a.thumb ? h('img', { src: a.thumb, alt: a.name, title: a.name }) : h('div', { class: 'nopic', title: a.name }, '?'))))));
    } else if (!item.asset && status !== 'unchecked') {
      parts.push(h('p', { class: 'muted' }, 'This product has no pictures in the PIM.'));
    }
    if (v.step === 'done') {
      parts.push(doneNote(v));
      return parts;
    }
    const a = state.assignees;
    const note = h('textarea', { 'data-field': 'note', rows: '2', placeholder: 'For example: wrong picture, or a better one is in the PIM' });
    note.value = v.note;
    note.addEventListener('input', trusted(() => (v.note = note.value)));
    const who = a && a.current && !v.pickWho
      ? h('p', { class: 'muted small' }, `Goes to ${a.current.name || 'the chosen colleague'} as a task. `, h('button', { type: 'button', class: 'link', onclick: () => { v.pickWho = true; renderPopKeepingInput(); } }, 'Change'))
      : h('label', { class: 'field' }, h('span', {}, 'Send the task to'), assigneeSelect(() => { v.pickWho = false; v.error = ''; renderPopKeepingInput(); }));
    const send1 = async () => {
      if (!v.note.trim()) {
        v.error = 'Say what should change.';
        return renderPopKeepingInput();
      }
      if (!a || !a.current) {
        v.error = 'Choose who should get the task.';
        return renderPopKeepingInput();
      }
      v.busy = true;
      v.error = '';
      renderPopKeepingInput();
      const r = await send('lens:suggest', {
        productId: state.result.product.id, kind: 'image', pageLabel: 'Picture', pageValue: item.value, assetName: item.asset ? item.asset.name : '',
        note: v.note, pageUrl: location.href, assignee: a.current,
      });
      v.busy = false;
      if (!r.ok) v.error = r.error || 'The task could not be created.';
      else {
        state.done[baseOf(key)] = 'suggested';
        v.sent = Object.assign({ kind: 'suggested' }, r);
        v.step = 'done';
      }
      render();
    };
    parts.push(h('div', { class: 'form' },
      state.mode === 'edit' ? h('p', { class: 'muted small' }, 'Pictures are changed in the PIM’s media library, not from here. You can open the product there or send a suggestion.') : null,
      session.canSuggest
        ? [h('label', { class: 'field' }, h('span', {}, 'What should change?'), note), who,
          v.error ? h('div', { class: 'note bad', role: 'alert' }, v.error) : null]
        : h('div', { class: 'note warn' }, 'Your role in this organisation cannot create tasks.'),
      h('div', { class: 'row' },
        session.canSuggest ? h('button', { type: 'button', class: 'btn primary', write: true, disabled: v.busy, onclick: send1 }, v.busy ? 'Sending…' : 'Send suggestion') : null,
        h('a', { class: 'btn', href: state.result.product.url, target: '_blank', rel: 'noopener', onclick: () => openPanel('') }, 'Open in the PIM ↗'))));
    return parts;
  }

  function inputFor(f, value, name, onInput) {
    let el;
    if (f && f.options && name === 'edit') {
      el = h('select', { 'data-field': name }, h('option', { value: '' }, 'Choose…'), f.options.map((o) => h('option', { value: o.id, selected: o.id === value }, o.label)));
      el.addEventListener('change', trusted(() => onInput(el.value)));
    } else if ((f && f.long) || String(value).length > 70) {
      el = h('textarea', { 'data-field': name, rows: '4' });
      el.value = value;
      el.addEventListener('input', trusted(() => onInput(el.value)));
    } else {
      el = h('input', { type: 'text', 'data-field': name, value });
      el.addEventListener('input', trusted(() => onInput(el.value)));
    }
    return el;
  }

  function editForm(key, item) {
    const f = item.fact;
    const v = state.view;
    const product = state.result.product;
    if (!f) {
      return h('div', { class: 'form' },
        h('p', { class: 'muted' }, 'There is nothing to edit yet: choose the attribute this value belongs to, or send a suggestion.'),
        h('button', { type: 'button', class: 'btn', onclick: () => { v.asSuggest = true; renderPopKeepingInput(); } }, 'Suggest instead'));
    }
    if (!f.can.owner && !f.can.holder) {
      return h('div', { class: 'form' },
        h('p', { class: 'muted' }, f.can.reason || 'This value cannot be edited here.'),
        h('div', { class: 'row' },
          h('a', { class: 'btn', href: `${state.result.session.base}/products/${encodeURIComponent(f.owner.id)}`, target: '_blank', rel: 'noopener' }, 'Open in the PIM ↗'),
          h('button', { type: 'button', class: 'btn', onclick: () => { v.asSuggest = true; renderPopKeepingInput(); } }, 'Suggest instead')));
    }
    const field = inputFor(f, v.editInput, 'edit', (x) => (v.editInput = x));
    // "247 g" on the page, an attribute in grams: the number alone goes in the field.
    const pageInput = () => (f.unit ? String(item.value).trim().replace(/\s*[a-zA-Zµ°%"]{1,6}\.?$/, '') : String(item.value).trim());
    const usePage = (item.status === 'differs' || item.status === 'empty') && !f.options
      ? h('button', { type: 'button', class: 'link', onclick: () => { v.editInput = pageInput(); renderPop(); placePop(); } }, 'Use the value from this page')
      : null;
    let where = null;
    if (f.can.owner && f.can.holder) {
      const radio = (target, label) => h('label', { class: 'choice' },
        h('input', { type: 'radio', name: 'lens-target', checked: v.target === target, onchange: () => (v.target = target) }), h('span', {}, label));
      where = h('div', { class: 'choices' },
        radio('owner', `On the ${f.owner.level.toLowerCase()} “${clip(f.owner.name, 32)}”, where the value is kept`),
        radio('holder', `Only on this ${f.holder.level.toLowerCase()}`));
    }
    return h('div', { class: 'form' },
      h('label', { class: 'field' }, h('span', {}, `New value${f.unit ? ` (${f.unit})` : ''}`), field),
      usePage, where,
      v.error ? h('div', { class: 'note bad', role: 'alert' }, v.error) : null,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn primary', disabled: v.busy, onclick: async () => {
          v.busy = true;
          v.error = '';
          const r = await send('lens:preview', { productId: product.id, factKey: f.key, input: v.editInput, target: v.target });
          v.busy = false;
          if (!r.ok) v.error = r.error || 'That value cannot be saved.';
          else Object.assign(v, { preview: r, step: 'review' });
          renderPop();
          placePop();
        } }, 'Review change'),
        h('button', { type: 'button', class: 'link', onclick: () => { v.asSuggest = true; renderPopKeepingInput(); } }, 'Suggest instead')));
  }

  function review(key, item) {
    const f = item.fact;
    const v = state.view;
    const p = v.preview;
    const also = p.impact.propagates && (p.impact.variants || p.impact.groups)
      ? `It is passed down to ${[p.impact.groups ? `${p.impact.groups} group${p.impact.groups === 1 ? '' : 's'}` : '', p.impact.variants ? `${p.impact.variants} variant${p.impact.variants === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')}.`
      : '';
    return h('div', { class: 'form' },
      h('div', { class: 'preview' },
        h('div', {}, h('s', {}, f.empty ? 'No value' : clip(f.display, 120)), ' → ', h('b', {}, clip(p.display, 160))),
        h('div', { class: 'muted' }, `Saved on the ${p.product.level.toLowerCase()} “${clip(p.product.name, 40)}” (${p.product.number}). ${also}`),
        h('div', { class: 'muted' }, `${p.language ? `In ${p.language}, in ` : 'In '}${clip(p.organisation || '', 40)} on ${p.pim || ''}.`)),
      also ? h('label', { class: 'choice' }, h('input', { type: 'checkbox', checked: v.forceVla, onchange: (e) => (v.forceVla = e.target.checked) }), h('span', {}, 'Also overwrite products below that have their own value')) : null,
      v.error ? h('div', { class: 'note bad', role: 'alert' }, v.error) : null,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn primary', write: true, disabled: v.busy, onclick: async () => {
          v.busy = true;
          renderPop();
          const r = await send('lens:apply', { productId: state.result.product.id, factKey: f.key, input: v.editInput, target: v.target, forceVla: v.forceVla });
          v.busy = false;
          if (!r.ok) v.error = r.error || 'The PIM did not accept the change.';
          else {
            state.done[baseOf(key)] = 'saved';
            f.display = r.display;
            f.empty = false;
            v.sent = { kind: 'saved', display: r.display };
            v.step = 'done';
            delete state.details[baseOf(key)];
          }
          render();
        } }, v.busy ? 'Saving…' : 'Save to the PIM'),
        h('button', { type: 'button', class: 'btn', disabled: v.busy, onclick: () => { v.step = 'form'; v.error = ''; renderPop(); placePop(); } }, 'Back')));
  }

  function suggestForm(key, item) {
    const f = item.fact;
    const v = state.view;
    const a = state.assignees;
    const field = inputFor(f, v.suggestInput, 'suggest', (x) => (v.suggestInput = x));
    const note = h('textarea', { 'data-field': 'note', rows: '2', placeholder: 'Why? (optional)' });
    note.value = v.note;
    note.addEventListener('input', trusted(() => (v.note = note.value)));
    const who = a && a.current && !v.pickWho
      ? h('p', { class: 'muted small' }, `Goes to ${a.current.name || 'the chosen colleague'} as a task. `, h('button', { type: 'button', class: 'link', onclick: () => { v.pickWho = true; renderPopKeepingInput(); } }, 'Change'))
      : h('label', { class: 'field' }, h('span', {}, 'Send the task to'), assigneeSelect(() => { v.pickWho = false; v.error = ''; renderPopKeepingInput(); }));
    return h('div', { class: 'form' },
      h('label', { class: 'field' }, h('span', {}, `Suggested value${f && f.unit ? ` (${f.unit})` : ''}`), field),
      h('label', { class: 'field' }, h('span', {}, 'Note'), note),
      who,
      v.error ? h('div', { class: 'note bad', role: 'alert' }, v.error) : null,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn primary', write: true, disabled: v.busy, onclick: async () => {
          if (!a || !a.current) {
            v.error = 'Choose who should get the task.';
            return renderPopKeepingInput();
          }
          v.busy = true;
          v.error = '';
          renderPopKeepingInput();
          const r = await send('lens:suggest', {
            productId: state.result.product.id, factKey: f ? f.key : null, pageLabel: item.label, pageValue: item.value,
            input: v.suggestInput, note: v.note, pageUrl: location.href, assignee: a.current,
          });
          v.busy = false;
          if (!r.ok) v.error = r.error || 'The task could not be created.';
          else {
            state.done[baseOf(key)] = 'suggested';
            v.sent = Object.assign({ kind: 'suggested' }, r);
            v.step = 'done';
          }
          render();
        } }, v.busy ? 'Sending…' : 'Send suggestion'),
        v.asSuggest && state.mode === 'edit' ? h('button', { type: 'button', class: 'link', onclick: () => { v.asSuggest = false; renderPopKeepingInput(); } }, 'Back to editing') : null),
      h('p', { class: 'muted small' }, 'Nothing changes on the product until someone acts on the task.'));
  }

  function doneNote(v) {
    const s = v.sent;
    if (s.kind === 'saved') {
      return h('div', { class: 'note ok' }, h('b', {}, 'Saved to the PIM. '), 'This page shows the new value once the shop has picked it up from the PIM.');
    }
    return h('div', { class: 'note ok' },
      h('b', {}, `Sent to ${s.assignee || 'your colleague'} as a task. `),
      `“${s.title}”, due ${s.due}. `,
      s.attached ? '' : 'The product could not be put on the task; it is named in the description. ',
      h('a', { href: s.url, target: '_blank', rel: 'noopener' }, 'Open tasks in the PIM ↗'));
  }

  async function startChoose() {
    const v = state.view;
    v.step = 'choose';
    renderPop();
    placePop();
    if (!v.facts) {
      const r = await send('lens:facts', { productId: state.result.product.id });
      v.facts = r.ok ? r.facts : [];
      if (state.view === v) {
        renderPop();
        placePop();
      }
    }
  }

  function chooser(key, item) {
    const v = state.view;
    const list = h('div', { class: 'list' });
    const quick = (item.others || []).map((o) => o.key);
    const fill = (q) => {
      const all = v.facts || [];
      const rows = (q ? all.filter((x) => x.label.toLowerCase().includes(q.toLowerCase())) : all.filter((x) => quick.includes(x.key)).concat(all.filter((x) => !quick.includes(x.key)))).slice(0, 60);
      list.replaceChildren(...rows.map((x) => h('button', { type: 'button', onclick: () => linkTo(key, item, x.key) }, h('b', {}, x.label), x.display ? h('span', { class: 'muted' }, ' ' + x.display) : null)));
      if (!rows.length) list.append(h('span', { class: 'muted' }, v.facts ? 'No attribute by that name on this product.' : 'Loading…'));
    };
    const filter = h('input', { type: 'text', 'data-field': 'filter', placeholder: 'Search this product’s attributes', 'aria-label': 'Search attributes' });
    filter.addEventListener('input', trusted(() => fill(filter.value)));
    fill('');
    return h('div', { class: 'form' },
      h('p', {}, `Which attribute is “${item.label}”? The Lens remembers it for this shop.`),
      filter, list,
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => { v.step = 'form'; renderPop(); placePop(); } }, 'Back'),
        item.linked ? h('button', { type: 'button', class: 'link', onclick: () => linkTo(key, item, null) }, 'Forget the link') : null));
  }

  async function linkTo(key, item, factKey) {
    await send('lens:link', { host: location.host, label: item.label, factKey });
    await scan();
    if (entries().has(key)) openPop(key);
  }

  function placePop() {
    if (!host || pop.hidden || !state.open) return;
    const pill = pills.get(state.open);
    const narrow = innerWidth < 480;
    pop.classList.toggle('sheet', narrow || !pill || pill.hidden);
    if (pop.classList.contains('sheet')) {
      pop.style.left = '';
      pop.style.top = '';
      return;
    }
    const r = pill.getBoundingClientRect();
    const w = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const docWidth = document.documentElement.clientWidth;
    let left;
    let top;
    if (r.right + 12 + w <= docWidth - 8) {
      // Beside the pill, so the facts around it stay readable.
      left = r.right + 12;
      top = Math.max(8, Math.min(r.top - 44, innerHeight - ph - 8));
    } else {
      left = Math.max(8, Math.min(r.left - 16, docWidth - w - 8));
      top = r.bottom + 8;
      // Not enough room below but enough above: open upwards.
      if (top + ph > innerHeight - 8 && r.top - 8 - ph > 8) top = r.top - 8 - ph;
    }
    const o = origin();
    pop.style.left = `${Math.round(left - o.left)}px`;
    pop.style.top = `${Math.round(top - o.top)}px`;
  }

  // The Bluestone PIM icon (the PIM app's own favicon, 40 px), kept inline so the
  // page needs no access to the extension's files.
  const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAARGVYSWZNTQAqAAAACAABh2kABAAAAAEAAAAaAAAAAAADoAEAAwAAAAEAAQAAoAIABAAAAAEAAAAooAMABAAAAAEAAAAoAAAAAHrmZqwAAAHLaVRYdFhNTDpjb20uYWRvYmUueG1wAAAAAAA8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIiB4OnhtcHRrPSJYTVAgQ29yZSA2LjAuMCI+CiAgIDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+CiAgICAgIDxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiCiAgICAgICAgICAgIHhtbG5zOmV4aWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20vZXhpZi8xLjAvIj4KICAgICAgICAgPGV4aWY6Q29sb3JTcGFjZT4xPC9leGlmOkNvbG9yU3BhY2U+CiAgICAgICAgIDxleGlmOlBpeGVsWERpbWVuc2lvbj4yNTY8L2V4aWY6UGl4ZWxYRGltZW5zaW9uPgogICAgICAgICA8ZXhpZjpQaXhlbFlEaW1lbnNpb24+MjU2PC9leGlmOlBpeGVsWURpbWVuc2lvbj4KICAgICAgPC9yZGY6RGVzY3JpcHRpb24+CiAgIDwvcmRmOlJERj4KPC94OnhtcG1ldGE+CuYattQAAAepSURBVFgJ7Zh/UFTXFcfvfe/tsisiCvJThBSMMSNCYWFUmFqJDW01hKnJgm7BiVWn1cEyk/HHdOxU/nCqtradMC2MU4PRVCm7EEeTmhFtxTS21vAjJgarpUCQ8kMNguwq7L73br939bm7CsJq4j/hzTzu73M/75x7zrkLIRPPhAa+BhpIKjwYmLKiMvpxPlV4nEX+rtE7pQKJ6i+kv1qZ4e/arwywqKgoOicnJ50DqZQ2E8KmM5HsT1x5OMIfyK8EsKCgINlqtf6tubn5Z4wxKutcjao83CZIxtkGmZaZzVZxvJBfKiCHyc7Ofun48eMnrl279pxOp/s3pZR98vYqB6H074wphEq65a3MueWpAwJOWrhwYdHZs2er+/r6IkRRJIGBga33QZh6gjCVqKqLUFG/Pc18+MX7Y4+ofCkaBJxh3rx5exobG0sdDkcA348DhoSEtHn21n+oys5Bd5uSACYI+0xma6xnfOTaEwOWlpaGxcfHV126dKnY6XTe30WSpOGIiIhOraPBZr7KKGmiggRFykQQpFgiKH+c9f1S9wdp8x4snwhw3bp1c3fu3Hmivb39ZUVRfGTr9fq+jIyMa55OCj7hJKV3t1QVJxFEfXbw5JASz5yHa48FyJ1h6dKl36upqTnZ3d2dgvZDkgHYvX79eof3AKP0FFNkdFF3N0yO86jbnJp/aLn3PO+634CAETMzM39y5syZd+AMUd7CvOsGg6ELbR+1TjFGfMxU9T1B0sOp+dbuDxNRL08zv/2c93qt7hfg6dOnDXPnzt1dX19fBmcwakK4QwQEBJCgoCAHHKM1JiamLi4u7hBCjA9g3VtZQwP266+qsrwJWuyHiXEeFSJQXTjcqoKnRE2mVt7VtdZ6RMk1l5ycXN7W1rYOG98wGgz/MxgD/otQcmXy5CktoaGhLQkJCR1bt27tAaALc7gtR31M5j/NI4L0azjLd7nTwNSEyUN/qLf+sMh7kR+AhC7LXpwcOEl0/nxD9OdJMQmuzQ3bdZ+3EmoroXZN6IULFwLxIT5nTxt7sOQZpU1Q16N/OwCnc20C9rUGq+WANnfcgIsXl0iDMS+EMaX/earcmc+Imk4FMYUocns8kb5js+UpWVlZyy9fvrw7MTHxp7W1te9rm4xVml45PIfqxN0IQS/DiQYZcS5uqCps5OtGBUwxW8NE6pyN3MS9NI0SlowjHQ+oKTyW8UMOL7yjMiW/0Wp5Nzc391t1dXXvDgwMBOMcdufn52eVl5dfHgvOM85oat6f14qi/peq6mwJ6o2EvCzZC5BRU15lLqXiC8iZKVg4G/zh3OMIwghDmuK5lNcByQs7U1wrG6sL3luzZk3ikSNHTsCr79/5ZsyY8dGOHTuyV69e3e+BGLuW/kpFPBP1UTiL/8D+iJ3aU8IEU3NltRQQ9AN+FlR5yA2lDWslPoCvcyiKy9JkKzy2bdu2mfv27avt7e2do83hJZyEzJo16/CVK1deQ93lPeZP3RNmSqhKps7Odw3ZlwPuA+yASK/zkeWGI+S2qsiFHA5gIQcOHKh6EI4v4sEbHm8xmUxbUPfs4yNx7IZHg15z3d4lkmWIs68TJnybCsJdbTJyhzClsN5qqbl69apx0aJFVqS5lzjMaI/RaJQR2PNPnTr1zmhzxtWPTUS8ks/kkhIhPa8qJy2vsi59hfULU/4hMx/fv3+/AeY7CNNxsjHfqVOn3uCXWB/Z/jS4CRAaSmNjY/+yZMkSrhGD93qu0fQVlTO1vuLi4tioqKh2BGk7UpqKvMuQTZBqRwfGzeZT/jNAkzHe0m1iANG0tLSiixcvlqJOkBUakKretFgs1Rs3brxxb2MfmXv37g1uamqa1tPTE9rf3x+G1Bc5NDQUiStX5PDwcKTL5QpHfbosy9PwBquqGoQ0ufX8+fO/8hE03gbX4vz584uRU1WsYbjPMYB2JCUl7Th40JMjy8rKppXA9I+SC5tTZjXjyHym//Do0aANGzbMRFxMXrVqVeij1o005uMkHHLBggUbka5+B224x2A+gkOei4vCsV27dgVXVFScTJ7zDculwM2DAfJ1G0I97vCsG5O7CKPd8H68rMflYtclpvT1ign9nbaMOyNtPp4+H6eAKVVA/h6QFJC/5ZD8lgwzZkLYMQTjnM7OzvTo6PBn6IxnG8gXvd8UJEMQj9o8LLkfHtARRyWRIfaJ9gjSPhCRX3kLQayFEfFHDba8gfGAaXMeMhUglXPnzpUi4b8OB+AeSnDGFgDcgMvpitu3b5NbNwfnfFoed5MQ4RPc7wi/HeNn5d1XcbljINKhTpSM06igewYRdRJSwn/I0E2/A7aPBjXqe5osxa80Ckf4zeDgYLLNZpsETzza1dW17JbDcS9rsEbEyEwozf3w/AwgAPKUqLSqsvI+I0KNntFz/7StfCwzjwjId7sH+UZqaioF1JaqqqpweOBbCC8/ttvtSayECKmfsY9EHEJ+8eThUFXlLqa6aqH2Gp2kfPCvQwW33ORP8MfHSUaSA9PSPXv2hG3atOk6oBmuVEs6OjreaDlWmJryi2fjRFE4DsSPqaBWq5T9taHScmMkOU+tjwOvXbv2ebPZ7P73xUjX9KcGM7HRhAYmNEDI/wEpkGdo8uEdMAAAAABJRU5ErkJggg==';

  // ---- styles ---------------------------------------------------------------

  const CSS = `
    :host { all: initial; }
    .t::before { content: attr(data-t); }
    .root, .root * { -webkit-user-select: none; user-select: none; }
    .root input, .root textarea { -webkit-user-select: text; user-select: text; }
    .root { --blue: #2f5fb3; --blue-d: #234a8f; --ink: #1d2433; --text: #3a4252; --muted: #6a7282; --line: #d5d9e2; --bg: #fff; --soft: #f4f6fa;
      --ok: #17694a; --ok-bg: #dff3e8; --warn: #8a5300; --warn-bg: #fdecc8; --bad: #a82a25; --bad-bg: #fbe1df; --pur: #5b3ea8; --pur-bg: #ebe4fb;
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: var(--text); text-align: left; letter-spacing: normal; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    button, input, select, textarea { font: inherit; color: inherit; }
    button { cursor: pointer; }
    button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }
    a { color: var(--blue); text-decoration: none; }
    a:hover { text-decoration: underline; }
    p { margin: 0; }
    .muted { color: var(--muted); }
    .small { font-size: 12px; }
    .link { background: none; border: 0; padding: 0; color: var(--blue); }
    .link:hover { text-decoration: underline; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

    .layer { position: absolute; top: 0; left: 0; }
    .pill { position: absolute; display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 8px 0 6px; border-radius: 10px; border: 1.5px solid transparent;
      font-size: 12px; font-weight: 700; line-height: 17px; white-space: nowrap; transition: transform .08s;
      box-shadow: 0 0 0 2px #fff, 0 2px 6px rgba(20, 30, 50, .38); }
    .pill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    .pill::after { content: attr(data-t); }
    .pill:hover, .pill.on { transform: scale(1.1); }
    .pill.on { box-shadow: 0 0 0 2px #fff, 0 0 0 4px var(--ink); }
    /* Pills are solid so they stand out on any page; the chips in the cards keep the soft colours below. */
    .pill.s-match { background: var(--blue); color: #fff; border-color: var(--blue); }
    .pill.s-match::before, .pill.s-saved::before { content: "✓"; width: auto; height: auto; background: none; font-size: 11px; line-height: 1; }
    .pill.s-saved { background: var(--ok); color: #fff; border-color: var(--ok); }
    .pill.s-differs { background: #f5a800; color: #382300; border-color: #cf8800; }
    .pill.s-unsure { background: #fff; color: var(--blue-d); border-color: var(--blue); }
    .pill.s-unknown, .pill.s-empty { background: #fff; color: #474f60; border: 1.5px dashed #7b8496; }
    .pill.s-suggested { background: var(--pur); color: #fff; border-color: var(--pur); }
    .pill.s-unchecked { background: #fff; color: var(--blue-d); border-color: var(--blue); }
    .chip.s-unchecked { background: #e6eefb; color: var(--blue-d); }
    .mark { position: absolute; pointer-events: none; border-radius: 3px; }
    .mark.frame { background: none; box-shadow: none; border: 3px solid transparent; border-radius: 6px; }
    .frame.m-match { border-color: var(--blue); }
    .frame.m-unknown { border: 3px dashed #7b8496; }
    .frame.m-suggested { border-color: var(--pur); }
    .pics { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    figure { margin: 0; display: grid; gap: 4px; align-content: start; }
    figcaption { font-size: 12px; color: var(--muted); }
    figure img { width: 100%; height: 130px; object-fit: contain; background: var(--soft); border: 1px solid var(--line); border-radius: 6px; }
    .nopic { height: 130px; display: grid; place-items: center; background: var(--soft); border: 1px dashed var(--line); border-radius: 6px; color: var(--muted); font-size: 12px; }
    .thumbs { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
    .thumbs img, .thumbs .nopic { width: 56px; height: 72px; object-fit: contain; background: var(--soft); border: 1px solid var(--line); border-radius: 4px; }
    .bad-text { color: var(--bad); margin-top: 4px; }
    .mark.bar { border-radius: 2px; }
    .m-match { background: rgba(47, 95, 179, .13); box-shadow: inset 0 -2px 0 var(--blue); }
    .m-differs { background: rgba(245, 168, 0, .24); box-shadow: inset 0 -2px 0 #cf8800; }
    .m-unsure { border-bottom: 2px dashed var(--blue); border-radius: 0; }
    .m-saved { background: rgba(23, 105, 74, .14); box-shadow: inset 0 -2px 0 var(--ok); }
    .m-suggested { background: rgba(91, 62, 168, .14); box-shadow: inset 0 -2px 0 var(--pur); }
    .m-match.bar { background: var(--blue); box-shadow: none; }
    .m-differs.bar { background: #f5a800; box-shadow: none; }
    .m-unsure.bar { background: none; border-bottom: 0; border-left: 3px dashed var(--blue); }
    .m-saved.bar { background: var(--ok); box-shadow: none; }
    .m-suggested.bar { background: var(--pur); box-shadow: none; }
    .s-match { background: var(--ok-bg); color: var(--ok); border-color: #9fd5bb; }
    .s-saved { background: var(--ok); color: #fff; }
    .s-differs { background: var(--warn-bg); color: var(--warn); border-color: #ecc67a; }
    .s-unsure { background: var(--bg); color: var(--blue-d); border-color: #a9bde3; }
    .s-unknown, .s-empty { background: var(--bg); color: var(--muted); border: 1px dashed #aab1bf; }
    .s-suggested { background: var(--pur-bg); color: var(--pur); border-color: #c4b3ef; }
    .hl { position: absolute; border: 2px solid var(--blue); border-radius: 5px; background: rgba(47, 95, 179, .07); pointer-events: none; }

    .dock { position: fixed; right: 16px; bottom: 16px; width: 320px; max-width: calc(100vw - 24px); max-height: calc(100vh - 32px); overflow: auto;
      background: var(--bg); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 10px 34px rgba(20, 30, 50, .28); }
    .dock-head { display: flex; align-items: center; gap: 7px; padding: 9px 10px 9px 12px; border-bottom: 1px solid var(--line); color: var(--ink); }
    .dock-head strong { font-size: 13px; }
    .dock-head strong { white-space: nowrap; }
    .dock-head .org { margin-left: auto; min-width: 0; flex: 0 1 auto; font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .logo { width: 20px; height: 20px; border-radius: 4px; flex: none; display: block; }
    .icon { border: 0; background: none; width: 24px; height: 24px; border-radius: 6px; color: var(--muted); font-size: 16px; line-height: 1; flex: none; }
    .icon:hover { background: var(--soft); color: var(--ink); }
    .dock-body { padding: 10px 12px 12px; display: grid; gap: 9px; }
    .product { display: grid; gap: 1px; }
    .product a { font-weight: 600; color: var(--ink); overflow-wrap: anywhere; }
    .chips { display: flex; flex-wrap: wrap; gap: 5px; }
    .chip { display: inline-block; border-radius: 10px; padding: 1px 8px; font-size: 11px; font-weight: 600; border: 1px solid transparent; }
    button.chip:hover { filter: brightness(.96); }
    .mode { display: grid; gap: 4px; }
    .seg { display: grid; grid-template-columns: 1fr 1fr; background: var(--soft); border-radius: 8px; padding: 3px; gap: 3px; }
    .seg button { border: 0; background: none; border-radius: 6px; padding: 5px 0; font-weight: 600; color: var(--muted); }
    .seg button.on { background: var(--bg); color: var(--ink); box-shadow: 0 1px 2px rgba(20, 30, 50, .2); }
    .seg button:disabled { opacity: .45; cursor: not-allowed; }
    .cand { display: grid; gap: 1px; text-align: left; width: 100%; border: 1px solid var(--line); background: var(--bg); border-radius: 8px; padding: 7px 9px; }
    .cand:hover { border-color: var(--blue); background: var(--soft); }
    .find input { flex: 1; min-width: 0; }
    .settings { display: grid; gap: 7px; border-top: 1px solid var(--line); padding-top: 9px; }
    .settings label { display: grid; grid-template-columns: 104px minmax(0, 1fr); gap: 8px; align-items: start; }
    .settings label > span { color: var(--muted); padding-top: 4px; }
    .orgs, .confirm { display: grid; gap: 5px; }
    .who { border-top: 1px solid var(--line); padding-top: 8px; margin: 0; }
    .list { display: grid; gap: 1px; max-height: 180px; overflow: auto; border: 1px solid var(--line); border-radius: 6px; padding: 3px; }
    .list button { text-align: left; border: 0; background: none; border-radius: 4px; padding: 4px 6px; overflow-wrap: anywhere; }
    .list button:hover { background: var(--soft); }
    .list .cur { font-weight: 600; }
    .spin { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--line); border-top-color: var(--blue); border-radius: 50%; margin-right: 6px; vertical-align: -2px; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spin { animation: none; } .pill { transition: none; } }

    input[type="text"], select, textarea { border: 1px solid var(--line); background: var(--bg); border-radius: 6px; padding: 5px 7px; width: 100%; color: var(--ink); }
    textarea { resize: vertical; min-height: 44px; }
    .btn { display: inline-block; border: 1px solid var(--line); background: var(--bg); color: var(--ink); border-radius: 6px; padding: 5px 11px; font-weight: 600; }
    .btn:hover { border-color: var(--blue); text-decoration: none; }
    .btn.primary { background: var(--blue); border-color: var(--blue); color: #fff; }
    .btn.primary:hover { background: var(--blue-d); }
    .btn:disabled { opacity: .55; cursor: default; }
    .note { border-radius: 8px; padding: 7px 9px; color: var(--ink); }
    .note.ok { background: var(--ok-bg); } .note.bad { background: var(--bad-bg); } .note.warn { background: var(--warn-bg); } .note.info { background: #e6eefb; }

    .pop { position: absolute; width: 340px; max-width: calc(100vw - 16px); background: var(--bg); border: 1px solid var(--line); border-radius: 12px;
      box-shadow: 0 12px 40px rgba(20, 30, 50, .32); padding: 11px 13px 13px; display: grid; gap: 9px; }
    .pop.sheet { position: fixed; left: 8px; right: 8px; bottom: 8px; top: auto; width: auto; max-height: 75vh; overflow: auto; }
    .pop-head { display: flex; justify-content: space-between; align-items: center; }
    .pop-head .chips { display: flex; gap: 6px; align-items: center; margin: 0; }
    .note.origin { background: var(--soft); border-left: 3px solid var(--blue); border-radius: 0 6px 6px 0; }
    .chip.env-prod { background: var(--bad); color: #fff; }
    .env-band { display: flex; gap: 8px; align-items: baseline; padding: 4px 12px; background: var(--bad); color: #fff; font-size: 11px; }
    .env-band b { letter-spacing: .06em; }
    .env-band .sub { opacity: .95; }
    .pop h2 { margin: 0; font-size: 15px; line-height: 1.3; color: var(--ink); overflow-wrap: anywhere; }
    .pop h2 .muted { font-weight: 400; font-size: 12px; }
    dl { margin: 0; display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 5px 10px; }
    dt { color: var(--muted); }
    dd { margin: 0; color: var(--ink); overflow-wrap: anywhere; white-space: pre-line; max-height: 120px; overflow: auto; }
    dd .sub { display: block; color: var(--muted); font-size: 12px; }
    .form { display: grid; gap: 8px; border-top: 1px dashed var(--line); padding-top: 9px; }
    .field { display: grid; gap: 3px; }
    .field > span { font-size: 12px; color: var(--muted); }
    .choices { display: grid; gap: 4px; }
    .choice { display: flex; gap: 7px; align-items: flex-start; }
    .choice input { margin: 3px 0 0; accent-color: var(--blue); }
    .preview { background: var(--soft); border-radius: 8px; padding: 8px 10px; display: grid; gap: 3px; color: var(--ink); overflow-wrap: anywhere; }
    .preview s { color: var(--muted); }
  `;

  // ---- the toolbar button ---------------------------------------------------

  let myTabId = null;
  try {
    if (chrome.tabs && chrome.tabs.getCurrent) chrome.tabs.getCurrent((t) => (myTabId = t ? t.id : null));
  } catch (e) {
    /* a content script: no tabs API */
  }
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    // Permission to read the shop's pictures was given from the right-click menu: compare now.
    if (msg && msg.type === 'lens:images-again' && (msg.tabId == null || msg.tabId === myTabId)) {
      if (state.on) loadImages();
      return;
    }
    if (!msg || (msg.type !== 'lens:toggle' && msg.type !== 'lens:show')) return;
    // Sent to every extension page when the page is one of the extension's own: only the right tab answers.
    if (msg.tabId != null && msg.tabId !== myTabId) return;
    if (state.on && msg.type === 'lens:toggle') stop();
    else if (!state.on) {
      // The button gets a "!" when this page cannot take the Lens.
      if (!begin()) return reply({ ok: false, on: false });
      start();
    }
    reply({ ok: true, on: state.on });
  });
})();
