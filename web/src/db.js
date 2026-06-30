// On-device catalog cache. This is what makes the app work offline at venues.
import Dexie from 'dexie';

export const db = new Dexie('baci-rep');
db.version(1).stores({
  kv: 'key',
  availability: 'variantId',
});

export async function saveSnapshot(snapshot) {
  await db.kv.put({ key: 'snapshot', value: snapshot });
  await db.kv.put({ key: 'syncedAt', value: Date.now() });
}

export async function loadSnapshot() {
  return (await db.kv.get('snapshot'))?.value || null;
}

export async function getSyncedAt() {
  return (await db.kv.get('syncedAt'))?.value || null;
}

export async function setAvailability(map) {
  const rows = Object.entries(map).map(([variantId, available]) => ({ variantId, available }));
  if (rows.length) await db.availability.bulkPut(rows);
}

export async function patchAvailability(variantId, available) {
  await db.availability.put({ variantId, available });
}

export async function loadAvailability() {
  const rows = await db.availability.toArray();
  const m = {};
  for (const r of rows) m[r.variantId] = r.available;
  return m;
}
