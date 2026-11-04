import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const companyId = searchParams.get('companyId') || '';
    const currencyCode = (searchParams.get('currency') || 'EUR').toUpperCase();

    const config = await prisma.cashflowConfig.findFirst({
      where: { companyId, currencyCode },
    });

    return NextResponse.json({
      ok: true,
      initialBalance: config?.initialBalance || 0,
      currencyCode,
    });
  } catch (error: any) {
    console.error('Error al obtener saldo inicial:', error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { companyId, currencyCode, initialBalance } = body;

    const currency = (currencyCode || 'EUR').toUpperCase();
    const balanceNum = parseFloat(initialBalance) || 0;

    const existing = await prisma.cashflowConfig.findFirst({
      where: { companyId: companyId || '', currencyCode: currency },
    });

    let config;
    if (existing) {
      config = await prisma.cashflowConfig.update({
        where: { id: existing.id },
        data: { initialBalance: balanceNum },
      });
    } else {
      config = await prisma.cashflowConfig.create({
        data: {
          companyId: companyId || '',
          currencyCode: currency,
          initialBalance: balanceNum,
        },
      });
    }

    return NextResponse.json({ ok: true, config });
  } catch (error: any) {
    console.error('Error al actualizar saldo inicial:', error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
