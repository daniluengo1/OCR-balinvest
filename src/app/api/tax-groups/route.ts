import { NextRequest, NextResponse } from 'next/server';
import { getBcContext, bcFetchAll } from '@/lib/bcClient';
import { cached, HOUR } from '@/lib/cache';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const company = url.searchParams.get('company') || req.cookies.get('empresa_activa')?.value || undefined;
    const ctx = await getBcContext(company);

    const force = url.searchParams.get('refresh') === 'true';
    const taxGroups = await cached(`tax-groups:${ctx.companyName}`, 6 * HOUR, async () => {
      const raw = await bcFetchAll(`${ctx.apiBase}/taxGroups`, ctx.token);
      const parseRate = (code: string, name: string): number => {
        const c = (code + ' ' + name).toUpperCase();
        if (c.includes('21')) return 21;
        if (c.includes('10')) return 10;
        if (c.includes('5')) return 5;
        if (c.includes('4')) return 4;
        if (/exento|no sujeto|dua/i.test(c)) return 0;
        return 21;
      };

      const groups = raw.map((t: any) => ({
        code: t.code,
        name: t.displayName || t.code,
        rate: parseRate(t.code, t.displayName || ''),
      }));

      // Si por alguna razón la lista viniera vacía de BC, proporcionar defaults del estándar español
      if (!groups.length) {
        return [
          { code: 'IVA21', name: 'IVA 21%', rate: 21 },
          { code: 'IVA10', name: 'IVA 10%', rate: 10 },
          { code: 'IVA4', name: 'IVA 4%', rate: 4 },
          { code: 'IVA5', name: 'IVA 5%', rate: 5 },
          { code: 'EXENTO', name: 'Exento (0%)', rate: 0 },
          { code: 'NO SUJETO', name: 'No sujeto (0%)', rate: 0 },
        ];
      }

      return groups;
    }, force);

    return NextResponse.json({ taxGroups }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' }
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
