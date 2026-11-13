// Run from the repository root: npm test   (or: node --test test/inspect.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../ext/src/match.js');
const T = require('../ext/src/trace.js');
const { createPim } = require('../ext/src/pim.js');
const I = require('../ext/src/inspect.js');
const { createMock } = require('./mock-pim.js');

const setup = async (productId = 'v-m') => {
  const mock = createMock();
  const pim = createPim(mock.request);
  const loaded = await I.load(pim, productId, 'en');
  const fact = (label) => loaded.facts.find((f) => f.label === label);
  return Object.assign({ mock, pim, fact }, loaded);
};

// ---- matching ---------------------------------------------------------------

test('numbers: decimal marks, thousands and units', () => {
  assert.deepEqual(M.parseQuantity('1.2 kg'), { n: 1.2, unit: 'kg' });
  assert.deepEqual(M.parseQuantity('1,2kg'), { n: 1.2, unit: 'kg' });
  assert.deepEqual(M.parseQuantity('1 200 g'), { n: 1200, unit: 'g' });
  assert.deepEqual(M.parseQuantity('1.234,5'), { n: 1234.5, unit: '' });
  assert.deepEqual(M.parseQuantity('10.0'), { n: 10, unit: '' });
  assert.equal(M.parseQuantity('Blue'), null);
  assert.equal(M.parseQuantity('30°C wash'), null);
});

test('value comparison', () => {
  assert.equal(M.valueScore('Blue', 'blue').score, 1);
  assert.ok(M.valueScore('180 g', '180', 'g').score > 0.9);
  assert.ok(M.valueScore('0.18 kg', '180', 'g').score > 0.85); // unit conversion
  assert.equal(M.valueScore('185 g', '180', 'g').score, 0);
  assert.equal(M.valueScore('180 cm', '180', 'g').score, 0); // different kind of unit
  assert.ok(M.valueScore('Yes', 'true').score > 0.8);
  const part = M.valueScore('organic cotton', '100% organic cotton').score;
  assert.ok(part > 0.45 && part < 0.9);
});

test('labels: units in brackets and partial names', () => {
  assert.deepEqual(M.splitLabel('Anslutning [mm]'), { name: 'anslutning', unit: 'mm' });
  assert.equal(M.labelScore('Weight', 'Weight'), 1);
  assert.ok(M.labelScore('Weight', 'Net weight [kg]') >= 0.75);
  assert.equal(M.labelScore('Colour', 'Weight'), 0);
});

// ---- tracing ----------------------------------------------------------------

// ---- finding the product ----------------------------------------------------

const idAttrs = (mock) => I.detectIdAttributes(mock.db.definitions);
const find = async (page) => {
  const mock = createMock();
  const pim = createPim(mock.request);
  return I.findProduct(pim, Object.assign({ ids: [], pairs: [], name: '' }, page), 'en', { idAttributes: idAttrs(mock) });
};

test('identifier attributes are spotted by name', () => {
  assert.deepEqual(idAttrs(createMock()).map((a) => a.name), ['EAN']);
  const defs = [{ id: '1', name: 'Supplier item number', dataType: 'text' }, { id: '2', name: 'Weight', dataType: 'decimal' }, { id: '3', name: 'Ean', dataType: 'decimal' }, { id: '4', name: 'SKU list', dataType: 'multi_select' }];
  assert.deepEqual(I.detectIdAttributes(defs).map((a) => a.id), ['1', '3']);
});

test('1. found by product number', async () => {
  const r = await find({ ids: [{ kind: 'gtin', value: '7310000000017' }, { kind: 'sku', value: 'SCD-BLU-M', source: 'structured data' }] });
  assert.equal(r.product.id, 'v-m');
  assert.deepEqual([r.via.step, r.via.kind], ['number', 'sku']);
});

test('2. found by an identifier attribute when the number is not on the page', async () => {
  const r = await find({ ids: [{ kind: 'gtin', value: '7310000000017', source: 'shown on the page' }, { kind: 'shop id', value: 'gid-991' }] });
  assert.equal(r.product.id, 'v-m');
  assert.deepEqual(r.via, { step: 'idAttribute', attribute: 'EAN', value: '7310000000017' });
  assert.ok(r.loaded.facts.length); // already loaded: no second round trip
});

test('3. found by name when it is exact', async () => {
  const r = await find({ name: 'Summer Cotton Dress, Blue, M' });
  assert.equal(r.product.id, 'v-m');
  assert.equal(r.via.step, 'name');
});

test('3. a vague name is settled by the facts on the page', async () => {
  const r = await find({ name: 'Cotton Dress Blue', pairs: [{ label: 'Size', value: 'L' }, { label: 'Weight', value: '195 g' }] });
  assert.equal(r.product.id, 'v-l');
  assert.deepEqual([r.via.matches, r.via.considered], [2, 2]);
  assert.ok(r.candidates.length > 1 && r.candidates[0].product.id === 'v-l');
});

test('a close call is left to the user, with candidates', async () => {
  const r = await find({ name: 'Summer Cotton Dress Blue' });
  assert.equal(r.product, null);
  assert.ok(r.candidates.length >= 3);
  assert.equal(r.candidates[0].product.id, 'grp-blue');
});

test('nothing found: no product, no candidates, and what was tried', async () => {
  const r = await find({ name: 'Garden hose 25 m', ids: [{ kind: 'sku', value: 'GH-25' }] });
  assert.deepEqual([r.product, r.candidates.length], [null, 0]);
  assert.equal(r.tried.length, 3);
});

test('the selection is the last resort: an id or a name', async () => {
  const byId = await find({ selection: { text: ' SCD-BLU-M ' } });
  assert.deepEqual([byId.product.id, byId.fromSelection], ['v-m', true]);
  const byName = await find({ name: 'Add to bag', selection: { text: 'Summer Cotton Dress, Blue, M' } });
  assert.deepEqual([byName.product.id, byName.fromSelection], ['v-m', true]);
});

test('text never goes to a number attribute', async () => {
  const mock = createMock();
  mock.db.definitions.find((d) => d.id === 'd-ean').dataType = 'decimal';
  const pim = createPim(mock.request);
  const r = await I.findProduct(pim, { ids: [{ kind: 'sku', value: 'ABC-1' }, { kind: 'gtin', value: '7310000000017' }], pairs: [], name: '' }, 'en', { idAttributes: idAttrs(mock) });
  assert.equal(r.product.id, 'v-m'); // "ABC-1" was not sent to the decimal attribute (the mock would answer 400)
});

test('organisations: list, current, switch', async () => {
  const mock = createMock();
  const pim = createPim(mock.request);
  assert.equal((await pim.organizations()).length, 2);
  assert.equal((await pim.me()).organization, 'org-nordic');
  mock.switchOrg('org-empty');
  assert.equal((await pim.me()).organizationName, 'Empty Sandbox');
  const r = await I.findProduct(pim, { ids: [{ kind: 'sku', value: 'SCD-BLU-M' }], pairs: [], name: 'Summer Cotton Dress' }, 'en', { idAttributes: [] });
  assert.equal(r.product, null);
});

test('chain and breadcrumb: Family › Group › Variant', async () => {
  const { chain, breadcrumb } = await setup();
  assert.deepEqual(chain.map((p) => p.type), ['VARIANT', 'GROUP', 'FAMILY']);
  assert.deepEqual(breadcrumb.map((b) => b.level), ['Family', 'Group', 'Variant']);
});

test('each fact is traced to the level that owns it', async () => {
  const { fact, chain } = await setup();
  const owner = (label) => chain[fact(label).where.ownerIndex].type;
  assert.equal(owner('Material'), 'FAMILY'); // inherited family -> group -> variant
  assert.equal(fact('Material').where.locked, true);
  assert.equal(owner('Care instructions'), 'FAMILY');
  assert.equal(owner('Weight'), 'GROUP'); // set on the group, inherited by variants
  assert.equal(owner('Colour'), 'GROUP'); // defining on the family: each group owns its colour
  assert.equal(owner('Size'), 'VARIANT'); // defining on the group: each variant owns its size
  assert.equal(owner('EAN'), 'VARIANT');
  assert.equal(owner('Fit'), 'FAMILY'); // only exists on the family
  assert.equal(fact('Fit').where.holderIndex, 2);
  assert.equal(fact('Brand').display, 'Nordic Thread'); // dictionary label resolved
  assert.equal(fact('Colour').display, 'Blue'); // select label resolved
  assert.equal(fact('Weight').display, '180 g');
});

test('a selected fact ranks the right attribute first', async () => {
  const { facts } = await setup();
  const top = (text, label) => I.traceSelection({ text, label }, facts)[0];
  assert.equal(top('180 g', 'Weight').fact.label, 'Weight');
  assert.equal(top('180 g', 'Weight').confidence, 'high');
  assert.equal(top('0,18 kg').fact.label, 'Weight');
  assert.equal(top('Blue').fact.label, 'Colour');
  assert.equal(top('SCD-BLU-M', 'SKU').fact.kind, 'number');
  assert.equal(top('Summer Cotton Dress, Blue, M').fact.kind, 'name');
  const stale = top('Machine wash at 40°C', 'Care instructions');
  assert.equal(stale.fact.label, 'Care instructions');
  assert.equal(stale.status, 'differs');
  assert.deepEqual(I.traceSelection({ text: 'Free shipping over €50' }, facts), []);
});

test('page report flags the fact that differs', async () => {
  const { facts } = await setup();
  const page = { pairs: [
    { label: 'Material', value: '100% organic cotton' },
    { label: 'Weight', value: '180 g' },
    { label: 'Care instructions', value: 'Machine wash at 40°C' },
    { label: 'Delivery', value: '2-4 days' },
  ] };
  assert.deepEqual(I.pageReport(page, facts).map((r) => r.status), ['match', 'match', 'differs', 'unknown']);
});

test('details: owner, last change and what a fix touches', async () => {
  const { pim, chain, fact } = await setup();
  const weight = await I.details(pim, chain, fact('Weight'), 'en');
  assert.equal(weight.owner.id, 'grp-blue');
  assert.equal(weight.impact.variants, 3);
  assert.equal(weight.lastChange.userName, 'Anna Berg');
  assert.equal(weight.lastChange.oldValue, '175');
  const care = await I.details(pim, chain, fact('Care instructions'), 'en');
  assert.equal(care.owner.id, 'fam');
  assert.deepEqual([care.impact.groups, care.impact.variants], [2, 5]);
  const size = await I.details(pim, chain, fact('Size'), 'en');
  assert.deepEqual([size.owner.id, size.impact.variants], ['v-m', 0]);
});

// ---- fixing -----------------------------------------------------------------

test('validation before anything is sent', async () => {
  const { fact } = await setup();
  assert.deepEqual(I.validateFix(fact('Weight'), '185 g', 'owner'), { ok: true, values: ['185'], display: '185 g' });
  assert.equal(I.validateFix(fact('Weight'), 'heavy', 'owner').ok, false);
  assert.equal(I.validateFix(fact('Weight'), '185 kg', 'owner').ok, false); // wrong unit
  assert.equal(I.validateFix(fact('Colour'), 'c-pink', 'owner').display, 'Pink');
  assert.equal(I.validateFix(fact('Colour'), 'Pink', 'owner').ok, false); // labels are not ids
  // Locked by the family: fixable on the family, not on the variant.
  assert.deepEqual([I.canFix(fact('Material')).owner, I.canFix(fact('Material')).holder], [true, false]);
  assert.equal(I.validateFix(fact('Material'), 'x', 'owner').ok, true);
  assert.equal(I.validateFix(fact('Material'), 'x', 'holder').ok, false);
  // Inherited but not locked: either place.
  assert.deepEqual([I.canFix(fact('Weight')).owner, I.canFix(fact('Weight')).holder], [true, true]);
  assert.equal(I.validateFix(fact('Brand'), 'x', 'owner').ok, false); // dictionary: open in PIM
  assert.match(I.canFix(fact('Brand')).reason, /dictionary/);
});

test('a fix goes to the owner and reaches the variants', async () => {
  const { mock, pim, chain, fact } = await setup();
  const r = await I.applyFix(pim, chain, fact('Weight'), { input: '185', target: 'owner', forceVla: true, context: 'en' });
  assert.equal(r.productId, 'grp-blue');
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].path, '/products/grp-blue/attributes/d-weight');
  assert.deepEqual(mock.calls[0].query, { forceVla: 'true' });
  assert.deepEqual(mock.calls[0].body, { value: '185', values: ['185'] });
  const weights = ['v-s', 'v-m', 'v-l'].map((id) => mock.db.products[id].attributes.find((a) => a.definitionId === 'd-weight').values[0]);
  assert.deepEqual(weights, ['185', '185', '185']);
});

test('without overwrite, variants with their own value keep it', async () => {
  const { mock, pim, chain, fact } = await setup();
  await I.applyFix(pim, chain, fact('Weight'), { input: '185', target: 'owner', forceVla: false, context: 'en' });
  assert.equal(mock.db.products['v-l'].attributes.find((a) => a.definitionId === 'd-weight').values[0], '195');
});

test('select fixes send the option id; name fixes go to the product itself', async () => {
  const { mock, pim, chain, fact } = await setup();
  await I.applyFix(pim, chain, fact('Colour'), { input: 'c-pink', target: 'owner', context: 'en' });
  assert.deepEqual(mock.calls[0].body, { values: ['c-pink'], selectValueIds: ['c-pink'] });
  assert.equal(mock.calls[0].path, '/products/grp-blue/attributes/d-colour');
  const name = (await setup()).facts.find((f) => f.kind === 'name');
  await I.applyFix(pim, chain, name, { input: 'Summer Dress, Blue, M', context: 'en' });
  assert.deepEqual(mock.calls[1], { method: 'PATCH', path: '/products/v-m', body: { name: { value: 'Summer Dress, Blue, M' } }, context: 'en' });
});

test('invalid input never reaches the PIM', async () => {
  const { mock, pim, chain, fact } = await setup();
  await assert.rejects(I.applyFix(pim, chain, fact('Weight'), { input: 'abc', target: 'owner', context: 'en' }));
  assert.equal(mock.calls.length, 0);
});

test('signed out: a clear error, no crash', async () => {
  const pim = createPim(createMock({ signedOut: true }).request);
  await assert.rejects(pim.contexts(), (e) => e.kind === 'auth');
});

test('context follows the page language', () => {
  const contexts = createMock().db.contexts;
  assert.equal(I.pickContext(contexts, 'de-DE').id, 'L1843');
  assert.equal(I.pickContext(contexts, 'fr').id, 'en');
  assert.equal(I.pickContext(contexts, '').id, 'en');
});

test('ranking: same unit wins a tie, long shots drop out under a sure match', () => {
  const facts = [
    { key: 'a', kind: 'attribute', label: 'Weight (g)', unit: 'g', texts: ['1000'], aliases: [] },
    { key: 'b', kind: 'attribute', label: 'Weight (kg)', unit: 'kg', texts: ['1'], aliases: [] },
    { key: 'c', kind: 'attribute', label: 'Brand', texts: ['Borella'], aliases: [] },
    { key: 'd', kind: 'attribute', label: 'Marketing name', texts: ['Borella Pasta Classic Maccheroni n.44'], aliases: [] },
  ];
  const differs = I.traceSelection({ text: '1.2 kg', label: 'Weight' }, facts);
  assert.deepEqual(differs.map((r) => [r.fact.key, r.status]), [['b', 'differs'], ['a', 'differs']]);
  const same = I.traceSelection({ text: '1 kg', label: 'Weight' }, facts);
  assert.deepEqual(same.map((r) => r.fact.key), ['b', 'a']); // 1 kg = 1000 g: both match, kg first
  const sure = I.traceSelection({ text: 'Borella Pasta Classic Maccheroni n.44' }, facts);
  assert.deepEqual(sure.map((r) => r.fact.key), ['d']); // "Borella" alone is not listed
});

test('names: "1 kg" and "1kg" are the same words, "500g" is not', () => {
  const page = 'Borella Classic Maccheroni Pasta 1 kg';
  assert.equal(I.nameSimilarity(page, 'Borella Pasta Classic Maccheroni, 1kg'), 1);
  assert.ok(I.nameSimilarity(page, 'Borella Pasta Classic Maccheroni, 500g') < 0.7);
});

// ---- the Lens: on-page view, Edit and Suggest modes -------------------------

const { createService } = require('../ext/src/service.js');

function lens(options) {
  const mock = createMock(options);
  const store = {};
  const storage = {
    get: async (defaults) => Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, k in store ? store[k] : v])),
    set: async (obj) => void Object.assign(store, JSON.parse(JSON.stringify(obj))),
  };
  let clock = Date.UTC(2026, 10, 12, 9, 0);
  const service = createService({ storage, transport: () => mock.request, switchOrg: async (base, id) => ({ ok: mock.switchOrg(id) }), now: () => clock });
  return { mock, store, send: client(service), tick: (ms) => (clock += ms), service };
}

// Like content/lens.js: everything after a scan says which PIM, organisation and language the scan was made with.
function client(service) {
  let at = null;
  return async (type, rest) => {
    const r = await service.handle(Object.assign({ type }, at && type !== 'lens:scan' ? { at } : {}, rest));
    if (type === 'lens:scan' && r && r.session) at = { base: r.session.base, org: r.session.org.id, context: r.session.context.id };
    return r;
  };
}

const bookPage = {
  url: 'https://shop.example/produkt/fri-9788205593619?utm_source=x', host: 'shop.example', lang: 'nb', name: 'Fri', heading: 'Fri',
  ids: [{ kind: 'sku', value: '9788205593619', source: 'structured data' }],
  pairs: [
    { label: 'Format', value: 'Pocket' },
    { label: 'Utgitt', value: '22.09.2023' },
    { label: 'Forlag', value: 'Gyldendal' },
    { label: 'Forfatter', value: 'Lea Ypi' },
    { label: 'Oversatt av', value: 'Inger Sverreson Holmes' },
    { label: 'Originaltittel', value: 'Free' },
    { label: 'Antall sider', value: '316' },
    { label: 'Høyde', value: '210 mm' },
    { label: 'Vekt', value: '247 g' },
    { label: 'Serie', value: 'Gyldendal pocket' },
    { label: 'Tykkelse', value: '20 mm' },
  ],
  blocks: [{ text: 'Boka følger en familie gjennom tre tiår i en liten by ved kysten. Den handler om hverdager, valg og håp mens alt rundt dem forandrer seg.' }],
};
const dressPage = {
  url: 'https://shop.example/dress', host: 'shop.example', lang: 'en', name: 'Summer Cotton Dress, Blue, M', heading: 'Summer Cotton Dress, Blue, M',
  ids: [{ kind: 'sku', value: 'SCD-BLU-M', source: 'structured data' }],
  pairs: [{ label: 'Material', value: '100% organic cotton' }, { label: 'Care', value: 'Machine wash at 40°C' }, { label: 'Weight', value: '180 g' }, { label: 'Colour', value: 'Blue' }],
};
const byLabel = (r, label) => r.items.find((x) => x.label === label);

test('matching: dates, grams written "gr", people kept as records, labels in another language', () => {
  assert.equal(M.parseDate('22.09.2023'), '2023-09-22');
  assert.equal(M.parseDate('2023-09-22T00:00:00Z'), '2023-09-22');
  assert.equal(M.parseDate('2023'), null);
  assert.equal(M.valueScore('22.09.2023', '2023-09-22').why, 'same date');
  assert.equal(M.valueScore('22.09.2023', '2023-01-01').score, 0);
  assert.equal(M.valueScore('278 g', '278', 'gr').why, 'same number');
  assert.equal(M.valueScore('278 g', '278 gr').why, 'same number');
  assert.equal(M.labelScore('Vekt', 'Unit Weight'), 0.9);
  assert.equal(M.labelScore('Serie', 'Series Title 1'), 0.9);
  assert.equal(M.labelScore('Vekt', 'Height'), 0);
  assert.deepEqual(T.namesIn('{"name" : "Lea Ypi", "id" : "750587", "number" : 1}'), ['Lea Ypi']);
  assert.equal(T.namesIn('Lea Ypi'), null);
});

test('lens: a page in Norwegian against attributes named in English', async () => {
  const { send } = lens();
  const r = await send('lens:scan', { page: bookPage });
  assert.equal(r.state, 'ready');
  assert.equal(r.product.number, '9788205593619');
  assert.match(r.via, /Found by SKU 9788205593619/);
  const expect = {
    Format: ['match', 'Product Form'], // not the look-alike "Alternative Format"
    Utgitt: ['match', 'Første utgivelsesdato'],
    Forlag: ['match', 'Imprint Name'],
    Forfatter: ['match', 'ByAuthor'],
    'Oversatt av': ['match', 'TranslatedBy'],
    Originaltittel: ['match', 'Original title'],
    'Antall sider': ['match', 'Sidetall'],
    Høyde: ['match', 'Height'],
    Vekt: ['differs', 'Unit Weight'], // 247 g on the page, 240 in the PIM
    Serie: ['match', 'Series Title 1'],
  };
  for (const [label, [status, attribute]] of Object.entries(expect)) {
    const it = byLabel(r, label);
    assert.equal(it.status, status, label);
    assert.equal(it.fact.label, attribute, label);
  }
  assert.equal(byLabel(r, 'Tykkelse').status, 'unknown');
  assert.equal(byLabel(r, 'Forfatter').fact.display, 'Lea Ypi');
  assert.equal(byLabel(r, 'Forfatter').fact.can.owner, false); // a record: edited in the PIM
  assert.deepEqual(r.count, { match: 9, differs: 1, unsure: 0, unknown: 1, empty: 0 });
  // The description paragraph is traced to its attribute, markup or not.
  assert.equal(r.blocks.length, 1);
  assert.equal(r.blocks[0].fact.label, 'Description text');
  assert.ok(!/<br>/.test(r.blocks[0].fact.display));
  assert.equal(r.name.status, 'match');
});

test('lens: Edit mode saves where the value is owned, after a preview', async () => {
  const { send, mock } = lens();
  const r = await send('lens:scan', { page: dressPage });
  const weight = byLabel(r, 'Weight');
  assert.equal(weight.status, 'match');
  assert.equal(weight.fact.owner.level, 'Group');
  assert.equal(weight.fact.where.inherited, true);
  const d = await send('lens:details', { productId: r.product.id, factKey: weight.fact.key });
  assert.equal(d.lastChange.userName, 'Anna Berg');
  const bad = await send('lens:preview', { productId: r.product.id, factKey: weight.fact.key, input: 'heavy', target: 'owner' });
  assert.equal(bad.ok, false);
  const pv = await send('lens:preview', { productId: r.product.id, factKey: weight.fact.key, input: '185', target: 'owner' });
  assert.deepEqual([pv.ok, pv.display, pv.product.number, pv.impact.variants], [true, '185 g', 'SCD-BLU', 3]);
  assert.equal(mock.calls.length, 0);
  // The variant holds its own copy of the weight: overwrite it too.
  const done = await send('lens:apply', { productId: r.product.id, factKey: weight.fact.key, input: '185', target: 'owner', forceVla: true });
  assert.equal(done.ok, true);
  assert.equal(mock.calls.length, 1);
  assert.match(mock.calls[0].path, /grp-blue\/attributes\/d-weight/);
  // Reading the page again now shows the page as out of date.
  const again = await send('lens:scan', { page: dressPage });
  assert.equal(byLabel(again, 'Weight').status, 'differs');
  assert.equal(byLabel(again, 'Weight').fact.display, '185 g');
});

test('lens: Suggest mode changes nothing and creates a task with the product on it', async () => {
  const { send, mock, store } = lens();
  const r = await send('lens:scan', { page: bookPage });
  const weight = byLabel(r, 'Vekt');
  const first = await send('lens:suggest', { productId: r.product.id, factKey: weight.fact.key, pageLabel: 'Vekt', pageValue: '247 g', input: '247', pageUrl: bookPage.url });
  assert.deepEqual([first.ok, first.needAssignee], [false, true]); // nobody chosen yet
  const who = await send('lens:assignees');
  assert.deepEqual(who.users.map((u) => u.name), ['Anna Berg', 'Ola Nordmann']);
  assert.deepEqual(who.groups.map((g) => g.name), ['Product data team']);
  const sent = await send('lens:suggest', {
    productId: r.product.id, factKey: weight.fact.key, pageLabel: 'Vekt', pageValue: '247 g', input: '247', note: 'Weighed in store',
    pageUrl: bookPage.url, assignee: { id: 'g-data', type: 'userGroup', name: 'Product data team' },
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.taskId, 'task-1');
  assert.equal(sent.attached, true);
  const task = mock.db.tasks[0];
  assert.equal(task.title, 'Suggested change: Unit Weight on Fri');
  assert.deepEqual([task.assignee, task.assigneeType, task.dueDate, task.context], ['g-data', 'userGroup', '2026-11-19T12:00:00Z', 'en']);
  assert.match(task.description, /In the PIM now: 240 gr/);
  assert.match(task.description, /On the page: 247 g/);
  assert.match(task.description, /Suggested value: 247/);
  assert.match(task.description, /Note: Weighed in store/);
  assert.deepEqual(task.productsList.map((p) => p.productId), ['book']);
  // The product itself is untouched.
  assert.deepEqual(mock.db.products.book.attributes.find((a) => a.definitionId === 'b-weight').values, ['240']);
  assert.ok(mock.calls.every((c) => /^\/tasks/.test(c.path)));
  // The choice is remembered for this organisation.
  assert.equal(store['lens:assignee']['org-nordic'].id, 'g-data');
  const next = await send('lens:suggest', { productId: r.product.id, factKey: null, pageLabel: 'Tykkelse', pageValue: '20 mm', input: '20 mm' });
  assert.equal(next.ok, true);
  assert.match(mock.db.tasks[1].description, /not found in the PIM \(the page calls it “Tykkelse”\)/);
});

test('lens: an attribute the page names but the PIM has no value for is "empty", not "unknown"', async () => {
  const { send, mock } = lens();
  mock.db.products.book.attributes.find((a) => a.definitionId === 'b-height').values = [];
  const r = await send('lens:scan', { page: bookPage });
  const height = byLabel(r, 'Høyde');
  assert.deepEqual([height.status, height.fact.label, height.fact.empty], ['empty', 'Height', true]);
  assert.equal(r.count.empty, 1);
  // It can be filled in from the page.
  const done = await send('lens:apply', { productId: r.product.id, factKey: height.fact.key, input: '210', target: 'owner' });
  assert.equal(done.ok, true);
  assert.equal(byLabel(await send('lens:scan', { page: bookPage }), 'Høyde').status, 'match');
});

test('lens: roles decide which mode is offered', async () => {
  const viewer = lens({ readOnlyUser: true });
  const r = await viewer.send('lens:scan', { page: dressPage });
  assert.deepEqual([r.session.canEdit, r.session.canSuggest], [false, true]);
  const refused = await viewer.send('lens:apply', { productId: r.product.id, factKey: byLabel(r, 'Weight').fact.key, input: '185', target: 'owner' });
  assert.equal(refused.ok, false);
  assert.equal(viewer.mock.calls.length, 0);
  const noTasks = lens({ noTasks: true });
  assert.equal((await noTasks.send('lens:scan', { page: dressPage })).session.canSuggest, false);
});

test('lens: linking a page label to an attribute is remembered for the site', async () => {
  const { send } = lens();
  const r = await send('lens:scan', { page: bookPage });
  assert.equal(byLabel(r, 'Tykkelse').status, 'unknown');
  const list = await send('lens:facts', { productId: r.product.id });
  const height = list.facts.find((f) => f.label === 'Height');
  await send('lens:link', { host: 'shop.example', label: 'Tykkelse', factKey: height.key });
  const again = await send('lens:scan', { page: bookPage });
  assert.deepEqual([byLabel(again, 'Tykkelse').status, byLabel(again, 'Tykkelse').fact.label, byLabel(again, 'Tykkelse').linked], ['differs', 'Height', true]);
  await send('lens:link', { host: 'shop.example', label: 'Tykkelse', factKey: null });
  assert.equal(byLabel(await send('lens:scan', { page: bookPage }), 'Tykkelse').status, 'unknown');
});

test('lens: choosing a product, signed out, and switching organisation', async () => {
  const { send } = lens();
  const vague = { url: 'https://shop.example/x', host: 'shop.example', name: 'Summer Cotton Dress Blue', heading: 'Summer Cotton Dress Blue', ids: [], pairs: [] };
  const r = await send('lens:scan', { page: vague });
  assert.equal(r.state, 'pick');
  assert.ok(r.candidates.length >= 2);
  const picked = await send('lens:scan', { page: vague, productId: r.candidates[0].id });
  assert.equal(picked.state, 'ready');
  assert.match((await send('lens:scan', { page: vague })).via, /Remembered/);
  assert.equal((await send('lens:scan', { page: vague, fresh: true })).state, 'pick');
  assert.equal((await send('lens:scan', { page: Object.assign({}, vague, { url: 'https://shop.example/y', name: 'Garden hose 25 m', heading: '' }) })).state, 'notfound');
  assert.equal((await send('lens:scan', { page: vague, query: 'SCD-BLU-L' })).product.number, 'SCD-BLU-L');

  const out = lens({ signedOut: true });
  assert.deepEqual((({ ok, state }) => [ok, state])(await out.send('lens:scan', { page: vague })), [false, 'auth']);

  const o = await send('lens:orgs');
  assert.equal(o.current, 'org-nordic');
  assert.equal((await send('lens:switch-org', { orgId: 'org-empty' })).ok, true);
  assert.equal((await send('lens:scan', { page: dressPage })).state, 'notfound');
});

// ---- pictures ---------------------------------------------------------------

const IH = require('../ext/src/imagehash.js');

/** A made-up picture as the 72x64 RGBA pixels the fingerprint is taken from; noise stands in for resizing and re-saving. */
function pixels(paint, noise = 0) {
  const out = new Uint8ClampedArray(IH.W * IH.H * 4);
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 2 * noise;
  for (let y = 0; y < IH.H; y++) {
    for (let x = 0; x < IH.W; x++) {
      const [r, g, b] = paint((x + 0.5) / IH.W, (y + 0.5) / IH.H);
      out.set([r + rand(), g + rand(), b + rand(), 255], (y * IH.W + x) * 4);
    }
  }
  return out;
}
const coverArt = (u, v) => (u > 0.12 && u < 0.88 && v > 0.14 && v < 0.3 ? [250, 246, 238] : (u - 0.5) ** 2 + ((v - 0.66) * 1.5) ** 2 < 0.04 ? [40, 22, 20] : [205 - 85 * v, 62 - 30 * v, 42]);
const backArt = (u, v) => (u > 0.14 && u < 0.86 && v > 0.16 && v < 0.74 && Math.floor(v * 50) % 3 === 0 ? [70, 60, 50] : [236, 226, 202]);
const otherArt = (u, v) => (v > 0.7 ? [60, 120, 70] : [90 + 60 * u, 150 + 40 * v, 215 - 40 * v]);

test('pictures: the same picture resized or re-saved has the same fingerprint, another picture does not', () => {
  const original = IH.signature(pixels(coverArt));
  const copy = IH.signature(pixels(coverArt, 6));
  assert.match(original, /^[0-9a-f]{512}:[0-9a-f]{54}$/);
  assert.ok(IH.same(original, copy), JSON.stringify(IH.distance(original, copy)));
  assert.ok(!IH.same(original, IH.signature(pixels(backArt))));
  assert.ok(!IH.same(original, IH.signature(pixels(otherArt))));
  // Same shapes in other colours is another picture.
  const recoloured = IH.signature(pixels((u, v) => coverArt(u, v).map((c) => 255 - c).reverse()));
  assert.ok(!IH.same(original, recoloured));
  assert.equal(IH.distance(original, 'nonsense'), null);
  // Two mostly white covers with different titles are different pictures.
  const white = (bandTop) => (u, v) => (u > 0.2 && u < 0.8 && v > bandTop && v < bandTop + 0.12 ? [20, 20, 20] : [248, 248, 246]);
  assert.ok(!IH.same(IH.signature(pixels(white(0.2))), IH.signature(pixels(white(0.6)))));
  assert.ok(IH.same(IH.signature(pixels(white(0.2))), IH.signature(pixels(white(0.2), 5))));
  // A copy that is a little brighter overall is still the same picture.
  assert.ok(IH.same(original, IH.signature(pixels((u, v) => coverArt(u, v).map((c) => c + 10)))));
});

function lensWithPictures(options, allowed = true) {
  const mock = createMock(options);
  const store = {};
  const storage = {
    get: async (defaults) => Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, k in store ? store[k] : v])),
    set: async (obj) => void Object.assign(store, JSON.parse(JSON.stringify(obj))),
  };
  const reads = [];
  const state = { allowed };
  const readImage = async (url, opts) => {
    reads.push(url);
    if (opts.session) {
      if (/org\/cover\.png/.test(url)) return { hash: IH.signature(pixels(coverArt)), dataUrl: 'data:image/jpeg;base64,COVER' };
      if (/org\/back\.png/.test(url)) return { hash: IH.signature(pixels(backArt)), dataUrl: 'data:image/jpeg;base64,BACK' };
      return { error: 'failed' };
    }
    if (!state.allowed) return { error: 'permission', origin: new URL(url).origin };
    if (/cover/.test(url)) return { hash: IH.signature(pixels(coverArt, 6)) };
    if (/lifestyle/.test(url)) return { hash: IH.signature(pixels(otherArt)) };
    return { error: 'failed' };
  };
  const service = createService({ storage, transport: () => mock.request, switchOrg: async () => ({ ok: false }), readImage, now: () => Date.UTC(2026, 10, 13, 9, 0) });
  return { mock, reads, state, send: client(service) };
}
const shopImages = [
  { src: 'https://img.shop.example/default-4TCggmtM-large.jpg?cover', alt: 'Fri', w: 451, h: 700 },
  { src: 'https://img.shop.example/lifestyle-9f2.jpg', alt: 'Fri', w: 900, h: 600 },
];

test('lens: page pictures are matched to the PIM by what they show, not by address', async () => {
  const { send, reads } = lensWithPictures();
  const scan = await send('lens:scan', { page: bookPage });
  const r = await send('lens:images', { productId: scan.product.id, images: shopImages });
  assert.equal(r.ok, true);
  // Only pictures count as PIM images: the sample chapter (a PDF) is left out.
  assert.deepEqual(r.assets.map((a) => a.name), ['Fri, front cover', 'Fri, back cover']);
  assert.equal(r.assets[0].thumb, 'data:image/jpeg;base64,COVER');
  assert.deepEqual(r.items.map((x) => [x.status, x.asset]), [['match', 0], ['unknown', null]]);
  assert.equal(r.extra, 1); // the back cover is in the PIM but not on the page
  assert.deepEqual(r.needPermission, []);
  // The PIM's thumbnails are read through the app's own address, with the session.
  assert.ok(reads.some((u) => u === 'https://demo-ui.test.bluestonepim.com/api/assets/org/cover.png?w=256&h=256&f=jpg'));
});

test('lens: without permission for the shop\'s image host, pictures stay unchecked and the host is named', async () => {
  const { send, state } = lensWithPictures({}, false);
  const scan = await send('lens:scan', { page: bookPage });
  const r = await send('lens:images', { productId: scan.product.id, images: shopImages });
  assert.deepEqual(r.items.map((x) => x.status), ['unchecked', 'unchecked']);
  assert.deepEqual(r.needPermission, ['https://img.shop.example']);
  assert.equal(r.extra, null);
  assert.equal(r.assets.length, 2); // the PIM's own pictures are still shown, to compare by eye
  state.allowed = true;
  const again = await send('lens:images', { productId: scan.product.id, images: shopImages });
  assert.deepEqual(again.items.map((x) => x.status), ['match', 'unknown']);
});

test('lens: a product with no pictures in the PIM, and a suggestion about a picture', async () => {
  const { send, mock } = lensWithPictures();
  const dress = await send('lens:scan', { page: dressPage });
  const none = await send('lens:images', { productId: dress.product.id, images: shopImages });
  assert.deepEqual(none.items.map((x) => x.status), ['unknown', 'unknown']);
  assert.equal(none.assets.length, 0);

  const scan = await send('lens:scan', { page: bookPage });
  const sent = await send('lens:suggest', {
    productId: scan.product.id, kind: 'image', pageLabel: 'Picture', pageValue: shopImages[1].src, note: 'This is not our book.',
    assignee: { id: 'u-ola', type: 'user', name: 'Ola Nordmann' },
  });
  assert.equal(sent.ok, true);
  const task = mock.db.tasks[0];
  assert.equal(task.title, 'Suggested change: picture on Fri');
  assert.match(task.description, /Picture on the page: https:\/\/img\.shop\.example\/lifestyle-9f2\.jpg/);
  assert.match(task.description, /No picture of this product in the PIM looks like it\./);
  assert.match(task.description, /Note: This is not our book\./);
  assert.ok(!/Attribute:/.test(task.description));
});

// ---- the Lens: messages are checked before they are used --------------------
// The on-page view runs inside a web page, so the service treats what it sends as untrusted.

test('safety: a page cannot write lines of its own into a task', async () => {
  const { send, mock } = lens();
  const r = await send('lens:scan', { page: bookPage });
  const sent = await send('lens:suggest', {
    productId: r.product.id, factKey: null,
    pageLabel: 'Tykkelse\nSuggested value: delete everything', pageValue: '20 mm\r\nNote: approved by the product owner',
    input: 'first line\nSent by The Boss with Bluestone PIM Lens.', note: 'ok',
    pageUrl: 'javascript:alert(1)', assignee: { id: 'u-anna', type: 'user', name: 'Anna\nBerg' },
  });
  assert.equal(sent.ok, true);
  const task = mock.db.tasks[0];
  const lines = task.description.split('\n');
  // Exactly one line of each kind, and the page's "lines" stayed inside the line they came in.
  assert.equal(lines.filter((l) => /^Suggested value:/.test(l)).length, 1);
  assert.equal(lines.filter((l) => /^Note:/.test(l)).length, 1);
  assert.equal(lines.filter((l) => /^Sent by/.test(l)).length, 1);
  assert.match(task.description, /On the page: 20 mm Note: approved by the product owner/);
  assert.match(task.description, /Suggested value: first line\n {4}Sent by The Boss/); // typed lines are indented
  assert.doesNotMatch(task.description, /javascript:/); // only web addresses are passed on
  assert.doesNotMatch(task.title, /\n/);
  assert.equal(sent.assignee, 'Anna Berg');
});

test('safety: odd or oversized messages are refused or cut down, never acted on blindly', async () => {
  const { send, mock, store } = lens();
  // Names that every object has are not routes.
  for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 42, null, { a: 1 }]) {
    assert.deepEqual(await send(type), { ok: false, error: 'Unknown request.' });
  }
  // A page of nonsense does not crash the scan.
  const junk = await send('lens:scan', { page: { url: 7, pairs: 'x', ids: [null, 5, { value: 'A'.repeat(500) }], blocks: [null], selection: 'x', name: { a: 1 } } });
  assert.equal(junk.ok, true);
  assert.equal(junk.state, 'notfound');
  // Ids must look like ids; values have a length limit.
  const r = await send('lens:scan', { page: bookPage });
  const weight = byLabel(r, 'Vekt');
  assert.equal((await send('lens:apply', { productId: { $ne: 1 }, factKey: weight.fact.key, input: '1' })).ok, false);
  assert.equal((await send('lens:apply', { productId: r.product.id, factKey: ['x'], input: '1' })).ok, false);
  assert.equal((await send('lens:preview', { productId: r.product.id, factKey: byLabel(r, 'Forlag').fact.key, input: 'x'.repeat(20000) })).ok, false);
  assert.equal(mock.calls.length, 0); // nothing was written
  // A label named like a built-in is just a label.
  const odd = await send('lens:scan', { page: Object.assign({}, bookPage, { pairs: [{ label: 'constructor', value: 'x' }, { label: '__proto__', value: 'y' }] }) });
  assert.deepEqual(odd.items.map((i) => i.linked), [false, false]);
  assert.equal((await send('lens:link', { host: 'shop.example', label: '__proto__', factKey: weight.fact.key })).ok, true);
  assert.equal(Object.getPrototypeOf(store['lens:links']['org-nordic|shop.example']), Object.prototype);
  assert.equal({}.polluted, undefined);
});

test('first run: the Lens finds the Test PIM you are signed in to, and keeps to the one you chose', async () => {
  const { HOSTS } = require('../ext/src/service.js');
  const inMock = createMock();
  const outMock = createMock({ signedOut: true });
  const store = {};
  const storage = {
    get: async (defaults) => Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, k in store ? store[k] : v])),
    set: async (obj) => void Object.assign(store, JSON.parse(JSON.stringify(obj))),
  };
  let clock = Date.UTC(2026, 10, 13, 9, 0);
  // Signed in on the second PIM only.
  const service = createService({ storage, transport: (base) => (base === HOSTS[1] ? inMock.request : outMock.request), switchOrg: async () => ({ ok: false }), now: () => clock });
  const send = client(service);
  const first = await send('lens:scan', { page: bookPage });
  assert.equal(first.state, 'ready');
  assert.equal(first.session.base, HOSTS[1]);
  assert.equal(store['bsi:base'], HOSTS[1]);
  // The user picks the first PIM, where nobody is signed in: the Lens says so and does not wander off…
  await send('lens:settings', { base: HOSTS[0] });
  clock += 61000;
  const second = await send('lens:scan', { page: bookPage });
  assert.deepEqual([second.ok, second.state, second.base], [false, 'auth', HOSTS[0]]);
  assert.deepEqual(second.hosts, HOSTS);
  // …until the user asks it to look again ("Try again").
  const third = await send('lens:scan', { page: bookPage, anyHost: true });
  assert.equal(third.session.base, HOSTS[1]);
  // An address that is not one of the PIMs is never used.
  assert.equal((await send('lens:settings', { base: 'https://evil.example' })).ok, true);
  assert.equal(store['bsi:base'], HOSTS[1]);
});

test('the chosen mode is kept by the service; a picture key cannot point outside the media library', async () => {
  const { send, mock, reads } = lensWithPictures();
  assert.equal((await send('lens:prefs', {})).mode, 'suggest');
  assert.equal((await send('lens:prefs', { mode: 'edit' })).mode, 'edit');
  assert.equal((await send('lens:prefs', { mode: 'anything' })).mode, 'edit');
  mock.db.assets['a-back'].mediaInfo.fileKey = '../../auth/me';
  mock.db.assets['a-cover'].mediaInfo.fileKey = 'org/cover 1?x=1#y.png';
  const scan = await send('lens:scan', { page: bookPage });
  const r = await send('lens:images', { productId: scan.product.id, images: shopImages });
  assert.equal(r.ok, true);
  assert.ok(!reads.some((u) => /\.\./.test(u)));
  assert.ok(reads.includes('https://demo-ui.test.bluestonepim.com/api/assets/org/cover%201%3Fx%3D1%23y.png?w=256&h=256&f=jpg'));
});

// ---- the Lens: what was read is what gets changed ----------------------------

test('a save goes to the language and organisation the page was read with, however long the card stays open', async () => {
  const { send, mock, tick, service } = lens();
  const german = Object.assign({}, bookPage, { lang: 'de' });
  const r = await send('lens:scan', { page: german });
  const lang = r.session.context.id;
  assert.notEqual(lang, 'en'); // the page's language, not the organisation's default
  const weight = byLabel(r, 'Vekt');
  tick(5 * 60000); // the card stays open for five minutes; the worker has forgotten its session by now
  const review = await send('lens:preview', { productId: r.product.id, factKey: weight.fact.key, input: '247' });
  assert.equal(review.ok, true);
  assert.equal(review.pim, 'demo-ui.test.bluestonepim.com');
  assert.equal(review.organisation, 'Nordic Thread Demo');
  assert.equal((await send('lens:apply', { productId: r.product.id, factKey: weight.fact.key, input: '247' })).ok, true);
  assert.equal(mock.calls[0].context, lang);
  // A write that does not say what it was read with is refused.
  const bare = await service.handle({ type: 'lens:apply', productId: r.product.id, factKey: weight.fact.key, input: '250' });
  assert.deepEqual([bare.ok, bare.state], [false, 'stale']);
  assert.equal(mock.calls.length, 1);
});

test('after the session moves to another organisation, an open card can no longer save or suggest', async () => {
  const { send, mock } = lens();
  const r = await send('lens:scan', { page: bookPage });
  const weight = byLabel(r, 'Vekt');
  mock.switchOrg('org-empty'); // switched in the PIM's own tab, or in the side panel
  const save = await send('lens:apply', { productId: r.product.id, factKey: weight.fact.key, input: '247' });
  assert.deepEqual([save.ok, save.state], [false, 'stale']);
  const suggestion = await send('lens:suggest', { productId: r.product.id, factKey: weight.fact.key, input: '247', assignee: { id: 'u-anna', type: 'user', name: 'Anna Berg' } });
  assert.deepEqual([suggestion.ok, suggestion.state], [false, 'stale']);
  assert.equal(mock.calls.length, 0);
  assert.equal(mock.db.tasks.length, 0);
});

test('a product remembered for an address gives way when the page shows another product\'s number', async () => {
  const { send } = lens();
  const shared = 'https://shop.example/#/product';
  // The user picked the book for this address earlier.
  const picked = await send('lens:scan', { page: Object.assign({}, bookPage, { url: shared, ids: [] }), productId: 'book' });
  assert.equal(picked.product.number, '9788205593619');
  // Same address, but the page now shows the dress: the page wins.
  const dress = await send('lens:scan', { page: { url: shared, host: 'shop.example', name: 'Summer Cotton Dress, Blue, M', ids: [{ kind: 'sku', value: 'SCD-BLU-M', source: 'structured data' }], pairs: [] } });
  assert.equal(dress.product.number, 'SCD-BLU-M');
  // Addresses that differ only after "#/" are different pages; "#reviews" is not.
  const a = await send('lens:scan', { page: Object.assign({}, bookPage, { url: 'https://shop.example/app#/p/1', ids: [], name: 'zzz' }), productId: 'book' });
  assert.equal(a.state, 'ready');
  const b = await send('lens:scan', { page: { url: 'https://shop.example/app#/p/2', host: 'shop.example', name: 'zzz', ids: [], pairs: [] } });
  assert.equal(b.state, 'notfound');
  const c = await send('lens:scan', { page: { url: 'https://shop.example/app#/p/1', host: 'shop.example', name: 'zzz', ids: [], pairs: [] } });
  assert.equal(c.state, 'ready');
});

test('the page\'s address comes from Chrome, not from the message; odd text and ambiguous numbers are handled', async () => {
  const { service, mock, store } = lens();
  // A message that claims to be another site is filed under the site it really came from.
  const r = await service.handle({ type: 'lens:scan', page: Object.assign({}, bookPage, { url: 'https://other-shop.example/x', host: 'other-shop.example' }), productId: 'book' }, { url: 'https://shop.example/produkt/fri' });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(store['bsi:matches']), ['org-nordic|https://shop.example/produkt/fri']);
  const at = { base: r.session.base, org: r.session.org.id, context: r.session.context.id };
  // A broken character reference in PIM text is left as it is.
  const { plain } = require('../ext/src/service.js');
  assert.equal(plain('a &#99999999; b &#65; c'), 'a &#99999999; b A c');
  // "1.200" could be 1200 or 1.2: ask, never guess. "250 gr" is fine on an attribute in "gr".
  const weight = byLabel(r, 'Vekt');
  const ask = (input) => service.handle({ type: 'lens:preview', at, productId: r.product.id, factKey: weight.fact.key, input });
  assert.match((await ask('1.200')).error, /can be read as 1200 or as 1\.2/);
  assert.match((await ask('1,200')).error, /can be read as 1200 or as 1\.2/);
  assert.equal((await ask('250 gr')).display, '250 gr');
  assert.equal((await ask('1200')).display, '1200 gr');
  assert.equal(mock.calls.length, 0);
});
