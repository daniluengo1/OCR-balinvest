import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

function getDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  if (process.env.VERCEL) {
    const tmpDbPath = '/tmp/dev.db';
    if (!fs.existsSync(tmpDbPath)) {
      try {
        const candidatePaths = [
          path.join(process.cwd(), 'prisma', 'dev.db'),
          path.join(process.cwd(), 'gestion-empresa', 'prisma', 'dev.db'),
          path.join(process.cwd(), 'dev.db'),
        ];
        for (const p of candidatePaths) {
          if (fs.existsSync(p)) {
            fs.copyFileSync(p, tmpDbPath);
            break;
          }
        }
      } catch (err) {
        console.error('Error copying sqlite db to /tmp on Vercel:', err);
      }
    }
    return `file:${tmpDbPath}`;
  }

  // En local, buscar la ubicación real del archivo dev.db independientemente de desde dónde se ejecute el comando
  const candidates = [
    path.resolve(process.cwd(), 'prisma', 'dev.db'),
    path.resolve(process.cwd(), 'gestion-empresa', 'prisma', 'dev.db'),
    path.resolve(__dirname, '..', '..', 'prisma', 'dev.db'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      // Normalizar en formato de URL para SQLite (slashes)
      const normalized = candidate.replace(/\\/g, '/');
      return `file:${normalized}`;
    }
  }

  return undefined;
}

const dbUrl = getDatabaseUrl();

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  (dbUrl
    ? new PrismaClient({ datasources: { db: { url: dbUrl } } })
    : new PrismaClient());

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
