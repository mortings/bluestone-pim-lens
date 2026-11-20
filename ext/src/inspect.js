/*
 * The inspector's steps, without any UI:
 *   identify  page identifiers (SKU, MPN, GTIN…) -> the PIM product
 *   load      the product, its parents, definitions and every fact
 *   details   for one fact: where it is owned, who changed it last, what a fix touches
 *   applyFix  write the corrected value to the right product
 */
(function (root) {
  'use strict';

  const { trace, match } = root.BSI || {};
  const T = trace || (typeof require !== 'undefined' ? require('./trace.js') : null);
  const M = match || (typeof require !== 'undefined' ? require('./match.js') : null);

  /** Pick the context whose locale matches the page language, else the default one. */
  function pickContext(contexts, pageLang) {
    const lang = String(pageLang || '').toLowerCase().split(/[-_]/)[0];
    const byLocale = lang && contexts.find((c) => String(c.locale || '').toLowerCase().split(/[-_]/)[0] === lang);
    return byLocale || contexts.find((c) => c.initial) || contexts[0] || null;
  }

  // ---- finding the product --------------------------------------------------

  const ID_ATTRIBUTE_NAME = /\b(ean|gtin|upc|isbn|sku|mpn|item\s*(no|nr|number)|article\s*(no|nr|number)|art\.?\s*(no|nr)|supplier\s*(item|article|part)|part\s*(no|number)|model\s*(no|number)|product\s*(id|code)|shop\s*id|external\s*id)\b/i;
  const ID_ATTRIBUTE_TYPES = new Set(['text', 'integer', 'decimal']);

  /** Attributes that look like they hold an identifier: "Ean", "Item number", "Supplier article no"… */
  function detectIdAttributes(definitions) {
    return definitions
      .filter((d) => ID_ATTRIBUTE_TYPES.has(d.dataType) && ID_ATTRIBUTE_NAME.test(d.name || ''))
      .slice(0, 8)
      .map((d) => ({ id: d.id, name: d.name, dataType: d.dataType }));
  }

  /** Words of a name. "1kg" and "1 kg" give the same words: digits and letters are split. */
  function nameTokens(s) {
    return M.norm(s)
      .replace(/(\p{N})(\p{L})/gu, '$1 $2')
      .replace(/(\p{L})(\p{N})/gu, '$1 $2')
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
  }

  /** How alike two product names are, 0..1 (shared words, order ignored). */
  function nameSimilarity(a, b) {
    const ta = nameTokens(a);
    const tb = nameTokens(b);
    if (!ta.length || !tb.length) return 0;
    const setB = new Set(tb);
    const common = new Set(ta.filter((t) => setB.has(t))).size;
    return (2 * common) / (new Set(ta).size + setB.size);
  }

  /** "Name | Shop", "Name - Shop": the part before the separator, if it is long enough. */
  function trimShopName(name) {
    const cut = String(name || '').split(/\s[|–—]\s|\s-\s/)[0].trim();
    return cut.length >= 6 && cut !== name ? cut : null;
  }

  /** Step 1: an identifier on the page is a product number in the PIM. */
  async function byNumber(pim, ids, context, pageName) {
    if (!ids.length) return null;
    const found = await pim.findByNumbers(ids.map((c) => String(c.value)), context);
    for (const c of ids) {
      const hit = found.find((p) => p.number === String(c.value));
      // A number the page shows without a label is a guess: the product must have the page's name too.
      if (hit && c.weak && nameSimilarity(pageName, hit.name) < 0.6) continue;
      if (hit) return { product: hit, via: { step: 'number', kind: c.kind, value: c.value, source: c.source } };
    }
    return null;
  }

  /** Step 2b: the page's address holds the PIM's own id of the product (sites fed straight from the PIM). */
  async function byPimId(pim, ids, context) {
    for (const c of ids.slice(0, 2)) {
      let rows = [];
      try {
        rows = await pim.summaries([String(c.value)], context);
      } catch (e) {
        // "No such product" is an answer; not being signed in, or no connection, is not.
        if (e && (e.kind === 'auth' || e.kind === 'network')) throw e;
      }
      const hit = rows.find((p) => p.id === String(c.value));
      if (hit) return { product: { id: hit.id, number: hit.number, name: hit.name, type: hit.type }, via: { step: 'pimId', value: c.value, source: c.source } };
    }
    return null;
  }

  /** Step 2: an identifier on the page is the value of an identifier attribute (EAN, item number…). */
  async function byIdAttribute(pim, ids, idAttributes, context) {
    const pairs = [];
    for (const attr of idAttributes || []) {
      for (const c of ids.slice(0, 8)) {
        const value = String(c.value).replace(/\s+/g, '');
        // Number attributes reject anything that is not a number.
        if (attr.dataType !== 'text' && !/^\d+([.,]\d+)?$/.test(value)) continue;
        pairs.push({ definitionId: attr.id, dataType: attr.dataType, value });
      }
    }
    if (!pairs.length) return [];
    return pim.searchAttributes(pairs.slice(0, 40), context);
  }

  /** Which identifier attribute of a loaded product holds one of the page's identifiers. */
  function matchedIdAttribute(loaded, ids, idAttributes) {
    const wanted = new Set(ids.map((c) => String(c.value).replace(/\s+/g, '')));
    for (const attr of idAttributes || []) {
      const fact = loaded.facts.find((f) => f.definitionId === attr.id);
      const value = fact && (fact.raw || []).map((v) => String(v).replace(/\s+/g, '')).find((v) => wanted.has(v) || wanted.has(v.replace(/\.0+$/, '')));
      if (value) return { name: attr.name, value };
    }
    return null;
  }

  /**
   * Score loaded candidates against the page: how alike the names are, and how
   * many of the page's facts the candidate holds.
   */
  function scoreCandidate(page, loaded) {
    const product = loaded.chain[0];
    const nameScore = nameSimilarity(page.name, product.name);
    const report = pageReport(page, loaded.facts).filter((r) => r.top && r.top.fact.kind === 'attribute');
    const matches = report.filter((r) => r.status === 'match').length;
    const differs = report.filter((r) => r.status === 'differs').length;
    const considered = matches + differs;
    const factScore = considered ? Math.max(0, (matches - 0.5 * differs) / considered) : 0;
    const score = considered ? 0.5 * nameScore + 0.5 * factScore : nameScore * 0.8;
    return {
      product: { id: product.id, number: product.number, name: product.name, type: product.type },
      score, nameScore, matches, differs, considered,
      nameExact: M.norm(page.name) === M.norm(product.name),
      loaded,
    };
  }

  async function rankCandidates(pim, page, ids, context) {
    const loaded = await Promise.all(ids.slice(0, 6).map((id) => load(pim, id, context).catch(() => null)));
    return loaded.filter(Boolean).map((l) => scoreCandidate(page, l)).sort((a, b) => b.score - a.score);
  }

  /** A clear winner is accepted; a close call goes to the user. */
  function clearWinner(ranked) {
    const [best, second] = ranked;
    if (!best || best.score < 0.5) return null;
    if (!second) return best;
    if (best.nameExact && !second.nameExact && best.matches >= second.matches) return best;
    return best.score - second.score >= 0.1 ? best : null;
  }

  /**
   * Find the PIM product for a page, trying in order:
   *   1. an identifier on the page as product number
   *   2. an identifier on the page as the value of an identifier attribute
   *   2b. the PIM's own product id, when the page's address holds one
   *   3. the product name (fuzzy search), checked against the facts on the page
   * and, when all of that finds nothing, the same again with the user's selection.
   *
   * Returns { product, via, loaded?, candidates, tried }. product is null when the
   * user has to choose (candidates) or nothing was found.
   */
  async function findProduct(pim, page, context, options) {
    const opts = options || {};
    const tried = [];
    const seen = new Set();
    const ids = (page.ids || []).filter((c) => c.value && !seen.has(c.value) && seen.add(c.value));

    const attempt = async (all, name) => {
      // The PIM's own product id, when the page's address holds one (see step 2b).
      const own = all.filter((c) => c.kind === 'pim id' && /^[0-9a-f]{24}$/i.test(String(c.value)));
      const idList = all.filter((c) => !own.includes(c));
      // 1. product number
      if (idList.length) {
        tried.push(`product number: ${idList.map((c) => c.value).slice(0, 4).join(', ')}`);
        const hit = await byNumber(pim, idList, context, name || page.name);
        if (hit) return Object.assign(hit, { candidates: [] });
      }
      // 2. identifier attributes
      let pool = [];
      if (idList.some((c) => !c.weak) && (opts.idAttributes || []).length) {
        tried.push(`identifier attributes: ${opts.idAttributes.map((a) => a.name).join(', ')}`);
        // A number the page shows without a label is not sure enough for this.
        pool = await byIdAttribute(pim, idList.filter((c) => !c.weak), opts.idAttributes, context);
        if (pool.length === 1) {
          const loaded = await load(pim, pool[0], context);
          const p = loaded.chain[0];
          const m = matchedIdAttribute(loaded, idList, opts.idAttributes);
          return {
            product: { id: p.id, number: p.number, name: p.name, type: p.type },
            via: { step: 'idAttribute', attribute: m && m.name, value: m && m.value },
            loaded, candidates: [],
          };
        }
      }
      // 2b. the PIM's own product id in the page's address. After the identifiers the page shows:
      //     a page for a product with variants keeps the parent's address while it shows one
      //     variant, with that variant's number.
      if (own.length) {
        tried.push('PIM product id in the page’s address');
        const hit = await byPimId(pim, own, context);
        if (hit) return Object.assign(hit, { candidates: [] });
      }
      // 3. name, checked against the facts
      let viaStep = 'idAttribute';
      if (!pool.length && name && !opts.idsOnly) {
        viaStep = 'name';
        tried.push(`name: “${name}”`);
        let hits = await pim.searchText(name, context, 8);
        const shorter = trimShopName(name);
        if (!hits.length && shorter) hits = await pim.searchText(shorter, context, 8);
        pool = hits.map((h) => h.id);
      }
      if (!pool.length) return null;
      // Fuzzy search always returns something: keep only candidates that resemble the page.
      const ranked = (await rankCandidates(pim, Object.assign({}, page, { name: name || page.name }), pool, context))
        .filter((c) => viaStep === 'idAttribute' || c.score >= 0.3);
      if (!ranked.length) return null;
      const winner = clearWinner(ranked);
      const candidates = ranked.map(({ loaded, ...rest }) => rest);
      if (winner) {
        return {
          product: winner.product,
          via: { step: viaStep, matches: winner.matches, considered: winner.considered, nameScore: winner.nameScore },
          loaded: winner.loaded, candidates,
        };
      }
      return { product: null, via: null, candidates };
    };

    let result = await attempt(ids, page.name);
    // Nothing at all: the user's selection may be the identifier or the name.
    const hint = page.selection && M.norm(page.selection.text);
    if ((!result || (!result.product && !result.candidates.length)) && hint && hint.length <= 120 && !opts.idsOnly) {
      const text = page.selection.text.trim();
      const hinted = await attempt([{ kind: 'selection', value: text, source: 'your selection' }], text);
      if (hinted) result = Object.assign(hinted, { fromSelection: true });
    }
    return Object.assign({ product: null, via: null, candidates: [] }, result || {}, { tried });
  }

  async function load(pim, productId, context) {
    const chain = await T.loadChain(pim, productId, context);
    if (!chain.length) throw new Error('Product not found in the PIM.');
    const definitions = await pim.definitions(T.definitionIds(chain), context);
    const dictLabels = {};
    const refs = T.dictionaryRefs(chain, definitions).slice(0, 40);
    await Promise.all(
      refs.map(async (r) => {
        try {
          dictLabels[r.key] = await pim.dictionaryLabel(r.definitionId, r.valueId, context);
        } catch (e) {
          /* the id shows instead of the label */
        }
      })
    );
    return { chain, definitions, facts: T.buildFacts(chain, definitions, dictLabels), breadcrumb: T.breadcrumb(chain) };
  }

  /** Rank the PIM facts for what the user selected. */
  function traceSelection(selection, facts) {
    if (!selection || !M.norm(selection.text)) return [];
    const ranked = M.rank({ value: selection.text, label: selection.label }, facts);
    // A confident answer doesn't need the long shots listed under it.
    return ranked.length && ranked[0].confidence === 'high' ? ranked.filter((r) => r.confidence !== 'low') : ranked;
  }

  /** Compare every label/value pair on the page with the PIM. */
  function pageReport(page, facts) {
    return M.checkPairs(page.pairs || [], facts);
  }

  /** Everything the panel shows about one fact. */
  async function details(pim, chain, fact, context) {
    const out = { holder: chain[0], owner: chain[0], lastChange: null, impact: null };
    if (fact.kind === 'attribute') {
      out.holder = chain[fact.where.holderIndex];
      out.owner = chain[fact.where.ownerIndex];
    }
    out.impact = await T.impact(pim, chain, fact, 'owner', context);
    if (fact.kind !== 'attribute') {
      if (chain[0].lastUpdate) out.lastChange = { date: chain[0].lastUpdate, wholeProduct: true };
      return out;
    }
    try {
      const query = { definitionId: fact.definitionId };
      // The value's recent history: its last change, and what it was before (see origin()).
      const changes = await pim.changes(out.owner.id, Object.assign(query, fact.contextAware === false ? {} : { context }), HISTORY_LIMIT);
      out.changes = changes;
      const change = changes[0];
      if (change) {
        let userName = null;
        if (change.userId) userName = await pim.userName(change.userId).catch(() => null);
        out.lastChange = Object.assign({ userName }, change);
      }
    } catch (e) {
      out.lastChangeError = e.kind === 'permission' ? 'You do not have access to the history.' : 'History is not available.';
    }
    return out;
  }

  // ---- where a difference comes from -------------------------------------------
  // "Differs" says the page and the PIM disagree, not which of them is wrong. The PIM's
  // own history can often tell: the page may show what the PIM held earlier (the shop
  // is behind), the PIM's value rounded or converted (done on the way out), or a value
  // the PIM has not held at all (changed in the integration or in the shop).
  //
  // What an integration actually delivered is not known to the PIM, and the published
  // copy is only readable with an API key, which the Lens does not hold. So this is
  // evidence from the PIM's side, worded as such.

  const HISTORY_LIMIT = 20; // changes of one value that are looked at
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = (ms) => {
    const d = new Date(ms);
    return isNaN(d) ? '' : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  };

  /**
   * fact: the PIM fact the page value was compared with. pageValue: what the page shows.
   * changes: pim.changes() of that value, newest first; null when the history could not be read.
   * Returns null when there is nothing to say, or
   *   { kind: 'earlier' | 'rounded' | 'elsewhere', title, text, until?, since? }.
   */
  function origin(fact, pageValue, changes) {
    if (!fact || fact.kind !== 'attribute' || !M.norm(pageValue)) return null;
    // This product holds its own value while the history read is its parent's: nothing sure to say.
    if (fact.where && fact.where.overridden) return null;
    const now = (fact.texts || []).filter((t) => M.norm(t));
    const same = (text) => M.valueScore(pageValue, text, fact.unit).score >= 0.85;
    if (now.some(same)) return null; // no difference to explain
    const shown = (v) => `“${String(v).replace(/\s+/g, ' ').trim().slice(0, 60)}”`;
    const pimNow = now.length ? shown(String(fact.display || now[0])) : 'no value';

    // A select's history may name an option by its id: read it as the option's text.
    const options = fact.options || [];
    let unreadable = false;
    const readable = (v) => {
      if (v == null || v === '') return [];
      const text = String(v);
      const o = options.find((x) => x.valueId === text);
      if (o) return [o.value, o.number].filter((x) => x != null && String(x).trim()).map(String);
      if (/^[0-9a-f]{24}$/.test(text)) unreadable = true; // an id that cannot be shown or compared
      return [text];
    };

    const list = Array.isArray(changes) ? changes : null;
    // 1. The page shows a value the PIM held before.
    if (list) {
      const was = list.find((c) => readable(c.oldValue).some(same));
      if (was) {
        return {
          kind: 'earlier', until: was.date,
          title: `The page shows what the PIM held until ${day(was.date)}.`,
          text: `The PIM was changed after that, to ${pimNow}, so the shop has probably not picked the change up yet. Check that the product is published and synced before changing anything in the PIM.`,
        };
      }
    }
    // 2. The page shows the PIM's value rounded or converted.
    if (now.some((t) => M.roundedFrom(pageValue, t, fact.unit))) {
      return {
        kind: 'rounded',
        title: 'The page’s value looks like the PIM’s value rounded or converted.',
        text: `${shown(pageValue)} is ${pimNow} rounded. That usually happens on the way out, in the integration or in the shop, so the PIM may well be right. Check there before changing the PIM.`,
      };
    }
    // 3. The page's value has not been in the PIM as far back as the history goes.
    if (list) {
      list.forEach((c) => readable(c.value));
      const since = list[0] ? list[0].date : null;
      const whole = list.length < HISTORY_LIMIT && !unreadable; // every change on record was read
      const held = since ? `The PIM has held ${pimNow} since ${day(since)}` : `The PIM has held ${pimNow} for the six months its history covers`;
      return {
        kind: 'elsewhere', since,
        title: whole ? 'The page’s value has not been in the PIM.' : 'The page’s value is not one the PIM held recently.',
        text: `${held}, and ${shown(pageValue)} was not its value ${whole ? (since ? 'before that either, as far as the history goes (six months)' : 'in that time') : `in its last ${list.length} changes`}. So the difference probably arises after the PIM: in the integration, or by an edit in the shop. Check those before changing the PIM.`,
      };
    }
    return null;
  }

  /**
   * Where a fact can be fixed from here: on its owner, on the page's own product
   * (holder), or not at all (with the reason).
   */
  function canFix(fact) {
    if (!fact.editableType) {
      const what = fact.kind === 'attribute' ? `This kind of value (${String(fact.dataType || '').replace('_', ' ')})` : 'This value';
      return { owner: false, holder: false, reason: `${what} can't be edited here yet. Open it in the PIM.` };
    }
    if (fact.kind === 'name') {
      return fact.readOnly ? { owner: false, holder: false, reason: 'This product is read-only for you.' } : { owner: true, holder: false, reason: '' };
    }
    const w = fact.where;
    const owner = !w.ownerReadOnly;
    const holder = w.inherited && !w.locked && !w.holderReadOnly;
    return { owner, holder, reason: owner || holder ? '' : 'This value is read-only for you.' };
  }

  /** Check a proposed value before anything is sent. Returns { ok, values, display, error }. */
  function validateFix(fact, input, target) {
    const text = String(input == null ? '' : input).trim();
    if (text.length > 10000) return { ok: false, error: 'That value is too long to save from here.' };
    const can = canFix(fact);
    if (!(target === 'holder' ? can.holder : can.owner)) {
      return { ok: false, error: can.reason || (target === 'holder' ? 'This value is locked by the parent product. Fix it there.' : 'This value is read-only for you.') };
    }
    if (fact.kind === 'name') {
      if (!text) return { ok: false, error: 'A name cannot be empty.' };
      return { ok: true, values: [text], display: text };
    }
    if (fact.dataType === 'single_select') {
      const option = (fact.options || []).find((o) => o.valueId === text);
      if (!option) return { ok: false, error: 'Choose one of the listed options.' };
      return { ok: true, values: [option.valueId], display: option.value, select: true };
    }
    if (!text) return { ok: false, error: 'Type the corrected value.' };
    if (fact.dataType === 'integer' || fact.dataType === 'decimal') {
      const q = M.parseQuantity(text);
      // "gr" and "g" are the same unit, on the attribute as well as in what was typed.
      if (!q || (q.unit && fact.unit && q.unit !== M.unitOf(fact.unit))) {
        return { ok: false, error: fact.unit ? `Type a number in ${fact.unit}.` : 'Type a number.' };
      }
      // "1.200" and "1,200" can each mean 1200 or 1.2: never guess with a value that is about to be saved.
      if (/^[-+]?\d{1,3}[.,]\d{3}(\s*[^\d\s.,]*)$/.test(text)) {
        return { ok: false, error: `“${text}” can be read as ${text.replace(/[.,]/, '').replace(/\s*[^\d]*$/, '')} or as ${text.replace(',', '.').replace(/\s*[^\d.]*$/, '').replace(/0+$/, '').replace(/\.$/, '')}. Type it without a thousands separator, with a point for decimals.` };
      }
      if (fact.dataType === 'integer' && !Number.isInteger(q.n)) return { ok: false, error: 'Type a whole number.' };
      const value = String(q.n);
      return { ok: true, values: [value], display: value + (fact.unit ? ' ' + fact.unit : '') };
    }
    return { ok: true, values: [text], display: text };
  }

  /**
   * Write the fix. target: 'owner' (where the value is owned) or 'holder' (only the
   * page's product). forceVla: also overwrite children that hold their own value.
   */
  async function applyFix(pim, chain, fact, { input, target, forceVla, context }) {
    const v = validateFix(fact, input, target);
    if (!v.ok) throw new Error(v.error);
    if (fact.kind === 'name') {
      await pim.updateName(chain[0].id, v.values[0], context);
      return { productId: chain[0].id, display: v.display };
    }
    const index = target === 'holder' ? fact.where.holderIndex : fact.where.ownerIndex;
    const product = chain[index];
    await pim.updateAttribute(product.id, fact.definitionId, v.values, { context, forceVla: !!forceVla, select: !!v.select });
    return { productId: product.id, display: v.display };
  }

  const api = { pickContext, detectIdAttributes, nameSimilarity, findProduct, load, traceSelection, pageReport, details, origin, canFix, validateFix, applyFix };
  root.BSI = Object.assign(root.BSI || {}, { inspect: api });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
