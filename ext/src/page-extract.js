/*
 * Runs inside the web page (only after the user clicks the extension or its
 * right-click menu item). Reads what identifies the product and what the user
 * selected. It changes nothing on the page and sends nothing anywhere: the
 * result goes back to the extension's side panel.
 *
 * Must stay self-contained: Chrome serialises this one function into the page.
 */
function bsiExtractPage(keep) {
  // keep: also remember the page elements (for the on-page view; they cannot be sent anywhere).
  const clean = (s) => String(s == null ? '' : s).replace(/[\s ]+/g, ' ').trim();
  const short = (s, n) => (s.length > n ? s.slice(0, n) : s);
  const ids = [];
  const addId = (kind, value, source) => {
    const v = clean(value);
    if (v && v.length <= 80 && ids.length < 16 && !ids.some((x) => x.value === v)) ids.push({ kind, value: v, source });
  };
  let name = '';
  let brand = '';

  // 1. Structured product data (schema.org JSON-LD), which most shops publish for search engines.
  const nodes = [];
  const collect = (node, depth) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) return node.forEach((n) => collect(n, depth + 1));
    if (typeof node !== 'object') return;
    nodes.push(node);
    for (const key of ['@graph', 'mainEntity', 'hasVariant', 'offers', 'itemListElement', 'item']) collect(node[key], depth + 1);
  };
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      collect(JSON.parse(script.textContent), 0);
    } catch (e) {
      /* not valid JSON: skip */
    }
  }
  const isType = (node, re) => [].concat(node['@type'] || []).some((t) => re.test(String(t)));
  const products = nodes.filter((n) => isType(n, /^(Product|ProductModel|IndividualProduct)$/));
  const groups = nodes.filter((n) => isType(n, /^ProductGroup$/));
  const offers = nodes.filter((n) => isType(n, /^Offer$/));
  for (const p of products.concat(groups)) {
    if (!name && p.name) name = clean(p.name);
    if (!brand && p.brand) brand = clean(typeof p.brand === 'string' ? p.brand : p.brand.name);
    addId('sku', p.sku, 'structured data');
    addId('mpn', p.mpn, 'structured data');
    for (const k of ['gtin', 'gtin13', 'gtin14', 'gtin12', 'gtin8']) addId('gtin', p[k], 'structured data');
    if (typeof p.productID === 'string') addId('productID', p.productID.replace(/^[a-z]+:/i, ''), 'structured data');
    if (p.productGroupID) addId('productGroupID', p.productGroupID, 'structured data');
  }
  for (const o of offers) {
    addId('sku', o.sku, 'structured data (offer)');
    addId('mpn', o.mpn, 'structured data (offer)');
  }

  // 2. Microdata and meta tags.
  for (const [prop, kind] of [['sku', 'sku'], ['mpn', 'mpn'], ['gtin', 'gtin'], ['gtin13', 'gtin'], ['gtin14', 'gtin'], ['gtin12', 'gtin'], ['gtin8', 'gtin'], ['productID', 'productID']]) {
    for (const el of document.querySelectorAll(`[itemprop="${prop}"]`)) addId(kind, el.getAttribute('content') || el.textContent, 'microdata');
  }
  for (const [sel, kind] of [
    ['meta[property="product:retailer_item_id"]', 'sku'],
    ['meta[property="og:sku"]', 'sku'],
    ['meta[name="sku"]', 'sku'],
    ['meta[property="product:mfr_part_no"]', 'mpn'],
    ['meta[property="product:ean"]', 'gtin'],
  ]) {
    const el = document.querySelector(sel);
    if (el) addId(kind, el.getAttribute('content'), 'meta tag');
  }

  // 3. Common data attributes, as a last resort.
  for (const attr of ['data-sku', 'data-product-sku', 'data-product-number', 'data-article-number', 'data-product-id']) {
    const el = document.querySelector(`[${attr}]`);
    if (el) addId(attr === 'data-product-id' ? 'productID' : 'sku', el.getAttribute(attr), 'page markup');
  }
  // 3b. Identifiers shops keep for their own scripts: analytics data and add-to-cart forms.
  //     These are often the shop's own ids, which a PIM attribute may hold.
  const idKey = /["']?(sku|item_id|product_id|productId|productSku|variant_id|variantId|ean|gtin(?:8|12|13|14)?|mpn|upc|article_number|articleNumber)["']?\s*[:=]\s*["']?([A-Za-z0-9][A-Za-z0-9._\-/]{2,40})["']?/g;
  let scanned = 0;
  for (const script of document.querySelectorAll('script:not([src]):not([type="application/ld+json"])')) {
    const text = script.textContent || '';
    if (!text || text.length > 400000 || scanned++ > 40) continue;
    let m;
    let found = 0;
    idKey.lastIndex = 0;
    while ((m = idKey.exec(text)) && found++ < 6) {
      const key = m[1].toLowerCase();
      const kind = /ean|gtin|upc/.test(key) ? 'gtin' : key === 'mpn' ? 'mpn' : /sku|article/.test(key) ? 'sku' : 'shop id';
      if (/\d/.test(m[2])) addId(kind, m[2], 'page scripts');
    }
  }
  for (const input of document.querySelectorAll('form input[type="hidden"]')) {
    const n = (input.getAttribute('name') || '').toLowerCase();
    if (/^(id|sku|product[_-]?id|variant[_-]?id|item[_-]?id|product|variant)$/.test(n) && /\d/.test(input.value || '')) {
      addId(n.includes('sku') ? 'sku' : 'shop id', input.value, 'add-to-cart form');
    }
  }
  for (const attr of ['data-variant-id', 'data-item-id', 'data-product-code', 'data-ean', 'data-gtin']) {
    const el = document.querySelector(`[${attr}]`);
    if (el) addId(/ean|gtin/.test(attr) ? 'gtin' : 'shop id', el.getAttribute(attr), 'page markup');
  }
  try {
    const params = new URLSearchParams(location.search);
    for (const key of ['sku', 'variant', 'variantId', 'pid', 'productId', 'product_id', 'id', 'ean']) {
      const v = params.get(key);
      if (v && /\d/.test(v)) addId(key === 'sku' ? 'sku' : key === 'ean' ? 'gtin' : 'shop id', v, 'page address');
    }
  } catch (e) {
    /* odd address: skip */
  }

  if (!brand) {
    const b = document.querySelector('[itemprop="brand"] [itemprop="name"], [itemprop="brand"], meta[property="product:brand"]');
    if (b) brand = clean(b.getAttribute('content') || b.textContent);
  }
  if (!name) {
    const og = document.querySelector('meta[property="og:title"]');
    const h1 = document.querySelector('h1');
    name = clean((h1 && h1.textContent) || (og && og.getAttribute('content')) || document.title);
  }

  // 4. Label/value pairs: spec tables, definition lists and "Label: value" lines.
  const pairs = [];
  const addPair = (label, value, el) => {
    const l = clean(label).replace(/:$/, '');
    const v = clean(value);
    if (!l || !v || l.length > 60 || v.length > 200 || l === v) return;
    const same = pairs.find((p) => p.label === l && p.value === v);
    // Shown twice on the page (in the summary and in the specification): one fact, two places.
    if (same && keep && el && !same.els.some((x) => x === el || x.contains(el) || el.contains(x))) same.els.push(el);
    if (!same && pairs.length < 80) pairs.push(keep ? { label: l, value: v, els: el ? [el] : [] } : { label: l, value: v });
  };
  for (const row of document.querySelectorAll('tr')) {
    const cells = row.querySelectorAll(':scope > th, :scope > td');
    if (cells.length === 2) addPair(cells[0].textContent, cells[1].textContent, cells[1]);
  }
  for (const dt of document.querySelectorAll('dt')) {
    const dd = dt.nextElementSibling;
    if (dd && dd.tagName === 'DD') addPair(dt.textContent, dd.textContent, dd);
  }
  for (const el of document.querySelectorAll('li, p')) {
    if (el.children.length > 2) continue;
    const m = /^([^:]{2,50}):\s+(.{1,160})$/.exec(clean(el.textContent));
    if (m) addPair(m[1], m[2], el);
  }

  // 4a. The heading and the longer texts (descriptions), for the on-page view.
  const h1 = document.querySelector('h1');
  const heading = h1 ? short(clean(h1.textContent), 200) : '';
  const blocks = [];
  if (keep) {
    const inline = /^(BR|B|I|EM|STRONG|A|SPAN|U|SMALL|SUP|SUB|MARK)$/;
    // The product part of the page when it is marked up as such; never menus, forms or cookie notices.
    const scope = document.querySelector('main, [role="main"], article') || document.body;
    const notContent = 'nav, header, footer, form, dialog, [role="dialog"], [aria-modal="true"], [aria-hidden="true"], [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i]';
    for (const el of scope.querySelectorAll('p, [itemprop="description"], div, section, span')) {
      if (blocks.length >= 16) break;
      if (el.closest(notContent) || !el.getClientRects().length) continue;
      if ([...el.children].some((c) => !inline.test(c.tagName))) continue;
      const text = clean(el.textContent);
      if (text.length < 80 || text.length > 4000) continue;
      if (blocks.some((b) => b.el.contains(el) || el.contains(b.el))) continue;
      blocks.push({ text: short(text, 1500), el });
    }
  }

  // 4c. The product's own pictures, for the on-page view: the ones the page declares as
  //     the product's image, or whose description is the product's name. Pictures that
  //     link to another page are other products (recommendations) and are left out.
  const images = [];
  if (keep) {
    const baseName = (u) => {
      try {
        return new URL(u, location.href).pathname.split('/').pop().replace(/\.[a-z0-9]+$/i, '').replace(/[-_](large|medium|small|thumb|zoom|\d+x\d+|\d+w)$/i, '');
      } catch (e) {
        return '';
      }
    };
    const declared = new Set();
    for (const p of products.concat(groups)) {
      for (const im of [].concat(p.image || [])) {
        const u = typeof im === 'string' ? im : im && (im.contentUrl || im.url);
        if (u) declared.add(baseName(u));
      }
    }
    const og = document.querySelector('meta[property="og:image"]');
    if (og) declared.add(baseName(og.getAttribute('content')));
    declared.delete('');
    const productName = clean(name).toLowerCase();
    for (const el of document.querySelectorAll('img')) {
      if (images.length >= 8) break;
      const src = el.currentSrc || el.src;
      if (!src || !/^(https?:|data:image\/(png|jpe?g|webp|avif))/i.test(src) || /\.svg(\?|$)/i.test(src)) continue;
      const box = el.getBoundingClientRect();
      if (box.width < 90 || box.height < 90) continue; // showing, and more than an icon
      if (el.closest('nav, header, footer, [aria-hidden="true"]')) continue;
      const link = el.closest('a[href]');
      if (link) {
        try {
          const to = new URL(link.href, location.href);
          if (to.pathname !== location.pathname && !/\.(jpe?g|png|webp|avif)$/i.test(to.pathname)) continue;
        } catch (e) {
          /* an odd link: keep the picture */
        }
      }
      const alt = clean(el.alt).toLowerCase();
      const named = productName.length >= 3 && alt.length >= 3 && (alt.includes(productName) || productName.includes(alt));
      if (!declared.has(baseName(src)) && !named) continue;
      if (images.some((x) => x.src === src)) continue;
      images.push({ src, alt: short(clean(el.alt), 120), w: el.naturalWidth || 0, h: el.naturalHeight || 0, el });
    }
  }

  // 4b. Identifiers shown as text: "SKU: 123", "Item no. 123", "EAN 731…".
  const idLabel = /(^|\s)(sku|item\s*(no|nr|number|#)\.?|art(icle|ikel)?\.?\s*(no|nr|number|#)?\.?|product\s*(no|nr|number|code|id)\.?|model(\s*(no|number))?\.?|mpn|ean(-?13)?|gtin(-?\d+)?|upc|isbn|part\s*(no|number)\.?|ref(erence)?\.?)$/i;
  const idKind = (label) => (/ean|gtin|upc|isbn/i.test(label) ? 'gtin' : /mpn|model|part/i.test(label) ? 'mpn' : 'sku');
  // An identifier has a digit, or looks like a code: SCD-BLU-M.
  const looksLikeId = (v) => /\d/.test(v) || /^[A-Z0-9]+([-_./][A-Z0-9]+)+$/.test(v);
  for (const pair of pairs) {
    if (idLabel.test(pair.label) && looksLikeId(pair.value) && pair.value.length <= 40) addId(idKind(pair.label), pair.value, 'shown on the page');
  }
  const idLine = /^(SKU|Item\s*(?:no|nr|number|#)|Art(?:icle|ikel)?\.?\s*(?:no|nr|number|#)|Product\s*(?:no|nr|number|code|id)|Model(?:\s*(?:no|number))?|MPN|EAN(?:-?13)?|GTIN(?:-?\d+)?|UPC|ISBN|Part\s*(?:no|number)|Ref)[\s.:#]*([A-Za-z0-9][A-Za-z0-9._\-/]{2,40})$/i;
  let looked = 0;
  for (const el of document.querySelectorAll('span, div, p, li, small, td')) {
    if (el.children.length || looked++ > 3000) continue;
    const text = clean(el.textContent);
    if (text.length < 5 || text.length > 70) continue;
    const m = idLine.exec(text);
    if (m && looksLikeId(m[2])) addId(idKind(m[1]), m[2], 'shown on the page');
  }

  // 5. What the user selected, and the label that goes with it.
  let selection = null;
  const sel = window.getSelection && window.getSelection();
  const text = sel ? clean(sel.toString()) : '';
  if (text) {
    let label = '';
    let el = sel.rangeCount ? sel.getRangeAt(0).commonAncestorContainer : null;
    if (el && el.nodeType !== 1) el = el.parentElement;
    const cell = el && el.closest('td, th, dd');
    if (cell && cell.tagName === 'DD') {
      const dt = cell.previousElementSibling;
      if (dt && dt.tagName === 'DT') label = clean(dt.textContent);
    } else if (cell) {
      const first = cell.parentElement && cell.parentElement.querySelector(':scope > th, :scope > td');
      if (first && first !== cell) label = clean(first.textContent);
    }
    const block = el && (el.closest('li, p, dd, td, div, span') || el);
    const blockText = block ? clean(block.textContent) : '';
    if (!label && blockText) {
      const at = blockText.indexOf(text);
      const before = at > 0 ? blockText.slice(0, at) : '';
      const m = /([^:.;|]{2,50}):\s*$/.exec(before);
      if (m) label = clean(m[1]);
    }
    if (!label) {
      const hit = pairs.find((p) => p.value === text);
      if (hit) label = hit.label;
    }
    selection = { text: short(text, 300), label: short(label.replace(/:$/, ''), 60), context: short(blockText, 240) };
  }

  return {
    url: location.href,
    host: location.host,
    title: clean(document.title),
    lang: document.documentElement.getAttribute('lang') || '',
    name: short(name, 160),
    heading,
    headingEl: keep ? h1 : undefined,
    brand: short(brand, 80),
    ids,
    pairs,
    blocks: keep ? blocks : undefined,
    images: keep ? images : undefined,
    selection,
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { bsiExtractPage };
