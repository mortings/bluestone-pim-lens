/*
 * A picture's fingerprint, for telling whether two files show the same picture
 * although one has been resized, renamed or saved again (a shop's copy of a PIM
 * image). Two parts:
 *   - shape: the brightness of each cell of a 16x16 grid
 *   - colour: the average colour of each cell of a 3x3 grid
 * The same picture at another size gives almost the same fingerprint. A cropped
 * picture, or another picture with a similar layout, does not: besides the average
 * difference, the share of cells that differ strongly is counted, so two mostly
 * white covers with different titles are told apart.
 */
(function (root) {
  'use strict';

  const W = 64;
  const H = 64;
  const GRID = 16; // cells per side, 4 px each
  const SHAPE_HEX = GRID * GRID * 2;
  const COLOUR_HEX = 54;
  const TIMEOUT_MS = 15000;
  const MAX_BYTES = 25 * 1024 * 1024;
  const MAX_PIXELS = 50 * 1000 * 1000;
  const MAX_UNKNOWN_BYTES = 3 * 1024 * 1024; // a format whose size cannot be read up front (AVIF) must at least be small

  /** Width and height as a PNG, GIF, JPEG or WebP file states them in its header; null for anything else. */
  function dimensions(b) {
    const u16 = (i) => (b[i] << 8) | b[i + 1];
    const u32 = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const le16 = (i) => b[i] | (b[i + 1] << 8);
    const le24 = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
    const tag = (i, s) => s.split('').every((c, n) => b[i + n] === c.charCodeAt(0));
    if (b.length >= 24 && b[0] === 0x89 && tag(1, 'PNG')) return { width: u32(16), height: u32(20) };
    if (b.length >= 10 && tag(0, 'GIF8')) return { width: le16(6), height: le16(8) };
    if (b.length >= 30 && tag(0, 'RIFF') && tag(8, 'WEBP')) {
      if (tag(12, 'VP8X')) return { width: le24(24) + 1, height: le24(27) + 1 };
      if (tag(12, 'VP8L')) {
        const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
        return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 };
      }
      if (tag(12, 'VP8 ')) return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
      return null;
    }
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
      // JPEG: walk the segments to the frame header.
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: u16(i + 7), height: u16(i + 5) };
        i += 2 + u16(i + 2);
      }
      return null;
    }
    return null;
  }
  const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');

  /** pixels: RGBA bytes of the picture drawn at 64x64. Returns "<512 hex>:<54 hex>". */
  function signature(pixels) {
    const cell = (x0, y0, w, h) => {
      let r = 0, g = 0, b = 0;
      for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
          const i = (y * W + x) * 4;
          r += pixels[i];
          g += pixels[i + 1];
          b += pixels[i + 2];
        }
      }
      const n = w * h;
      return [r / n, g / n, b / n];
    };
    const size = W / GRID;
    let shape = '';
    for (let row = 0; row < GRID; row++) {
      for (let col = 0; col < GRID; col++) {
        const [r, g, b] = cell(col * size, row * size, size, size);
        shape += hex2(0.299 * r + 0.587 * g + 0.114 * b);
      }
    }
    let colour = '';
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const x0 = Math.round((col * W) / 3);
        const x1 = Math.round(((col + 1) * W) / 3);
        const y0 = Math.round((row * H) / 3);
        const y1 = Math.round(((row + 1) * H) / 3);
        for (const v of cell(x0, y0, x1 - x0, y1 - y0)) colour += hex2(v);
      }
    }
    return `${shape}:${colour}`;
  }

  const bytes = (hex) => {
    const out = [];
    for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
    return out;
  };

  /**
   * How different two fingerprints are, or null when one is not a fingerprint:
   *   shape:  average brightness difference per cell (0-255), overall brightness ignored
   *   strong: share of cells that differ a lot (0-1)
   *   colour: average colour difference (0-255)
   */
  function distance(a, b) {
    const pa = String(a || '').split(':');
    const pb = String(b || '').split(':');
    if (pa.length !== 2 || pb.length !== 2 || pa[0].length !== SHAPE_HEX || pb[0].length !== SHAPE_HEX || pa[1].length !== COLOUR_HEX || pb[1].length !== COLOUR_HEX) return null;
    const ga = bytes(pa[0]);
    const gb = bytes(pb[0]);
    const mean = (list) => list.reduce((s, v) => s + v, 0) / list.length;
    const ma = mean(ga);
    const mb = mean(gb);
    let sum = 0;
    let strong = 0;
    for (let i = 0; i < ga.length; i++) {
      const d = Math.abs(ga[i] - ma - (gb[i] - mb));
      sum += d;
      if (d > 24) strong++;
    }
    const ca = bytes(pa[1]);
    const cb = bytes(pb[1]);
    let colour = 0;
    for (let i = 0; i < ca.length; i++) colour += Math.abs(ca[i] - cb[i]);
    return { shape: sum / ga.length, strong: strong / ga.length, colour: colour / ca.length };
  }

  /** The same picture? */
  function same(a, b) {
    const d = distance(a, b);
    return !!d && d.shape <= 8 && d.strong <= 0.08 && d.colour <= 36;
  }

  function canvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  async function toDataUrl(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return `data:${blob.type || 'image/jpeg'};base64,${btoa(s)}`;
  }

  /**
   * Fetch a picture and fingerprint it. options: credentials ('include' for the PIM
   * session), dataUrl (also return the picture itself, for showing a thumbnail).
   * Returns { hash, width, height, dataUrl? }. Throws when it cannot be read.
   */
  async function read(url, options) {
    const opts = options || {};
    // A picture host that never answers, or a file that is far too large, is given up on.
    const abort = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = abort ? setTimeout(() => abort.abort(), TIMEOUT_MS) : null;
    let blob;
    try {
      const res = await fetch(url, { credentials: opts.credentials || 'omit', redirect: 'follow', signal: abort ? abort.signal : undefined });
      if (!res.ok) throw new Error(`Picture answered ${res.status}`);
      const type = (res.headers.get('content-type') || '').toLowerCase();
      if (type && !/^(image\/|application\/octet-stream|binary\/)/.test(type)) throw new Error('Not a picture');
      if (Number(res.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('Picture too large');
      // Read piece by piece, and stop as soon as it is more than a picture should be.
      const parts = [];
      let size = 0;
      const reader = res.body && res.body.getReader ? res.body.getReader() : null;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_BYTES) {
            reader.cancel().catch(() => {});
            throw new Error('Picture too large');
          }
          parts.push(value);
        }
        blob = new Blob(parts, { type: type.split(';')[0] });
      } else {
        blob = await res.blob();
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (blob.size > MAX_BYTES) throw new Error('Picture too large');
    // The size the file says it has, read from its first bytes, before anything is unpacked:
    // a small file can claim to be an enormous picture.
    const claimed = dimensions(new Uint8Array(await blob.slice(0, 65536).arrayBuffer()));
    if (claimed ? claimed.width * claimed.height > MAX_PIXELS : blob.size > MAX_UNKNOWN_BYTES) throw new Error('Picture too large');
    const bitmap = await createImageBitmap(blob);
    if (bitmap.width * bitmap.height > MAX_PIXELS) {
      if (bitmap.close) bitmap.close();
      throw new Error('Picture too large');
    }
    const c = canvas(W, H);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; // a transparent picture is compared as on white
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, W, H);
    const out = { hash: signature(ctx.getImageData(0, 0, W, H).data), width: bitmap.width, height: bitmap.height };
    if (opts.dataUrl && blob.size <= 400000) out.dataUrl = await toDataUrl(blob);
    if (bitmap.close) bitmap.close();
    return out;
  }

  const api = { signature, distance, same, read, dimensions, W, H };
  root.BSI = Object.assign(root.BSI || {}, { imagehash: api });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
