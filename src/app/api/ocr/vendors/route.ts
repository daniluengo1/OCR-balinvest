import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { searchVendors } from '@/lib/ocr';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const cookieStore = await cookies();
    const company = cookieStore.get('empresa_activa')?.value || cookieStore.get('craze_selected_company')?.value || '';
    const term = new URL(req.url).searchParams.get('q') || '';
    const ctx = await getBcContext(company);
    const vendors = await searchVendors(ctx, term);
    return NextResponse.json({ vendors });
  } catch (error: any) {
    return NextResponse.json({ error: error.message, vendors: [] }, { status: 500 });
  }
}