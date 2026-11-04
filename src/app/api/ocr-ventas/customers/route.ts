import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { searchCustomers } from '@/lib/ocrVentas';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const cookieStore = await cookies();
    const company = cookieStore.get('empresa_activa')?.value || cookieStore.get('craze_selected_company')?.value || '';
    const term = new URL(req.url).searchParams.get('q') || '';
    const ctx = await getBcContext(company);
    const customers = await searchCustomers(ctx, term);
    return NextResponse.json({ customers });
  } catch (error: any) {
    return NextResponse.json({ error: error.message, customers: [] }, { status: 500 });
  }
}
