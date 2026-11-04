import prisma from '@/lib/prisma';

export const HOUR = 3600 * 1000;
const CACHE_PREFIX = 'cache:';

export async function readSetting<T>(key: string, fallback: T): Promise<T> {
  try {
    const row = await prisma.apiConfig.findUnique({ where: { key: 'setting:' + key } });
    if (!row?.config) return fallback;
    return JSON.parse(row.config) as T;
  } catch {
    return fallback;
  }
}

export async function writeSetting(key: string, value: unknown) {
  try {
    const dbKey = 'setting:' + key;
    const config = JSON.stringify(value);
    await prisma.apiConfig.upsert({
      where: { key: dbKey },
      update: { config },
      create: { key: dbKey, url: '', config },
    });
  } catch (e) {
    console.error(`Error saving setting ${key}:`, e);
  }
}

export async function cached<T>(
  key: string,
  maxAgeMs: number,
  compute: () => Promise<T>,
  force = false
): Promise<T> {
  const dbKey = CACHE_PREFIX + key;
  if (!force) {
    try {
      const row = await prisma.apiConfig.findUnique({ where: { key: dbKey } });
      if (row?.config) {
        const isFresh = Date.now() - row.updatedAt.getTime() < maxAgeMs;
        if (isFresh) {
          return JSON.parse(row.config) as T;
        }
      }
    } catch {
      // Si falla la lectura, recalculamos
    }
  }

  const value = await compute();
  try {
    const config = JSON.stringify(value);
    await prisma.apiConfig.upsert({
      where: { key: dbKey },
      update: { config },
      create: { key: dbKey, url: '', config },
    });
  } catch (e) {
    console.error(`Error storing cache for ${key}:`, e);
  }
  return value;
}