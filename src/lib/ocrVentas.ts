import { getDocumentProxy, extractText } from 'unpdf';
import { BcContext, bcFetchAll, odataUrl } from '@/lib/bcClient';
import { attachFile, bcRequest } from '@/lib/bcWrite';
import { cached, readSetting, writeSetting, HOUR } from '@/lib/cache';
import { determinePostingDate } from '@/lib/bcPostingPeriod';
import {
  pdfText,
  identifiers,
  detectCurrency,
  totals,
  guessHeader,
  parseAmount,
  r2,
  accountNamesMap,
  itemNamesMap,
  toLine,
  OcrLine,
} from '@/lib/ocr';

export type CustomerRow = {
  number: string;
  name: string;
  email: string;
  website: string;
  vat: string;
  currency: string;
  blocked: boolean;
  invoices: number;
};

export type CustomerCandidate = {
  number: string;
  name: string;
  vat: string;
  currency: string;
  score: number;
  reasons: string[];
  invoices: number;
};

export type HistoryInvoice = {
  number: string;
  vendorInvoiceNumber: string;
  invoiceDate: string;
  postingDate: string;
  dueDate: string;
  currency: string;
  net: number | null;
  vat: number | null;
  total: number | null;
  postingDescription?: string;
  lines: OcrLine[];
  comment?: string;
};

export type OcrSuggestion = {
  documentType: 'invoice' | 'credit_note';
  invoiceNo: string;
  invoiceDate: string;
  postingDate: string;
  dueDate: string;
  postingDescription: string;
  currency: string;
  net: number | null;
  vat: number | null;
  total: number | null;
  lines: OcrLine[];
  comment?: string;
  isReverseCharge?: boolean;
  postingDateAdjusted?: boolean;
  postingDateReason?: string;
};

export type OcrResult = {
  file: string;
  scanned: boolean;
  currency: string;
  ids: string[];
  candidates: CustomerCandidate[];
  customer: CustomerCandidate | null;
  history: HistoryInvoice[];
  suggestion: OcrSuggestion | null;
  existing: { id: string; no: string }[];
  warnings: string[];
};

export type OcrCreateSalesInput = {
  documentType?: 'invoice' | 'credit_note';
  customer: string;
  invoiceNo: string;
  invoiceDate: string;
  postingDate: string;
  dueDate: string;
  currency?: string;
  postingDescription?: string;
  lines: OcrLine[];
  ids?: string[];
  force?: boolean;
};

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const q = (s: string) => s.replace(/'/g, "''");

function companyCurrency(companyName: string): string {
  if (/poland|polska|\bpl\b/i.test(companyName)) return 'PLN';
  if (/sweden|sverige|\bse\b/i.test(companyName)) return 'SEK';
  if (/czech|cesk|\bcz\b/i.test(companyName)) return 'CZK';
  if (/uk|united kingdom|britain|\bgb\b/i.test(companyName)) return 'GBP';
  return 'EUR';
}

// Índice de clientes de BC para búsqueda rápida por NIF, nombre, correo, etc.
async function customerIndex(ctx: BcContext): Promise<{ customers: CustomerRow[]; ownVat: string }> {
  return cached(`ocr:customers:${ctx.companyName}`, 6 * HOUR, async () => {
    const since = new Date(Date.now() - 365 * 24 * HOUR).toISOString().substring(0, 10);
    const [customers, invoices, info] = await Promise.all([
      bcFetchAll(odataUrl(`${ctx.apiBase}/customers`, {
        $select: 'number,displayName,email,website,taxRegistrationNumber,currencyCode,blocked'
      }), ctx.token),
      bcFetchAll(odataUrl(`${ctx.apiBase}/salesInvoices`, {
        $filter: `postingDate ge ${since}`,
        $select: 'customerNumber'
      }), ctx.token).catch(() => []),
      bcFetchAll(odataUrl(`${ctx.apiBase}/companyInformation`, {
        $select: 'taxRegistrationNumber'
      }), ctx.token).catch(() => []),
    ]);

    const count = new Map<string, number>();
    for (const i of invoices) count.set(i.customerNumber, (count.get(i.customerNumber) || 0) + 1);

    const rows = customers.map((c: any) => ({
      number: c.number,
      name: c.displayName || '',
      email: c.email || '',
      website: c.website || '',
      vat: squash(c.taxRegistrationNumber || ''),
      currency: c.currencyCode || '',
      blocked: !!c.blocked && c.blocked.trim?.() !== '' && c.blocked !== '_x0020_',
      invoices: count.get(c.number) || 0,
    }));

    return { customers: rows, ownVat: squash(info[0]?.taxRegistrationNumber || '') };
  });
}

const STOP = new Set([
  'gmbh', 'co', 'kg', 'ltd', 'limited', 'llc', 'inc', 'sl', 'slu', 'sa', 'sas', 'sarl', 'srl', 'ag', 'se', 'bv', 'nv', 'ab', 'oy', 'as',
  'the', 'and', 'und', 'de', 'del', 'la', 'el', 'les', 'der', 'die', 'das', 'en', 'et', 'of', 'for', 'mbh', 'ohg', 'ug', 'plc', 'spa',
  'eur', 'usd', 'gbp', 'chf', 'cny', 'rmb', 'cliente', 'ticket', 'tiquet'
]);

const nameWords = (name: string) => norm(name.replace(/\([^)]*\)/g, ' ')).split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !STOP.has(w));
const customerCurrency = (c: CustomerRow) => c.currency || c.name.match(/\((USD|EUR|GBP|CHF|CNY)\)/i)?.[1]?.toUpperCase() || '';

type Hints = Record<string, string | null>;
const hintsKey = (company: string) => `ocr:hints_customer:${company}`;

export async function matchCustomers(ctx: BcContext, text: string, ids: string[], currency: string): Promise<CustomerCandidate[]> {
  const [{ customers, ownVat }, hints] = await Promise.all([
    customerIndex(ctx),
    readSetting<Hints>(hintsKey(ctx.companyName), {})
  ]);

  const ownVatSquashed = squash(ownVat || '');
  const ownVatNoEs = ownVatSquashed.replace(/^ES/, '');
  // Excluimos nuestro propio NIF (Balinvest) para no asociarnos a nosotros mismos
  ids = ids.filter(id => id !== `vat:${ownVatSquashed}` && id !== `vat:${ownVatNoEs}` && id !== `vat:ES${ownVatNoEs}`);

  const words = new Set(norm(text).split(/[^a-z0-9]+/));
  const flat = norm(text).replace(/[^a-z0-9]+/g, ' ');
  const lcy = companyCurrency(ctx.companyName);
  const out: CustomerCandidate[] = [];

  for (const c of customers) {
    const currentCompNorm = norm(ctx.companyName);
    const isOwnCompany = (currentCompNorm.length > 3 && norm(c.name).includes(currentCompNorm)) || c.vat === ownVatNoEs || c.vat === ownVatSquashed;
    if (isOwnCompany) continue;
    let score = 0;
    const reasons: string[] = [];

    // 1. Coincidencia aprendida por ID previo
    const learnt = ids.filter(id => hints[id] === c.number);
    if (learnt.length) {
      score += 5;
      reasons.push(`reconocido por ${learnt.map(i => i.split(':')[1]).join(', ')} (facturas anteriores)`);
    }

    // 2. Coincidencia por NIF / CIF del cliente
    const cClean = squash(c.vat || '');
    const cNoEs = cClean.replace(/^ES/, '');
    const vatHit = (cClean.length >= 6 && ids.includes(`vat:${cClean}`)) ||
                   (cNoEs.length >= 6 && ids.includes(`vat:${cNoEs}`)) ||
                   (cNoEs.length >= 6 && ids.includes(`vat:ES${cNoEs}`));
    if (vatHit) {
      score += 4.5;
      reasons.push(`NIF/CIF ${c.vat}`);
    }

    // 3. Coincidencia por dominio web / email
    const doms = [c.email.split('@')[1], c.website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]]
      .filter(Boolean).map(d => d!.toLowerCase().split('.').slice(-2).join('.'));
    const dom = doms.find(d => ids.includes(`dom:${d}`));
    if (dom) {
      score += 3;
      reasons.push(`dominio ${dom}`);
    }

    // 4. Coincidencia por palabras del nombre del cliente
    const nw = nameWords(c.name);
    const hit = nw.filter(w => words.has(w));
    if (hit.length && hit.some(w => w.length >= 4)) {
      score += 3 * hit.length / nw.length + 0.5 * (hit.length - 1);
      const full = norm(c.name.replace(/\([^)]*\)/g, ' ')).replace(/[^a-z0-9]+/g, ' ').trim();
      if (full.split(' ').length > 1 && flat.includes(full)) score += 1.5;
      reasons.push(`nombre (${hit.length}/${nw.length} palabras)`);
    }

    if (score < 1) continue;

    const cur = customerCurrency(c) || lcy;
    if (currency) {
      if (cur === currency) { score += 0.5; }
      else { score -= 1; reasons.push(`divisa ${cur} ≠ ${currency} del PDF`); }
    }
    if (c.blocked) { score -= 2; reasons.push('bloqueado'); }
    score += Math.min(0.6, Math.log10(1 + c.invoices) / 4);

    out.push({
      number: c.number,
      name: c.name,
      vat: c.vat,
      currency: cur,
      score: Math.round(score * 100) / 100,
      reasons,
      invoices: c.invoices,
    });
  }

  return out.sort((a, b) => b.score - a.score || b.invoices - a.invoices).slice(0, 8);
}

export async function learnCustomer(company: string, ids: string[], customer: string) {
  if (!ids.length || !customer) return;
  const hints = await readSetting<Hints>(hintsKey(company), {});
  for (const id of ids) hints[id] = id in hints && hints[id] !== customer ? null : customer;
  await writeSetting(hintsKey(company), hints);
}

export async function customerByNumber(ctx: BcContext, number: string): Promise<CustomerCandidate | null> {
  const { customers } = await customerIndex(ctx);
  const found = customers.find(c => c.number.toLowerCase() === number.toLowerCase());
  if (!found) return null;
  return {
    number: found.number,
    name: found.name,
    vat: found.vat,
    currency: found.currency || companyCurrency(ctx.companyName),
    score: 1,
    reasons: ['seleccionado manualmente'],
    invoices: found.invoices,
  };
}

export async function searchCustomers(ctx: BcContext, query: string): Promise<CustomerCandidate[]> {
  const { customers } = await customerIndex(ctx);
  const qClean = norm(query.trim());
  if (!qClean) return customers.slice(0, 20).map(c => ({
    number: c.number,
    name: c.name,
    vat: c.vat,
    currency: c.currency || companyCurrency(ctx.companyName),
    score: 1,
    reasons: [],
    invoices: c.invoices,
  }));

  const matches = customers.filter(c =>
    norm(c.name).includes(qClean) ||
    c.number.toLowerCase().includes(qClean) ||
    (c.vat && c.vat.toLowerCase().includes(qClean))
  );

  return matches.slice(0, 20).map(c => ({
    number: c.number,
    name: c.name,
    vat: c.vat,
    currency: c.currency || companyCurrency(ctx.companyName),
    score: 1,
    reasons: [],
    invoices: c.invoices,
  }));
}

// Histórico de ventas de un cliente: consulta las facturas y abonos de venta registrados,
// y obtiene sus líneas (Posted Sales Lines) para servir como modelo de propuesta.
export async function customerHistory(ctx: BcContext, customerNo: string) {
  try {
    const [accMap, itmMap] = await Promise.all([
      accountNamesMap(ctx).catch(() => new Map<string, string>()),
      itemNamesMap(ctx).catch(() => new Map<string, string>()),
    ]);

    // 1. Buscar facturas de venta registradas de este cliente
    let targetCompanyId = ctx.companyId;
    let targetApiBase = ctx.apiBase;

    let postedInvoices: any[] = await bcFetchAll(odataUrl(`${targetApiBase}/salesInvoices`, {
      $filter: `customerNumber eq '${q(customerNo)}'`,
      $orderby: 'postingDate desc',
      $top: '10',
    }), ctx.token).catch(() => []);

    // Fallback: Si no hay facturas en la empresa activa, buscar en fallbackCompany si está configurada
    const fallbackCompany = process.env.BC_FALLBACK_COMPANY || (ctx.companyName.toUpperCase().includes('BALINVEST') ? 'BALINVEST TRADE SL 2023' : '');
    if (fallbackCompany && (!postedInvoices || !postedInvoices.length) && !ctx.companyName.includes(fallbackCompany)) {
      try {
        const compList = await bcFetchAll(`${ctx.root}/api/v2.0/companies`, ctx.token);
        const fbComp = (compList || []).find((c: any) => c.name.toLowerCase().includes(fallbackCompany.toLowerCase()));
        if (fbComp) {
          const fallbackApi = `${ctx.root}/api/v2.0/companies(${fbComp.id})`;
          const fbInvoices = await bcFetchAll(odataUrl(`${fallbackApi}/salesInvoices`, {
            $filter: `customerNumber eq '${q(customerNo)}'`,
            $orderby: 'postingDate desc',
            $top: '10',
          }), ctx.token).catch(() => []);
          if (fbInvoices && fbInvoices.length) {
            postedInvoices = fbInvoices;
            targetCompanyId = fbComp.id;
            targetApiBase = fallbackApi;
          }
        }
      } catch {}
    }

    const history: HistoryInvoice[] = [];

    // Procesar las facturas de venta más recientes
    for (const inv of postedInvoices.slice(0, 5)) {
      let lines: OcrLine[] = [];

      // Consultar Posted Sales Lines (salesInvoiceLines de API v2)
      try {
        const lRes = await bcFetchAll(`${targetApiBase}/salesInvoices(${inv.id})/salesInvoiceLines`, ctx.token);
        if (lRes && lRes.length > 0) {
          lines = lRes.map((l: any) => {
            const lineType = l.lineType === 'Account' ? 'Account' : l.lineType === 'Comment' ? 'Comment' : 'Item';
            const number = String(l.lineObjectNumber || l.itemId || l.accountId || '').trim();
            let description = String(l.description || '').trim();
            if (lineType === 'Item' && itmMap.has(number)) {
              description = itmMap.get(number) || description;
            } else if (lineType === 'Account' && accMap.has(number)) {
              description = accMap.get(number) || description;
            }
            const qty = Math.abs(parseFloat(l.quantity || '1')) || 1;
            const price = Math.abs(parseFloat(l.unitPrice || '0')) || 0;
            const taxCode = String(l.taxCode || 'IVA21').trim();

            return {
              lineType,
              number,
              description: description || (lineType === 'Item' ? `Artículo ${number}` : `Cuenta ${number}`),
              description2: String(l.description2 || '').trim(),
              quantity: qty,
              unitCost: price,
              taxCode,
              vatAmount: Math.abs(parseFloat(l.totalTaxAmount || '0')) || Math.round(price * (taxCode === 'IVA21' ? 0.21 : 0.10) * 100) / 100,
            };
          }).filter((l: OcrLine) => l.number || l.description);
        }
      } catch {}

      // Fallback a contabilidad (General Ledger Entries) si no se encontraron líneas directas
      if (!lines.length) {
        try {
          const gleRes = await bcFetchAll(odataUrl(`${ctx.root}/api/v2.0/companies(${targetCompanyId})/generalLedgerEntries`, {
            $filter: `documentNumber eq '${q(inv.number)}'`,
          }), ctx.token).catch(() => []);

          // En ventas, las cuentas de ingresos son el Grupo 7 (70000000, 70500000...) con haber/crédito
          const salesEntries = gleRes.filter((e: any) =>
            e.creditAmount > 0 && (e.accountNumber.startsWith('7') || (!e.accountNumber.startsWith('4') && !e.accountNumber.startsWith('3')))
          );
          const taxEntry = gleRes.find((e: any) => e.creditAmount > 0 && e.accountNumber.startsWith('477'));
          const net = salesEntries.reduce((s: number, e: any) => s + (e.creditAmount || 0), 0);
          const vat = taxEntry ? Math.round(taxEntry.creditAmount * 100) / 100 : 0;
          let vatGroup = 'IVA21';
          if (net > 0 && vat > 0) {
            const r = Math.round((vat / net) * 100);
            if (r >= 18 && r <= 25) vatGroup = 'IVA21';
            else if (r >= 8 && r <= 15) vatGroup = 'IVA10';
            else if (r >= 3 && r <= 6) vatGroup = 'IVA4';
          } else if (vat === 0) {
            vatGroup = 'EXENTO';
          }

          if (salesEntries.length > 0) {
            lines = salesEntries.map((e: any) => {
              const price = Math.round(e.creditAmount * 100) / 100;
              const rate = vatGroup === 'IVA21' ? 0.21 : vatGroup === 'IVA10' ? 0.10 : vatGroup === 'IVA4' ? 0.04 : 0;
              const accName = accMap.get(e.accountNumber);
              return {
                lineType: 'Account',
                number: e.accountNumber,
                description: accName || e.description || 'Ingreso venta',
                description2: '',
                quantity: 1,
                unitCost: price,
                taxCode: vatGroup,
                vatAmount: Math.round(price * rate * 100) / 100,
              };
            });
          }
        } catch {}
      }

      history.push({
        number: inv.number,
        vendorInvoiceNumber: inv.externalDocumentNumber || inv.number,
        invoiceDate: inv.invoiceDate || '',
        postingDate: inv.postingDate || '',
        dueDate: inv.dueDate || '',
        currency: inv.currencyCode || companyCurrency(ctx.companyName),
        net: inv.totalAmountExcludingTax ?? (lines.reduce((s, l) => s + (l.quantity * l.unitCost), 0) || null),
        vat: inv.totalTaxAmount ?? (lines.reduce((s, l) => s + (l.vatAmount || 0), 0) || null),
        total: inv.totalAmountIncludingTax ?? null,
        lines,
      });
    }

    return { history };
  } catch (err: any) {
    console.error('Error al obtener histórico de ventas de BC:', err);
    return { history: [] };
  }
}

// Comprueba si ya existe una factura o abono de venta en BC con este número
export async function existingForSales(ctx: BcContext, customerNo: string, invoiceNo: string, docType?: 'invoice' | 'credit_note') {
  if (!invoiceNo) return [];
  const out: { id: string; no: string }[] = [];
  const cleanNo = invoiceNo.trim();

  try {
    if (docType === 'credit_note') {
      const cms = await bcFetchAll(odataUrl(`${ctx.apiBase}/salesCreditMemos`, {
        $filter: `customerNumber eq '${q(customerNo)}' and (externalDocumentNumber eq '${q(cleanNo)}' or number eq '${q(cleanNo)}')`,
        $select: 'id,number'
      }), ctx.token).catch(() => []);
      for (const cm of cms) out.push({ id: cm.id, no: cm.number });
    } else {
      const invs = await bcFetchAll(odataUrl(`${ctx.apiBase}/salesInvoices`, {
        $filter: `customerNumber eq '${q(customerNo)}' and (externalDocumentNumber eq '${q(cleanNo)}' or number eq '${q(cleanNo)}')`,
        $select: 'id,number'
      }), ctx.token).catch(() => []);
      for (const i of invs) out.push({ id: i.id, no: i.number });
    }
  } catch {}

  return out;
}

const flat = (t: string) => t.replace(/\s+/g, ' ');

// Genera la propuesta automática de cabecera y líneas para la factura o abono de venta
export function proposeSales(
  text: string,
  history: HistoryInvoice[],
  filename?: string,
  customer?: CustomerCandidate | null,
  detectedCurr?: string
): OcrSuggestion | null {
  const t = flat(text);
  const warnings: string[] = [];
  const generic = guessHeader(t, filename);
  const invoiceNo = generic.invoiceNo;
  const invoiceDate = generic.invoiceDate;
  const dueDate = generic.dueDate || '';
  const postingDate = invoiceDate;

  const { net, vat, total, isReverseCharge } = totals(t);
  if (net == null) warnings.push('No se han detectado los importes automáticamente: revísalos en la tabla.');

  const absNet = net != null ? Math.abs(net) : null;
  const absVat = vat != null ? Math.abs(vat) : null;
  const absTotal = total != null ? Math.abs(total) : null;

  let currency = detectedCurr || detectCurrency(text) || (history[0]?.currency) || (customer?.currency) || 'EUR';
  if (currency === 'EU') currency = 'EUR';

  // Detección de cliente intracomunitario (miembro de la UE sin ser España)
  const isEuCustomer = Boolean(
    customer?.vat &&
    /^(AT|BE|BG|CY|CZ|DE|DK|EE|EL|GR|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK)/i.test(customer.vat) &&
    !customer.vat.toUpperCase().startsWith('ES')
  );

  const reverseChargeEffective = Boolean(
    (isReverseCharge || (isEuCustomer && (!absVat || absVat === 0))) && (!absVat || absVat === 0)
  );
  const isZeroVat = absVat === 0 || reverseChargeEffective;

  let defaultTaxCode = 'IVA21';
  if (isZeroVat) {
    defaultTaxCode = 'EXENTO';
  } else if (absNet != null && absVat != null && absNet > 0) {
    const r = Math.round((absVat / absNet) * 100);
    if (r >= 18 && r <= 25) defaultTaxCode = 'IVA21';
    else if (r >= 8 && r <= 15) defaultTaxCode = 'IVA10';
    else if (r >= 3 && r <= 6) defaultTaxCode = 'IVA4';
  }

  let effectiveNet = absNet;
  if (effectiveNet == null && absTotal != null && isZeroVat) {
    effectiveNet = absTotal;
  }

  // Detección de Abono / Factura Rectificativa vs Factura ordinaria
  const isCreditNote = /\b(abono\s+de\s+factura|factura\s+rectificativa|rectificativa|credit\s+note|credit\s+memo|nota\s+de\s+cr[eé]dito|nota\s+de\s+abono|gutschrift|avoir|nota\s+di\s+credito|creditnota|faktura\s+koryguj[ąa]ca|korekta|opravn[yý]\s+da[nň]ov[yý]\s+doklad|dobropis)\b/iu.test(t.slice(0, 2500))
    || (/\b(abono|avoir|dobropis|gutschrift|creditnota|korekta)\b/iu.test(t.slice(0, 2500)) && !/\b(factura(?!\s+rectificativa)|facture(?!\s+d['’]avoir)|rechnung(?!\s+gutschrift))\b/iu.test(t.slice(0, 400)))
    || (Boolean(filename) && /\b(abono|credit|gutschrift|avoir|dobropis|creditnota|korekta)\b/iu.test(filename || ''))
    || (total != null && total < 0)
    || (net != null && net < 0);
  const documentType = isCreditNote ? 'credit_note' : 'invoice';

  const model = history[0];
  let lines: OcrLine[] = [];

  if (model && model.lines.length) {
    lines = model.lines.map(l => ({
      ...l,
      taxCode: isZeroVat ? 'EXENTO' : (l.taxCode && !l.taxCode.startsWith('477') ? l.taxCode : defaultTaxCode),
      vatAmount: isZeroVat ? 0 : (l.vatAmount != null ? Math.abs(l.vatAmount) : 0),
    }));

    if (effectiveNet != null) {
      if (lines.length === 1) {
        lines[0].quantity = 1;
        lines[0].unitCost = effectiveNet;
        lines[0].vatAmount = isZeroVat ? 0 : (absVat != null ? absVat : r2(effectiveNet * 0.21));
      } else {
        const sum = lines.reduce((a, l) => a + Math.abs(l.quantity) * Math.abs(l.unitCost), 0) || 1;
        lines.forEach(l => {
          const qty = Math.abs(l.quantity) || 1;
          const prevPrice = Math.abs(l.unitCost);
          l.quantity = qty;
          l.unitCost = r2((effectiveNet * (qty * prevPrice)) / sum / qty);
          l.vatAmount = isZeroVat ? 0 : (absVat != null ? r2((absVat * (qty * l.unitCost)) / effectiveNet) : r2(l.unitCost * 0.21));
        });
      }
    }
  } else {
    // Si no hay histórico de ventas, proponemos una cuenta típica de ingresos de ventas (70000000 Venta de mercaderías)
    lines = [{
      lineType: 'Account',
      number: '70000000',
      description: isCreditNote ? 'Abono / Devolución venta' : 'Venta de mercaderías',
      description2: '',
      quantity: 1,
      unitCost: effectiveNet || 0,
      taxCode: defaultTaxCode,
      vatAmount: isZeroVat ? 0 : (absVat != null ? absVat : (effectiveNet ? r2(effectiveNet * 0.21) : 0)),
    }];
  }

  let comment = '';
  if (isZeroVat) {
    comment = 'Operación con 0% IVA / Exenta / Exportación o entrega intracomunitaria.';
  } else if (isCreditNote) {
    comment = model
      ? `Abono de venta basado en factura anterior ${model.number}`
      : 'Abono / Factura rectificativa de venta.';
  } else if (model) {
    comment = `Basado en la factura de venta anterior ${model.number}`;
  } else {
    comment = 'Nueva factura de venta sin histórico previo.';
  }

  const postingDescription = isCreditNote
    ? `Abono Venta ${invoiceNo || ''}`.trim()
    : `Factura Venta ${invoiceNo || ''}`.trim();

  return {
    documentType,
    invoiceNo,
    invoiceDate,
    postingDate,
    dueDate,
    postingDescription,
    currency,
    net: absNet,
    vat: reverseChargeEffective ? 0 : absVat,
    total: absTotal,
    lines,
    comment,
    isReverseCharge: reverseChargeEffective,
  };
}

export async function processPdfSales(ctx: BcContext, file: string, data: Uint8Array, customerNo?: string): Promise<OcrResult> {
  const warnings: string[] = [];
  let text = '';
  try { text = await pdfText(data); } catch (e: any) { warnings.push(`No se ha podido leer el texto del PDF (${e.message}).`); }
  const scanned = text.replace(/\s/g, '').length < 40;
  if (scanned) {
    text = '';
    warnings.push('PDF escaneado o sin capa de texto: por favor, selecciona el cliente e introduce los importes manualmente.');
  }

  const ids = identifiers(text);
  const detectedCurr = detectCurrency(text) || 'EUR';
  const candidates = text ? await matchCustomers(ctx, text, ids, detectedCurr) : [];
  const customer = customerNo ? await customerByNumber(ctx, customerNo) : candidates[0] || null;

  if (customerNo && !customer) warnings.push(`El cliente ${customerNo} no se encontró en ${ctx.companyName}.`);
  if (!customer && !scanned) warnings.push('No se ha reconocido el cliente con certeza: selecciónalo en el buscador.');

  const { history } = customer ? await customerHistory(ctx, customer.number) : { history: [] };
  if (customer && !history.length) warnings.push('Este cliente no tiene ventas previas registradas: introduce la cuenta o artículo de venta.');

  let finalCurrency = detectedCurr;
  if (!finalCurrency || finalCurrency === 'EUR') {
    if (history[0]?.currency && history[0].currency !== 'EU') finalCurrency = history[0].currency;
    else if (customer?.currency && customer.currency !== 'EU') finalCurrency = customer.currency;
  }
  if (finalCurrency === 'EU') finalCurrency = 'EUR';

  const suggestion = proposeSales(text, history, file, customer, finalCurrency);
  if (suggestion) {
    if (suggestion.documentType === 'credit_note') {
      warnings.push('El documento ha sido detectado como abono / factura rectificativa de venta.');
    }
    // Determinar la fecha de registro según periodos contables e IVA de Business Central
    try {
      const postingCheck = await determinePostingDate(suggestion.invoiceDate, ctx);
      suggestion.postingDate = postingCheck.postingDate;
      suggestion.postingDateAdjusted = postingCheck.wasAdjusted;
      suggestion.postingDateReason = postingCheck.reason || undefined;
      if (postingCheck.wasAdjusted && postingCheck.reason) {
        warnings.push(postingCheck.reason);
      }
    } catch (err: any) {
      console.error('Error al validar fecha de registro con periodos de BC:', err);
    }
  }

  const existing = customer && suggestion?.invoiceNo ? await existingForSales(ctx, customer.number, suggestion.invoiceNo, suggestion.documentType) : [];
  if (existing.length) warnings.push(`¡Aviso! Ya existe un documento de venta en BC con este número: ${existing.map(e => e.no).join(', ')}`);

  return { file, scanned, currency: finalCurrency, ids, candidates, customer, history, suggestion, existing, warnings };
}

// ---------- Creación de Factura de Venta en Business Central ----------
export async function createOcrSalesInvoice(ctx: BcContext, input: OcrCreateSalesInput, pdf?: { name: string; data: Uint8Array }) {
  const warnings: string[] = [];

  // 1. Crear cabecera de la Factura de Venta (Sales Invoice)
  const headPayload: any = {
    customerNumber: input.customer,
    externalDocumentNumber: input.invoiceNo,
    ...(input.currency && input.currency !== 'EUR' && input.currency !== 'EU' ? { currencyCode: input.currency } : {}),
    ...(input.invoiceDate ? { invoiceDate: input.invoiceDate } : {}),
    ...(input.postingDate ? { postingDate: input.postingDate } : {}),
  };

  const head = await bcRequest('POST', `${ctx.apiBase}/salesInvoices`, ctx.token, headPayload);
  const id: string = head.id, no: string = head.number;
  const headUrl = `${ctx.apiBase}/salesInvoices(${id})`;

  try {
    if (input.dueDate) await bcRequest('PATCH', headUrl, ctx.token, { dueDate: input.dueDate });

    // Eliminar líneas predeterminadas que añade BC al fijar el cliente
    const auto = await bcRequest('GET', `${headUrl}/salesInvoiceLines?$select=id`, ctx.token);
    for (const l of auto?.value || []) await bcRequest('DELETE', `${headUrl}/salesInvoiceLines(${l.id})`, ctx.token);

    // Añadir líneas revisadas (en ventas se utiliza unitPrice)
    for (const l of input.lines) {
      const comment = l.lineType === 'Comment';
      await bcRequest('POST', `${headUrl}/salesInvoiceLines`, ctx.token, comment
        ? { lineType: 'Comment', description: l.description }
        : {
          lineType: l.lineType,
          lineObjectNumber: l.number,
          quantity: l.quantity,
          unitPrice: l.unitCost,
          ...(l.description ? { description: l.description } : {}),
          ...(l.description2 ? { description2: l.description2 } : {}),
          ...(l.taxCode ? { taxCode: l.taxCode } : {}),
        });
    }
  } catch (e) {
    await bcRequest('DELETE', headUrl, ctx.token).catch(() => {});
    throw e;
  }

  // Posting Description vía OData si está disponible
  if (input.postingDescription?.trim()) {
    try {
      await bcRequest('PATCH', `${ctx.odataCompanyBase}/salesDocuments(${id})`, ctx.token, {
        postingDescription: input.postingDescription.trim().substring(0, 100)
      });
    } catch {}
  }

  // Adjuntar PDF original a la factura de venta
  if (pdf) {
    try {
      await attachFile(ctx, id, pdf, 'Sales Invoice');
    } catch (e: any) {
      warnings.push(`Aviso: No se pudo adjuntar el PDF (${e.message})`);
    }
  }

  const after = await bcRequest('GET', headUrl, ctx.token).catch(() => null);
  return {
    id,
    no,
    documentType: 'invoice' as const,
    net: after?.totalAmountExcludingTax ?? null,
    total: after?.totalAmountIncludingTax ?? null,
    currency: after?.currencyCode || 'EUR',
    warnings,
  };
}

// ---------- Creación de Abono de Venta en Business Central ----------
export async function createOcrSalesCreditMemo(ctx: BcContext, input: OcrCreateSalesInput, pdf?: { name: string; data: Uint8Array }) {
  const warnings: string[] = [];

  // Crear cabecera del abono de venta (Sales Credit Memo)
  const headPayload: any = {
    customerNumber: input.customer,
    externalDocumentNumber: input.invoiceNo,
    ...(input.currency && input.currency !== 'EUR' && input.currency !== 'EU' ? { currencyCode: input.currency } : {}),
    ...(input.invoiceDate ? { creditMemoDate: input.invoiceDate } : {}),
    ...(input.postingDate ? { postingDate: input.postingDate } : {}),
  };

  const head = await bcRequest('POST', `${ctx.apiBase}/salesCreditMemos`, ctx.token, headPayload);
  const id: string = head.id, no: string = head.number;
  const headUrl = `${ctx.apiBase}/salesCreditMemos(${id})`;

  try {
    if (input.dueDate) await bcRequest('PATCH', headUrl, ctx.token, { dueDate: input.dueDate });

    // Eliminar líneas predeterminadas que añade BC
    const auto = await bcRequest('GET', `${headUrl}/salesCreditMemoLines?$select=id`, ctx.token);
    for (const l of auto?.value || []) await bcRequest('DELETE', `${headUrl}/salesCreditMemoLines(${l.id})`, ctx.token);

    // Añadir líneas revisadas al abono de venta
    for (const l of input.lines) {
      const comment = l.lineType === 'Comment';
      await bcRequest('POST', `${headUrl}/salesCreditMemoLines`, ctx.token, comment
        ? { lineType: 'Comment', description: l.description }
        : {
          lineType: l.lineType,
          lineObjectNumber: l.number,
          quantity: l.quantity,
          unitPrice: l.unitCost,
          ...(l.description ? { description: l.description } : {}),
          ...(l.description2 ? { description2: l.description2 } : {}),
          ...(l.taxCode ? { taxCode: l.taxCode } : {}),
        });
    }
  } catch (e) {
    await bcRequest('DELETE', headUrl, ctx.token).catch(() => {});
    throw e;
  }

  // Posting Description vía OData si está disponible
  if (input.postingDescription?.trim()) {
    try {
      await bcRequest('PATCH', `${ctx.odataCompanyBase}/salesDocuments(${id})`, ctx.token, {
        postingDescription: input.postingDescription.trim().substring(0, 100)
      });
    } catch {}
  }

  // Adjuntar PDF original al abono de venta
  if (pdf) {
    try {
      await attachFile(ctx, id, pdf, 'Sales Credit Memo');
    } catch (e: any) {
      warnings.push(`Aviso: No se pudo adjuntar el PDF (${e.message})`);
    }
  }

  const after = await bcRequest('GET', headUrl, ctx.token).catch(() => null);
  return {
    id,
    no,
    documentType: 'credit_note' as const,
    net: after?.totalAmountExcludingTax ?? null,
    total: after?.totalAmountIncludingTax ?? null,
    currency: after?.currencyCode || 'EUR',
    warnings,
  };
}
