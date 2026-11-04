import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { createOcrInvoice, createOcrCreditMemo, existingFor, learnVendor, type OcrCreateInput } from '@/lib/ocr';
import { logAction } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const isDate = (d: string) => !d || /^\d{4}-\d{2}-\d{2}$/.test(d);

export async function POST(req: Request) {
  try {
    const cookieStore = await cookies();
    const company = cookieStore.get('empresa_activa')?.value || cookieStore.get('craze_selected_company')?.value || '';
    const form = await req.formData();
    const body = JSON.parse(String(form.get('data') || '{}')) as OcrCreateInput;
    const pdfFile = form.get('pdf');
    const pdf = pdfFile instanceof File ? { name: pdfFile.name, data: new Uint8Array(await pdfFile.arrayBuffer()) } : undefined;

    if (!body.vendor || !body.invoiceNo?.trim()) {
      return NextResponse.json({ error: 'Faltan el proveedor o el nº de documento.' }, { status: 400 });
    }
    if (![body.invoiceDate, body.postingDate, body.dueDate].every(isDate)) {
      return NextResponse.json({ error: 'Formato de fecha no válido (debe ser YYYY-MM-DD).' }, { status: 400 });
    }
    if (!Array.isArray(body.lines) || !body.lines.length) {
      return NextResponse.json({ error: 'El documento debe tener al menos una línea.' }, { status: 400 });
    }
    const missing = body.lines.find(l => l.lineType !== 'Comment' && !l.number);
    if (missing) {
      return NextResponse.json({ error: `Falta el código de cuenta o artículo en la línea "${missing.description}".` }, { status: 400 });
    }

    const ctx = await getBcContext(company);
    const invoiceNo = body.invoiceNo.trim();
    const isCredit = body.documentType === 'credit_note';
    const existing = await existingFor(ctx, body.vendor, invoiceNo, body.documentType);
    if (existing.length && !body.force) {
      return NextResponse.json({ error: `Ya existe un documento en BC con este número: ${existing.map(e => e.no).join(', ')}`, existing }, { status: 409 });
    }

    const result = isCredit
      ? await createOcrCreditMemo(ctx, { ...body, invoiceNo }, pdf)
      : await createOcrInvoice(ctx, { ...body, invoiceNo }, pdf);

    await learnVendor(ctx.companyName, body.ids || [], body.vendor).catch(() => {});
    await logAction(
      isCredit ? 'OCR: abono de compra creado en Business Central' : 'OCR: factura creada en Business Central',
      `${result.no} · Proveedor ${body.vendor} · ${isCredit ? 'Abono' : 'Factura'} ${invoiceNo} · Total ${result.total ?? ''} ${result.currency}`
    );
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('OCR create error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}