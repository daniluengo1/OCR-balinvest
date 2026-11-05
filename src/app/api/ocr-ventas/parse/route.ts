import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { processPdfSales } from '@/lib/ocrVentas';
import { splitMultiDocumentPdf } from '@/lib/ocr';

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
    const data = new Uint8Array(await file.arrayBuffer());
    const explicitCustomer = String(form.get('customer') || '') || undefined;

    // Detectar si es un PDF unificado con múltiples facturas/abonos de venta
    if (!explicitCustomer) {
      const splitDocs = await splitMultiDocumentPdf(file.name, data.slice());
      if (splitDocs.length > 1) {
        const documents = await Promise.all(
          splitDocs.map(async (doc) => {
            const ocrRes = await processPdfSales(ctx, doc.fileName, doc.pdfBytes.slice());
            return {
              ...ocrRes,
              file: doc.fileName,
              originalFile: file.name,
              pages: doc.pageNumbers,
              pdfBase64: doc.pdfBase64,
              isSplitDoc: true,
            };
          })
        );

        return NextResponse.json({
          company: ctx.companyName,
          multiDoc: true,
          totalDocuments: documents.length,
          originalFile: file.name,
          documents,
        });
      }
    }

    const result = await processPdfSales(ctx, file.name, data.slice(), explicitCustomer);
    return NextResponse.json({ company: ctx.companyName, multiDoc: false, ...result });
  } catch (error: any) {
    console.error('OCR ventas parse error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
