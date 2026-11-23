import { createHash } from 'node:crypto';

export class TrustError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}
export function digest(value) {
  const normalize = v => Array.isArray(v) ? v.map(normalize) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, normalize(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}
export function text(value, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TrustError('INVALID_INPUT', 400);
  return value.trim();
}
export function actorId(user) { return text(String(user?._id || user?.sub || '')); }
export function maintainer(user) {
  if (user?.role !== 'admin') throw new TrustError('FORBIDDEN', 403);
  return actorId(user);
}
export async function insertOnce(collection, record) {
  try { await collection.insertOne(record); return record; }
  catch (error) {
    if (error.code !== 11000) throw error;
    return collection.findOne({ _id: record._id });
  }
}
