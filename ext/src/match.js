/*
 * Matching a fact seen on a web page ("Weight: 1.2 kg") against facts stored in
 * the PIM. Pure functions, no DOM and no network.
 *
 * A PIM fact: { key, kind: 'name'|'number'|'description'|'attribute', label,
 *               display, texts: [..], unit, dataType, definitionId }
 *   texts = every string form the value can take on a page (the raw value, the
 *   select label, each multi-select label, ...).
 */
(function (root) {
  'use strict';

  // Unit -> [dimension, factor to the base unit]
  const UNITS = {
    mm: ['length', 0.001], cm: ['length', 0.01], dm: ['length', 0.1], m: ['length', 1], km: ['length', 1000],
    in: ['length', 0.0254], inch: ['length', 0.0254], '"': ['length', 0.0254], ft: ['length', 0.3048],
    mg: ['mass', 0.000001], g: ['mass', 0.001], gr: ['mass', 0.001], gram: ['mass', 0.001], grams: ['mass', 0.001], kg: ['mass', 1], t: ['mass', 1000], lb: ['mass', 0.45359237], lbs: ['mass', 0.45359237],
    ml: ['volume', 0.001], cl: ['volume', 0.01], dl: ['volume', 0.1], l: ['volume', 1],
    w: ['power', 1], kw: ['power', 1000],
    v: ['voltage', 1], kv: ['voltage', 1000],
    bar: ['pressure', 1], mbar: ['pressure', 0.001],
  };

  // Other spellings of the same unit.
  const UNIT_ALIAS = { gr: 'g', gram: 'g', grams: 'g', gramm: 'g', kilo: 'kg', millimeter: 'mm', meter: 'm', liter: 'l' };

  const TRUE_WORDS = new Set(['true', 'yes', 'ja', 'oui', 'si', 'sí', 'y', '1', '✓', '✔']);
  const FALSE_WORDS = new Set(['false', 'no', 'nei', 'nein', 'nej', 'non', 'n', '0', '✗', '✘']);

  function norm(s) {
    return String(s == null ? '' : s)
      .slice(0, 5000) // long texts are compared elsewhere; this keeps the trimming below quick
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s  ]+/g, ' ')
      .replace(/^[\s:;,.\-–—]+|[\s:;,.\-–—]+$/g, '')
      .trim();
  }

  /** "Anslutning [mm]" -> { name: "anslutning", unit: "mm" }. Some orgs keep the unit in the name. */
  function splitLabel(label) {
    const m = /^(.*?)\s*[\[(]\s*([^\])]{1,12})\s*[\])]\s*$/.exec(String(label || ''));
    if (m && m[1].trim()) return { name: norm(m[1]), unit: norm(m[2]) };
    return { name: norm(label), unit: '' };
  }

  /**
   * Parse "1.2 kg", "1,2kg", "1 200 g", "10.0" -> { n, unit }. Returns null when the
   * text is not essentially one number with an optional unit.
   */
  function parseQuantity(text) {
    const s = String(text == null ? '' : text).slice(0, 80).normalize('NFKC').trim();
    const m = /^([-+]?\d[\d\s  .,']*)\s*([a-zA-Zµ°%"]{0,6})\.?$/.exec(s);
    if (!m) return null;
    let num = m[1].replace(/[\s  ']/g, '');
    const lastComma = num.lastIndexOf(',');
    const lastDot = num.lastIndexOf('.');
    if (lastComma >= 0 && lastDot >= 0) {
      // The later one is the decimal mark: "1.234,5" or "1,234.5"
      if (lastComma > lastDot) num = num.replace(/\./g, '').replace(',', '.');
      else num = num.replace(/,/g, '');
    } else if (lastComma >= 0) {
      // "1,2" is a decimal; "1,234" is ambiguous, read as thousands only with 3 digits after
      const after = num.length - lastComma - 1;
      num = after === 3 && num.indexOf(',') === lastComma && /^\d{1,3},\d{3}$/.test(num) ? num.replace(',', '') : num.replace(',', '.');
    }
    const n = Number(num);
    if (!isFinite(n)) return null;
    const unit = m[2].toLowerCase();
    return { n, unit: UNIT_ALIAS[unit] || unit };
  }

  /** "16.01.2023", "16/01/2023", "2023-01-16", "2023-01-16T00:00:00Z" -> "2023-01-16". Day comes first in dotted and slashed dates. */
  function parseDate(text) {
    const s = String(text == null ? '' : text).trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s);
    if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return null;
  }

  // The same thing under different names and in different languages. A page label
  // and a PIM attribute name from the same row count as the same label.
  const CONCEPTS = [
    ['weight', 'unit weight', 'net weight', 'gross weight', 'vekt', 'vikt', 'vægt', 'gewicht', 'poids'],
    ['height', 'høyde', 'höjd', 'højde', 'höhe', 'hauteur'],
    ['width', 'bredde', 'bredd', 'breite', 'largeur'],
    ['length', 'lengde', 'längd', 'længde', 'länge', 'longueur'],
    ['depth', 'dybde', 'djup', 'tiefe', 'profondeur'],
    ['publisher', 'imprint', 'imprint name', 'forlag', 'förlag', 'verlag'],
    ['language', 'language of text', 'språk', 'sprog', 'sprache', 'langue'],
    ['original language', 'originalspråk', 'originalsprache'],
    ['original title', 'originaltittel', 'originaltitel'],
    ['author', 'byauthor', 'authors', 'forfatter', 'författare', 'autor'],
    ['translator', 'translatedby', 'translated by', 'oversatt av', 'oversetter', 'översättare', 'übersetzer'],
    ['illustrator', 'illustratedby', 'illustrated by', 'illustrert av', 'illustratør'],
    ['narrator', 'readby', 'read by', 'innleser', 'oppleser'],
    ['series', 'series title', 'serie', 'reihe'],
    ['pages', 'number of pages', 'page count', 'sidetall', 'antall sider', 'sidor', 'seiten'],
    ['published', 'publication date', 'first publication date', 'utgitt', 'utgivelsesdato', 'første utgivelsesdato', 'erscheinungsdatum'],
    ['publish year', 'publication year', 'year', 'utgivelsesår', 'utgivningsår', 'erscheinungsjahr'],
    ['format', 'product form', 'binding', 'innbinding', 'einband'],
    ['brand', 'merke', 'märke', 'mærke', 'marke', 'marque'],
    ['colour', 'color', 'farge', 'färg', 'farve', 'farbe', 'couleur'],
    ['size', 'størrelse', 'storlek', 'größe', 'taille'],
    ['material', 'materiale', 'materiell', 'matière'],
    ['age group', 'age', 'aldersgruppe', 'alder', 'altersgruppe'],
    ['subject', 'subjects', 'emne', 'emner', 'ämne', 'thema'],
    ['country of origin', 'opprinnelsesland', 'ursprungsland', 'herkunftsland'],
  ];
  const CONCEPT_OF = new Map();
  CONCEPTS.forEach((row, i) => row.forEach((name) => CONCEPT_OF.set(name, i)));
  /** "Series Title 1" and "Serie" are the same concept: a trailing number is ignored. */
  function conceptOf(name) {
    const n = String(name || '').replace(/\s*\d+$/, '').trim();
    return CONCEPT_OF.has(n) ? CONCEPT_OF.get(n) : -1;
  }

  function sameNumber(a, b) {
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  }

  /**
   * How well a page value matches one PIM text, 0..1, with a reason.
   * factUnit: the unit the PIM value is in (from the definition or the label).
   */
  function valueScore(pageValue, pimText, factUnit) {
    const a = norm(pageValue);
    const b = norm(pimText);
    if (!a || !b) return { score: 0, why: '' };
    if (a === b) return { score: 1, why: 'same text' };

    const da0 = parseDate(pageValue);
    const db0 = parseDate(pimText);
    if (da0 && db0) return da0 === db0 ? { score: 0.95, why: 'same date' } : { score: 0, why: '' };

    const qa = parseQuantity(pageValue);
    const qb = parseQuantity(pimText);
    if (qa && qb) {
      const ua = qa.unit;
      const fu = norm(factUnit || '');
      const ub = qb.unit || UNIT_ALIAS[fu] || fu;
      if (sameNumber(qa.n, qb.n) && (!ua || !ub || ua === ub)) {
        return { score: ua && ub ? 0.97 : 0.9, why: 'same number' };
      }
      const da = UNITS[ua];
      const db = UNITS[ub];
      if (da && db && da[0] === db[0] && sameNumber(qa.n * da[1], qb.n * db[1])) {
        return { score: 0.88, why: `same amount (${ua} vs ${ub})` };
      }
      return { score: 0, why: '' };
    }

    if ((TRUE_WORDS.has(a) && TRUE_WORDS.has(b)) || (FALSE_WORDS.has(a) && FALSE_WORDS.has(b))) {
      return { score: 0.85, why: 'same yes/no value' };
    }

    // One contains the other: "Nickel" on the page, "Nickel plated" in the PIM.
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    if (short.length >= 4 && long.includes(short)) {
      const ratio = short.length / long.length;
      return { score: 0.45 + 0.4 * ratio, why: 'one contains the other' };
    }
    return { score: 0, why: '' };
  }

  function tokens(s) {
    return norm(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  }

  /** How well a page label ("Weight") matches a PIM label ("Net weight [kg]"), 0..1. */
  function labelScore(pageLabel, pimLabel) {
    const a = splitLabel(pageLabel).name;
    const b = splitLabel(pimLabel).name;
    if (!a || !b) return 0;
    if (a === b) return 1;
    const ca = conceptOf(a);
    if (ca >= 0 && ca === conceptOf(b)) return 0.9;
    const ta = new Set(tokens(a));
    const tb = new Set(tokens(b));
    if (!ta.size || !tb.size) return 0;
    let common = 0;
    for (const t of ta) if (tb.has(t)) common++;
    if (!common) return 0;
    const jaccard = common / (ta.size + tb.size - common);
    const contained = common === Math.min(ta.size, tb.size) ? 0.75 : 0;
    return Math.max(jaccard, contained);
  }

  function bestValue(pageValue, fact) {
    const unit = fact.unit || splitLabel(fact.label).unit;
    let best = { score: 0, why: '' };
    for (const t of fact.texts || []) {
      const s = valueScore(pageValue, t, unit);
      if (s.score > best.score) best = s;
    }
    // A select option shown by its number ("M2") where the PIM shows its value ("Square metre").
    const numbers = (fact.altTexts || []).map(norm).filter(Boolean);
    if (best.score < 1 && numbers.includes(norm(pageValue))) best = { score: 1, why: 'same as the option’s number' };
    // A list on the page against several values in the PIM: "Harry Potter, Harry Potter-universet".
    // Each part may be an option's value or its number.
    const texts = (fact.texts || []).map(norm).filter(Boolean);
    if (best.score < 1 && texts.length > 1) {
      const parts = String(pageValue == null ? '' : pageValue).split(/\s*[,;]\s*/).map(norm).filter(Boolean);
      if (parts.length === texts.length && parts.every((x) => texts.includes(x))) best = { score: 0.98, why: 'same values' };
      else if (parts.length === texts.length && parts.every((x) => texts.includes(x) || numbers.includes(x))) best = { score: 0.98, why: 'same values, by the options’ numbers' };
    }
    return best;
  }

  /**
   * Rank PIM facts against one page fact { value, label }.
   * Returns [{ fact, score, status: 'match'|'differs', confidence, why }], best first.
   *  - match:   the value is in the PIM (the label, if any, raises or lowers confidence)
   *  - differs: the label clearly names this attribute, but the PIM holds another value
   */
  function rank(page, facts, options) {
    const empties = !!(options && options.empties);
    const out = [];
    const hasLabel = !!norm(page.label);
    for (const fact of facts) {
      const v = bestValue(page.value, fact);
      const l = hasLabel ? Math.max(...[fact.label].concat(fact.aliases || []).map((x) => labelScore(page.label, x))) : 0;
      let score = 0;
      let status = 'match';
      let why = v.why;
      // When the value is not in the PIM, only the label says which field is meant. For the
      // product's own name, number and description the label must then say so outright:
      // "Focus Product" is not the product's name because it has the word "product" in it.
      const named = fact.kind && fact.kind !== 'attribute' ? 0.9 : 0.75;
      if (v.score > 0) {
        score = hasLabel ? 0.7 * v.score + 0.3 * l + (l >= 0.75 ? 0.05 : 0) : v.score * 0.92;
        if (l >= 0.75) why += ', label matches';
      } else if (l >= named && (fact.texts || []).some((t) => norm(t))) {
        status = 'differs';
        score = 0.5 + 0.3 * l;
        why = 'label matches, value differs';
        // "Weight: 1.2 kg" against "Weight (kg)" and "Weight (g)": prefer the same unit.
        const q = parseQuantity(page.value);
        const unit = norm(fact.unit || splitLabel(fact.label).unit);
        if (q && q.unit && unit && q.unit === unit) score += 0.05;
      } else if (empties && l >= named) {
        // The label names this attribute, and the PIM has no value for it.
        status = 'empty';
        score = 0.36 + 0.2 * l;
        why = 'label matches, no value in the PIM';
      }
      if (score >= 0.35) {
        score = Math.min(1, score);
        out.push({ fact, score, status, why, valueScore: v.score, confidence: score >= 0.8 ? 'high' : score >= 0.55 ? 'medium' : 'low' });
      }
    }
    out.sort((x, y) => y.score - x.score);
    return out;
  }

  /** Check every label/value pair found on the page. Returns one row per pair. */
  function checkPairs(pairs, facts, options) {
    return pairs.map((pair) => {
      const ranked = rank(pair, facts, options);
      const top = ranked[0];
      if (!top) return { pair, status: 'unknown', top: null, ranked };
      if (top.status === 'differs') {
        // Another attribute holds exactly this value: the page shows that one, not
        // the look-alike label ("Format" is "Product Form", not "Alternative Format").
        const distinctive = norm(pair.value).length >= 4;
        const exact = distinctive && ranked.find((r) => r.status === 'match' && r.valueScore >= 0.88);
        if (exact) return { pair, status: 'match', top: exact, ranked: [exact].concat(ranked.filter((r) => r !== exact)) };
      }
      if (top.status === 'match' && top.confidence === 'low') return { pair, status: 'unsure', top, ranked };
      return { pair, status: top.status, top, ranked };
    });
  }

  /** A unit as it is compared: lower case, with its common spellings folded together. */
  const unitOf = (u) => {
    const k = String(u || '').toLowerCase().trim();
    return UNIT_ALIAS[k] || k;
  };

  const api = { norm, splitLabel, parseQuantity, parseDate, valueScore, labelScore, rank, checkPairs, unitOf };
  root.BSI = Object.assign(root.BSI || {}, { match: api });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
