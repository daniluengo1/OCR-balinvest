import prisma from '@/lib/prisma';
import { cookies } from 'next/headers';

export async function logAction(
  action: string,
  details?: string,
  companyIdOverride?: string
) {
  try {
    let companyId = companyIdOverride;
    if (!companyId) {
      try {
        const cookieStore = await cookies();
        companyId = cookieStore.get('empresa_activa')?.value || cookieStore.get('craze_selected_company')?.value || '';
      } catch {
        // Ejecución fuera de contexto de cookies
      }
    }

    await prisma.actionLog.create({
      data: {
        user: 'Usuario',
        action,
        details,
        companyId: companyId || 'General',
      }
    });
  } catch (error) {
    console.error('Failed to write audit log:', error);
  }
}