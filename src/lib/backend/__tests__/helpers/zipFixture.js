import { deflateRawSync } from "node:zlib";

/**
 * Build a ZIP archive in memory for #638 tests — no `zip` binary, no fixture
 * blobs committed. Supports the fields the adversarial cases need.
 *
 * @param {Array<{
 *   name: string, data?: string|Buffer, deflate?: boolean,
 *   forceUncompressed?: number, bitFlag?: number, externalAttr?: number,
 *   overrideLocalOffset?: number, method?: number,
 * }>} entries
 * @param {{ eocdTotalEntries?: number, prepend?: Buffer, append?: Buffer }} [opts]
 */
export function buildZip(entries, opts = {}) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "");
    const method = e.method ?? (e.deflate ? 8 : 0);
    const body = e.deflate ? deflateRawSync(raw) : raw;
    const usize = e.forceUncompressed ?? raw.length;
    const csize = e.forceCompressed ?? body.length;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(e.bitFlag ?? 0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(csize, 18);
    lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const localOffset = e.overrideLocalOffset ?? offset;
    chunks.push(lh, nameBuf, body);
    offset += lh.length + nameBuf.length + body.length;

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(e.bitFlag ?? 0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(csize, 20);
    ch.writeUInt32LE(usize, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt32LE(e.externalAttr ?? 0, 38);
    ch.writeUInt32LE(localOffset, 42);
    central.push(ch, nameBuf);
  }

  const cdStart = offset;
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(opts.eocdTotalEntries ?? entries.length, 8);
  eocd.writeUInt16LE(opts.eocdTotalEntries ?? entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdStart, 16);

  return Buffer.concat([opts.prepend ?? Buffer.alloc(0), ...chunks, cd, eocd, opts.append ?? Buffer.alloc(0)]);
}

/** Symlink external attributes: Unix mode S_IFLNK (0xA000) in the high 16 bits. */
export const SYMLINK_EXTERNAL_ATTR = 0xa1ff0000;
