import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import {
  createOcrSalesInvoice,
  createOcrSalesCreditMemo,
  existingForSales,
  learnCustomer,
  type OcrCreateSalesInput
} from '@/lib/ocrVentas';
import { logAction } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const isDate = (d: string) => !d || /^\d{4}-\d{2}-\d{2}$/.test(d);

export async function POST(req: Request) {
  try {
    const cookieStore = await cookies();
    const company = cookieStore.get('empresa_activa')?.value || cookieStore.get('craze_selected_company')?.value || '';
    const form = await req.formData();
    const body = JSON.parse(String(form.get('data') || '{}')) as OcrCreateSalesInput;
    const pdfFile = form.get('pdf');
    const pdf = pdfFile instanceof File ? { name: pdfFile.name, data: new Uint8Array(await pdfFile.arrayBuffer()) } : undefined;

    if (!body.customer || !body.invoiceNo?.trim()) {
      return NextResponse.json({ error: 'Faltan el cliente o el nº de documento.' }, { status: 400 });
    }
    if (![body.invoiceDate, body.postingDate, body.dueDate].every(isDate)) {
      return NextResponse.json({ error: 'Formato de fecha no válido (debe ser YYYY-MM-DD).' }, { status: 400 });
    }
    if (!Array.isArray(body.lines) || !body.lines.length) {
      return NextResponse.json({ error: 'El documento de venta debe tener al menos una línea.' }, { status: 400 });
    }
    const missing = body.lines.find(l => l.lineType !== 'Comment' && !l.number);
    if (missing) {
      return NextResponse.json({ error: `Falta el código de cuenta o artículo en la línea "${missing.description}".` }, { status: 400 });
    }

    const ctx = await getBcContext(company);
    const invoiceNo = body.invoiceNo.trim();
    const isCredit = body.documentType === 'credit_note';

    const existing = await existingForSales(ctx, body.customer, invoiceNo, body.documentType);
    if (existing.length && !body.force) {
      return NextResponse.json({
        error: `Ya existe un documento de venta en BC con este número: ${existing.map(e => e.no).join(', ')}`,
        existing
      }, { status: 409 });
    }

    const result = isCredit
      ? await createOcrSalesCreditMemo(ctx, { ...body, invoiceNo }, pdf)
      : await createOcrSalesInvoice(ctx, { ...body, invoiceNo }, pdf);

    await learnCustomer(ctx.companyName, body.ids || [], body.customer).catch(() => {});
    await logAction(
      isCredit ? 'OCR: abono de venta creado en Business Central' : 'OCR: factura de venta creada en Business Central',
      `${result.no} · Cliente ${body.customer} · ${isCredit ? 'Abono Venta' : 'Factura Venta'} ${invoiceNo} · Total ${result.total ?? ''} ${result.currency}`
    );

    return NextResponse.json(result);
  } catch (error: any) {
    console.error('OCR ventas create error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
