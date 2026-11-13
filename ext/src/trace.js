/*
 * Tracing: from a product on a page to where each of its facts lives in the PIM.
 *
 * The product structure is Family -> Group -> Variant. A value can be set on a
 * parent and inherited by its children (the attribute's `copy` flag on the parent).
 * "Owner" below means the highest product in that chain the value is inherited from:
 * the place to fix it once.
 */
(function (root) {
  'use strict';

  const LEVEL = { FAMILY: 'Family', GROUP: 'Group', VARIANT: 'Variant', SINGLE: 'Single', BUNDLE: 'Bundle' };
  const EDITABLE = new Set(['text', 'integer', 'decimal', 'single_select']);

  /** The page's product plus its parents: chain[0] = product, then group, then family. */
  async function loadChain(pim, productId, context) {
    const chain = [];
    let id = productId;
    for (let depth = 0; id && depth < 3; depth++) {
      const p = await pim.product(id, context);
      if (!p) break;
      chain.push(p);
      id = p.variantParentId || p.groupParentId || null;
    }
    return chain;
  }

  function attrOf(product, definitionId) {
    return (product.attributes || []).find((a) => a.definitionId === definitionId) || null;
  }

  function rawValues(attr) {
    if (!attr) return [];
    return (attr.values && attr.values.length ? attr.values : attr.dictionary) || [];
  }

  function sameValues(a, b) {
    const x = rawValues(a).slice().sort();
    const y = rawValues(b).slice().sort();
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }

  /**
   * Where a definition's value is read from (holder) and where it is owned.
   * holder: the nearest product in the chain that carries the attribute.
   * owner:  climb from the holder while the parent passes the attribute down.
   */
  function locate(chain, definitionId) {
    const holderIndex = chain.findIndex((p) => attrOf(p, definitionId));
    if (holderIndex < 0) return null;
    let ownerIndex = holderIndex;
    while (ownerIndex + 1 < chain.length) {
      const parentAttr = attrOf(chain[ownerIndex + 1], definitionId);
      // A "defining" attribute is passed down as a field, but each child sets its
      // own value (colour per group, size per variant): the child owns the value.
      if (parentAttr && parentAttr.copy && !parentAttr.definingAttributes) ownerIndex++;
      else break;
    }
    const holderAttr = attrOf(chain[holderIndex], definitionId);
    const ownerAttr = attrOf(chain[ownerIndex], definitionId);
    const inherited = ownerIndex > holderIndex;
    return {
      holderIndex,
      ownerIndex,
      inherited,
      // The child holds its own value although the parent passes one down.
      overridden: inherited && !sameValues(holderAttr, ownerAttr),
      locked: !!ownerAttr.locked,
      mandatory: !!ownerAttr.mandatory,
      defining: !!ownerAttr.definingAttributes,
      passesDown: !!ownerAttr.copy,
      holderReadOnly: !!(holderAttr.readOnly || chain[holderIndex].readOnly),
      ownerReadOnly: !!(ownerAttr.readOnly || chain[ownerIndex].readOnly),
    };
  }

  /** Every definition id that appears anywhere in the chain. */
  function definitionIds(chain) {
    const ids = new Set();
    for (const p of chain) for (const a of p.attributes || []) ids.add(a.definitionId);
    return [...ids];
  }

  /**
   * Some organisations keep people as small records in a text attribute:
   * {"name": "Lea Ypi", "id": "750587"}. A page shows the names, so the names are the texts.
   */
  function namesIn(value) {
    const s = String(value == null ? '' : value).trim();
    if (!/^[\[{]/.test(s) || !/"name"\s*:/.test(s)) return null;
    const names = [];
    const re = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(s))) {
      const name = m[1].replace(/\\(.)/g, '$1').trim();
      if (name && !names.includes(name)) names.push(name);
    }
    return names.length ? names : null;
  }

  function textsFor(attr, def, dictLabels) {
    if (!attr || !def) return [];
    const type = def.dataType;
    if (type === 'single_select' || type === 'multi_select') {
      const options = (def.restrictions && def.restrictions.enum && def.restrictions.enum.values) || [];
      return (attr.values || []).map((id) => {
        const o = options.find((x) => x.valueId === id);
        return o ? o.value : id;
      });
    }
    if (type === 'dictionary') {
      return (attr.dictionary || []).map((id) => (dictLabels && dictLabels[def.id + ':' + id]) || id);
    }
    if (attr.matrix || attr.column) return [];
    const out = [];
    for (const v of attr.values || []) {
      const names = namesIn(v);
      if (names) out.push(...names);
      else out.push(v);
    }
    return out;
  }

  /**
   * All facts of the page's product that could show on a page: name, number,
   * description and every attribute on it or on its parents.
   */
  function buildFacts(chain, definitions, dictLabels) {
    const product = chain[0];
    const defs = new Map(definitions.map((d) => [d.id, d]));
    const facts = [
      { key: 'name', kind: 'name', label: 'Name', aliases: ['Product name', 'Title', 'Product'], display: product.name || '', texts: [product.name || ''], editableType: true, readOnly: !!product.readOnly },
      {
        key: 'number', kind: 'number', label: 'Number',
        aliases: ['SKU', 'Item number', 'Article number', 'Art. no.', 'Product number', 'Item no.', 'MPN', 'Model'],
        display: product.number || '', texts: [product.number || ''], editableType: false,
      },
    ];
    if (product.description) {
      facts.push({ key: 'description', kind: 'description', label: 'Description', aliases: [], display: product.description, texts: [product.description], editableType: false });
    }
    for (const definitionId of definitionIds(chain)) {
      const def = defs.get(definitionId);
      if (!def) continue;
      const where = locate(chain, definitionId);
      const holderAttr = attrOf(chain[where.holderIndex], definitionId);
      const texts = textsFor(holderAttr, def, dictLabels).filter((t) => t != null && String(t) !== '');
      const unit = def.unit || '';
      facts.push({
        key: 'attr:' + definitionId,
        kind: 'attribute',
        definitionId,
        label: def.name || definitionId,
        aliases: [],
        dataType: def.dataType,
        unit,
        contextAware: !!def.contextAware,
        texts,
        display: texts.length ? texts.join(', ') + (unit && texts.length === 1 ? ' ' + unit : '') : '',
        raw: rawValues(holderAttr),
        options: def.dataType === 'single_select' ? ((def.restrictions && def.restrictions.enum && def.restrictions.enum.values) || []) : null,
        where,
        ownerTexts: textsFor(attrOf(chain[where.ownerIndex], definitionId), def, dictLabels),
        // People kept as records are shown by name; the record itself is edited in the PIM.
        editableType: EDITABLE.has(def.dataType) && !rawValues(holderAttr).some((v) => namesIn(v)),
      });
    }
    return facts;
  }

  /** Dictionary values need a lookup per value; collect what the chain uses. */
  function dictionaryRefs(chain, definitions) {
    const dict = new Set(definitions.filter((d) => d.dataType === 'dictionary').map((d) => d.id));
    const refs = [];
    const seen = new Set();
    for (const p of chain) {
      for (const a of p.attributes || []) {
        if (!dict.has(a.definitionId)) continue;
        for (const id of a.dictionary || []) {
          const key = a.definitionId + ':' + id;
          if (!seen.has(key)) {
            seen.add(key);
            refs.push({ definitionId: a.definitionId, valueId: id, key });
          }
        }
      }
    }
    return refs;
  }

  /**
   * Which product a fix should go to, and what else it touches.
   * target 'owner' (default): fix it where it is owned. 'holder': only this product.
   */
  async function impact(pim, chain, fact, target, context) {
    if (fact.kind !== 'attribute') {
      return { product: chain[0], level: LEVEL[chain[0].type] || chain[0].type, groups: 0, variants: 0, propagates: false };
    }
    const index = target === 'holder' ? fact.where.holderIndex : fact.where.ownerIndex;
    const product = chain[index];
    const attr = attrOf(product, fact.definitionId);
    const propagates = !!(attr && attr.copy && !attr.definingAttributes);
    let groups = 0;
    let variants = 0;
    if (propagates) {
      if (product.type === 'GROUP') {
        variants = (product.productVariants || []).length;
      } else if (product.type === 'FAMILY') {
        const groupIds = product.productGroups || [];
        groups = groupIds.length;
        // Variants inherit from their group; count them when the groups pass it on too.
        if (groupIds.length) {
          const summaries = await pim.summaries(groupIds, context);
          variants = summaries.reduce((n, g) => n + (g.productVariants || []).length, 0);
        }
      }
    }
    return { product, level: LEVEL[product.type] || product.type, groups, variants, propagates };
  }

  /** "Family › Group › Variant" for the header, top level first. */
  function breadcrumb(chain) {
    return chain
      .slice()
      .reverse()
      .map((p) => ({ id: p.id, name: p.name || p.number, number: p.number, level: LEVEL[p.type] || p.type, type: p.type }));
  }

  const api = { LEVEL, loadChain, locate, definitionIds, namesIn, buildFacts, dictionaryRefs, impact, breadcrumb, attrOf };
  root.BSI = Object.assign(root.BSI || {}, { trace: api });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
