/*
 * The Lens's back end. It runs in the extension's background worker and answers
 * the messages of the on-page view (content/lens.js): find the product, compare
 * the page with the PIM, load details, save a change, or send a suggestion as a
 * task. The page never talks to the PIM itself.
 *
 * Everything outside (storage, the PIM connection, switching organisation) is
 * handed in, so the same code runs in the tests and in the browser simulator.
 */
(function (root) {
  'use strict';

  const B = root.BSI || {};
  const need = (name, file) => B[name] || (typeof require !== 'undefined' ? require(file) : null);
  const M = need('match', './match.js');
  const T = need('trace', './trace.js');
  const P = need('pim', './pim.js');
  const I = need('inspect', './inspect.js');
  const M_IMG = need('imagehash', './imagehash.js');

  // Test and Production. The first one (a Test PIM) is where a first run starts.
  const HOSTS = P.HOSTS;
  const envOf = (base) => P.environmentOf(base) || P.ENVIRONMENTS[0];
  const LOCKED = 'Saving is switched off on Production in this version of the Lens. Send a suggestion instead.';
  const DAY = 24 * 3600 * 1000;
  const MAX_VALUE = 10000; // characters in one value sent to the PIM
  const MAX_SRC = 300000; // characters in a picture address (an inline picture can be long)
  const MAX_LINKS = 300; // remembered label links per organisation and site
  const MAX_LINK_SITES = 200; // organisation-and-site pairs that have links
  const MAX_TEXT = 20000; // characters of one PIM text that are looked at

  const clip = (s, n) => {
    const t = String(s == null ? '' : s);
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  };

  /** Text as a reader sees it: no markup, no CDATA wrapper, entities decoded where simple. */
  function plain(s) {
    return String(s == null ? '' : s)
      .slice(0, MAX_TEXT)
      .replace(/<!\[CDATA\[|\]\]>/g, '')
      .replace(/<br\s*\/?>|<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#(\d{1,7});/g, (m, d) => (+d > 0 && +d <= 0x10ffff ? String.fromCodePoint(+d) : m))
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n')
      .trim();
  }

  /** Letters and digits only, for comparing long texts whatever their markup. */
  const bare = (s) => plain(s).replace(/&[a-z]+;/gi, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  function pageKey(orgId, url) {
    let address = String(url || '');
    try {
      const u = new URL(address);
      for (const k of [...u.searchParams.keys()]) if (/^(utm_|gclid|fbclid|ref$|mc_)/i.test(k)) u.searchParams.delete(k);
      // "#/product/12" is a page of its own on some shops; "#reviews" is a place on a page.
      if (!/^#[/!]/.test(u.hash)) u.hash = '';
      address = u.toString();
    } catch (e) {
      /* keep the raw address */
    }
    return `${orgId}|${address}`;
  }

  // ---- what arrives in a message is checked before it is used -----------------
  // The on-page view runs inside a web page. Its messages are treated as untrusted:
  // every field is cut to a sensible length and to the type that is expected.

  const own = (obj, key) => (obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined);
  const text = (v, n) => (typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, n) : '');
  /** One line of text: a value read from a page can never start a new line in a task. */
  const oneLine = (v, n) => clip(text(v, n * 2).replace(/\s+/g, ' ').trim(), n);
  /** Several lines typed by the user: later lines are indented, so they read as part of the same field. */
  const lines = (v, n) => clip(text(v, n * 2).trim(), n).replace(/\r?\n/g, '\n    ');
  /** An id as the PIM gives them out: one short word, no spaces or control characters. */
  const idOf = (v) => (/^[^\s\u0000-\u001f/\\?#]{1,120}$/.test(text(v, 130)) && !/^\.+$/.test(String(v)) ? String(v) : '');
  const webUrl = (v, n) => {
    const t = text(v, n);
    return /^https?:\/\//i.test(t) ? t.replace(/\s+/g, '') : '';
  };
  const rows = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []).map((x) => (x && typeof x === 'object' ? x : {}));

  function cleanPage(p) {
    const page = p && typeof p === 'object' ? p : {};
    const sel = page.selection && typeof page.selection === 'object' ? page.selection : null;
    return {
      url: text(page.url, 2000),
      host: text(page.host, 255),
      title: text(page.title, 300),
      lang: text(page.lang, 20),
      name: text(page.name, 200),
      heading: text(page.heading, 200),
      brand: text(page.brand, 100),
      ids: rows(page.ids, 16).map((x) => Object.assign({ kind: text(x.kind, 30), value: text(x.value, 80), source: text(x.source, 40) }, x.weak === true ? { weak: true } : {})).filter((x) => x.value),
      // Kept in the order they came: the on-page view finds its elements by position.
      pairs: rows(page.pairs, 120).map((x) => ({ label: text(x.label, 80), value: text(x.value, 300) })),
      blocks: rows(page.blocks, 20).map((x) => ({ text: text(x.text, 2000) })),
      selection: sel ? { text: text(sel.text, 300), label: text(sel.label, 80), context: text(sel.context, 300) } : null,
    };
  }

  const hostOf = (url) => {
    try {
      return new URL(url).host;
    } catch (e) {
      return '';
    }
  };

  function createService(deps) {
    const storage = deps.storage;
    const now = deps.now || (() => Date.now());
    const loadedCache = new Map();
    const pictureCache = new Map(); // product -> the PIM's pictures with their fingerprints
    let sessionCache = null;

    const get = async (key, fallback) => (await storage.get({ [key]: fallback }))[key];
    const set = (key, value) => storage.set({ [key]: value });

    /** The PIM the user chose, or null when none has been chosen (or found) yet. */
    async function chosenBase() {
      const base = await get('bsi:base', null);
      return HOSTS.includes(base) ? base : null;
    }
    const baseUrl = async () => (await chosenBase()) || HOSTS[0];

    /** Whether Chrome lets the Lens reach this PIM. Production is allowed by the user, once, when they choose it. */
    const canReach = async (base) => envOf(base).id === 'test' || !deps.canReach || !!(await deps.canReach(base));
    const noAccess = (base) => new P.PimError(`Chrome has not been told to let the Lens reach ${envOf(base).name}.`, { kind: 'access' });

    /**
     * The signed-in user on `base`. When nobody is signed in there and the user has
     * not picked a PIM yet (or asks to look again), the other Test PIM is tried too,
     * so a first run works whichever of the two the user is signed in to. Only PIMs of
     * the same environment are tried: the Lens never moves to Production (or away from
     * it) by itself.
     */
    async function signIn(base, lookElsewhere) {
      if (!(await canReach(base))) throw noAccess(base);
      const pim = P.createPim(deps.transport(base));
      try {
        return { base, pim, me: await pim.me() };
      } catch (e) {
        if (!lookElsewhere || (e.kind !== 'auth' && e.kind !== 'network')) throw e;
        for (const other of envOf(base).hosts) {
          if (other === base) continue;
          try {
            const otherPim = P.createPim(deps.transport(other));
            const me = await otherPim.me();
            await set('bsi:base', other);
            return { base: other, pim: otherPim, me };
          } catch (e2) {
            /* not signed in there either */
          }
        }
        throw e;
      }
    }

    /** Who is signed in, where, and what they may do. Cached briefly: every message needs it. */
    async function session(anyHost, fresh) {
      const chosen0 = await chosenBase();
      const wanted = chosen0 || HOSTS[0];
      if (!fresh && sessionCache && sessionCache.base === wanted && now() - sessionCache.at < 60000) return sessionCache;
      const { base, pim, me } = await signIn(wanted, !chosen0 || !!anyHost);
      if (!me || !me.organization) throw new P.PimError('Not signed in to Bluestone PIM.', { kind: 'auth' });
      const contexts = await pim.contexts();
      const perms = me.permissions && typeof me.permissions === 'object' ? me.permissions : null;
      const has = (action, re) => !perms || (perms[action] || []).some((r) => re.test(String(r)));
      const env = envOf(base);
      sessionCache = {
        base, pim, me, contexts, at: now(), env,
        org: { id: me.organization, name: me.organizationName || me.organization },
        // Where saving is switched off, no role can edit.
        editLocked: !env.edit,
        canEdit: env.edit && has('UPDATE', /^(PRODUCTS?|ATTRIBUTES?)$/),
        canSuggest: has('ADD', /^TASKS?$/),
      };
      return sessionCache;
    }

    const stale = () => Object.assign(new Error('Your PIM session is not the one this page was read with (another organisation, PIM or language). Read the page again.'), { kind: 'stale' });

    /**
     * The session, with the language to work in.
     *   pageLang: a first scan picks the language from the page (unless the user chose one).
     *   bound:    { at, fresh, required }. Everything after a scan (details, a save, a suggestion)
     *             carries `at`: the PIM, organisation and language the scan was made with.
     *             It is done in exactly that language, and refused when the session has since
     *             moved to another organisation or PIM. A write asks the PIM again who is
     *             signed in (fresh) instead of trusting what was true a minute ago.
     */
    async function open(pageLang, anyHost, bound) {
      const b = bound || {};
      const at = b.at && typeof b.at === 'object' ? b.at : null;
      if (b.required && !at) throw stale();
      const s = await session(anyHost, !!b.fresh);
      let context;
      if (at) {
        if (at.base !== s.base || at.org !== s.org.id) throw stale();
        context = s.contexts.find((c) => c.id === at.context);
        if (!context) throw stale();
      } else {
        const chosen = own(await get('lens:context', {}), s.org.id);
        context = s.contexts.find((c) => c.id === chosen) || I.pickContext(s.contexts, pageLang);
      }
      if (!context) throw new Error('This organisation has no language set up.');
      return Object.assign({}, s, { context });
    }
    /** For everything that follows a scan. */
    const reopen = (msg, write) => open(null, false, { at: msg.at, fresh: !!write, required: !!write });

    const sessionInfo = (s) => ({
      base: s.base,
      user: s.me.name || '',
      org: s.org,
      context: { id: s.context.id, name: s.context.name || s.context.id },
      contexts: s.contexts.map((c) => ({ id: c.id, name: c.name || c.id })),
      canEdit: s.canEdit,
      canSuggest: s.canSuggest,
      editLocked: s.editLocked,
      environment: { id: s.env.id, name: s.env.name },
      hosts: HOSTS,
      pims: HOSTS.map((u) => ({ base: u, label: P.pimLabel(u) })),
    });

    async function idAttributes(s) {
      const cache = await get('bsi:idattrs', {});
      const hit = cache[s.org.id];
      if (hit && now() - hit.at < DAY) return hit.attrs;
      const attrs = I.detectIdAttributes(await s.pim.allDefinitions(s.context.id));
      cache[s.org.id] = { at: now(), attrs };
      await set('bsi:idattrs', cache);
      return attrs;
    }

    async function remember(key, productId) {
      const matches = await get('bsi:matches', {});
      if (productId) matches[key] = productId;
      else delete matches[key];
      const keys = Object.keys(matches);
      for (const k of keys.slice(0, Math.max(0, keys.length - 500))) delete matches[k];
      await set('bsi:matches', matches);
    }

    const cacheKey = (s, productId) => `${s.base}|${s.org.id}|${s.context.id}|${productId}`;

    async function loadProduct(s, productId, fresh) {
      const key = cacheKey(s, productId);
      const hit = loadedCache.get(key);
      if (hit && !fresh && now() - hit.at < 120000) return hit.loaded;
      const loaded = await I.load(s.pim, productId, s.context.id);
      loadedCache.set(key, { loaded, at: now() });
      if (loadedCache.size > 12) loadedCache.delete(loadedCache.keys().next().value);
      return loaded;
    }

    const levelOf = (p) => T.LEVEL[p.type] || p.type || '';
    const briefProduct = (p) => ({ id: p.id, name: p.name || p.number || '', number: p.number || '', level: levelOf(p) });

    function briefFact(fact, chain) {
      const can = I.canFix(fact);
      const attribute = fact.kind === 'attribute';
      const w = fact.where;
      const raw0 = attribute ? (fact.raw || [])[0] : fact.display;
      const display = plain(fact.display);
      return {
        key: fact.key,
        kind: fact.kind,
        label: fact.label,
        display: clip(display, 700),
        empty: !M.norm(display),
        unit: fact.unit || '',
        dataType: fact.dataType || '',
        long: display.length > 70 || /\n/.test(display),
        input: raw0 == null ? '' : String(raw0),
        options: fact.options ? fact.options.map((o) => ({ id: o.valueId, label: o.value })) : null,
        can: { owner: !!can.owner, holder: !!can.holder, reason: can.reason || '' },
        where: attribute ? { inherited: w.inherited, overridden: w.overridden, locked: w.locked, passesDown: w.passesDown } : null,
        owner: briefProduct(attribute ? chain[w.ownerIndex] : chain[0]),
        holder: briefProduct(attribute ? chain[w.holderIndex] : chain[0]),
      };
    }

    /** What the user taught us: on this site, this page label is that attribute. */
    async function applyLinks(s, page, facts) {
      const links = own(await get('lens:links', {}), `${s.org.id}|${page.host || hostOf(page.url)}`) || {};
      for (const fact of facts) {
        if (!fact.baseAliases) fact.baseAliases = (fact.aliases || []).slice();
        fact.aliases = fact.baseAliases.slice();
      }
      for (const [label, factKey] of Object.entries(links)) {
        const fact = facts.find((f) => f.key === factKey);
        if (fact) fact.aliases.push(label);
      }
      return links;
    }

    function compare(page, loaded, links) {
      const { chain, facts } = loaded;
      const rows = M.checkPairs(page.pairs || [], facts, { empties: true });
      const items = rows.map((r, i) => {
        // A label the user linked always goes to that attribute, also when the value is new.
        const linked = own(links, M.norm(r.pair.label));
        let top = r.top;
        let status = r.status;
        if (linked && (!top || top.fact.key !== linked)) {
          const fact = facts.find((f) => f.key === linked);
          const hit = fact && r.ranked.find((x) => x.fact === fact);
          if (fact) {
            top = hit || { fact, status: fact.texts.some((t) => M.norm(t)) ? 'differs' : 'empty', why: 'linked by you', confidence: 'high' };
            status = top.status === 'match' && top.confidence === 'low' ? 'match' : top.status;
          }
        }
        if (status === 'differs' && top && !top.fact.texts.some((t) => M.norm(t))) status = 'empty';
        return {
          i,
          label: r.pair.label,
          value: r.pair.value,
          status,
          why: top ? top.why : '',
          confidence: top ? top.confidence : '',
          linked: !!(linked && top && top.fact.key === linked),
          fact: top ? briefFact(top.fact, chain) : null,
          others: r.ranked.filter((x) => !top || x.fact !== top.fact).slice(0, 4).map((x) => ({ key: x.fact.key, label: x.fact.label, display: clip(plain(x.fact.display), 80) })),
        };
      });

      // The product's name on the page.
      let name = null;
      const shown = page.heading || page.name;
      if (M.norm(shown)) {
        const ranked = M.rank({ value: shown, label: 'Name' }, facts);
        const top = ranked[0];
        if (top) {
          name = { value: shown, status: top.status === 'match' && top.confidence === 'low' ? 'unsure' : top.status, why: top.why, fact: briefFact(top.fact, chain), others: [] };
        } else {
          name = { value: shown, status: 'unknown', why: '', fact: null, others: [] };
        }
      }

      // Longer texts (descriptions): which PIM text each one comes from.
      const longFacts = facts.map((f) => ({ fact: f, text: bare((f.texts || []).join(' ')) })).filter((x) => x.text.length >= 60);
      const blocks = [];
      (page.blocks || []).forEach((b, i) => {
        const text = bare(b.text);
        if (text.length < 60) return;
        const head = text.slice(0, 160);
        const hit = longFacts.find((x) => x.text.includes(head) || text.includes(x.text.slice(0, 160)));
        if (hit) blocks.push({ i, value: clip(b.text, 700), status: 'match', why: 'same text', fact: briefFact(hit.fact, chain), others: [] });
      });

      const count = { match: 0, differs: 0, unsure: 0, unknown: 0, empty: 0 };
      for (const it of items) count[it.status] = (count[it.status] || 0) + 1;
      return { items, name, blocks, count };
    }

    function briefCandidate(c) {
      return {
        id: c.product.id,
        name: c.product.name,
        number: c.product.number,
        level: T.LEVEL[c.product.type] || c.product.type || '',
        evidence: c.considered ? `${c.matches} of ${c.considered} facts on the page match` : c.nameExact ? 'Same name' : 'Similar name',
      };
    }

    function viaText(via, fromSelection) {
      if (!via) return '';
      let text = '';
      if (via.step === 'number') text = via.kind === 'typed' ? `Found by the product number you typed (${via.value})` : `Found by ${String(via.kind || 'number').toUpperCase()} ${via.value}${via.source ? ` (${via.source})` : ''}`;
      else if (via.step === 'pimId') text = 'Found by the PIM product id in the page’s address';
      else if (via.step === 'idAttribute') text = via.attribute ? `Found by the PIM attribute “${via.attribute}” = ${via.value}` : 'Found by an identifier attribute in the PIM';
      else if (via.step === 'name') text = 'Matched on name' + (via.considered ? ` and ${via.matches} of ${via.considered} facts on the page` : '');
      else if (via.step === 'remembered') text = 'Remembered from your earlier choice for this page';
      else if (via.step === 'picked') text = 'Chosen by you (remembered for this page)';
      if (fromSelection) text += ', using your selection';
      return text;
    }

    /**
     * msg.page: what page-extract.js read. Optional: productId (the user picked one),
     * fresh (forget the remembered product and offer the alternatives), query (typed by the user).
     */
    async function scan(msg) {
      const page = cleanPage(msg.page);
      msg = Object.assign({}, msg, { productId: idOf(msg.productId) || null, query: oneLine(msg.query, 200) || null, fresh: !!msg.fresh });
      const s = await open(page.lang, !!msg.anyHost);
      const session = sessionInfo(s);
      const key = pageKey(s.org.id, page.url);
      let via = null;
      let loaded = null;
      let fromSelection = false;

      if (msg.fresh) await remember(key, null);
      let productId = msg.productId || null;
      if (productId) via = { step: 'picked' };
      else if (!msg.fresh && !msg.query) {
        productId = idOf(own(await get('bsi:matches', {}), key)) || null;
        if (productId) via = { step: 'remembered' };
      }
      if (productId) {
        try {
          loaded = await loadProduct(s, productId, true);
          if (msg.productId) await remember(key, productId);
        } catch (e) {
          if (e.kind === 'auth') throw e;
          await remember(key, null);
          loaded = null;
        }
      }
      // A remembered product is the user's earlier choice for this address. If the page now
      // shows an identifier that belongs to another product (a shop that keeps one address
      // for several products), the page wins and the old choice is forgotten.
      if (loaded && via && via.step === 'remembered' && page.ids.length) {
        // Its number, or one of its parents', or (a page fed from the PIM) one of their ids.
        const numbers = new Set(loaded.chain.flatMap((p) => [String(p.number), String(p.id)]));
        if (!page.ids.some((c) => numbers.has(String(c.value)))) {
          const other = await I.findProduct(s.pim, page, s.context.id, { idAttributes: await idAttributes(s), idsOnly: true }).catch(() => null);
          if (other && other.product && other.product.id !== loaded.chain[0].id) {
            await remember(key, null);
            loaded = null;
            via = null;
          }
        }
      }
      if (!loaded) {
        const asked = msg.query ? Object.assign({}, page, { ids: [{ kind: 'typed', value: msg.query, source: 'typed by you' }], name: msg.query, selection: null }) : page;
        const found = await I.findProduct(s.pim, asked, s.context.id, { idAttributes: await idAttributes(s) });
        const candidates = (found.candidates || []).map(briefCandidate);
        if (!found.product || (msg.fresh && candidates.length > 1)) {
          const state = candidates.length ? 'pick' : 'notfound';
          return { ok: true, state, session, candidates, tried: found.tried || [], pageName: page.name || '' };
        }
        loaded = found.loaded || (await loadProduct(s, found.product.id, true));
        loadedCache.set(cacheKey(s, found.product.id), { loaded, at: now() });
        via = found.via;
        fromSelection = !!found.fromSelection && !(via && via.kind === 'selection');
        if (msg.query) await remember(key, found.product.id);
      }

      const links = await applyLinks(s, page, loaded.facts);
      const product = loaded.chain[0];
      return Object.assign(
        {
          ok: true,
          state: 'ready',
          session,
          product: Object.assign(briefProduct(product), { url: `${s.base}/products/${encodeURIComponent(product.id)}`, crumbs: loaded.breadcrumb }),
          via: viaText(via, fromSelection),
        },
        compare(page, loaded, links)
      );
    }

    async function factOf(s, msg) {
      const productId = idOf(msg.productId);
      const factKey = text(msg.factKey, 200);
      if (!productId || !factKey) throw new Error('That value is no longer on the product. Read the page again.');
      const loaded = await loadProduct(s, productId);
      const fact = loaded.facts.find((f) => f.key === factKey);
      if (!fact) throw new Error('That value is no longer on the product. Read the page again.');
      return { loaded, fact };
    }

    /** Evidence on which side a difference comes from, as { kind, title, text }, or null. */
    const briefOrigin = (o) => (o ? { kind: o.kind, title: clip(o.title, 200), text: clip(o.text, 600) } : null);

    async function details(msg) {
      const s = await reopen(msg);
      const { loaded, fact } = await factOf(s, msg);
      const d = await I.details(s.pim, loaded.chain, fact, s.context.id);
      return {
        ok: true,
        // Only for a value the page shows differently: where the difference may come from.
        origin: briefOrigin(I.origin(fact, oneLine(msg.pageValue, 500), d.lastChangeError ? null : d.changes || null)),
        lastChange: d.lastChange
          ? { date: d.lastChange.date, userName: d.lastChange.userName || '', value: clip(plain(d.lastChange.value), 120), oldValue: clip(plain(d.lastChange.oldValue), 120), wholeProduct: !!d.lastChange.wholeProduct }
          : null,
        lastChangeError: d.lastChangeError || '',
        impact: d.impact ? { level: d.impact.level, groups: d.impact.groups, variants: d.impact.variants, propagates: d.impact.propagates } : null,
      };
    }

    /** Check a new value and say what saving it would touch. Nothing is written. */
    async function preview(msg) {
      const s = await reopen(msg);
      if (s.editLocked) return { ok: false, error: LOCKED };
      const { loaded, fact } = await factOf(s, msg);
      const target = msg.target === 'holder' ? 'holder' : 'owner';
      const v = I.validateFix(fact, text(msg.input, MAX_VALUE + 1), target);
      if (!v.ok) return { ok: false, error: v.error };
      const impact = await T.impact(s.pim, loaded.chain, fact, target, s.context.id);
      return {
        ok: true,
        display: v.display,
        // Shown in the review, so the user sees which language and PIM the change goes to.
        language: fact.kind === 'attribute' && fact.contextAware === false ? '' : s.context.name || s.context.id,
        pim: hostOf(s.base),
        organisation: s.org.name,
        product: briefProduct(impact.product),
        impact: { level: impact.level, groups: impact.groups, variants: impact.variants, propagates: impact.propagates },
      };
    }

    async function apply(msg) {
      const s = await reopen(msg, true);
      // Checked here, in the worker: it does not depend on what the on-page view offers.
      if (s.editLocked) return { ok: false, error: LOCKED };
      if (!s.canEdit) return { ok: false, error: 'Your role in this organisation cannot change products. Send a suggestion instead.' };
      const { loaded, fact } = await factOf(s, msg);
      const done = await I.applyFix(s.pim, loaded.chain, fact, {
        input: text(msg.input, MAX_VALUE + 1),
        target: msg.target === 'holder' ? 'holder' : 'owner',
        forceVla: !!msg.forceVla,
        context: s.context.id,
      });
      loadedCache.delete(cacheKey(s, idOf(msg.productId)));
      return { ok: true, display: done.display, productId: done.productId };
    }

    async function assignees() {
      const s = await open();
      const [users, groups] = await Promise.all([s.pim.users().catch(() => []), s.pim.userGroups().catch(() => [])]);
      const by = (a, b) => a.name.localeCompare(b.name);
      return {
        ok: true,
        users: users.sort(by),
        groups: groups.sort(by),
        me: s.me.id || '',
        current: (await get('lens:assignee', {}))[s.org.id] || null,
      };
    }

    // ---- pictures ----------------------------------------------------------

    const assetIdsOf = (product) => (product.assets || []).map((a) => (typeof a === 'string' ? a : a && (a.assetId || a.id))).filter(Boolean);

    /** The product's pictures in the PIM, each with a thumbnail and a fingerprint. */
    async function pimPictures(s, product) {
      const key = cacheKey(s, product.id);
      const hit = pictureCache.get(key);
      if (hit && now() - hit.at < 120000) return hit.pictures;
      const assets = (await s.pim.assetViews(assetIdsOf(product).slice(0, 30), s.context.id)).slice(0, 8);
      const pictures = await Promise.all(
        assets.map(async (a) => {
          // The PIM app's own thumbnail address: it resizes with the signed-in session, published or not.
          // The file key is a path inside the media library: each part is encoded, and a key
          // that tries to climb out of it ("..") is not asked for at all.
          const parts = String(a.fileKey).split('/').filter(Boolean);
          const safe = parts.length && parts.length <= 12 && !parts.some((x) => x === '.' || x === '..');
          const url = `${s.base}/api/assets/${parts.map(encodeURIComponent).join('/')}?w=256&h=256&f=jpg`;
          const read = safe && deps.readImage ? await deps.readImage(url, { session: true, thumb: true }).catch(() => null) : null;
          return { id: a.id, name: a.name, width: a.width, height: a.height, hash: (read && read.hash) || '', thumb: (read && read.dataUrl) || '' };
        })
      );
      pictureCache.set(key, { pictures, at: now() });
      if (pictureCache.size > 12) pictureCache.delete(pictureCache.keys().next().value);
      return pictures;
    }

    /**
     * Compare the page's product pictures with the PIM's. msg.images: [{ src, alt, w, h }].
     * A shop serves its own copies (renamed, resized), so pictures are compared by
     * fingerprint, not by address. Reading a shop's picture needs the user's
     * permission for its image host: until then the picture is 'unchecked'.
     */
    async function images(msg) {
      const s = await reopen(msg);
      const productId = idOf(msg.productId);
      if (!productId) return { ok: false, error: 'Read the page again.' };
      const loaded = await loadProduct(s, productId);
      const product = loaded.chain[0];
      const pictures = await pimPictures(s, product);
      const pageImages = rows(msg.images, 8).map((x) => ({ src: text(x.src, MAX_SRC + 1) }));
      const needPermission = new Set();
      const items = [];
      const used = new Set();
      let unchecked = 0;
      for (let i = 0; i < pageImages.length; i++) {
        if (!pictures.length) {
          items.push({ i, status: 'unknown', asset: null, why: 'The product has no pictures in the PIM' });
          continue;
        }
        let read = null;
        try {
          const src = pageImages[i].src;
          read = deps.readImage && src && src.length <= MAX_SRC ? await deps.readImage(src, { session: false }) : { error: 'failed' };
        } catch (e) {
          read = { error: 'failed' };
        }
        if (!read || read.error || !read.hash) {
          if (read && read.error === 'permission' && read.origin) needPermission.add(read.origin);
          unchecked++;
          items.push({ i, status: 'unchecked', asset: null, why: read && read.error === 'permission' ? 'Not allowed to read this picture yet' : 'This picture could not be read' });
          continue;
        }
        let best = -1;
        let closest = Infinity;
        pictures.forEach((p, n) => {
          const d = p.hash ? M_IMG.distance(read.hash, p.hash) : null;
          if (d && M_IMG.same(read.hash, p.hash) && d.shape < closest) {
            best = n;
            closest = d.shape;
          }
        });
        if (best >= 0) {
          used.add(best);
          items.push({ i, status: 'match', asset: best, why: 'Same picture' });
        } else {
          items.push({ i, status: 'unknown', asset: null, why: 'None of the PIM’s pictures of this product looks like it' });
        }
      }
      return {
        ok: true,
        assets: pictures.map((p) => ({ id: p.id, name: p.name, width: p.width, height: p.height, thumb: p.thumb })),
        items,
        needPermission: [...needPermission],
        // Pictures the PIM has that this page does not show; only known once every page picture was read.
        extra: unchecked ? null : pictures.length - used.size,
        productUrl: `${s.base}/products/${encodeURIComponent(product.id)}`,
      };
    }

    const cleanAssignee = (a) => {
      const id = a && typeof a === 'object' ? idOf(a.id) : '';
      return id ? { id, type: a.type === 'userGroup' ? 'userGroup' : 'user', name: oneLine(a.name, 120) } : null;
    };

    /** Who suggestions go to, for the current organisation. */
    async function setAssignee(msg) {
      const s = await open();
      const a = cleanAssignee(msg.assignee);
      if (!a) return { ok: false };
      const stored = await get('lens:assignee', {});
      stored[s.org.id] = a;
      await set('lens:assignee', stored);
      return { ok: true };
    }

    /**
     * Suggest mode: nothing on the product changes. A task goes to the chosen person
     * or group, with the product on it and the suggestion in the description.
     */
    async function suggest(msg) {
      const s = await reopen(msg, true);
      if (!s.canSuggest) return { ok: false, error: 'Your role in this organisation cannot create tasks.' };
      const stored = await get('lens:assignee', {});
      const picked = cleanAssignee(msg.assignee);
      const assignee = picked || cleanAssignee(own(stored, s.org.id));
      if (!assignee) return { ok: false, needAssignee: true };
      const productId = idOf(msg.productId);
      if (!productId) return { ok: false, error: 'Read the page again.' };
      const loaded = await loadProduct(s, productId);
      const factKey = text(msg.factKey, 200);
      const fact = factKey ? loaded.facts.find((f) => f.key === factKey) : null;
      // What the page said, as single lines: a page cannot write the rest of the task.
      const pageLabel = oneLine(msg.pageLabel, 80);
      const pageValue = oneLine(msg.pageValue, 500);
      const pageUrl = webUrl(msg.pageUrl, 1000);
      const assetName = oneLine(msg.assetName, 200);
      const product = loaded.chain[0];
      const owner = fact && fact.kind === 'attribute' ? loaded.chain[fact.where.ownerIndex] : product;
      const picture = msg.kind === 'image';
      const what = picture ? 'picture' : fact ? fact.label : pageLabel || 'a value';
      const suggested = lines(msg.input, 2000);
      const note = lines(msg.note, 1000);
      if (!suggested && !note) return { ok: false, error: 'Type the value you suggest, or a note.' };
      // What the PIM's history says about the difference, so the colleague sees which side to
      // look at before changing a PIM value that may be right. Left out when it cannot be read.
      let evidence = null;
      if (fact && fact.kind === 'attribute' && !picture && pageValue) {
        try {
          const query = Object.assign({ definitionId: fact.definitionId }, fact.contextAware === false ? {} : { context: s.context.id });
          evidence = I.origin(fact, pageValue, await s.pim.changes(owner.id, query, 20));
        } catch (e) {
          evidence = I.origin(fact, pageValue, null); // rounding can be seen without the history
        }
      }

      const title = clip(`Suggested change: ${what} on ${product.name || product.number}`, 140);
      const body = [
        `Product: ${product.name || ''} (${product.number || product.id})`,
        owner !== product ? `The value is set on the ${levelOf(owner).toLowerCase()} ${owner.name || ''} (${owner.number || owner.id}).` : '',
        picture ? `Picture on the page: ${pageValue}` : `Attribute: ${fact ? fact.label : `not found in the PIM (the page calls it “${pageLabel}”)`}`,
        picture ? (assetName ? `The same picture in the PIM: ${assetName}` : 'No picture of this product in the PIM looks like it.') : '',
        fact ? `In the PIM now: ${oneLine(plain(fact.display), 300) || '(empty)'}` : '',
        !picture && pageValue ? `On the page: ${clip(pageValue, 300)}` : '',
        evidence ? `Where the difference may come from: ${oneLine(`${evidence.title} ${evidence.text}`, 700)}` : '',
        suggested ? `Suggested value: ${suggested}` : '',
        note ? `Note: ${note}` : '',
        pageUrl ? `Page: ${pageUrl}` : '',
        `Sent by ${oneLine(s.me.name, 120) || 'a colleague'} with Bluestone PIM Lens.`,
      ].filter(Boolean);
      const due = new Date(now() + 7 * DAY).toISOString().slice(0, 10) + 'T12:00:00Z';

      let { id } = await s.pim.createTask({
        title,
        description: body.join('\n'),
        assignee: assignee.id,
        assigneeType: assignee.type,
        dueDate: due,
        context: s.context.id,
      });
      if (picked) {
        stored[s.org.id] = picked;
        await set('lens:assignee', stored);
      }
      if (!id) {
        // The PIM did not say which task it made: look for ours by title.
        const mine = (await s.pim.tasks().catch(() => [])).filter((t) => t.title === title && (!s.me.id || t.creator === s.me.id));
        id = mine.length ? mine[mine.length - 1].id : null;
      }
      let attached = false;
      if (id) {
        try {
          await s.pim.addTaskProducts(id, [...new Set([product.id, owner.id])]);
          attached = true;
        } catch (e) {
          /* the task exists; it just opens without the product listed */
        }
      }
      return { ok: true, taskId: id, title, attached, assignee: assignee.name || '', url: `${s.base}/tasks`, due: due.slice(0, 10) };
    }

    async function factList(msg) {
      const s = await reopen(msg);
      const productId = idOf(msg.productId);
      if (!productId) return { ok: false, error: 'Read the page again.' };
      const loaded = await loadProduct(s, productId);
      return {
        ok: true,
        facts: loaded.facts
          .filter((f) => f.kind !== 'number')
          .map((f) => ({ key: f.key, label: f.label, display: clip(plain(f.display), 60) }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      };
    }

    async function link(msg) {
      const s = await open();
      const all = await get('lens:links', {});
      const key = `${s.org.id}|${text(msg.host, 255)}`;
      const label = M.norm(text(msg.label, 80));
      const factKey = text(msg.factKey, 200);
      if (!label) return { ok: false };
      if (own(all, key) === undefined && Object.keys(all).length >= MAX_LINK_SITES) return { ok: false, error: 'Too many sites have label links. Remove the extension’s data to start again.' };
      const mine = Object.assign({}, own(all, key));
      if (factKey && (own(mine, label) !== undefined || Object.keys(mine).length < MAX_LINKS)) mine[label] = factKey;
      else delete mine[label];
      all[key] = mine;
      await set('lens:links', all);
      return { ok: true };
    }

    async function orgs() {
      const s = await open();
      const list = await s.pim.organizations();
      return { ok: true, current: s.org.id, orgs: list.sort((a, b) => a.name.localeCompare(b.name)) };
    }

    async function switchOrg(msg) {
      const base = await baseUrl();
      const orgId = idOf(msg.orgId);
      if (!orgId) return { ok: false, error: 'Could not switch organisation.' };
      const r = await deps.switchOrg(base, orgId);
      sessionCache = null;
      loadedCache.clear();
      pictureCache.clear();
      if (!r || !r.ok) return { ok: false, needsUser: !!(r && r.needsUser), error: r && r.needsUser ? 'The PIM needs you to finish signing in. Its tab is open now.' : 'Could not switch organisation.' };
      const s = await open();
      return s.org.id === orgId ? { ok: true, org: s.org } : { ok: false, error: 'The PIM stayed in the same organisation.' };
    }

    /**
     * Ends the browser's PIM session, so that someone else can sign in. The Lens has
     * no session of its own. Every PIM of the chosen environment is signed out of (the
     * two Test PIMs share one sign-in; Production has its own, and is left alone when
     * you sign out of Test, and the other way round). It counts as done only when the
     * PIM itself says nobody is signed in.
     */
    async function signOut() {
      const base = await baseUrl();
      const env = envOf(base);
      const mine = env.hosts; // of this environment only
      if (!deps.signOut) return { ok: false, base, error: 'Could not sign out. Open the PIM and sign out there.' };
      // true or false, or null when the PIM could not be asked.
      const signedIn = async (host) => {
        try {
          await P.createPim(deps.transport(host)).me();
          return true;
        } catch (e) {
          return e && e.kind === 'auth' ? false : null;
        }
      };
      const before = await Promise.all(mine.map(signedIn));
      let after = [];
      let r = null;
      try {
        r = await deps.signOut(mine.filter((h, i) => before[i] !== false), async () => {
          after = await Promise.all(mine.map(signedIn));
          return mine.find((h, i) => after[i] === true) || null;
        }, env.signInEnd);
      } catch (e) {
        r = null; // the browser could not do it: said below, in words a person can use
      }
      reset();
      if (r && r.ok) {
        if (after[mine.indexOf(base)] !== false) return { ok: false, base, error: 'Bluestone PIM could not be reached to check that you are signed out. Open the PIM to see.' };
        const other = P.ENVIRONMENTS.find((x) => x.id !== env.id);
        return { ok: true, base, hosts: mine, environment: { id: env.id, name: env.name }, other: other ? { base: other.hosts[0], name: other.name } : null };
      }
      if (r && r.needsUser) return { ok: false, needsUser: true, base: mine.includes(r.base) ? r.base : base, error: 'The PIM did not sign you out. It is open in a tab now: click your name there, then Sign out.' };
      return { ok: false, base, error: 'Could not sign out. Open the PIM and sign out there.' };
    }

    async function settings(msg) {
      if (msg.base && HOSTS.includes(msg.base)) {
        // Production is chosen only once Chrome has the user's yes for its address.
        if (!(await canReach(msg.base))) return { ok: false, needAccess: true, error: `Chrome has not been told to let the Lens reach ${envOf(msg.base).name}.` };
        await set('bsi:base', msg.base);
        sessionCache = null;
        loadedCache.clear();
        pictureCache.clear();
      }
      const contextId = idOf(msg.contextId);
      if (contextId) {
        const s = await open();
        if (s.contexts.some((c) => c.id === contextId)) {
          const all = await get('lens:context', {});
          all[s.org.id] = contextId;
          await set('lens:context', all);
          sessionCache = null;
          loadedCache.clear();
          pictureCache.clear();
        }
      }
      return { ok: true };
    }

    /** The on-page view's own choices (Suggest or Edit), kept by the worker, not by the page. */
    async function prefs(msg) {
      if (msg.mode === 'edit' || msg.mode === 'suggest') await set('lens:mode', msg.mode);
      return { ok: true, mode: (await get('lens:mode', 'suggest')) === 'edit' ? 'edit' : 'suggest' };
    }

    const routes = {
      'lens:scan': scan, 'lens:images': images, 'lens:details': details, 'lens:preview': preview, 'lens:apply': apply,
      'lens:assignees': assignees, 'lens:assignee': setAssignee, 'lens:suggest': suggest, 'lens:facts': factList, 'lens:link': link,
      'lens:orgs': orgs, 'lens:switch-org': switchOrg, 'lens:sign-out': signOut, 'lens:settings': settings, 'lens:prefs': prefs,
    };
    const routeOf = (type) => (typeof type === 'string' ? own(routes, type) : undefined);

    /** Every answer is { ok, … }. Failures never throw: { ok: false, state?, error }. */
    /**
     * from: where the message came from, as Chrome reports it ({ url } of the page the
     * on-page view runs in). When given, it replaces what the message itself says about
     * the page's address: a page cannot speak for another site.
     */
    async function handle(msg, from) {
      const route = msg && typeof msg === 'object' ? routeOf(msg.type) : null;
      if (!route) return { ok: false, error: 'Unknown request.' };
      if (from && typeof from.url === 'string') {
        msg = Object.assign({}, msg);
        if (msg.page && typeof msg.page === 'object') msg.page = Object.assign({}, msg.page, { url: from.url, host: hostOf(from.url) });
        if ('pageUrl' in msg) msg.pageUrl = from.url;
        if ('host' in msg) msg.host = hostOf(from.url);
      }
      const writing = msg.type === 'lens:apply' || msg.type === 'lens:suggest';
      try {
        return await route(msg);
      } catch (e) {
        const base = await baseUrl().catch(() => HOSTS[0]);
        const env = envOf(base);
        // What the on-page box needs to offer a way on: this environment's PIMs to sign in
        // to, and the other environment to choose instead.
        const where = () => {
          const other = P.ENVIRONMENTS.find((x) => x.id !== env.id);
          return { base, hosts: env.hosts, environment: { id: env.id, name: env.name }, other: other ? { base: other.hosts[0], name: other.name } : null };
        };
        if (e && e.kind === 'auth') {
          sessionCache = null;
          return Object.assign({ ok: false, state: 'auth', error: 'You are not signed in to Bluestone PIM.' }, where());
        }
        if (e && e.kind === 'access') {
          sessionCache = null;
          return Object.assign({ ok: false, state: 'access', error: e.message }, where());
        }
        if (e && e.kind === 'stale') {
          reset();
          return { ok: false, state: 'stale', base, error: e.message };
        }
        if (e && e.kind === 'network' && writing && /too long/.test(e.message || '')) {
          return { ok: false, base, error: 'Bluestone PIM took too long to answer, so it is not known whether this was saved. Check in the PIM before you try again.' };
        }
        if (e && e.kind === 'permission') return { ok: false, base, error: 'Your role in this organisation does not allow that.' };
        if (e && e.kind === 'network') return { ok: false, error: /too long/.test(e.message || '') ? 'Bluestone PIM took too long to answer. Try again in a moment.' : 'Could not reach Bluestone PIM. Check your connection and try again.' };
        return { ok: false, base, error: (e && e.message) || 'Something went wrong.' };
      }
    }

    /** Forget who is signed in and what was loaded: the session changed outside this service. */
    function reset() {
      sessionCache = null;
      loadedCache.clear();
      pictureCache.clear();
    }

    return { handle, reset, handles: (type) => !!routeOf(type) };
  }

  const api = { createService, HOSTS, plain, cleanPage };
  root.BSI = Object.assign(root.BSI || {}, { service: api });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
