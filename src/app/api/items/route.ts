import { NextRequest, NextResponse } from 'next/server';
import { getBcContext, bcFetchAll } from '@/lib/bcClient';
import { cached, HOUR } from '@/lib/cache';

export const dynamic = 'force-dynamic';

export type BcItem = {
  number: string;
  name: string;
  taxGroupCode: string;
};

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const company = url.searchParams.get('company') || req.cookies.get('empresa_activa')?.value || undefined;
    const ctx = await getBcContext(company);

    const force = url.searchParams.get('refresh') === 'true';
    const items = await cached(`items:v1:${ctx.companyName}`, 6 * HOUR, async () => {
      const endpoint = `${ctx.apiBase}/items?$select=number,displayName,taxGroupCode&$top=2000`;
      const raw = await bcFetchAll(endpoint, ctx.token);
      return (raw || [])
        .map((it: any) => ({
          number: it.number || '',
          name: it.displayName || '',
          taxGroupCode: it.taxGroupCode || '',
        }))
        .filter((it: any) => it.number)
        .sort((a: any, b: any) => a.number.localeCompare(b.number, undefined, { numeric: true }));
    }, force);

    return NextResponse.json({ items }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' }
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
