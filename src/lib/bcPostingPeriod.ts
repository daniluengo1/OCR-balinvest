import { BcContext } from './bcClient';
import prisma from './prisma';

export type PostingDatePolicy = 'auto' | 'today' | 'document';

export interface BcPostingLimits {
  companyName: string;
  allowPostingFrom: string | null;
  allowPostingTo: string | null;
  latestClosedPeriod: {
    startingDate: string;
    name: string;
  } | null;
  earliestAllowedDate: string | null;
  openPeriodsCount: number;
}

export interface PostingDateResult {
  postingDate: string;
  wasAdjusted: boolean;
  reason: string | null;
  policy: PostingDatePolicy;
}

// Obtiene la política configurada en la BD (por defecto 'auto')
export async function getPostingPolicy(): Promise<{ policy: PostingDatePolicy; customPostingFrom: string | null }> {
  try {
    const record = await prisma.apiConfig.findUnique({ where: { key: 'posting_date_policy' } });
    if (record?.config) {
      const parsed = JSON.parse(record.config);
      return {
        policy: (parsed.policy as PostingDatePolicy) || 'auto',
        customPostingFrom: parsed.customPostingFrom || null,
      };
    }
  } catch (e) {
    console.error('Error reading posting_date_policy from db:', e);
  }
  return { policy: 'auto', customPostingFrom: null };
}

// Guarda la política configurada
export async function savePostingPolicy(policy: PostingDatePolicy, customPostingFrom?: string | null): Promise<void> {
  const config = JSON.stringify({ policy, customPostingFrom: customPostingFrom || null });
  await prisma.apiConfig.upsert({
    where: { key: 'posting_date_policy' },
    update: { config },
    create: { key: 'posting_date_policy', url: '', config },
  });
}

// Consulta en Business Central los límites de periodos contables y configuración de contabilidad
export async function getBcPostingLimits(ctx: BcContext): Promise<BcPostingLimits> {
  let allowPostingFrom: string | null = null;
  let allowPostingTo: string | null = null;
  let latestClosedPeriod: { startingDate: string; name: string } | null = null;
  let earliestAllowedDate: string | null = null;
  let openPeriodsCount = 0;

  // 1. General Ledger Setup (Configuración contabilidad en BC)
  try {
    const glRes = await fetch(`${ctx.root}/api/v2.0/companies(${ctx.companyId})/generalLedgerSetup`, {
      headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' },
      cache: 'no-store',
    });
    if (glRes.ok) {
      const glData = await glRes.json();
      const glSetup = glData.value?.[0];
      if (glSetup?.allowPostingFrom && glSetup.allowPostingFrom !== '0001-01-01') {
        allowPostingFrom = glSetup.allowPostingFrom;
        earliestAllowedDate = glSetup.allowPostingFrom;
      }
      if (glSetup?.allowPostingTo && glSetup.allowPostingTo !== '0001-01-01') {
        allowPostingTo = glSetup.allowPostingTo;
      }
    }
  } catch (err) {
    console.error('Error al consultar generalLedgerSetup en BC:', err);
  }

  // 2. Accounting Periods (Periodos contables / de IVA en BC)
  try {
    const apRes = await fetch(`${ctx.root}/api/v2.0/companies(${ctx.companyId})/accountingPeriods?$orderby=startingDate asc`, {
      headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' },
      cache: 'no-store',
    });
    if (apRes.ok) {
      const apData = await apRes.json();
      const periods: any[] = apData.value || [];
      let firstOpenAfterClosed: any = null;

      for (let i = 0; i < periods.length; i++) {
        const p = periods[i];
        if (p.closed || p.dateLocked) {
          latestClosedPeriod = { startingDate: p.startingDate, name: (p.name || '').trim() };
          if (i + 1 < periods.length) {
            firstOpenAfterClosed = periods[i + 1];
          }
        } else {
          openPeriodsCount++;
        }
      }

      if (firstOpenAfterClosed?.startingDate) {
        if (!earliestAllowedDate || firstOpenAfterClosed.startingDate > earliestAllowedDate) {
          earliestAllowedDate = firstOpenAfterClosed.startingDate;
        }
      }
    }
  } catch (err) {
    console.error('Error al consultar accountingPeriods en BC:', err);
  }

  return {
    companyName: ctx.companyName,
    allowPostingFrom,
    allowPostingTo,
    latestClosedPeriod,
    earliestAllowedDate,
    openPeriodsCount,
  };
}

// Determina la fecha de registro según la política y los periodos de BC
export async function determinePostingDate(
  invoiceDate: string | null | undefined,
  ctx: BcContext,
  policyOverride?: PostingDatePolicy
): Promise<PostingDateResult> {
  const { policy: storedPolicy, customPostingFrom } = await getPostingPolicy();
  const policy = policyOverride || storedPolicy;

  // Fecha de hoy en formato YYYY-MM-DD (zona horaria España / Madrid)
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

  if (policy === 'today') {
    return {
      postingDate: today,
      wasAdjusted: Boolean(invoiceDate && invoiceDate !== today),
      reason: invoiceDate && invoiceDate !== today ? 'Política de empresa: registrar siempre con fecha de hoy.' : null,
      policy,
    };
  }

  const cleanInvDate = (invoiceDate || '').trim();
  if (!cleanInvDate) {
    return {
      postingDate: today,
      wasAdjusted: true,
      reason: 'No se detectó fecha en el documento; se asigna fecha de hoy.',
      policy,
    };
  }

  if (policy === 'document') {
    return {
      postingDate: cleanInvDate,
      wasAdjusted: false,
      reason: null,
      policy,
    };
  }

  // Política 'auto' (Automático / Inteligente)
  const limits = await getBcPostingLimits(ctx);
  
  // Calcular límite mínimo efectivo (tomando el mayor entre BC y override manual si existiera)
  let minAllowed = limits.earliestAllowedDate;
  if (customPostingFrom && (!minAllowed || customPostingFrom > minAllowed)) {
    minAllowed = customPostingFrom;
  }

  const isPriorToMin = Boolean(minAllowed && cleanInvDate < minAllowed);
  const isAfterMax = Boolean(limits.allowPostingTo && cleanInvDate > limits.allowPostingTo);

  if (isPriorToMin) {
    const formattedMin = minAllowed?.split('-').reverse().join('/') || minAllowed;
    const formattedToday = today.split('-').reverse().join('/');
    return {
      postingDate: today,
      wasAdjusted: true,
      reason: `Periodo contable/IVA cerrado en BC (anterior a ${formattedMin}). Fecha de registro asignada automáticamente a hoy (${formattedToday}) para permitir el registro.`,
      policy,
    };
  }

  if (isAfterMax) {
    const formattedMax = limits.allowPostingTo?.split('-').reverse().join('/') || limits.allowPostingTo;
    const formattedToday = today.split('-').reverse().join('/');
    return {
      postingDate: today,
      wasAdjusted: true,
      reason: `Fecha posterior al periodo permitido en BC (hasta ${formattedMax}). Fecha de registro ajustada a hoy (${formattedToday}).`,
      policy,
    };
  }

  return {
    postingDate: cleanInvDate,
    wasAdjusted: false,
    reason: null,
    policy,
  };
}
