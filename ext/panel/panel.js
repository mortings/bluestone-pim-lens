/*
 * The side panel: shows the product behind the current page, traces a selected
 * fact to where it lives in the PIM, and lets the user fix it there.
 * All page and PIM text is written with textContent: nothing is rendered as HTML.
 */
(async function () {
  'use strict';

  const { inspect: I, pim: P } = globalThis.BSI;
  const PIM_HOSTS = P.HOSTS; // Test and Production: the list is fixed in src/pim.js
  const envOf = (base) => P.environmentOf(base) || P.ENVIRONMENTS[0];
  /** Saving is switched off where the environment says so (Production, in this version). */
  const editLocked = () => !envOf(state.base).edit;
  const LOCKED = 'Saving is switched off on Production in this version of the Lens. Send a suggestion from the page instead.';
  const $ = (id) => document.getElementById(id);
  const app = $('app');

  /** Tiny DOM builder: h('div', { class: 'card', onclick }, 'text', child, …) */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'disabled' || k === 'value' || k === 'selected') el[k] = v;
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.appendChild(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
    }
    return el;
  }

  const state = {
    tabId: null,
    page: null,
    captureError: '',
    base: 'https://demo-ui.test.bluestonepim.com',
    org: null, // { id, name } the session is signed in to
    orgs: null, // every organisation the user can switch to
    contexts: null,
    context: null,
    contextChosen: false,
    idAttrs: null, // identifier attributes of this organisation
    matches: {}, // "<org>|<page address>" -> product id the user chose
    status: 'empty', // empty | loading | auth | access | error | notfound | pick | ready
    error: '',
    user: '', // the signed-in user's name
    notice: '',
    identified: null, // { product, via, candidates, tried, fromSelection }
    loaded: null,
    report: [],
    focus: null, // { value, label, from: 'selection' | 'pair' }
    ranked: [],
    openKey: null,
    details: {}, // fact key -> 'loading' | detail | { error }
    fix: null, // { key, input, target, forceVla, step: 'edit' | 'preview' | 'saving', error }
    saved: null, // { key, text }
    filter: '', // which rows of the comparison to show: '' | differs | missing | unsure | match
    jumpToReport: false,
    runId: 0,
  };
  const picker = { open: false, filter: '', pending: null, switching: false, error: '' };

  // Links to the demo shop pages, shown only in a copy of the extension that has them
  // (they show a product of one particular demo organisation, so the public copy leaves them out).
  const demoLinks = h('p', { class: 'small', style: 'margin-top:8px', hidden: true },
    h('button', { class: 'link', type: 'button', onclick: () => chrome.tabs.create({ url: chrome.runtime.getURL('demo/shop.html') }) }, 'Open the demo shop page'),
    ' · ',
    h('button', { class: 'link', type: 'button', onclick: () => chrome.tabs.create({ url: chrome.runtime.getURL('demo/shop-no-number.html') }) }, 'one without a product number'),
    h('span', { class: 'muted' }, ' (found only in an organisation that has this demo product)'));
  if (chrome.tabs && chrome.runtime.getURL) {
    fetch(chrome.runtime.getURL('demo/shop.html'), { method: 'HEAD' }).then((r) => (demoLinks.hidden = !r.ok), () => {});
  }
  let pim = null;

  function makePim() {
    pim = P.createPim(globalThis.BSI_TEST_TRANSPORT || P.sessionTransport(state.base));
  }

  // ---- session, organisation, remembered matches -----------------------------------

  /** Who is signed in, and to which organisation. Resets what belongs to the old one. */
  async function loadSession() {
    const me = await pim.me();
    state.user = typeof me.name === 'string' ? me.name : '';
    if (!state.org || state.org.id !== me.organization) {
      state.org = { id: me.organization, name: me.organizationName || me.organization };
      state.contexts = null;
      state.idAttrs = null;
      state.contextChosen = false;
    }
    renderOrgButton();
    if (!state.orgs) {
      pim.organizations()
        .then((orgs) => {
          state.orgs = orgs.sort((x, y) => x.name.localeCompare(y.name));
          const mine = state.orgs.find((o) => o.id === state.org.id);
          if (mine) state.org.name = mine.name;
          renderOrgButton();
        })
        .catch(() => {});
    }
  }

  /** Identifier attributes ("Ean", "Item number"…), looked up once a day per organisation. */
  async function loadIdAttributes() {
    if (state.idAttrs) return;
    const key = 'bsi:idattrs';
    const cache = (await chrome.storage.local.get({ [key]: {} }))[key];
    const hit = cache[state.org.id];
    if (hit && Date.now() - hit.at < 24 * 3600 * 1000) {
      state.idAttrs = hit.attrs;
      return;
    }
    state.idAttrs = I.detectIdAttributes(await pim.allDefinitions(state.context));
    cache[state.org.id] = { at: Date.now(), attrs: state.idAttrs };
    chrome.storage.local.set({ [key]: cache });
  }

  /** A page's address without tracking parameters, per organisation. */
  function matchKey() {
    let address = state.page.url;
    try {
      const u = new URL(state.page.url);
      for (const k of [...u.searchParams.keys()]) if (/^(utm_|gclid|fbclid|ref$|mc_)/i.test(k)) u.searchParams.delete(k);
      u.hash = '';
      address = u.toString();
    } catch (e) {
      /* keep the raw address */
    }
    return `${state.org.id}|${address}`;
  }

  function remember(productId) {
    const key = matchKey();
    if (productId) state.matches[key] = productId;
    else delete state.matches[key];
    const keys = Object.keys(state.matches);
    for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete state.matches[k];
    chrome.storage.local.set({ 'bsi:matches': state.matches });
  }

  // ---- loading -----------------------------------------------------------------

  function fail(e) {
    if (e && e.kind === 'auth') {
      state.status = 'auth';
      state.org = null;
      renderOrgButton();
    } else {
      state.status = 'error';
      state.error = (e && e.message) || 'Something went wrong.';
    }
    render();
  }

  /** Whether Chrome lets the panel reach the chosen PIM. Production is allowed by the user when they choose it. */
  async function canReach(base) {
    if (envOf(base).id === 'test' || globalThis.BSI_TEST_TRANSPORT) return true;
    try {
      return await chrome.permissions.contains({ origins: [P.originPattern(base)] });
    } catch (e) {
      return false;
    }
  }

  async function run() {
    const id = ++state.runId;
    renderEnv();
    if (!(await canReach(state.base))) {
      if (id !== state.runId) return;
      state.status = 'access';
      state.org = null;
      renderOrgButton();
      return render();
    }
    if (id !== state.runId) return;
    if (!state.page) {
      state.status = state.captureError ? 'error' : 'empty';
      state.error = state.captureError;
      render();
      return loadSession().catch(() => {});
    }
    Object.assign(state, { status: 'loading', loaded: null, fix: null, details: {}, saved: null, identified: null });
    render();
    try {
      // The on-page view may have chosen a product for this page since the panel started.
      state.matches = (await chrome.storage.local.get({ 'bsi:matches': {} }))['bsi:matches'] || {};
      await loadSession();
      if (!state.contexts) {
        state.contexts = await pim.contexts();
        fillContexts();
      }
      if (!state.contextChosen) state.context = (I.pickContext(state.contexts, state.page.lang) || {}).id || null;
      $('context').value = state.context || '';
      await loadIdAttributes();
      if (id !== state.runId) return;

      // A product the user chose for this page before wins over searching again.
      const remembered = state.matches[matchKey()];
      if (remembered) {
        try {
          const loaded = await I.load(pim, remembered, state.context);
          if (id !== state.runId) return;
          const p = loaded.chain[0];
          state.identified = { product: { id: p.id, number: p.number, name: p.name, type: p.type }, via: { step: 'remembered' }, candidates: [], tried: [] };
          return await showProduct(loaded, id);
        } catch (e) {
          if (e && e.kind === 'auth') throw e;
          remember(null); // the product is gone: search again
        }
      }

      const found = await I.findProduct(pim, state.page, state.context, { idAttributes: state.idAttrs });
      if (id !== state.runId) return;
      state.identified = found;
      if (found.product) return await showProduct(found.loaded || (await I.load(pim, found.product.id, state.context)), id);
      state.status = found.candidates.length ? 'pick' : 'notfound';
      render();
    } catch (e) {
      if (id === state.runId) fail(e);
    }
  }

  /** Labels the user linked to an attribute on the page ("Tykkelse" is Height) count here too. */
  async function applyLinks(facts) {
    try {
      const all = (await chrome.storage.local.get({ 'lens:links': {} }))['lens:links'] || {};
      const links = all[`${state.org.id}|${state.page.host || ''}`] || {};
      for (const [label, factKey] of Object.entries(links)) {
        const fact = facts.find((f) => f.key === factKey);
        if (fact && !(fact.aliases || []).includes(label)) fact.aliases = (fact.aliases || []).concat(label);
      }
    } catch (e) {
      /* without the links the comparison still works */
    }
  }

  async function showProduct(loaded, id) {
    if (id !== state.runId) return;
    await applyLinks(loaded.facts);
    if (id !== state.runId) return;
    state.loaded = loaded;
    state.details = {};
    // The same comparison as the pills on the page, including attributes that are empty in the PIM.
    state.report = globalThis.BSI.match.checkPairs(state.page.pairs || [], loaded.facts, { empties: true });
    // A selection that was used to find the product is not also a fact to trace.
    const usedAsHint = state.identified && state.identified.fromSelection;
    if (!state.focus && state.page.selection && !usedAsHint) {
      state.focus = { value: state.page.selection.text, label: state.page.selection.label, from: 'selection' };
    }
    refocus();
    state.status = 'ready';
    render();
    if (state.jumpToReport) {
      state.jumpToReport = false;
      const report = document.getElementById('report');
      if (report) report.scrollIntoView({ block: 'start' });
    }
  }

  async function loadProduct(productId, id) {
    await showProduct(await I.load(pim, productId, state.context), id);
  }

  /** The user picked a candidate: load it and remember it for this page. */
  async function choose(candidate) {
    const id = ++state.runId;
    state.status = 'loading';
    render();
    try {
      state.identified = Object.assign({}, state.identified, { product: candidate.product, via: { step: 'picked' }, fromSelection: false });
      remember(candidate.product.id);
      await loadProduct(candidate.product.id, id);
    } catch (e) {
      if (id === state.runId) fail(e);
    }
  }

  /** The user typed a number, an EAN or a name. */
  async function findTyped(text) {
    const id = ++state.runId;
    const before = state.identified || { candidates: [], tried: [] };
    state.status = 'loading';
    render();
    try {
      const page = Object.assign({}, state.page, { ids: [{ kind: 'typed', value: text, source: 'you' }], name: text, selection: null });
      const found = await I.findProduct(pim, page, state.context, { idAttributes: state.idAttrs });
      if (id !== state.runId) return;
      if (found.product) {
        state.identified = Object.assign(found, { via: Object.assign({}, found.via, { typed: text }) });
        remember(found.product.id);
        return await showProduct(found.loaded || (await I.load(pim, found.product.id, state.context)), id);
      }
      state.identified = { product: null, via: null, candidates: found.candidates.length ? found.candidates : before.candidates, tried: (before.tried || []).concat([`typed: “${text}”`]), typedMiss: text };
      state.status = state.identified.candidates.length ? 'pick' : 'notfound';
      render();
    } catch (e) {
      if (id === state.runId) fail(e);
    }
  }

  function refocus() {
    const facts = state.loaded.facts;
    state.ranked = state.focus ? I.traceSelection({ text: state.focus.value, label: state.focus.label }, facts).slice(0, 4) : [];
    // A fact that was just fixed stays in view even if the page still shows the old value.
    if (state.saved && !state.ranked.some((r) => r.fact.key === state.saved.key)) {
      const fact = facts.find((f) => f.key === state.saved.key);
      if (fact) state.ranked.unshift({ fact, status: 'differs', confidence: '', why: 'just changed' });
    }
    const keep = state.saved && state.saved.key;
    state.openKey = keep || (state.ranked[0] ? state.ranked[0].fact.key : null);
    if (state.openKey) ensureDetails(state.openKey);
  }

  function ensureDetails(key) {
    if (state.details[key]) return;
    const fact = state.loaded.facts.find((f) => f.key === key);
    if (!fact) return;
    state.details[key] = 'loading';
    const id = state.runId;
    I.details(pim, state.loaded.chain, fact, state.context)
      .then((d) => (state.details[key] = d))
      .catch((e) => (state.details[key] = { error: (e && e.message) || 'Could not load the details.' }))
      .then(() => id === state.runId && render());
  }

  function fillContexts() {
    const sel = $('context');
    sel.textContent = '';
    for (const c of state.contexts || []) sel.appendChild(h('option', { value: c.id }, c.name || c.locale || c.id));
    sel.disabled = !(state.contexts && state.contexts.length);
  }

  // ---- rendering -----------------------------------------------------------------

  const pimLink = (product, text) =>
    h('a', { class: 'link', href: `${state.base}/products/${encodeURIComponent(product.id)}`, target: '_blank', rel: 'noopener' }, text || 'Open in PIM ↗');

  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const contextName = () => ((state.contexts || []).find((c) => c.id === state.context) || {}).name || state.context || '';

  function render() {
    app.textContent = '';
    const view = { empty: viewEmpty, loading: viewLoading, auth: viewAuth, access: viewAccess, error: viewError, notfound: viewNotFound, pick: viewPick, ready: viewReady }[state.status];
    const notice = state.notice
      ? h('div', { class: 'note info' }, state.notice, ' ', h('button', { class: 'link', type: 'button', onclick: () => { state.notice = ''; render(); } }, 'OK'))
      : null;
    app.append(...[notice].concat(view()).filter(Boolean));
    $('recapture').hidden = state.tabId == null;
  }

  function viewEmpty() {
    return h('div', { class: 'card soft' },
      h('p', { class: 'product-name' }, 'Trace a product fact to its source'),
      h('ol', { class: 'steps' },
        h('li', null, 'Open a product page on any webshop or channel.'),
        h('li', null, 'Select a fact, such as a weight or a colour.'),
        h('li', null, 'Right-click and choose “Open in the side panel instead”.')
      ),
      h('p', { class: 'muted small' }, 'Or click the extension’s icon to check every fact on the page.'),
      demoLinks
    );
  }

  function viewLoading() {
    return h('p', { class: 'muted' }, h('span', { class: 'spinner' }), 'Looking this product up in the PIM…');
  }

  function viewAuth() {
    return h('div', { class: 'card' },
      h('p', { class: 'product-name' }, 'Sign in to Bluestone PIM'),
      h('p', { class: 'muted', style: 'margin:6px 0 10px' }, 'The inspector uses your own PIM session, so it sees and changes only what you are allowed to.'),
      h('div', { class: 'row' },
        h('a', { class: 'btn primary', href: state.base, target: '_blank', rel: 'noopener', style: 'text-decoration:none' }, 'Open the PIM to sign in'),
        h('button', { class: 'btn', type: 'button', onclick: run }, 'Try again')
      )
    );
  }

  /** Production was chosen earlier, but Chrome no longer lets the extension reach it. */
  function viewAccess() {
    const env = envOf(state.base);
    return h('div', { class: 'card' },
      h('p', { class: 'product-name' }, `Allow Bluestone PIM ${env.name}`),
      h('p', { class: 'muted', style: 'margin:6px 0 10px' }, `Chrome has not been told to let the Lens reach ${env.name}. It asks you once.`),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => setBase(state.base) }, `Allow ${env.name}`),
        h('button', { class: 'btn', type: 'button', onclick: () => setBase(PIM_HOSTS[0]) }, 'Use Test')));
  }

  /** The mark in the panel's top corner: which environment it talks to. */
  function renderEnv() {
    const env = envOf(state.base);
    const el = $('env');
    el.textContent = env.name;
    el.classList.toggle('prod', env.id !== 'test');
    el.title = env.id === 'test' ? 'This panel talks to the Test environment' : 'This panel talks to Production: live data. The Lens does not save there.';
  }

  function viewError() {
    return h('div', { class: 'note bad' }, state.error || 'Something went wrong.', ' ',
      state.page ? h('button', { class: 'link', type: 'button', onclick: run }, 'Try again') : null);
  }

  function pageCard() {
    const p = state.page;
    return h('div', null,
      h('div', { class: 'section-title' }, 'This page'),
      h('div', { class: 'card soft' },
        h('div', { class: 'product-name' }, p.name || p.title || p.host),
        h('div', { class: 'muted small' }, p.host)
      )
    );
  }

  /** A box to type a product number, an EAN or a name. */
  function findBox() {
    const input = h('input', { type: 'text', placeholder: 'Product number, EAN or name', 'aria-label': 'Product number, EAN or name' });
    const go = () => input.value.trim() && findTyped(input.value.trim());
    input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    return h('div', { class: 'find' }, input, h('button', { class: 'btn', type: 'button', onclick: go }, 'Find'));
  }

  function viewNotFound() {
    const found = state.identified || {};
    const tried = found.tried || [];
    return [
      pageCard(),
      h('div', { class: 'card' },
        h('p', { class: 'product-name' }, `No matching product in ${state.org ? state.org.name : 'the PIM'}`),
        tried.length
          ? [h('p', { class: 'muted small', style: 'margin-top:4px' }, 'Looked for it by:'), h('ul', { class: 'steps small muted' }, tried.map((t) => h('li', null, t)))]
          : h('p', { class: 'muted small', style: 'margin-top:4px' }, 'This page has no identifier or product name the inspector can read.'),
        findBox(),
        h('p', { class: 'muted small', style: 'margin-top:8px' }, 'You can also select the product’s number or name on the page, right-click and choose “Open in the side panel instead”. Or switch organisation below.')
      ),
    ];
  }

  function viewPick() {
    const found = state.identified || {};
    const candidates = found.candidates || [];
    const evidence = (c) => {
      const parts = [`name ${Math.round(c.nameScore * 100)}% alike`];
      if (c.considered) parts.push(`${c.matches} of ${c.considered} facts match`);
      return parts.join(' · ');
    };
    return [
      pageCard(),
      h('div', null,
        h('div', { class: 'section-title' }, candidates.length ? 'Which product is this?' : 'Find the product'),
        candidates.length
          ? h('p', { class: 'muted small', style: 'margin-bottom:8px' }, 'These come close. Your choice is remembered for this page.')
          : null,
        candidates.map((c) =>
          h('button', { class: 'card pick', type: 'button', onclick: () => choose(c) },
            h('span', { class: 'row spread' },
              h('span', { class: 'cand-name' }, c.product.name || c.product.number),
              h('span', { class: 'chip blue' }, globalThis.BSI.trace.LEVEL[c.product.type] || c.product.type)),
            h('span', { class: 'muted small' }, c.product.number),
            h('span', { class: 'small' }, evidence(c)))),
        h('div', { class: 'card soft', style: 'margin-top:8px' },
          h('p', { class: 'small muted' }, candidates.length ? 'None of these?' : 'Type what you know about it.'),
          findBox())
      ),
    ];
  }

  function viaText() {
    const found = state.identified || {};
    const via = found.via || {};
    let text = '';
    const own = via.kind === 'typed' || via.kind === 'selection';
    if (via.step === 'number') text = own ? `Recognised by the product number you ${via.kind === 'typed' ? 'typed' : 'selected'} (${via.value})` : `Recognised by ${String(via.kind).toUpperCase()} ${via.value}${via.source ? ` (${via.source})` : ''}`;
    else if (via.step === 'pimId') text = 'Recognised by the PIM product id in the page’s address';
    else if (via.step === 'idAttribute') text = via.attribute ? `Recognised by the PIM attribute “${via.attribute}” = ${via.value}` : 'Recognised by an identifier attribute in the PIM';
    else if (via.step === 'name') text = 'Matched on name' + (via.considered ? ` and ${via.matches} of ${via.considered} facts on the page` : '');
    else if (via.step === 'remembered') text = 'Remembered from your earlier choice for this page';
    else if (via.step === 'picked') text = 'Chosen by you (remembered for this page)';
    if (found.fromSelection && via.kind !== 'selection') text += ', using your selection';
    return text;
  }

  /** "Not this product?": forget the choice for this page, search again and show the alternatives. */
  async function notThisProduct() {
    remember(null);
    const current = state.identified && state.identified.product && state.identified.product.id;
    const id = ++state.runId;
    state.focus = null;
    state.status = 'loading';
    render();
    try {
      let found = state.identified || { candidates: [], tried: [] };
      if (!(found.candidates || []).length) found = await I.findProduct(pim, state.page, state.context, { idAttributes: state.idAttrs });
      if (id !== state.runId) return;
      const candidates = (found.candidates || []).filter((c) => c.product.id !== current);
      state.identified = { product: null, via: null, candidates, tried: found.tried || [] };
      state.status = 'pick';
      render();
    } catch (e) {
      if (id === state.runId) fail(e);
    }
  }

  function viewReady() {
    const { breadcrumb, chain } = state.loaded;
    const productCard = h('div', null,
      h('div', { class: 'section-title' }, 'In the PIM'),
      h('div', { class: 'card' },
        h('div', { class: 'row spread' },
          h('div', { class: 'product-name' }, chain[0].name || chain[0].number),
          pimLink(chain[0])
        ),
        h('div', { class: 'muted small' }, viaText(), viaText() ? ' · ' : '',
          h('button', { class: 'link', type: 'button', onclick: notThisProduct }, 'Not this product?')),
        h('div', { class: 'crumbs' },
          breadcrumb.map((b, i) =>
            h('div', { class: 'crumb' + (i === breadcrumb.length - 1 ? ' here' : '') },
              h('span', { class: 'level' }, b.level),
              h('span', { class: 'name' }, b.name, ' ', h('span', { class: 'muted small' }, b.number))
            )
          )
        )
      )
    );
    return [productCard, focusSection(), reportSection()];
  }

  function focusSection() {
    if (!state.focus) {
      return h('p', { class: 'muted small' }, 'Select a fact on the page and right-click “Open in the side panel instead”, or pick one from the list below.');
    }
    const f = state.focus;
    const head = h('div', null,
      h('div', { class: 'section-title' }, f.from === 'selection' ? 'You selected' : 'Fact from the page'),
      h('div', { class: 'quote' }, f.label ? h('span', { class: 'label' }, f.label) : null, '“', f.value, '”')
    );
    if (!state.ranked.length) {
      return h('div', null, head,
        h('div', { class: 'note info', style: 'margin-top:8px' },
          'Nothing in the PIM matches this for the product. It may come from the channel itself (prices, stock, delivery texts) or from another language.'));
    }
    return h('div', null, head,
      h('div', { class: 'section-title', style: 'margin-top:12px' }, state.ranked.length > 1 ? 'Where it comes from (best match first)' : 'Where it comes from'),
      state.ranked.map(candidateCard));
  }

  function statusChip(r) {
    if (state.saved && state.saved.key === r.fact.key) return h('span', { class: 'chip ok' }, 'Fixed');
    if (r.status === 'differs') return h('span', { class: 'chip bad' }, 'Differs from the page');
    return h('span', { class: 'chip ' + (r.confidence === 'high' ? 'ok' : 'warn') }, r.confidence === 'high' ? 'Match' : r.confidence === 'medium' ? 'Likely match' : 'Possible match');
  }

  function candidateCard(r) {
    const fact = r.fact;
    const open = state.openKey === fact.key;
    const head = h('button', {
      class: 'cand-head', type: 'button', 'aria-expanded': String(open),
      onclick: () => {
        state.openKey = open ? null : fact.key;
        state.fix = null;
        if (state.openKey) ensureDetails(fact.key);
        render();
      },
    },
      h('span', { class: 'row spread' }, h('span', { class: 'cand-name' }, fact.label), statusChip(r)),
      h('span', { class: 'cand-value' }, fact.display || h('span', { class: 'muted' }, '(no value)'))
    );
    return h('div', { class: 'card cand' }, head, open ? candidateBody(r) : null);
  }

  function candidateBody(r) {
    const fact = r.fact;
    const d = state.details[fact.key];
    if (!d || d === 'loading') return h('div', { class: 'cand-body' }, h('p', { class: 'muted' }, h('span', { class: 'spinner' }), 'Tracing…'));
    if (d.error) return h('div', { class: 'cand-body' }, h('div', { class: 'note bad' }, d.error));

    const chain = state.loaded.chain;
    const w = fact.where;
    const here = chain[0];
    const rows = [];

    // Stored on
    let storedSub = 'Set directly on this product.';
    if (fact.kind === 'attribute') {
      if (w.inherited) storedSub = `This ${levelOf(here)} inherits it.`;
      else if (w.holderIndex > 0) storedSub = `Not copied to this ${levelOf(here)}: the channel shows the ${d.impact.level}’s value.`;
    }
    rows.push(h('dt', null, 'Stored on'), h('dd', null,
      h('span', { class: 'chip blue' }, d.impact.level), ' ', d.owner.name || d.owner.number, ' ', pimLink(d.owner, '↗'),
      h('span', { class: 'sub' }, storedSub)));

    if (fact.kind === 'attribute' && (w.locked || w.mandatory || w.defining)) {
      rows.push(h('dt', null, 'Rules'), h('dd', null,
        w.locked ? [h('span', { class: 'chip' }, 'Locked'), ' '] : null,
        w.mandatory ? [h('span', { class: 'chip' }, 'Mandatory'), ' '] : null,
        w.defining ? h('span', { class: 'chip' }, 'Defining') : null));
    }

    // Last changed
    if (d.lastChange) {
      const c = d.lastChange;
      rows.push(h('dt', null, 'Last changed'), h('dd', null,
        when(c.date), c.userName ? ` by ${c.userName}` : '',
        c.wholeProduct ? h('span', { class: 'sub' }, 'Latest change to this product (any field).') : null,
        c.oldValue != null && c.value != null && String(c.oldValue) !== String(c.value) && String(c.value).length < 80
          ? h('span', { class: 'sub' }, `${c.oldValue || '(empty)'} → ${c.value}`) : null));
    } else if (fact.kind === 'attribute') {
      rows.push(h('dt', null, 'Last changed'), h('dd', null, h('span', { class: 'muted' }, d.lastChangeError || 'No change in the last 6 months.')));
    }

    // Reach
    if (fact.kind === 'attribute') {
      rows.push(h('dt', null, 'A fix reaches'), h('dd', null, reachText(d.impact)));
    }

    const notes = [];
    if (state.saved && state.saved.key === fact.key) {
      notes.push(h('div', { class: 'note ok' }, state.saved.text, ' Channels show it after the next publish.'));
    } else if (r.status === 'differs') {
      // Which side to fix: what the PIM's own history says about this difference, when it says anything.
      const from = I.origin(fact, state.focus.value, d.lastChangeError ? null : d.changes || null);
      notes.push(h('div', { class: 'note warn' },
        `The page shows “${state.focus.value}”, the PIM holds “${fact.display || '(no value)'}”. `,
        from
          ? [h('b', null, from.title), ' ', from.text]
          : editLocked()
            ? 'If the PIM is right, the channel is behind: publish again. If the page is right, send a suggestion from the page, or change it in the PIM.'
            : 'If the PIM is right, the channel is behind: publish again. If the page is right, fix the PIM below.'));
    }
    if (fact.kind === 'attribute' && w.overridden) {
      notes.push(h('div', { class: 'note info' },
        `This ${levelOf(here)} holds its own value. The ${d.impact.level} passes down “${(fact.ownerTexts || []).join(', ') || '(no value)'}”.`));
    }

    const can = I.canFix(fact);
    const fixing = state.fix && state.fix.key === fact.key;
    const actions = fixing ? null : editLocked()
      ? h('div', { class: 'row' }, h('span', { class: 'muted small' }, LOCKED), pimLink(d.owner))
      : h('div', { class: 'row' },
        can.owner || can.holder
          ? h('button', { class: 'btn primary', type: 'button', onclick: () => startFix(fact, can) }, 'Fix value')
          : h('span', { class: 'muted small' }, can.reason),
        !(can.owner || can.holder) ? pimLink(d.owner) : null);

    return h('div', { class: 'cand-body' }, notes, h('dl', { class: 'facts' }, rows), actions, fixing ? fixEditor(fact, d, can) : null);
  }

  const levelOf = (product) => (globalThis.BSI.trace.LEVEL[product.type] || 'product').toLowerCase();

  function reachText(impact) {
    if (!impact.propagates) return `Only this ${impact.level.toLowerCase()}.`;
    if (impact.level === 'Family') return `The family, ${plural(impact.groups, 'group', 'groups')} and ${plural(impact.variants, 'variant', 'variants')}.`;
    return `The group and ${plural(impact.variants, 'variant', 'variants')}.`;
  }

  // ---- fixing ----------------------------------------------------------------------

  function startFix(fact, can) {
    if (editLocked()) return;
    const current = fact.kind === 'name' ? fact.display : (fact.raw && fact.raw[0]) || '';
    // Products below that hold their own value keep it unless the user asks otherwise, as in the on-page view.
    state.fix = { key: fact.key, input: current, target: can.owner ? 'owner' : 'holder', forceVla: false, step: 'edit', error: '' };
    state.saved = null;
    render();
  }

  function fixEditor(fact, d, can) {
    const fix = state.fix;
    const chain = state.loaded.chain;
    const targetProduct = fact.kind === 'attribute' && fix.target === 'holder' ? chain[fact.where.holderIndex] : d.owner;
    const targetLevel = globalThis.BSI.trace.LEVEL[targetProduct.type] || 'Product';
    const passesDown = fact.kind === 'attribute' && fix.target === 'owner' && d.impact.propagates;

    if (fix.step === 'edit') {
      const field = fact.dataType === 'single_select'
        ? h('select', { 'aria-label': 'Corrected value', onchange: (e) => (fix.input = e.target.value) },
            (fact.options || []).map((o) => h('option', { value: o.valueId, selected: o.valueId === fix.input }, o.value)))
        : h('input', { type: 'text', value: fix.input, 'aria-label': 'Corrected value', oninput: (e) => (fix.input = e.target.value),
            onkeydown: (e) => e.key === 'Enter' && review() });
      const choices = can.owner && can.holder ? h('div', null,
        h('label', { class: 'choice' },
          h('input', { type: 'radio', name: 'target', checked: fix.target === 'owner', onchange: () => { fix.target = 'owner'; render(); } }),
          h('span', null, `On the ${d.impact.level.toLowerCase()} “${d.owner.name || d.owner.number}” `, h('span', { class: 'muted' }, '(where it is owned)'))),
        h('label', { class: 'choice' },
          h('input', { type: 'radio', name: 'target', checked: fix.target === 'holder', onchange: () => { fix.target = 'holder'; render(); } }),
          h('span', null, `Only on this ${levelOf(chain[0])}`))) : null;
      // A locked value is always enforced on the products below: no choice to offer.
      const overwrite = passesDown && !fact.where.locked ? h('label', { class: 'choice' },
        h('input', { type: 'checkbox', checked: fix.forceVla, onchange: (e) => (fix.forceVla = e.target.checked) }),
        h('span', null, 'Also replace the value on products below that already have one ',
          h('span', { class: 'muted' }, '(tick this when the product on this page has its own value and should get the new one)'))) : null;
      return h('div', { class: 'fix' },
        h('label', { class: 'field' }, `Corrected value${fact.unit ? ` (${fact.unit})` : ''}`, field),
        choices, overwrite,
        fix.error ? h('div', { class: 'note bad' }, fix.error) : null,
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', type: 'button', onclick: review }, 'Review change'),
          h('button', { class: 'btn', type: 'button', onclick: () => { state.fix = null; render(); } }, 'Cancel')));
    }

    // preview / saving
    const v = I.validateFix(fact, fix.input, fix.target);
    const saving = fix.step === 'saving';
    let reach = `Only this ${targetLevel.toLowerCase()} changes.`;
    if (passesDown) {
      reach = `Reaches ${reachText(d.impact).replace(/^The /, 'the ')}` +
        (fix.forceVla ? '' : ' Products below that already have a value keep it.');
    }
    return h('div', { class: 'fix' },
      h('div', { class: 'preview' },
        h('div', { class: 'muted small' }, `Change ${fact.label} on ${targetLevel.toLowerCase()} “${targetProduct.name || targetProduct.number}” (${targetProduct.number})`,
          fact.contextAware !== false ? `, in ${contextName()}` : ''),
        h('div', { class: 'change' }, h('s', null, oldDisplay()), ' → ', v.display),
        h('div', { class: 'small' }, reach),
        h('div', { class: 'muted small' }, `Saved to ${new URL(state.base).host} as you. Channels update after the next publish.`)),
      fix.error ? h('div', { class: 'note bad' }, fix.error) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', disabled: saving, onclick: save }, saving ? 'Saving…' : 'Save to PIM'),
        h('button', { class: 'btn', type: 'button', disabled: saving, onclick: () => { fix.step = 'edit'; fix.error = ''; render(); } }, 'Back')));

    function oldDisplay() {
      if (fact.kind !== 'attribute' || fix.target !== 'owner' || !fact.where.inherited) return fact.display || '(no value)';
      const texts = fact.ownerTexts || [];
      return texts.length ? texts.join(', ') + (fact.unit && texts.length === 1 ? ' ' + fact.unit : '') : '(no value)';
    }

    function review() {
      const check = I.validateFix(fact, fix.input, fix.target);
      if (!check.ok) fix.error = check.error;
      else if (check.display === fact.display && !(fact.where && fact.where.overridden)) fix.error = 'That is already the value in the PIM.';
      else {
        fix.error = '';
        fix.step = 'preview';
      }
      render();
    }

    async function save() {
      // Checked again at the moment of saving, not only where the button is drawn.
      if (editLocked()) {
        fix.error = LOCKED;
        return render();
      }
      fix.step = 'saving';
      fix.error = '';
      render();
      const id = state.runId;
      try {
        const res = await I.applyFix(pim, chain, fact, { input: fix.input, target: fix.target, forceVla: passesDown && fix.forceVla, context: state.context });
        if (id !== state.runId) return;
        state.saved = { key: fact.key, text: `Saved: ${fact.label} is now “${res.display}” on the ${targetLevel.toLowerCase()}.` };
        state.fix = null;
        await loadProduct(chain[0].id, id);
        // The PIM records the change in its history a few seconds later: refresh "Last changed" then.
        setTimeout(() => {
          if (id !== state.runId || !state.loaded) return;
          delete state.details[fact.key];
          ensureDetails(fact.key);
        }, 4000);
      } catch (e) {
        if (id !== state.runId) return;
        if (e && e.kind === 'auth') return fail(e);
        fix.step = 'preview';
        fix.error = e && e.kind === 'permission' ? 'Your role in the PIM is not allowed to change this.' : `The PIM did not accept the change: ${(e && e.message) || 'unknown error'}`;
        render();
      }
    }
  }

  // ---- facts on the page -------------------------------------------------------------

  const REPORT_ORDER = { differs: 0, empty: 1, unknown: 2, unsure: 3, match: 4 };
  const inGroup = (r, group) => !group || (group === 'missing' ? r.status === 'unknown' || r.status === 'empty' : r.status === group);

  /** The page compared with the PIM: differences first, with the PIM's value beside the page's. */
  function reportSection() {
    const all = state.report;
    if (!all.length) return null;
    const groups = [['', 'All'], ['differs', 'Differs'], ['missing', 'Not in the PIM'], ['unsure', 'Unsure'], ['match', 'From the PIM']]
      .map(([id, label]) => ({ id, label, n: all.filter((r) => inGroup(r, id)).length }))
      .filter((g) => !g.id || g.n);
    // A filter with nothing in it (the page changed) falls back to everything.
    const filter = groups.some((g) => g.id === state.filter) ? state.filter : '';
    const rows = all.filter((r) => inGroup(r, filter)).sort((a, b) => REPORT_ORDER[a.status] - REPORT_ORDER[b.status]);
    const chip = (r) => {
      if (r.status === 'match') return h('span', { class: 'chip ok' }, 'From the PIM');
      if (r.status === 'differs') return h('span', { class: 'chip warn' }, 'Differs');
      if (r.status === 'unsure') return h('span', { class: 'chip blue' }, 'Unsure');
      if (r.status === 'empty') return h('span', { class: 'chip' }, 'Empty in PIM');
      return h('span', { class: 'chip' }, 'Not in PIM');
    };
    const pimLine = (r) => {
      if (r.status === 'differs') return h('span', { class: 'sub' }, `In the PIM: ${r.top.fact.display} (${r.top.fact.label})`);
      if (r.status === 'empty') return h('span', { class: 'sub' }, `In the PIM: no value (${r.top.fact.label})`);
      return null;
    };
    return h('div', { id: 'report' },
      h('div', { class: 'section-title' }, `This page compared with the PIM (${all.length})`),
      h('div', { class: 'filters', role: 'group', 'aria-label': 'Show' },
        groups.map((g) => h('button', {
          type: 'button', class: 'fchip' + (g.id === filter ? ' on' : ''), 'aria-pressed': String(g.id === filter),
          onclick: () => { state.filter = g.id; render(); },
        }, `${g.label} ${g.n}`))),
      h('p', { class: 'muted small', style: 'margin-bottom:6px' }, 'Differences first. Click a row to trace it.'),
      h('table', { class: 'pairs' },
        rows.map((r) => {
          const on = state.focus && state.focus.from === 'pair' && state.focus.value === r.pair.value && state.focus.label === r.pair.label;
          const go = () => {
            state.focus = { value: r.pair.value, label: r.pair.label, from: 'pair' };
            state.fix = null;
            state.saved = null;
            refocus();
            render();
            app.scrollTo({ top: 0, behavior: 'smooth' });
          };
          return h('tr', { class: 'click' + (on ? ' on' : ''), tabindex: '0', onclick: go, onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), go()) },
            h('td', { class: 'l' }, r.pair.label), h('td', null, r.pair.value, pimLine(r)), h('td', { class: 's' }, chip(r)));
        })));
  }

  // ---- organisation selector -------------------------------------------------------------

  function renderOrgButton() {
    const btn = $('org');
    btn.textContent = state.org ? state.org.name : 'Not signed in';
    btn.disabled = !state.org;
    btn.title = state.org ? 'Switch organisation' : '';
    renderWho();
  }

  // ---- signing out ---------------------------------------------------------------------
  // The panel uses the browser's PIM session, so signing out ends that session everywhere.

  const leaving = { asking: false, busy: false, error: '' };

  function renderWho() {
    const row = $('who');
    row.hidden = !state.org && !leaving.error;
    row.textContent = '';
    if (row.hidden) return;
    if (leaving.busy) row.append(h('span', null, h('span', { class: 'spinner' }), 'Signing out of Bluestone PIM…'));
    else if (leaving.asking) {
      row.append(
        h('span', null, 'Sign out of Bluestone PIM? Your open PIM tabs are signed out too.'),
        h('button', { class: 'btn primary', type: 'button', onclick: signOut }, 'Sign out'),
        h('button', { class: 'btn', type: 'button', onclick: () => { leaving.asking = false; renderWho(); } }, 'Cancel'));
    } else {
      if (leaving.error) row.append(h('span', { class: 'note bad' }, leaving.error));
      if (state.org) {
        row.append(
          h('span', null, state.user ? `Signed in as ${state.user}.` : 'Signed in.'),
          h('button', { class: 'link', type: 'button', onclick: () => { leaving.asking = true; leaving.error = ''; renderWho(); } }, 'Sign out'));
      }
    }
  }

  async function signOut() {
    Object.assign(leaving, { asking: false, busy: true, error: '' });
    renderWho();
    const res = await chrome.runtime.sendMessage({ type: 'lens:sign-out' }).catch(() => null);
    leaving.busy = false;
    if (res && res.ok) {
      state.orgs = null;
      state.notice = 'You are signed out of Bluestone PIM in this browser. Sign in again, as the same user or another one.';
      fail({ kind: 'auth' });
    } else {
      leaving.error = (res && res.error) || 'Could not sign out. Open the PIM and sign out there.';
      renderWho();
    }
  }

  function openOrgPicker(open) {
    Object.assign(picker, { open, filter: '', pending: null, error: '' });
    $('org').setAttribute('aria-expanded', String(open));
    renderOrgPicker();
    if (open) {
      const input = $('orgpop').querySelector('input');
      if (input) input.focus();
    }
  }

  function renderOrgPicker() {
    const pop = $('orgpop');
    pop.hidden = !picker.open;
    pop.textContent = '';
    if (!picker.open) return;

    if (picker.pending) {
      const org = picker.pending;
      pop.append(...[
        h('p', { class: 'orgpop-title' }, `Switch to ${org.name}?`),
        h('p', { class: 'muted small' }, 'Your PIM session moves to this organisation, so any open PIM tabs switch too. Reload them afterwards.'),
        picker.error ? h('div', { class: 'note bad', style: 'margin-top:8px' }, picker.error) : null,
        h('div', { class: 'row', style: 'margin-top:10px' },
          h('button', { class: 'btn primary', type: 'button', disabled: picker.switching, onclick: () => switchOrg(org) }, picker.switching ? 'Switching…' : 'Switch'),
          h('button', { class: 'btn', type: 'button', disabled: picker.switching, onclick: () => { picker.pending = null; picker.error = ''; renderOrgPicker(); } }, 'Back')),
      ].filter(Boolean));
      return;
    }

    const list = h('div', { class: 'orglist', role: 'listbox', 'aria-label': 'Organisations' });
    const fill = () => {
      list.textContent = '';
      const q = picker.filter.trim().toLowerCase();
      const orgs = (state.orgs || []).filter((o) => !q || o.name.toLowerCase().includes(q));
      if (!state.orgs) list.append(h('p', { class: 'muted small' }, h('span', { class: 'spinner' }), 'Loading organisations…'));
      else if (!orgs.length) list.append(h('p', { class: 'muted small' }, 'No organisation matches.'));
      for (const o of orgs) {
        const current = state.org && o.id === state.org.id;
        list.append(h('button', {
          class: 'orgitem' + (current ? ' current' : ''), type: 'button', role: 'option', 'aria-selected': String(current),
          onclick: () => { if (current) return openOrgPicker(false); picker.pending = o; renderOrgPicker(); },
        }, o.name, current ? h('span', { class: 'chip ok' }, 'Current') : null));
      }
    };
    const input = h('input', { type: 'text', placeholder: `Search ${state.orgs ? state.orgs.length : ''} organisations`, 'aria-label': 'Search organisations',
      oninput: (e) => { picker.filter = e.target.value; fill(); },
      onkeydown: (e) => {
        if (e.key === 'Escape') openOrgPicker(false);
        if (e.key === 'Enter') { const first = list.querySelector('.orgitem:not(.current)'); if (first) first.click(); }
      } });
    fill();
    pop.append(input, list);
  }

  async function switchOrg(org) {
    picker.switching = true;
    picker.error = '';
    renderOrgPicker();
    try {
      const res = await chrome.runtime.sendMessage({ type: 'bsi:switch-org', base: state.base, orgId: org.id });
      const me = await pim.me();
      if (me.organization !== org.id) {
        picker.error = res && res.needsUser
          ? 'Signing in to this organisation needs an extra step. Finish it in the tab that opened, then switch again.'
          : 'The switch did not complete. Try again.';
        return;
      }
      state.notice = `Now in ${org.name}. Reload any open PIM tabs: they work in this organisation from now on.`;
      state.focus = null;
      openOrgPicker(false);
      run();
    } catch (e) {
      picker.error = e && e.kind === 'auth' ? 'You are signed out of the PIM. Sign in and try again.' : 'The switch did not complete. Try again.';
    } finally {
      picker.switching = false;
      if (picker.open) renderOrgPicker();
    }
  }

  // ---- wiring --------------------------------------------------------------------------

  function onCapture(capture) {
    if (!capture) return;
    state.tabId = capture.tabId;
    state.page = capture.page || null;
    state.captureError = capture.error || '';
    state.focus = null;
    state.contextChosen = false;
    run();
  }

  $('context').addEventListener('change', (e) => {
    state.context = e.target.value;
    state.contextChosen = true;
    run();
  });
  $('org').addEventListener('click', () => openOrgPicker(!picker.open));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && picker.open && openOrgPicker(false));
  document.addEventListener('click', (e) => {
    // composedPath, not closest(): a clicked list item is gone from the page by the time this runs.
    const path = e.composedPath();
    if (picker.open && !picker.switching && !path.includes($('orgpop')) && !path.includes($('org'))) openOrgPicker(false);
  });
  /**
   * Move the panel to another PIM. Production needs the user's yes to Chrome's own question
   * for its address, asked straight from the click; until then the panel stays where it was.
   */
  async function setBase(base) {
    if (!PIM_HOSTS.includes(base)) return;
    if (envOf(base).id !== 'test' && !globalThis.BSI_TEST_TRANSPORT) {
      let granted = false;
      try {
        granted = await chrome.permissions.request({ origins: [P.originPattern(base)] });
      } catch (e) {
        granted = false;
      }
      if (!granted) {
        $('base').value = state.base;
        state.notice = `Not allowed, so the panel stays on ${P.pimLabel(state.base)}.`;
        return render();
      }
    }
    state.base = base;
    $('base').value = base;
    Object.assign(state, { contexts: null, org: null, orgs: null, idAttrs: null, fix: null, notice: '' });
    renderOrgButton();
    await chrome.storage.local.set({ 'bsi:base': state.base });
    // The on-page Lens shares this choice: it must not keep the session of the PIM that was left.
    try {
      Promise.resolve(chrome.runtime.sendMessage({ type: 'bsi:base-changed', base: state.base })).catch(() => {});
    } catch (e) {
      /* the worker is not there: it reads the choice from storage when it starts */
    }
    makePim();
    run();
  }
  for (const u of PIM_HOSTS) $('base').append(h('option', { value: u }, P.pimLabel(u)));
  $('base').addEventListener('change', (e) => setBase(e.target.value));
  $('recapture').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'bsi:recapture', tabId: state.tabId }));

  const stored = await chrome.storage.local.get({ 'bsi:base': state.base, 'bsi:matches': {} });
  // Only the PIMs this extension is allowed to talk to, whatever is in storage.
  if (PIM_HOSTS.includes(stored['bsi:base'])) state.base = stored['bsi:base'];
  state.matches = stored['bsi:matches'] || {};
  $('base').value = state.base;
  makePim();

  /** The on-page box asked for part of the comparison: a count was clicked there. */
  function onFilter(f) {
    if (!f || !f.status) return;
    state.filter = f.status === 'all' ? '' : f.status === 'unknown' || f.status === 'empty' ? 'missing' : f.status;
    state.jumpToReport = true;
    if (state.status === 'ready') render();
  }

  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes['bsi:panel-filter']) onFilter(changes['bsi:panel-filter'].newValue);
    if (changes['bsi:capture']) onCapture(changes['bsi:capture'].newValue);
  });
  const session = await chrome.storage.session.get(['bsi:capture', 'bsi:panel-filter']);
  onFilter(session['bsi:panel-filter']);
  renderOrgButton();
  if (session['bsi:capture']) onCapture(session['bsi:capture']);
  else run();
})();
