import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { processPdf, splitMultiDocumentPdf } from '@/lib/ocr';

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
    const explicitVendor = String(form.get('vendor') || '') || undefined;

    // 1. Detectar si es un PDF unificado que contiene más de una factura o abono
    if (!explicitVendor) {
      const splitDocs = await splitMultiDocumentPdf(file.name, data);
      if (splitDocs.length > 1) {
        const documents = await Promise.all(
          splitDocs.map(async (doc) => {
            const ocrRes = await processPdf(ctx, doc.fileName, doc.pdfBytes);
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

    // 2. Documento único estándar
    const result = await processPdf(ctx, file.name, data, explicitVendor);
    return NextResponse.json({ company: ctx.companyName, multiDoc: false, ...result });
  } catch (error: any) {
    console.error('OCR parse error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}