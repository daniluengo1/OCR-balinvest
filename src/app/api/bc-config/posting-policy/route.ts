import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getBcContext } from '@/lib/bcClient';
import { getPostingPolicy, savePostingPolicy, getBcPostingLimits, PostingDatePolicy } from '@/lib/bcPostingPeriod';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const { policy, customPostingFrom } = await getPostingPolicy();
    const cookieStore = await cookies();
    const company = cookieStore.get('empresa_activa')?.value || cookieStore.get('craze_selected_company')?.value || '';

    let limits: any = null;
    let bcError: string | null = null;

    try {
      const ctx = await getBcContext(company);
      limits = await getBcPostingLimits(ctx);
    } catch (e: any) {
      bcError = e.message;
    }

    return NextResponse.json({
      ok: true,
      policy,
      customPostingFrom,
      limits,
      bcError,
    });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const policy = (body.policy || 'auto') as PostingDatePolicy;
    const customPostingFrom = body.customPostingFrom || null;

    if (!['auto', 'today', 'document'].includes(policy)) {
      return NextResponse.json({ ok: false, error: 'Política no válida. Opciones: auto, today, document' }, { status: 400 });
    }

    await savePostingPolicy(policy, customPostingFrom);

    return NextResponse.json({
      ok: true,
      message: 'Política de fecha de registro guardada correctamente.',
      policy,
      customPostingFrom,
    });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
