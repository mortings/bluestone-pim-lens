/*
 * A stand-in PIM for tests and the browser harness: the same request() contract as
 * the real transport, answering from a small fixture shaped like the live API
 * (Family -> Group -> Variant, inherited and defining attributes, a select, a
 * dictionary, history). Writes change the fixture, so the fix flow can be tested
 * without touching a real organisation.
 */
(function (root) {
  'use strict';

  function fixture() {
    const attr = (definitionId, values, flags) => Object.assign({ definitionId, values }, flags || {});
    return {
      contexts: [
        { id: 'en', name: 'English', locale: 'en', initial: true },
        { id: 'L1843', name: 'German', locale: 'de', initial: false, fallback: 'en' },
      ],
      definitions: [
        { id: 'd-material', name: 'Material', dataType: 'text', contextAware: true },
        { id: 'd-care', name: 'Care instructions', dataType: 'text', contextAware: true },
        { id: 'd-fit', name: 'Fit', dataType: 'text', contextAware: true },
        { id: 'd-weight', name: 'Weight', dataType: 'decimal', unit: 'g', contextAware: false },
        { id: 'd-ean', name: 'EAN', dataType: 'text', contextAware: false },
        { id: 'd-brand', name: 'Brand', dataType: 'dictionary', contextAware: false },
        {
          id: 'd-colour', name: 'Colour', dataType: 'single_select', contextAware: false,
          restrictions: { enum: { values: [
            { valueId: 'c-blue', value: 'Blue', number: 'blue' },
            { valueId: 'c-black', value: 'Black', number: 'black' },
            { valueId: 'c-pink', value: 'Pink', number: 'pink' },
          ] } },
        },
        {
          id: 'd-size', name: 'Size', dataType: 'single_select', contextAware: false,
          restrictions: { enum: { values: [
            { valueId: 's-s', value: 'S', number: 's' },
            { valueId: 's-m', value: 'M', number: 'm' },
            { valueId: 's-l', value: 'L', number: 'l' },
          ] } },
        },
        // A bookshop's attributes: English names, while the shop page is in Norwegian.
        { id: 'b-form', name: 'Product Form', dataType: 'text', contextAware: true },
        { id: 'b-altformat', name: 'Alternative Format', dataType: 'text', contextAware: true },
        { id: 'b-imprint', name: 'Imprint Name', dataType: 'text', contextAware: true },
        { id: 'b-author', name: 'ByAuthor', dataType: 'multiline', contextAware: true },
        { id: 'b-translator', name: 'TranslatedBy', dataType: 'multiline', contextAware: true },
        { id: 'b-origtitle', name: 'Original title', dataType: 'text', contextAware: true },
        { id: 'b-weight', name: 'Unit Weight', dataType: 'decimal', unit: 'gr', contextAware: false },
        { id: 'b-height', name: 'Height', dataType: 'decimal', unit: 'mm', contextAware: false },
        { id: 'b-pages', name: 'Sidetall', dataType: 'integer', unit: 'Sider', contextAware: false },
        { id: 'b-first', name: 'Første utgivelsesdato', dataType: 'date', contextAware: false },
        { id: 'b-series', name: 'Series Title 1', dataType: 'text', contextAware: true },
        { id: 'b-desc', name: 'Description text', dataType: 'multiline', contextAware: true },
      ],
      dictionary: { 'd-brand:b-nordic': { en: 'Nordic Thread', L1843: 'Nordic Thread' } },
      users: {
        'u-anna': { id: 'u-anna', name: 'Anna Berg', email: 'anna@example.com', status: 'ACTIVE' },
        'u-ola': { id: 'u-ola', name: 'Ola Nordmann', email: 'ola@example.com', status: 'ACTIVE' },
      },
      userGroups: [{ id: 'g-data', name: 'Product data team' }],
      // The media library: two pictures of the book, and its sample chapter (not a picture).
      assets: {
        'a-cover': { id: 'a-cover', metadata: { name: { value: { en: 'Fri, front cover' } } }, mediaInfo: { mediaType: 'IMAGE', fileKey: 'org/cover.png', contentType: 'image/png', width: 600, height: 900 } },
        'a-back': { id: 'a-back', metadata: { name: { value: { en: 'Fri, back cover' } } }, mediaInfo: { mediaType: 'IMAGE', fileKey: 'org/back.png', contentType: 'image/png', width: 600, height: 900 } },
        'a-sample': { id: 'a-sample', metadata: { name: { value: { en: 'Fri, sample chapter' } } }, mediaInfo: { mediaType: 'DOCUMENT', fileKey: 'org/sample.pdf', contentType: 'application/pdf' } },
      },
      tasks: [],
      products: {
        fam: {
          id: 'fam', number: 'SCD', name: 'Summer Cotton Dress', type: 'FAMILY', productGroups: ['grp-blue', 'grp-black'],
          attributes: [
            attr('d-material', ['100% organic cotton'], { copy: true, locked: true, mandatory: true }),
            attr('d-care', ['Machine wash at 30°C'], { copy: true }),
            attr('d-fit', ['Regular fit']),
            Object.assign({ definitionId: 'd-brand', dictionary: ['b-nordic'] }, { copy: true }),
            attr('d-colour', [], { copy: true, definingAttributes: true }),
          ],
        },
        'grp-blue': {
          id: 'grp-blue', number: 'SCD-BLU', name: 'Summer Cotton Dress, Blue', type: 'GROUP', groupParentId: 'fam',
          productVariants: ['v-s', 'v-m', 'v-l'],
          attributes: [
            // Inheritance is set per level: the group passes these on to its variants too.
            attr('d-material', ['100% organic cotton'], { readOnly: true, copy: true, locked: true }),
            attr('d-care', ['Machine wash at 30°C'], { copy: true }),
            { definitionId: 'd-brand', dictionary: ['b-nordic'], copy: true },
            attr('d-colour', ['c-blue'], { copy: true }),
            attr('d-weight', ['180'], { copy: true }),
            attr('d-size', [], { copy: true, definingAttributes: true }),
          ],
        },
        'grp-black': {
          id: 'grp-black', number: 'SCD-BLK', name: 'Summer Cotton Dress, Black', type: 'GROUP', groupParentId: 'fam',
          productVariants: ['v-bk-s', 'v-bk-m'],
          attributes: [attr('d-material', ['100% organic cotton']), attr('d-colour', ['c-black'], { copy: true })],
        },
        'v-m': {
          id: 'v-m', number: 'SCD-BLU-M', name: 'Summer Cotton Dress, Blue, M', type: 'VARIANT', variantParentId: 'grp-blue',
          description: 'A light summer dress in organic cotton.',
          attributes: [
            attr('d-material', ['100% organic cotton'], { readOnly: true }),
            attr('d-care', ['Machine wash at 30°C']),
            { definitionId: 'd-brand', dictionary: ['b-nordic'] },
            attr('d-colour', ['c-blue']),
            attr('d-weight', ['180']),
            attr('d-size', ['s-m']),
            attr('d-ean', ['7310000000017']),
          ],
        },
        book: {
          id: 'book', number: '9788205593619', name: 'Fri', type: 'SINGLE', assets: ['a-cover', 'a-back', 'a-sample'],
          attributes: [
            attr('b-form', ['Pocket']),
            attr('b-altformat', ['20221025152039557']),
            attr('b-imprint', ['Gyldendal']),
            attr('b-author', ['{"name" : "Lea Ypi", "id" : "750587", "number" : 1}']),
            attr('b-translator', ['{"name" : "Inger Sverreson Holmes", "id" : "701777", "number" : 2}']),
            attr('b-origtitle', ['Free']),
            attr('b-weight', ['240']),
            attr('b-height', ['210']),
            attr('b-pages', ['316']),
            attr('b-first', ['2023-09-22']),
            attr('b-series', ['Gyldendal pocket']),
            attr('b-desc', ['Boka følger en familie gjennom tre tiår i en liten by ved kysten. <br> <br>Den handler om hverdager, valg og håp mens alt rundt dem forandrer seg.']),
          ],
        },
        // A product with variants whose ids are the PIM's own kind (24 hex), as a page fed straight
        // from the PIM puts them in its address (test/shop/content-store.html).
        '64b7f0a1c2d3e4f5a6b7c8d9': {
          id: '64b7f0a1c2d3e4f5a6b7c8d9', number: '7001', name: 'Linen Shirt Group', type: 'GROUP',
          productVariants: ['64b7f0a1c2d3e4f5a6b7c8da', '64b7f0a1c2d3e4f5a6b7c8db'],
          attributes: [attr('d-material', ['Linen'], { copy: true }), attr('d-care', ['Hand wash'], { copy: true })],
        },
        '64b7f0a1c2d3e4f5a6b7c8da': {
          id: '64b7f0a1c2d3e4f5a6b7c8da', number: '7001-a', name: 'Linen Shirt', type: 'VARIANT', variantParentId: '64b7f0a1c2d3e4f5a6b7c8d9',
          attributes: [attr('d-material', ['Linen']), attr('d-care', ['Hand wash']), attr('d-fit', ['Slim']), attr('d-size', ['s-l']), attr('d-weight', ['210'])],
        },
        '64b7f0a1c2d3e4f5a6b7c8db': {
          id: '64b7f0a1c2d3e4f5a6b7c8db', number: '7001-b', name: 'Linen Shirt', type: 'VARIANT', variantParentId: '64b7f0a1c2d3e4f5a6b7c8d9',
          attributes: [attr('d-material', ['Linen']), attr('d-care', ['Hand wash']), attr('d-fit', ['Regular fit']), attr('d-size', ['s-m']), attr('d-weight', ['200'])],
        },
        'v-s': { id: 'v-s', number: 'SCD-BLU-S', name: 'Summer Cotton Dress, Blue, S', type: 'VARIANT', variantParentId: 'grp-blue', attributes: [attr('d-weight', ['180']), attr('d-size', ['s-s'])] },
        'v-l': { id: 'v-l', number: 'SCD-BLU-L', name: 'Summer Cotton Dress, Blue, L', type: 'VARIANT', variantParentId: 'grp-blue', attributes: [attr('d-weight', ['195']), attr('d-size', ['s-l'])] },
        'v-bk-s': { id: 'v-bk-s', number: 'SCD-BLK-S', name: 'Summer Cotton Dress, Black, S', type: 'VARIANT', variantParentId: 'grp-black', attributes: [] },
        'v-bk-m': { id: 'v-bk-m', number: 'SCD-BLK-M', name: 'Summer Cotton Dress, Black, M', type: 'VARIANT', variantParentId: 'grp-black', attributes: [] },
      },
      history: {
        'grp-blue': [
          { date: Date.UTC(2026, 9, 28, 9, 13), userId: 'u-anna', eventType: 'PRODUCT_WATCH_ATTRIBUTE_UPDATE_VALUE', metadata: [{ entity: 'd-weight', field: 'Weight', value: '180', oldValue: '175' }] },
        ],
        fam: [
          { date: Date.UTC(2026, 8, 2, 14, 40), userId: 'u-anna', eventType: 'PRODUCT_WATCH_ATTRIBUTE_UPDATE_VALUE', metadata: [{ entity: 'd-care', field: 'Care instructions', value: 'Machine wash at 30°C', oldValue: 'Machine wash at 40°C' }] },
        ],
      },
    };
  }

  /**
   * options.signedOut: every call fails as "not signed in". options.user: { id, name } of who is signed in.
   * Returns { request, db, calls } where calls lists every write that was made.
   */
  function createMock(options) {
    const full = fixture();
    // A second organisation with the same languages and no products, to test switching.
    const empty = { contexts: full.contexts, definitions: [], dictionary: {}, users: full.users, userGroups: [], tasks: [], assets: {}, products: {}, history: {} };
    const orgs = [{ id: 'org-nordic', name: 'Nordic Thread Demo' }, { id: 'org-empty', name: 'Empty Sandbox' }];
    let currentOrg = 'org-nordic';
    let db = full;
    const calls = [];
    const opts = Object.assign({}, options);
    // Signing out and in again (as another user, when one is given), as a person does in the PIM.
    const signOut = () => void (opts.signedOut = true);
    const signIn = (user) => void Object.assign(opts, { signedOut: false }, user ? { user } : {});
    const tokens = (t) => String(t || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    function switchOrg(id) {
      if (!orgs.some((o) => o.id === id)) return false;
      currentOrg = id;
      db = id === 'org-nordic' ? full : empty;
      return true;
    }

    function fail(kind, status, message) {
      const e = new Error(message);
      e.name = 'PimError';
      e.kind = kind;
      e.status = status;
      throw e;
    }
    const meta = (p) => ({ number: p.number, type: p.type, name: { value: { en: p.name } }, variantParentId: p.variantParentId, groupParentId: p.groupParentId });
    const view = (p) => ({ id: p.id, metadata: meta(p), productVariants: p.productVariants || [], productGroups: p.productGroups || [] });
    const childrenOf = (p) => (p.productVariants || []).concat(p.productGroups || []).map((id) => db.products[id]).filter(Boolean);

    async function request({ service, method, path, query, body, context }) {
      if (opts.signedOut) fail('auth', 401, 'Not signed in to Bluestone PIM.');
      const m = method || 'GET';
      let match;
      if (service === 'settings' && path === '/context') return { ok: true, status: 200, data: { data: db.contexts } };
      if (service === 'auth' && path === '/me') {
        const org = orgs.find((o) => o.id === currentOrg);
        const permissions = { READ: ['TASKS'], ADD: opts.noTasks ? [] : ['TASKS'], UPDATE: opts.readOnlyUser ? ['TASKS'] : ['TASKS', 'PRODUCTS', 'ATTRIBUTES'] };
        return { ok: true, status: 200, data: { id: (opts.user && opts.user.id) || 'u-anna', name: (opts.user && opts.user.name) || 'Anna Berg', organization: org.id, organizationName: org.name, permissions } };
      }
      if (service === 'idp' && path === '/organizations') return { ok: true, status: 200, data: orgs.map((o) => Object.assign({ mfa: { enabled: false } }, o)) };
      if (service === 'search' && path === '/find') {
        const want = new Set(tokens(query.query));
        const scored = Object.values(db.products)
          .map((p) => {
            const have = new Set(tokens(p.name));
            const common = [...want].filter((t) => have.has(t)).length;
            return { p, score: common ? (2 * common) / (want.size + have.size) : 0 };
          })
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, Number(query.pageSize) || 10);
        return { ok: true, status: 200, data: { data: scored.map((x) => ({ id: x.p.id, name: x.p.name.toLowerCase() })), total: scored.length } };
      }
      if (service === 'query' && m === 'POST' && path === '/products/search') {
        const terms = body.query.children;
        for (const t of terms) {
          const def = db.definitions.find((d) => d.id === t.attributeId);
          if (def && def.dataType !== 'text' && !/^\d+([.,]\d+)?$/.test(String(t.value))) fail('http', 400, `Number format exception: For input string: "${t.value}"`);
        }
        const hits = Object.values(db.products).filter((p) =>
          terms.some((t) => (p.attributes || []).some((a) => a.definitionId === t.attributeId && (a.values || []).includes(String(t.value)))));
        return { ok: true, status: 200, data: { data: hits.map((p) => ({ id: p.id })) } };
      }

      if (service === 'pim' && m === 'POST' && path === '/products/list/views/by-numbers') {
        const found = Object.values(db.products).filter((p) => body.numbers.includes(p.number));
        return { ok: true, status: 200, data: { data: found.map(view) } };
      }
      if (service === 'pim' && m === 'POST' && path === '/products/list/views/by-ids') {
        return { ok: true, status: 200, data: { data: body.ids.map((id) => db.products[id]).filter(Boolean).map(view) } };
      }
      if (service === 'pim' && m === 'POST' && path === '/definitions/list') {
        const filter = body.filters && body.filters[0];
        const rows = filter ? db.definitions.filter((d) => filter.values.includes(d.id)) : db.definitions;
        return { ok: true, status: 200, data: { data: body.page ? [] : rows } };
      }
      if (service === 'pim' && m === 'GET' && (match = /^\/definitions\/dictionary\/([^/]+)\/values\/([^/]+)$/.exec(path))) {
        const labels = db.dictionary[match[1] + ':' + match[2]];
        if (!labels) fail('http', 404, 'Not found');
        return { ok: true, status: 200, data: { id: match[2], definitionId: match[1], value: { value: labels } } };
      }
      if (service === 'pim' && m === 'GET' && (match = /^\/products\/([^/]+)$/.exec(path))) {
        const p = db.products[decodeURIComponent(match[1])];
        if (!p) fail('http', 404, 'Product not found');
        return { ok: true, status: 200, data: JSON.parse(JSON.stringify(p)) };
      }
      if (service === 'history' && (match = /^\/history\/PRODUCT\/([^/]+)$/.exec(path))) {
        let events = db.history[match[1]] || [];
        if (query && query.metadataEntityId) events = events.filter((e) => (e.metadata || []).some((x) => x.entity === query.metadataEntityId));
        return { ok: true, status: 200, data: { data: events } };
      }
      if (service === 'idp' && m === 'GET' && path === '/users') return { ok: true, status: 200, data: Object.values(db.users) };
      if (service === 'idp' && m === 'GET' && path === '/userGroups/list') return { ok: true, status: 200, data: { userGroups: db.userGroups || [] } };
      if (service === 'media' && m === 'POST' && path === '/assets/views/by-ids') {
        return { ok: true, status: 200, data: { data: (body.ids || []).map((id) => (db.assets || {})[id]).filter(Boolean) } };
      }
      if (service === 'tasks' && m === 'GET' && path === '/tasks') return { ok: true, status: 200, data: { data: db.tasks || [] } };
      if (service === 'tasks' && m === 'POST' && path === '/tasks') {
        if (opts.noTasks) fail('permission', 403, 'Access denied');
        if (!body.title || !body.assignee) fail('http', 400, 'title and assignee are required');
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(body.dueDate))) fail('http', 400, `Unable to parse the due date [${body.dueDate}]`);
        const task = Object.assign({ id: 'task-' + ((db.tasks || []).length + 1), status: 'New', creator: 'u-anna', productsList: [] }, body);
        (db.tasks = db.tasks || []).push(task);
        calls.push({ method: m, path, body });
        // Like the live API: no body, the new id in a header.
        return { ok: true, status: 201, data: null, resourceId: task.id };
      }
      if (service === 'tasks' && m === 'POST' && (match = /^\/tasks\/([^/]+)\/products$/.exec(path))) {
        const task = (db.tasks || []).find((t) => t.id === match[1]);
        if (!task) fail('http', 404, 'Task not found');
        for (const id of body.productIds || []) {
          if (!db.products[id]) fail('http', 400, 'Unknown product');
          task.productsList.push({ productId: id, isDone: false });
        }
        calls.push({ method: m, path, body });
        return { ok: true, status: 202, data: null };
      }
      if (service === 'idp' && (match = /^\/users\/([^/]+)$/.exec(path))) {
        const u = db.users[match[1]];
        if (!u) fail('http', 404, 'User not found');
        return { ok: true, status: 200, data: u };
      }

      // ---- writes ----
      if (opts.readOnlyUser && service === 'pim' && (m === 'PUT' || m === 'PATCH')) fail('permission', 403, 'Access denied');
      if (service === 'pim' && m === 'PUT' && (match = /^\/products\/([^/]+)\/attributes\/([^/]+)$/.exec(path))) {
        const p = db.products[match[1]];
        const a = p && p.attributes.find((x) => x.definitionId === match[2]);
        if (!a) fail('http', 404, 'Attribute not found on product');
        if (a.readOnly) fail('http', 400, 'Attribute is locked by the parent product');
        calls.push({ method: m, path, query, body, context });
        const before = a.values.slice();
        a.values = body.values.slice();
        if (a.copy && !a.definingAttributes) {
          const force = query && query.forceVla === 'true';
          const push = (parent) => {
            for (const child of childrenOf(parent)) {
              const ca = child.attributes.find((x) => x.definitionId === match[2]);
              if (!ca) child.attributes.push({ definitionId: match[2], values: body.values.slice() });
              else if (force || !ca.values.length) ca.values = body.values.slice();
              if (!ca || ca.copy) push(child);
            }
          };
          push(p);
        }
        (db.history[p.id] = db.history[p.id] || []).unshift({
          date: Date.now(), userId: 'u-anna', eventType: 'PRODUCT_WATCH_ATTRIBUTE_UPDATE_VALUE',
          metadata: [{ entity: match[2], value: body.values[0], oldValue: before[0] }],
        });
        return { ok: true, status: 204, data: null };
      }
      if (service === 'pim' && m === 'PATCH' && (match = /^\/products\/([^/]+)$/.exec(path))) {
        const p = db.products[match[1]];
        if (!p) fail('http', 404, 'Product not found');
        calls.push({ method: m, path, body, context });
        if (body.name) p.name = body.name.value;
        return { ok: true, status: 204, data: null };
      }
      fail('http', 404, `Mock PIM has no route for ${m} ${service}${path}`);
    }

    return { request, calls, switchOrg, signOut, signIn, orgs, get db() { return db; } };
  }

  const api = { createMock };
  root.BSI = Object.assign(root.BSI || {}, { mock: api });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
