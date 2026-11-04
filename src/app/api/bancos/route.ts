import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const companyId = searchParams.get('companyId') || '';
    const currencyCode = (searchParams.get('currency') || 'EUR').toUpperCase();
    const search = searchParams.get('search') || '';
    const type = searchParams.get('type') || 'ALL'; // ALL, INCOME, EXPENSE
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');

    // 1. Obtener saldo inicial configurado
    let initialBalance = 0;
    try {
      const config = await prisma.cashflowConfig.findFirst({
        where: {
          companyId,
          currencyCode,
        },
      });
      if (config) {
        initialBalance = config.initialBalance;
      }
    } catch (e: any) {
      console.warn('Error al leer saldo inicial:', e.message);
    }

    // 2. Construir filtro de movimientos
    const where: any = {
      currencyCode,
    };
    if (companyId) {
      where.companyId = companyId;
    }
    if (search) {
      where.description = {
        contains: search,
      };
    }
    if (startDate || endDate) {
      where.date = {};
      if (startDate) where.date.gte = new Date(startDate);
      if (endDate) where.date.lte = new Date(`${endDate}T23:59:59.999Z`);
    }

    // 3. Consultar todos los movimientos ordenados por fecha ascendente
    let entries: any[] = [];
    try {
      entries = await prisma.cashflowManualEntry.findMany({
        where,
        orderBy: { date: 'asc' },
      });
    } catch (e: any) {
      console.warn('Error al consultar movimientos bancarios:', e.message);
    }

    // 4. Calcular saldo progresivo y totales
    let runningBalance = initialBalance;
    let totalIncome = 0;
    let totalExpense = 0;

    const enrichedEntries = entries.map((entry) => {
      const amt = entry.amount;
      if (amt > 0) totalIncome += amt;
      else totalExpense += Math.abs(amt);

      runningBalance = Math.round((runningBalance + amt) * 100) / 100;

      return {
        ...entry,
        date: entry.date.toISOString().split('T')[0],
        runningBalance,
      };
    });

    // 5. Aplicar filtro de tipo si se especifica
    let filtered = enrichedEntries;
    if (type === 'INCOME') {
      filtered = enrichedEntries.filter((e) => e.amount > 0);
    } else if (type === 'EXPENSE') {
      filtered = enrichedEntries.filter((e) => e.amount < 0);
    }

    // Devolver lista invertida para visualización (los más recientes primero en la tabla)
    const reversed = [...filtered].reverse();

    return NextResponse.json({
      ok: true,
      initialBalance,
      finalBalance: runningBalance,
      totalIncome: Math.round(totalIncome * 100) / 100,
      totalExpense: Math.round(totalExpense * 100) / 100,
      count: filtered.length,
      entries: reversed,
    });
  } catch (error: any) {
    console.error('Error en GET /api/bancos:', error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { companyId, currencyCode, date, description, amount, bankAccount } = body;

    if (!date || !description || amount === undefined) {
      return NextResponse.json({ ok: false, error: 'Fecha, descripción e importe son obligatorios.' }, { status: 400 });
    }

    const entry = await prisma.cashflowManualEntry.create({
      data: {
        companyId: companyId || '',
        currencyCode: (currencyCode || 'EUR').toUpperCase(),
        date: new Date(date),
        description: String(description).trim(),
        amount: parseFloat(amount),
        bankAccount: bankAccount ? String(bankAccount).trim() : null,
      },
    });

    return NextResponse.json({ ok: true, entry });
  } catch (error: any) {
    console.error('Error en POST /api/bancos:', error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    const clearAll = searchParams.get('clearAll') === 'true';
    const companyId = searchParams.get('companyId') || '';

    if (clearAll) {
      await prisma.cashflowManualEntry.deleteMany({
        where: companyId ? { companyId } : {},
      });
      return NextResponse.json({ ok: true, message: 'Todos los movimientos han sido eliminados.' });
    }

    if (!id) {
      return NextResponse.json({ ok: false, error: 'Falta el ID del movimiento.' }, { status: 400 });
    }

    await prisma.cashflowManualEntry.delete({
      where: { id: parseInt(id, 10) },
    });

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error('Error en DELETE /api/bancos:', error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
