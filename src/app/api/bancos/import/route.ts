import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { parseBankStatement } from '@/lib/bankParser';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const companyId = (formData.get('companyId') as string) || '';
    const forcedCurrency = (formData.get('currency') as string) || '';

    if (!file) {
      return NextResponse.json({ ok: false, error: 'No se ha adjuntado ningún archivo.' }, { status: 400 });
    }

    const filename = file.name;
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Parsear el extracto bancario
    const parseResult = parseBankStatement(buffer, filename);

    if (!parseResult.movements || parseResult.movements.length === 0) {
      return NextResponse.json({
        ok: false,
        error: 'No se encontraron movimientos válidos en el archivo. Asegúrate de que contiene columnas de fecha, descripción e importe.',
      }, { status: 400 });
    }

    const effectiveCurrency = forcedCurrency || parseResult.currencyCode || 'EUR';

    // 1. Guardar movimientos en la base de datos
    const createdEntries = [];
    for (const m of parseResult.movements) {
      const entry = await prisma.cashflowManualEntry.create({
        data: {
          companyId,
          currencyCode: effectiveCurrency,
          date: new Date(m.date),
          description: m.description,
          amount: m.amount,
          balance: m.balance,
          bankAccount: m.bankAccount || parseResult.bankAccount,
          sourceFile: filename,
        },
      });
      createdEntries.push(entry);
    }

    // 2. Si el extracto incluye saldo inicial y no existía uno configurado, guardarlo opcionalmente
    if (parseResult.initialBalance != null) {
      const existingConfig = await prisma.cashflowConfig.findFirst({
        where: { companyId, currencyCode: effectiveCurrency },
      });
      if (!existingConfig) {
        await prisma.cashflowConfig.create({
          data: {
            companyId,
            currencyCode: effectiveCurrency,
            initialBalance: parseResult.initialBalance,
          },
        });
      }
    }

    // 3. Registrar importación en BankStatementImport
    const importRecord = await prisma.bankStatementImport.create({
      data: {
        companyId,
        filename,
        bankAccount: parseResult.bankAccount,
        currencyCode: effectiveCurrency,
        totalRows: parseResult.movements.length,
        totalIncome: parseResult.totalIncome,
        totalExpense: parseResult.totalExpense,
        initialBalance: parseResult.initialBalance,
        finalBalance: parseResult.finalBalance,
      },
    });

    return NextResponse.json({
      ok: true,
      filename,
      count: createdEntries.length,
      currency: effectiveCurrency,
      bankAccount: parseResult.bankAccount,
      totalIncome: parseResult.totalIncome,
      totalExpense: parseResult.totalExpense,
      initialBalance: parseResult.initialBalance,
      finalBalance: parseResult.finalBalance,
      importId: importRecord.id,
    });
  } catch (error: any) {
    console.error('Error al importar extracto bancario:', error);
    return NextResponse.json({ ok: false, error: error.message || 'Error al procesar el archivo.' }, { status: 500 });
  }
}
