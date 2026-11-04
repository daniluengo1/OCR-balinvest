import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { processPdfSales } from '@/lib/ocrVentas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const cookieStore = await cookies();
    const company = cookieStore.get('empresa_activa')?.value || cookieStore.get('craze_selected_company')?.value || '';
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Debes subir un archivo PDF válido.' }, { status: 400 });
    }

    const ctx = await getBcContext(company);
    const result = await processPdfSales(
      ctx,
      file.name,
      new Uint8Array(await file.arrayBuffer()),
      String(form.get('customer') || '') || undefined
    );
    return NextResponse.json({ company: ctx.companyName, ...result });
  } catch (error: any) {
    console.error('OCR ventas parse error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
