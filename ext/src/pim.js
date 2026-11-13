/*
 * A small client for the Bluestone PIM endpoints the inspector needs.
 *
 * It is transport-agnostic: `request({ service, method, path, query, body, context })`
 * does the HTTP call and returns { ok, status, data }. The extension uses
 * sessionTransport (the signed-in user's own PIM session, so every call runs with
 * that user's permissions); the tests use a mock.
 *
 * Paths are the documented PIM routes (docs.api.bluestonepim.com). The service
 * prefixes are the ones the PIM web app itself uses (/api/pim/…), as documented
 * for in-app plugins.
 */
(function (root) {
  'use strict';

  const SERVICE_PREFIX = {
    pim: '/api/pim',
    history: '/api/history',
    settings: '/api/global-settings',
    idp: '/api/idp',
    search: '/api/search',
    query: '/api/query-builder',
    auth: '/auth',
    tasks: '/api/tasks',
    media: '/api/media-bank',
  };

  const TIMEOUT_MS = 25000;

  class PimError extends Error {
    constructor(message, info) {
      super(message);
      this.name = 'PimError';
      Object.assign(this, info || {});
    }
  }

  /** Calls the PIM app's own API with the browser's signed-in session. */
  function sessionTransport(baseUrl, fetchImpl) {
    const doFetch = fetchImpl || fetch.bind(globalThis);
    return async function request({ service, method, path, query, body, context, headers: extra }) {
      const qs = query ? '?' + new URLSearchParams(query).toString() : '';
      const url = baseUrl.replace(/\/$/, '') + SERVICE_PREFIX[service] + path + qs;
      const headers = { Accept: 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (context) {
        headers.context = context;
        if (!method || method === 'GET' || /\/list(\/|$)/.test(path)) headers['context-fallback'] = 'true';
      }
      Object.assign(headers, extra || {});
      let res;
      // A PIM that does not answer must not leave the Lens waiting for ever.
      const abort = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = abort ? setTimeout(() => abort.abort(), TIMEOUT_MS) : null;
      try {
        res = await doFetch(url, {
          method: method || 'GET',
          headers,
          credentials: 'include',
          redirect: 'manual',
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: abort ? abort.signal : undefined,
        });
      } catch (e) {
        if (timer) clearTimeout(timer);
        const slow = abort && abort.signal.aborted;
        throw new PimError(slow ? 'Bluestone PIM took too long to answer.' : 'Could not reach Bluestone PIM.', { kind: 'network', cause: e });
      }
      const type = res.headers.get('content-type') || '';
      // Not signed in: the app answers 401/403, or redirects to its login page.
      if (res.status === 401 || res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        if (timer) clearTimeout(timer);
        throw new PimError('Not signed in to Bluestone PIM.', { kind: 'auth', status: res.status });
      }
      let data = null;
      let text = '';
      if (res.status !== 204 && type.includes('json')) data = await res.json().catch(() => null);
      else if (res.status !== 204) text = await res.text().catch(() => '');
      if (timer) clearTimeout(timer);
      if (abort && abort.signal.aborted) throw new PimError('Bluestone PIM took too long to answer.', { kind: 'network' });
      if (!res.ok) {
        const msg = (data && (data.message || data.error || data.errorMessage)) || `PIM answered ${res.status}.`;
        throw new PimError(String(msg), { kind: res.status === 403 ? 'permission' : 'http', status: res.status, data });
      }
      // A page where data was expected is the app's sign-in screen. (Creates answer with no body at all.)
      if (text.trim()) throw new PimError('Not signed in to Bluestone PIM.', { kind: 'auth', status: res.status });
      return { ok: true, status: res.status, data, resourceId: res.headers.get('resource-id') || null };
    };
  }

  function createPim(request) {
    const list = (r) => (r.data && r.data.data) || [];

    return {
      /** The signed-in user: { id, name, organization, organizationName, … } */
      async me() {
        return (await request({ service: 'auth', path: '/me' })).data || {};
      },

      /** Every organisation the user can switch to: [{ id, name }] */
      async organizations() {
        const r = await request({ service: 'idp', path: '/organizations' });
        const rows = Array.isArray(r.data) ? r.data : list(r);
        return rows.map((o) => ({ id: o.id, name: o.name || o.id }));
      },

      /** All attribute definitions of the organisation (for spotting identifier attributes). */
      async allDefinitions(context) {
        const out = [];
        for (let page = 0; page < 6; page++) {
          const r = await request({ service: 'pim', method: 'POST', path: '/definitions/list', body: { page, pageSize: 500 }, context });
          const rows = list(r);
          out.push(...rows);
          if (rows.length < 500) break;
        }
        return out;
      },

      /** Fuzzy full-text search, as the PIM's own search box does: [{ id, name }] best first. */
      async searchText(text, context, pageSize) {
        const r = await request({
          service: 'search',
          path: '/find',
          query: { query: text, context: context || 'en', pageSize: String(pageSize || 8), archiveState: 'ACTIVE' },
        });
        return list(r).map((x) => ({ id: x.id, name: x.name || '' }));
      },

      /**
       * Products where one of the attributes holds one of the values, exactly.
       * pairs: [{ definitionId, dataType, value }] -> [productId]
       */
      async searchAttributes(pairs, context) {
        if (!pairs.length) return [];
        const children = pairs.map((p) => ({
          termType: 'attribute',
          attributeType: p.dataType,
          filterType: 'is',
          context: context || 'en',
          attributeId: p.definitionId,
          value: p.value,
        }));
        const r = await request({
          service: 'query',
          method: 'POST',
          path: '/products/search',
          query: { archiveState: 'ACTIVE' },
          body: { query: { matchRule: 'any', contextFallback: true, children }, paging: { page: 0, pageSize: 10 } },
          headers: { 'context-fallback': 'true' },
        });
        return list(r).map((x) => x.id);
      },

      /** Languages/contexts: [{ id, name, locale, initial, fallback }] */
      async contexts() {
        return list(await request({ service: 'settings', path: '/context', query: { contextState: 'ACTIVE' } }));
      },

      /** Exact product numbers -> [{ id, number, name, type }] */
      async findByNumbers(numbers, context) {
        const r = await request({
          service: 'pim',
          method: 'POST',
          path: '/products/list/views/by-numbers',
          body: { numbers, views: [{ type: 'METADATA' }] },
          context,
        });
        return list(r).map((p) => metaOf(p, context));
      },

      /** Ids -> [{ id, number, name, type, productVariants, productGroups }] */
      async summaries(ids, context) {
        const out = [];
        for (let i = 0; i < ids.length; i += 100) {
          const r = await request({
            service: 'pim',
            method: 'POST',
            path: '/products/list/views/by-ids',
            body: { ids: ids.slice(i, i + 100), views: [{ type: 'METADATA' }, { type: 'VARIANTS' }, { type: 'GROUPS' }] },
            context,
          });
          for (const p of list(r)) {
            out.push(Object.assign(metaOf(p, context), { productVariants: p.productVariants || [], productGroups: p.productGroups || [] }));
          }
        }
        return out;
      },

      /** Full product: metadata, parents, children and attributes with inheritance flags. */
      async product(id, context) {
        return (await request({ service: 'pim', path: `/products/${encodeURIComponent(id)}`, context })).data;
      },

      /** Attribute definitions by id -> [{ id, name, dataType, unit, contextAware, restrictions }] */
      async definitions(ids, context) {
        const out = [];
        for (let i = 0; i < ids.length; i += 200) {
          const r = await request({
            service: 'pim',
            method: 'POST',
            path: '/definitions/list',
            body: { filters: [{ type: 'ID_IN', values: ids.slice(i, i + 200) }], page: 0, pageSize: 200 },
            context,
          });
          out.push(...list(r));
        }
        return out;
      },

      /** One dictionary value's label for the context. */
      async dictionaryLabel(definitionId, valueId, context) {
        const r = await request({
          service: 'pim',
          path: `/definitions/dictionary/${encodeURIComponent(definitionId)}/values/${encodeURIComponent(valueId)}`,
          context,
        });
        const v = r.data && (r.data.value ? r.data : r.data.data);
        const map = (v && v.value && v.value.value) || {};
        return map[context] || Object.values(map)[0] || valueId;
      },

      /** Latest change to one field of a product: { date, userId, value, oldValue } or null. */
      async lastChange(productId, { definitionId, field, context }) {
        const query = { page: 0, pageSize: 5 };
        if (definitionId) query.metadataEntityId = definitionId;
        if (field) query.field = field;
        if (context) query.context = context;
        const r = await request({ service: 'history', path: `/history/PRODUCT/${encodeURIComponent(productId)}`, query });
        const events = list(r).slice().sort((a, b) => (b.date || 0) - (a.date || 0));
        const e = events[0];
        if (!e) return null;
        const m = (e.metadata || [])[0] || {};
        const label = (v) => (typeof v === 'string' ? v.replace(/^[0-9a-f]{24},/, '') : v);
        return { date: e.date, userId: e.userId, origin: e.origin, value: label(m.value), oldValue: label(m.oldValue) };
      },

      async userName(userId) {
        const r = await request({ service: 'idp', path: `/users/${encodeURIComponent(userId)}` });
        const u = r.data && (r.data.name || r.data.email ? r.data : r.data.data);
        return (u && (u.name || u.email)) || null;
      },

      /**
       * A product's files in the media library, images only:
       * [{ id, name, fileKey, width, height, contentType }] in the order asked for.
       */
      async assetViews(ids, context) {
        if (!ids.length) return [];
        const r = await request({ service: 'media', method: 'POST', path: '/assets/views/by-ids', body: { ids: ids.slice(0, 100), views: [{ type: 'METADATA' }, { type: 'MEDIAINFO' }] }, context });
        const rows = list(r);
        return ids
          .map((id) => rows.find((a) => a.id === id))
          .filter(Boolean)
          .map((a) => {
            const info = a.mediaInfo || {};
            const meta = a.metadata || {};
            return {
              id: a.id,
              name: langValue(meta.name, context) || meta.fileName || meta.number || a.id,
              fileKey: info.fileKey || '',
              width: info.width || 0,
              height: info.height || 0,
              contentType: info.contentType || '',
              image: info.mediaType ? info.mediaType === 'IMAGE' : /^image\//.test(info.contentType || ''),
            };
          })
          .filter((a) => a.image && a.fileKey);
      },

      /** People a task can go to: [{ id, name }] */
      async users() {
        const r = await request({ service: 'idp', path: '/users' });
        const rows = Array.isArray(r.data) ? r.data : list(r);
        return rows.filter((u) => !u.status || /active/i.test(u.status)).map((u) => ({ id: u.id, name: u.name || u.email || u.id }));
      },

      /** User groups a task can go to: [{ id, name }] */
      async userGroups() {
        const r = await request({ service: 'idp', path: '/userGroups/list' });
        const rows = (r.data && (r.data.userGroups || r.data.data)) || [];
        return rows.map((g) => ({ id: g.id, name: g.name || g.id }));
      },

      /** Open tasks, newest ids last: [{ id, title, creator, assignee }] */
      async tasks() {
        return list(await request({ service: 'tasks', path: '/tasks', query: { sortField: 'TITLE', sortDirection: 'ASC', page: 0, pageSize: 1000 } }));
      },

      // ---- writes (only ever called after an explicit confirm on the page or in the panel) ----

      /**
       * Create a task. assignee is a user id or user group id; dueDate a UTC instant
       * ("2026-11-20T12:00:00Z"). Returns { id } (null if the PIM did not say which id it got).
       */
      async createTask({ title, description, assignee, assigneeType, dueDate, context }) {
        const body = { title, description: description || '', assignee, assigneeType: assigneeType || 'user', dueDate };
        if (context) body.context = context;
        const r = await request({ service: 'tasks', method: 'POST', path: '/tasks', body });
        return { id: r.resourceId || (r.data && (r.data.id || (r.data.data && r.data.data.id))) || null };
      },

      /** Put products on a task, so it opens with them listed. */
      async addTaskProducts(taskId, productIds) {
        return request({ service: 'tasks', method: 'POST', path: `/tasks/${encodeURIComponent(taskId)}/products`, body: { productIds } });
      },

      /** Scalars: values = ["475"]. Selects: values = [optionId, …]. */
      async updateAttribute(productId, definitionId, values, { context, forceVla, select }) {
        const body = select ? { values, selectValueIds: values } : { value: values[0], values };
        return request({
          service: 'pim',
          method: 'PUT',
          path: `/products/${encodeURIComponent(productId)}/attributes/${encodeURIComponent(definitionId)}`,
          query: { forceVla: forceVla ? 'true' : 'false' },
          body,
          context,
        });
      },

      async updateName(productId, name, context) {
        return request({
          service: 'pim',
          method: 'PATCH',
          path: `/products/${encodeURIComponent(productId)}`,
          body: { name: { value: name } },
          context,
        });
      },
    };
  }

  function langValue(dto, context) {
    if (dto == null) return '';
    if (typeof dto === 'string') return dto;
    const map = dto.value || {};
    return map[context] || Object.values(map).find(Boolean) || '';
  }

  function metaOf(p, context) {
    const m = p.metadata || p;
    return { id: p.id || m.id, number: m.number || '', name: langValue(m.name, context), type: m.type || '' };
  }

  const api = { createPim, sessionTransport, PimError, SERVICE_PREFIX, langValue };
  root.BSI = Object.assign(root.BSI || {}, { pim: api });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
