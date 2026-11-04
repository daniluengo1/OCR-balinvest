import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { attachFile } from '@/lib/bcWrite';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const cookieStore = await cookies();
    const company = cookieStore.get('empresa_activa')?.value || cookieStore.get('craze_selected_company')?.value || '';
    const form = await req.formData();
    const id = String(form.get('id') || '');
    const file = form.get('file');
    if (!/^[0-9a-f-]{36}$/i.test(id) || !(file instanceof File)) {
      return NextResponse.json({ error: 'Faltan el ID de la factura o el fichero adjunto.' }, { status: 400 });
    }
    const ctx = await getBcContext(company);
    await attachFile(ctx, id, { name: file.name, data: new Uint8Array(await file.arrayBuffer()) });
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('OCR attach error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}