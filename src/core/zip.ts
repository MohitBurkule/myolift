/** Minimal ZIP writer (stored, no compression): enough to bundle raw recordings for export. */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const utf8 = (s: string) => {
  const out: number[] = [];
  for (const ch of s) {
    let c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else { out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
  }
  return Uint8Array.from(out);
};

function dosTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * Streams entries: call add() per file, then finish(). `write` receives consecutive chunks of
 * the zip file (so large recordings never need to be concatenated in memory).
 */
export class ZipWriter {
  private offset = 0;
  private central: Uint8Array[] = [];
  private count = 0;
  constructor(private write: (chunk: Uint8Array) => void, private now = new Date()) {}

  add(name: string, data: Uint8Array) {
    const nm = utf8(name), crc = crc32(data), { time, date } = dosTime(this.now);
    const h = new Uint8Array(30 + nm.length), v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, 0, true);
    v.setUint16(10, time, true); v.setUint16(12, date, true); v.setUint32(14, crc, true);
    v.setUint32(18, data.length, true); v.setUint32(22, data.length, true); v.setUint16(26, nm.length, true); v.setUint16(28, 0, true);
    h.set(nm, 30);
    const c = new Uint8Array(46 + nm.length), w = new DataView(c.buffer);
    w.setUint32(0, 0x02014b50, true); w.setUint16(4, 20, true); w.setUint16(6, 20, true); w.setUint16(8, 0x0800, true); w.setUint16(10, 0, true);
    w.setUint16(12, time, true); w.setUint16(14, date, true); w.setUint32(16, crc, true);
    w.setUint32(20, data.length, true); w.setUint32(24, data.length, true); w.setUint16(28, nm.length, true);
    w.setUint32(42, this.offset, true);
    c.set(nm, 46);
    this.write(h); this.write(data);
    this.offset += h.length + data.length;
    this.central.push(c); this.count++;
  }

  /**
   * A large file read in chunks (e.g. a video): sizes and CRC go in a data descriptor after the
   * data, so the file is never held in memory. `read` returns the next chunk, or null at the end.
   */
  addChunked(name: string, read: () => Uint8Array | null) {
    const nm = utf8(name), { time, date } = dosTime(this.now);
    const h = new Uint8Array(30 + nm.length), v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0808, true); v.setUint16(8, 0, true);
    v.setUint16(10, time, true); v.setUint16(12, date, true); v.setUint16(26, nm.length, true);
    h.set(nm, 30);
    this.write(h);
    const start = this.offset;
    this.offset += h.length;
    let crc = 0, size = 0;
    for (let c = read(); c && c.length; c = read()) { crc = crc32Update(crc, c); size += c.length; this.write(c); }
    const d = new Uint8Array(16), dv = new DataView(d.buffer);
    dv.setUint32(0, 0x08074b50, true); dv.setUint32(4, crc, true); dv.setUint32(8, size, true); dv.setUint32(12, size, true);
    this.write(d);
    this.offset += size + 16;
    const c = new Uint8Array(46 + nm.length), w = new DataView(c.buffer);
    w.setUint32(0, 0x02014b50, true); w.setUint16(4, 20, true); w.setUint16(6, 20, true); w.setUint16(8, 0x0808, true);
    w.setUint16(12, time, true); w.setUint16(14, date, true); w.setUint32(16, crc, true);
    w.setUint32(20, size, true); w.setUint32(24, size, true); w.setUint16(28, nm.length, true);
    w.setUint32(42, start, true);
    c.set(nm, 46);
    this.central.push(c); this.count++;
  }

  finish() {
    const cdStart = this.offset;
    let size = 0;
    for (const c of this.central) { this.write(c); size += c.length; }
    const e = new Uint8Array(22), v = new DataView(e.buffer);
    v.setUint32(0, 0x06054b50, true); v.setUint16(8, this.count, true); v.setUint16(10, this.count, true);
    v.setUint32(12, size, true); v.setUint32(16, cdStart, true);
    this.write(e);
  }
}

/** Incremental CRC32: pass the previous value (start with 0). */
export function crc32Update(prev: number, data: Uint8Array): number {
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
