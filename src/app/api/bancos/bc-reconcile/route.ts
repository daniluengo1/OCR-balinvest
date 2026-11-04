import { NextResponse } from 'next/server';
import { getBcBankAccounts, getBcJournalBatches, reconcileStatementWithBc } from '@/lib/bcBankReconcile';

export const dynamic = 'force-dynamic';

// GET: Lista cuentas bancarias y lotes de diario de Business Central
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const company = searchParams.get('company') || undefined;

    const [bankAccounts, journalBatches] = await Promise.all([
      getBcBankAccounts(company),
      getBcJournalBatches(company),
    ]);

    return NextResponse.json({
      ok: true,
      bankAccounts,
      journalBatches,
    });
  } catch (err: any) {
    console.error('Error en GET /api/bancos/bc-reconcile:', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

// POST: Sube extracto y realiza la conciliación contra BC
export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const bankAccountNo = (formData.get('bankAccount') as string) || '';
    const journalBatchId = (formData.get('journalBatch') as string) || '';
    const company = (formData.get('company') as string) || undefined;

    if (!file) {
      return NextResponse.json({ ok: false, error: 'No se ha adjuntado ningún extracto bancario.' }, { status: 400 });
    }

    const filename = file.name;
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const result = await reconcileStatementWithBc(
      buffer,
      filename,
      bankAccountNo,
      journalBatchId,
      company
    );

    return NextResponse.json({
      ok: true,
      filename,
      result,
    });
  } catch (err: any) {
    console.error('Error en POST /api/bancos/bc-reconcile:', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
