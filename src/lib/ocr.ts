import { getDocumentProxy, extractText } from 'unpdf';
import { bcFetchAll, BcContext, odataUrl } from '@/lib/bcClient';
import { attachFile, bcRequest } from '@/lib/bcWrite';
import { cached, readSetting, writeSetting, HOUR } from '@/lib/cache';
import { determinePostingDate } from '@/lib/bcPostingPeriod';

// OCR de facturas de compra: del PDF de un proveedor a una Purchase Invoice sin registrar en BC.
// 1. Texto del PDF con unpdf (un escaneo sin texto no se puede leer).
// 2. Proveedor: identificadores del PDF (NIF/VAT, IBAN, dominio de correo/web) aprendidos de las facturas ya creadas
//    desde aquí (setting ocr:hints:<empresa>), el VAT y el correo de la ficha del proveedor, las palabras de su nombre,
//    la divisa y cuántas facturas suyas hay en el último año.
// 3. Sus facturas registradas más recientes (líneas y el texto del PDF adjunto) son el modelo.

export type OcrLine = {
  lineType: string;
  number: string;
  description: string;
  description2: string;
  quantity: number;
  unitCost: number;
  taxCode: string;
  vatAmount?: number;
};

export type VendorCandidate = {
  number: string;
  name: string;
  vat?: string;
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
  net: number;
  total: number;
  postingDescription: string;
  lines: OcrLine[];
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
  comment: string;
  isReverseCharge?: boolean;
  postingDateAdjusted?: boolean;
  postingDateReason?: string | null;
};

export type OcrResult = {
  file: string;
  scanned: boolean;
  currency: string;
  ids: string[];
  candidates: VendorCandidate[];
  vendor: VendorCandidate | null;
  history: HistoryInvoice[];
  suggestion: OcrSuggestion | null;
  existing: { no: string; status: string }[];
  warnings: string[];
};

export function companyCurrency(company: string): string {
  if (/\bUK\b/i.test(company)) return 'GBP';
  if (/\bAG\b/i.test(company) || /\bCH\b/i.test(company)) return 'CHF';
  if (/\bUS\b/i.test(company)) return 'USD';
  return 'EUR';
}

const q = (s: string) => s.replace(/'/g, "''");
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ß/g, 'ss');
const squash = (s: string) => s.replace(/[\s.\-/]/g, '').toUpperCase();

export async function pdfText(data: Uint8Array): Promise<string> {
  const { text } = await extractText(await getDocumentProxy(data), { mergePages: true });
  return String(text).replace(/[ \t]+/g, ' ').trim();
}

// ---------- Identificadores del PDF ----------
const VAT_RE = /\b(ATU ?\d{8}|BE ?0?\d{9}|CHE[- ]?\d{3}\.?\d{3}\.?\d{3}|CZ ?\d{8,10}|DE ?\d{3} ?\d{3} ?\d{3}|DK ?\d{8}|ES ?[A-Z0-9]\d{7}[A-Z0-9]|FR ?[A-Z0-9]{2} ?\d{9}|GB ?\d{3} ?\d{4} ?\d{2}(?:\d{3})?|IE ?\d[A-Z0-9]\d{5}[A-Z]{1,2}|IT ?\d{11}|LU ?\d{8}|NL ?\d{9}B\d{2}|PL ?\d{10}|PT ?\d{9}|SE ?\d{12})\b/g;
const ES_NIF_RE = /\b(?:ES[- ]?)?([ABCDEFGHJNPQRSUVW][ -]?\d{7}[ -]?[0-9A-J]|\d{8}[ -]?[A-Z]|[XYZ][ -]?\d{7}[ -]?[A-Z])\b/gi;
const IBAN_RE = /\b([A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?)\b/g;
const MAIL_RE = /[\w.+-]+@((?:[\w-]+\.)+[a-z]{2,})/gi;
const WEB_RE = /\bwww\.((?:[\w-]+\.)+[a-z]{2,})/gi;
const GENERIC_DOMAINS = /^(gmail|googlemail|outlook|hotmail|yahoo|gmx|web|icloud|live|t-online)\./i;

export function identifiers(text: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(VAT_RE)) {
    const v = squash(m[1]);
    ids.add(`vat:${v}`);
    if (v.startsWith('ES')) {
      ids.add(`vat:${v.slice(2)}`);
    }
  }
  for (const m of text.matchAll(ES_NIF_RE)) {
    const v = squash(m[0]);
    ids.add(`vat:${v}`);
    if (v.startsWith('ES')) {
      ids.add(`vat:${v.slice(2)}`);
    } else {
      ids.add(`vat:ES${v}`);
    }
  }
  for (const m of text.matchAll(IBAN_RE)) {
    const iban = squash(m[1]);
    if (iban.length >= 15 && iban.length <= 34) ids.add(`iban:${iban}`);
  }
  for (const re of [MAIL_RE, WEB_RE]) {
    for (const m of text.matchAll(re)) {
      const dom = m[1].toLowerCase().split('.').slice(-2).join('.');
      if (!GENERIC_DOMAINS.test(dom)) ids.add(`dom:${dom}`);
    }
  }
  return [...ids];
}

export function detectCurrency(text: string): string {
  const count = (re: RegExp) => (text.match(re) || []).length;
  // Prioridad 1: Etiqueta explícita de divisa ("Invoice Currency PLN", "Waluta faktury PLN", "Fakturavaluta SEK", etc.)
  const explicit = text.match(/(?:invoice\s+currency|waluta\s+faktury|fakturavaluta|moneda(?:\s+de\s+la\s+factura)?|currency|divisa)\s*[:.]?\s*([A-Z]{3})\b/i);
  if (explicit) {
    const code = explicit[1].toUpperCase();
    if (['PLN', 'SEK', 'NOK', 'DKK', 'CHF', 'GBP', 'USD', 'EUR', 'CZK', 'HUF', 'RON', 'BGN', 'TRY', 'CAD', 'AUD', 'JPY'].includes(code)) {
      return code;
    }
  }

  const scores: [string, number][] = [
    ['PLN', count(/\bPLN\b|\bz[łl]\b/gi) * 3],
    ['SEK', count(/\bSEK\b/gi) * 3],
    ['NOK', count(/\bNOK\b/gi) * 3],
    ['DKK', count(/\bDKK\b/gi) * 3],
    ['CHF', count(/\bCHF\b/gi) * 3],
    ['GBP', count(/\bGBP\b|£/gi) * 3],
    ['USD', count(/\bUSD\b|US\$/gi) * 3],
    ['EUR', count(/\bEUR\b|€/gi) * 2],
    ['CZK', count(/\bCZK\b/gi) * 3],
    ['HUF', count(/\bHUF\b/gi) * 3],
    ['RON', count(/\bRON\b/gi) * 3],
    ['TRY', count(/\bTRY\b/gi) * 3],
    ['CAD', count(/\bCAD\b/gi) * 3],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  return scores[0] && scores[0][1] > 0 ? scores[0][0] : 'EUR';
}

// ---------- Proveedores ----------
type VendorRow = {
  number: string;
  name: string;
  email: string;
  website: string;
  vat: string;
  currency: string;
  blocked: boolean;
  invoices: number;
};

async function vendorIndex(ctx: BcContext): Promise<{ vendors: VendorRow[]; ownVat: string }> {
  return cached(`ocr:vendors:${ctx.companyName}`, 6 * HOUR, async () => {
    const since = new Date(Date.now() - 365 * 24 * HOUR).toISOString().substring(0, 10);
    const [vendors, invoices, info] = await Promise.all([
      bcFetchAll(odataUrl(`${ctx.apiBase}/vendors`, { $select: 'number,displayName,email,website,taxRegistrationNumber,currencyCode,blocked' }), ctx.token),
      bcFetchAll(odataUrl(`${ctx.apiBase}/purchaseInvoices`, { $filter: `postingDate ge ${since}`, $select: 'vendorNumber' }), ctx.token).catch(() => []),
      bcFetchAll(odataUrl(`${ctx.apiBase}/companyInformation`, { $select: 'taxRegistrationNumber' }), ctx.token).catch(() => []),
    ]);
    const count = new Map<string, number>();
    for (const i of invoices) count.set(i.vendorNumber, (count.get(i.vendorNumber) || 0) + 1);
    const rows = vendors.map((v: any) => ({
      number: v.number,
      name: v.displayName || '',
      email: v.email || '',
      website: v.website || '',
      vat: squash(v.taxRegistrationNumber || ''),
      currency: v.currencyCode || '',
      blocked: !!v.blocked && v.blocked.trim?.() !== '' && v.blocked !== '_x0020_',
      invoices: count.get(v.number) || 0,
    }));
    return { vendors: rows, ownVat: squash(info[0]?.taxRegistrationNumber || '') };
  });
}

const STOP = new Set([
  'gmbh', 'co', 'kg', 'ltd', 'limited', 'llc', 'inc', 'sl', 'slu', 'sa', 'sas', 'sarl', 'srl', 'ag', 'se', 'bv', 'nv', 'ab', 'oy', 'as',
  'the', 'and', 'und', 'de', 'del', 'la', 'el', 'les', 'der', 'die', 'das', 'en', 'et', 'of', 'for', 'mbh', 'ohg', 'ug', 'plc', 'spa',
  'eur', 'usd', 'gbp', 'chf', 'cny', 'rmb', 'sepa', 'lastschrift', 'credit', 'card', 'paypal', 'kreditkarte'
]);

const nameWords = (name: string) => norm(name.replace(/\([^)]*\)/g, ' ')).split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !STOP.has(w));
const vendorCurrency = (v: VendorRow) => v.currency || v.name.match(/\((USD|EUR|GBP|CHF|CNY)\)/i)?.[1]?.toUpperCase() || '';

type Hints = Record<string, string | null>;
const hintsKey = (company: string) => `ocr:hints:${company}`;

export async function matchVendors(ctx: BcContext, text: string, ids: string[], currency: string): Promise<VendorCandidate[]> {
  const [{ vendors, ownVat }, hints] = await Promise.all([vendorIndex(ctx), readSetting<Hints>(hintsKey(ctx.companyName), {})]);
  const ownVatSquashed = squash(ownVat || '');
  const ownVatNoEs = ownVatSquashed.replace(/^ES/, '');
  ids = ids.filter(id => id !== `vat:${ownVatSquashed}` && id !== `vat:${ownVatNoEs}` && id !== `vat:ES${ownVatNoEs}`);
  const words = new Set(norm(text).split(/[^a-z0-9]+/));
  const flat = norm(text).replace(/[^a-z0-9]+/g, ' ');
  const lcy = companyCurrency(ctx.companyName);
  const out: VendorCandidate[] = [];

  for (const v of vendors) {
    if (norm(v.name).includes('balinvest') || v.vat === ownVatNoEs || v.vat === ownVatSquashed) continue;
    let score = 0;
    const reasons: string[] = [];
    const learnt = ids.filter(id => hints[id] === v.number);
    if (learnt.length) {
      score += 5;
      reasons.push(`reconocido por ${learnt.map(i => i.split(':')[1]).join(', ')} (facturas anteriores)`);
    }
    const vClean = squash(v.vat || '');
    const vNoEs = vClean.replace(/^ES/, '');
    const vatHit = (vClean.length >= 8 && ids.includes(`vat:${vClean}`)) ||
                   (vNoEs.length >= 8 && ids.includes(`vat:${vNoEs}`)) ||
                   (vNoEs.length >= 8 && ids.includes(`vat:ES${vNoEs}`));
    if (vatHit) {
      score += 4;
      reasons.push(`NIF/CIF ${v.vat}`);
    }
    const doms = [v.email.split('@')[1], v.website.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]]
      .filter(Boolean).map(d => d!.toLowerCase().split('.').slice(-2).join('.'));
    const dom = doms.find(d => !GENERIC_DOMAINS.test(d) && ids.includes(`dom:${d}`));
    if (dom) {
      score += 3;
      reasons.push(`dominio ${dom}`);
    }
    const nw = nameWords(v.name);
    const hit = nw.filter(w => words.has(w));
    if (hit.length && hit.some(w => w.length >= 4)) {
      score += 3 * hit.length / nw.length + 0.5 * (hit.length - 1);
      const full = norm(v.name.replace(/\([^)]*\)/g, ' ')).replace(/[^a-z0-9]+/g, ' ').trim();
      if (full.split(' ').length > 1 && flat.includes(full)) score += 1;
      reasons.push(`nombre (${hit.length}/${nw.length} palabras)`);
    }
    if (score < 1) continue;

    const cur = vendorCurrency(v) || lcy;
    if (currency) {
      if (cur === currency) { score += 0.5; }
      else { score -= 1; reasons.push(`divisa ${cur} ≠ ${currency} del PDF`); }
    }
    if (v.blocked) { score -= 2; reasons.push('bloqueado'); }
    score += Math.min(0.6, Math.log10(1 + v.invoices) / 4);
    out.push({
      number: v.number,
      name: v.name,
      vat: v.vat,
      currency: cur,
      score: Math.round(score * 100) / 100,
      reasons,
      invoices: v.invoices,
    });
  }
  return out.sort((a, b) => b.score - a.score || b.invoices - a.invoices).slice(0, 8);
}

export async function learnVendor(company: string, ids: string[], vendor: string) {
  if (!ids.length || !vendor) return;
  const hints = await readSetting<Hints>(hintsKey(company), {});
  for (const id of ids) hints[id] = id in hints && hints[id] !== vendor ? null : vendor;
  await writeSetting(hintsKey(company), hints);
}

export async function vendorByNumber(ctx: BcContext, number: string): Promise<VendorCandidate | null> {
  const v = (await vendorIndex(ctx)).vendors.find(x => x.number.toLowerCase() === number.trim().toLowerCase());
  return v ? { number: v.number, name: v.name, vat: v.vat, currency: vendorCurrency(v) || companyCurrency(ctx.companyName), score: 0, reasons: ['elegido a mano'], invoices: v.invoices } : null;
}

export async function searchVendors(ctx: BcContext, term: string) {
  const t = norm(term.trim());
  if (t.length < 2) return [];
  return (await vendorIndex(ctx)).vendors
    .filter(v => v.number.toLowerCase().includes(t) || norm(v.name).includes(t))
    .sort((a, b) => b.invoices - a.invoices)
    .slice(0, 20)
    .map(v => ({ number: v.number, name: v.name, currency: vendorCurrency(v) || companyCurrency(ctx.companyName), invoices: v.invoices }));
}

// ---------- Facturas anteriores del proveedor ----------
const LINE_TYPE: Record<string, string> = {
  Item: 'Item',
  G_x002F_L_x0020_Account: 'Account',
  'G/L Account': 'Account',
  Resource: 'Resource',
  Fixed_x0020_Asset: 'Fixed Asset',
  'Fixed Asset': 'Fixed Asset',
  Charge_x0020__x0028_Item_x0029_: 'Charge',
  'Charge (Item)': 'Charge',
  _x0020_: 'Comment',
  '': 'Comment'
};

const toLine = (l: any): OcrLine => ({
  lineType: LINE_TYPE[l.type] ?? String(l.type || 'Item'),
  number: l.no || l.lineObjectNumber || '',
  description: l.description || '',
  description2: l.description2 || '',
  quantity: l.quantity || 1,
  unitCost: l.directUnitCost ?? l.unitCost ?? 0,
  taxCode: l.vatProdPostingGroup || l.taxCode || '',
});

async function bcGet(ctx: BcContext, url: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`BC ${res.status}: ${(await res.text()).substring(0, 200)}`);
  return res.json();
}

async function accountNamesMap(ctx: BcContext): Promise<Map<string, string>> {
  return cached(`ocr:account-names:${ctx.companyName}`, 6 * HOUR, async () => {
    try {
      const data = await bcFetchAll(odataUrl(`${ctx.apiBase}/accounts`, {
        $select: 'number,displayName',
      }), ctx.token);
      const map: Record<string, string> = {};
      for (const a of data) {
        if (a.number && a.displayName) map[a.number] = a.displayName;
      }
      return map;
    } catch {
      return {};
    }
  }).then(obj => new Map(Object.entries(obj)));
}

async function itemNamesMap(ctx: BcContext): Promise<Map<string, string>> {
  return cached(`ocr:item-names:${ctx.companyName}`, 6 * HOUR, async () => {
    try {
      const data = await bcFetchAll(odataUrl(`${ctx.apiBase}/items`, {
        $select: 'number,displayName',
        $top: '2000',
      }), ctx.token);
      const map: Record<string, string> = {};
      for (const item of data) {
        if (item.number && item.displayName) map[item.number] = item.displayName;
      }
      return map;
    } catch {
      return {};
    }
  }).then(obj => new Map(Object.entries(obj)));
}

function parseBcLines(rawLines: any[], itmMap: Map<string, string>, accMap: Map<string, string>): OcrLine[] {
  return rawLines.map((l: any) => {
    const rawType = String(l.Type || l.type || l.FilteredTypeField || '').trim();
    let lineType: 'Account' | 'Item' | 'Resource' | 'Fixed Asset' | 'Charge' | 'Comment' = 'Account';
    if (/item|art[ií]culo/i.test(rawType) || rawType === '1' || l.lineObjectNumber) {
      lineType = 'Item';
    } else if (/account|cuenta|g_x002f_l|g\/l/i.test(rawType) || rawType === '2') {
      lineType = 'Account';
    } else if (/fixed|activo/i.test(rawType)) {
      lineType = 'Fixed Asset';
    } else if (/charge|cargo/i.test(rawType)) {
      lineType = 'Charge';
    }

    const number = String(l.No || l.No_ || l.no || l.lineObjectNumber || '').trim();
    let description = String(l.Description || l.description || '').trim();
    if (itmMap.has(number) && (!accMap.has(number) || lineType === 'Item')) {
      lineType = 'Item';
    }
    if (lineType === 'Item' && itmMap.has(number)) {
      description = itmMap.get(number) || description;
    } else if (lineType === 'Account' && accMap.has(number)) {
      description = accMap.get(number) || description;
    }

    const qty = Math.abs(parseFloat(l.Quantity || l.quantity || '1')) || 1;
    const cost = Math.abs(parseFloat(l.Direct_Unit_Cost || l.directUnitCost || l.Unit_Cost || l.unitCost || '0')) || 0;
    const taxCode = String(l.VAT_Prod_Posting_Group || l.vatProdPostingGroup || l.taxCode || 'IVA21').trim();

    return {
      lineType,
      number,
      description: description || (lineType === 'Item' ? `Artículo ${number}` : `Cuenta ${number}`),
      description2: String(l.Description_2 || l.description2 || '').trim(),
      quantity: qty,
      unitCost: cost,
      taxCode,
      vatAmount: Math.round(cost * (taxCode === 'IVA21' ? 0.21 : 0.10) * 100) / 100,
    };
  }).filter((l: OcrLine) => l.number || l.description);
}

export async function vendorHistory(ctx: BcContext, vendor: string) {
  try {
    const [accMap, itmMap] = await Promise.all([
      accountNamesMap(ctx).catch(() => new Map<string, string>()),
      itemNamesMap(ctx).catch(() => new Map<string, string>()),
    ]);

    // 1. Intentar buscar en Histórico_facturas_compra_Excel en la empresa actual
    let targetCompany = ctx.companyName;
    let targetOData = ctx.odataCompanyBase;
    let targetCompanyId = ctx.companyId;

    let hData = await bcGet(ctx, odataUrl(`${targetOData}/Hist%C3%B3rico_facturas_compra_Excel`, {
      $filter: `Buy_from_Vendor_No eq '${q(vendor)}'`,
      $orderby: 'Posting_Date desc',
      $top: '10',
    })).catch(() => ({ value: [] }));

    // Fallback: Si no hay facturas en la empresa actual, buscar en BALINVEST TRADE SL 2023 (donde reside el histórico contable)
    if ((!hData.value || !hData.value.length) && !/2023/i.test(ctx.companyName)) {
      const fallbackCompany = 'BALINVEST TRADE SL 2023';
      const fallbackOdata = `${ctx.root}/ODataV4/Company('${encodeURIComponent(fallbackCompany)}')`;
      const fbData = await bcGet(ctx, odataUrl(`${fallbackOdata}/Hist%C3%B3rico_facturas_compra_Excel`, {
        $filter: `Buy_from_Vendor_No eq '${q(vendor)}'`,
        $orderby: 'Posting_Date desc',
        $top: '10',
      })).catch(() => ({ value: [] }));

      if (fbData.value && fbData.value.length) {
        hData = fbData;
        targetCompany = fallbackCompany;
        targetOData = fallbackOdata;
        try {
          const compList = await bcGet(ctx, `${ctx.root}/api/v2.0/companies`);
          const c2023 = (compList.value || []).find((c: any) => /2023/i.test(c.name));
          if (c2023) targetCompanyId = c2023.id;
        } catch {}
      }
    }

    const postedInvoices: any[] = hData.value || [];
    if (postedInvoices.length > 0) {
      const history: HistoryInvoice[] = [];
      for (const inv of postedInvoices.slice(0, 5)) {
        const docNo = inv.No;
        let lines: OcrLine[] = [];

        // 1. Consultar las Líneas de Factura de Compra Registradas (Purch. Inv. Line - Tabla 123)
        // Probamos primero por la propiedad de navegación directa de la factura:
        try {
          const navUrl = `${targetOData}/Hist%C3%B3rico_facturas_compra_Excel('${encodeURIComponent(docNo)}')/Hist%C3%B3rico_facturas_compra_ExcelPurchInvLines`;
          const navRes = await bcGet(ctx, navUrl);
          if (navRes.value && navRes.value.length > 0) {
            lines = parseBcLines(navRes.value, itmMap, accMap);
          }
        } catch {}

        // Si no, probamos por el servicio directo con filtro
        if (!lines.length) {
          const lineServices = [
            'Hist%C3%B3rico_facturas_compra_ExcelPurchInvLines',
            'Hist%C3%B3rico_facturas_compra_l%C3%ADneas_Excel',
            'Hist%C3%B3rico_facturas_compra_lineas_Excel',
            'L%C3%ADneas_factura_compra_reg_Excel',
            'Purch_Inv_Lines_Excel',
            'Purchase_Order_Line_Excel',
          ];

          for (const s of lineServices) {
            try {
              const lRes = await bcGet(ctx, odataUrl(`${targetOData}/${s}`, {
                $filter: `Document_No eq '${q(docNo)}'`,
              }));
              if (lRes.value && lRes.value.length > 0) {
                lines = parseBcLines(lRes.value, itmMap, accMap);
                if (lines.length > 0) break;
              }
            } catch {}
          }
        }

        // 2. Si no se encontró por OData, probar por API custom o API v2
        if (!lines.length) {
          try {
            const customUrl = odataUrl(`${ctx.customApiBase}/purchInvLines`, {
              $filter: `documentNo eq '${q(docNo)}'`,
            });
            const res = await bcGet(ctx, customUrl);
            if (res.value && res.value.length > 0) {
              lines = res.value.map(toLine);
            }
          } catch {}
        }

        let net = 0;
        let vat = 0;

        if (lines.length > 0) {
          net = lines.reduce((sum, l) => sum + (l.quantity * l.unitCost), 0);
          vat = lines.reduce((sum, l) => sum + (l.vatAmount || 0), 0);
        } else {
          // 3. Fallback a contabilidad (General Ledger Entries) solo si la tabla de líneas de compra no estuviera disponible
          let gleEntries: any[] = [];
          try {
            const gleRes = await bcGet(ctx, `${ctx.root}/api/v2.0/companies(${targetCompanyId})/generalLedgerEntries?$filter=documentNumber eq '${q(docNo)}'`);
            gleEntries = gleRes.value || [];
          } catch {}

          // Cuentas de compras y gastos (Grupo 6 de contabilidad o débitos que no sean IVA/Proveedores/Existencias)
          const expenseEntries = gleEntries.filter((e: any) =>
            e.debitAmount > 0 && (e.accountNumber.startsWith('6') || (!e.accountNumber.startsWith('4') && !e.accountNumber.startsWith('3')))
          );

          // Cuenta de IVA soportado (Grupo 472)
          const taxEntry = gleEntries.find((e: any) => e.debitAmount > 0 && e.accountNumber.startsWith('472'));
          net = expenseEntries.reduce((sum: number, e: any) => sum + (e.debitAmount || 0), 0);
          vat = taxEntry ? Math.round(taxEntry.debitAmount * 100) / 100 : 0;
          let vatGroup = 'IVA21';
          if (net > 0 && vat > 0) {
            const r = Math.round((vat / net) * 100);
            if (r >= 18 && r <= 25) vatGroup = 'IVA21';
            else if (r >= 8 && r <= 15) vatGroup = 'IVA10';
            else if (r >= 3 && r <= 6) vatGroup = 'IVA4';
          } else if (vat === 0) {
            vatGroup = 'EXENTO';
          }

          if (expenseEntries.length > 0) {
            lines = expenseEntries.map((e: any) => {
              const cost = Math.round(e.debitAmount * 100) / 100;
              const rate = vatGroup === 'IVA21' ? 0.21 : vatGroup === 'IVA10' ? 0.10 : vatGroup === 'IVA4' ? 0.04 : 0;
              const accName = accMap.get(e.accountNumber);
              return {
                lineType: 'Account',
                number: e.accountNumber,
                description: accName || e.description || inv.OperationDescription || 'Gasto proveedor',
                description2: '',
                quantity: 1,
                unitCost: cost,
                taxCode: vatGroup,
                vatAmount: Math.round(cost * rate * 100) / 100,
              };
            });
          } else {
            lines = [{
              lineType: 'Account',
              number: '',
              description: inv.OperationDescription || 'Gasto proveedor',
              description2: '',
              quantity: 1,
              unitCost: 0,
              taxCode: vatGroup,
              vatAmount: 0,
            }];
          }
        }

        history.push({
          number: docNo,
          vendorInvoiceNumber: inv.Vendor_Invoice_No || '',
          invoiceDate: inv.Document_Date || inv.Posting_Date || '',
          postingDate: inv.Posting_Date || '',
          dueDate: inv.Due_Date || '',
          currency: inv.Currency_Code || companyCurrency(targetCompany),
          net,
          total: net + vat,
          postingDescription: inv.OperationDescription || '',
          lines,
        });
      }

      return { history, examples: [] as { number: string; text: string }[] };
    }

    // Fallback estándar si no hay facturas registradas en Histórico
    const data = await bcGet(ctx, odataUrl(`${ctx.apiBase}/purchaseInvoices`, {
      $filter: `vendorNumber eq '${q(vendor)}' and status ne 'Draft' and status ne 'Canceled'`,
      $orderby: 'postingDate desc',
      $top: '15',
    })).catch(() => ({ value: [] }));

    const raw: any[] = (data.value || []).slice(0, 10);
    if (!raw.length) return { history: [] as HistoryInvoice[], examples: [] as { number: string; text: string }[] };

    const linesPromises = raw.slice(0, 3).map(async (inv) => {
      const lRes = await bcGet(ctx, `${ctx.apiBase}/purchaseInvoices(${inv.id})/purchaseInvoiceLines`).catch(() => ({ value: [] }));
      return (lRes.value || []).map((l: any) => ({ ...l, documentNo: inv.number }));
    });
    const nested = await Promise.all(linesPromises);
    const lines = nested.flat();
    const linesBy = new Map<string, any[]>();
    for (const l of lines) linesBy.set(l.documentNo, [...(linesBy.get(l.documentNo) || []), l]);

    const history: HistoryInvoice[] = raw.map(i => ({
      number: i.number,
      vendorInvoiceNumber: i.vendorInvoiceNumber || '',
      invoiceDate: i.invoiceDate || '',
      postingDate: i.postingDate || '',
      dueDate: i.dueDate || '',
      currency: i.currencyCode || companyCurrency(ctx.companyName),
      net: i.totalAmountExcludingTax || 0,
      total: i.totalAmountIncludingTax || 0,
      postingDescription: '',
      lines: (linesBy.get(i.number) || []).map((rawLine: any) => {
        const l = toLine(rawLine);
        if (l.lineType === 'Account' && l.number && accMap.has(l.number)) {
          l.description = accMap.get(l.number) || l.description;
        } else if (l.lineType === 'Item' && l.number && itmMap.has(l.number)) {
          l.description = itmMap.get(l.number) || l.description;
        }
        return l;
      }).filter((l: OcrLine) => l.lineType !== 'Comment' || l.description),
    }));

    return { history, examples: [] as { number: string; text: string }[] };
  } catch (e) {
    console.warn('vendorHistory error:', e);
    return { history: [] as HistoryInvoice[], examples: [] as { number: string; text: string }[] };
  }
}

export async function existingFor(ctx: BcContext, vendor: string, invoiceNo: string, documentType?: 'invoice' | 'credit_note') {
  if (!vendor || !invoiceNo) return [];
  const variants = [invoiceNo, `${invoiceNo}.`].map(v => `vendorInvoiceNumber eq '${q(v)}'`).join(' or ');
  const crVariants = [invoiceNo, `${invoiceNo}.`].map(v => `vendorCreditMemoNumber eq '${q(v)}'`).join(' or ');
  const results: { no: string; status: string }[] = [];

  if (documentType !== 'credit_note') {
    const invRows = await bcFetchAll(odataUrl(`${ctx.apiBase}/purchaseInvoices`, {
      $filter: `vendorNumber eq '${q(vendor)}' and (${variants})`,
      $select: 'number,status',
    }), ctx.token).catch(() => []);
    results.push(...invRows.filter((r: any) => r.status !== 'Canceled').map((r: any) => ({ no: r.number as string, status: r.status as string })));
  }

  if (documentType === 'credit_note' || results.length === 0) {
    const odataCrVariants = [invoiceNo, `${invoiceNo}.`].map(v => `vendorCrMemoNumber eq '${q(v)}'`).join(' or ');
    const crRows = await bcFetchAll(odataUrl(`${ctx.odataCompanyBase}/purchaseDocuments`, {
      $filter: `documentType eq 'Credit Memo' and buyFromVendorNumber eq '${q(vendor)}' and (${odataCrVariants})`,
      $select: 'number,status',
    }), ctx.token).catch(() => []);
    results.push(...crRows.filter((r: any) => r.status !== 'Canceled').map((r: any) => ({ no: r.number as string, status: r.status as string })));
  }

  return results;
}

// ---------- Propuesta de líneas y totales ----------
export type Example = { number: string; text: string };
const flat = (t: string) => t.replace(/\s+/g, ' ');

const MONTHS: Record<string, string> = {
  jan: '01', ene: '01', feb: '02', mar: '03', mär: '03', mae: '03', apr: '04', abr: '04', may: '05', mai: '05', jun: '06', jul: '07',
  aug: '08', ago: '08', sep: '09', oct: '10', okt: '10', nov: '11', dec: '12', dez: '12', dic: '12',
};

const DATE_RE = /\d{4}[-./]\d{2}[-./]\d{2}|\d{1,2}[-./]\d{1,2}[-./]\d{2,4}|\d{1,2}[ -][A-Za-zäąćęłńóśźż]{3,9}\.?[ -]\d{2,4}|[A-Za-zäąćęłńóśźż]{3,9}\.? \d{1,2},? \d{4}/g;

function parseDate(s: string) {
  let m = s.match(/^(\d{4})[-./](\d{2})[-./](\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})$/);
  if (m) {
    const p1 = parseInt(m[1], 10);
    const p2 = parseInt(m[2], 10);
    const year = m[3].length === 2 ? '20' + m[3] : m[3];
    let day = p1;
    let month = p2;
    if (p1 > 12 && p2 <= 12) {
      day = p1;
      month = p2;
    } else if (p2 > 12 && p1 <= 12) {
      day = p2;
      month = p1;
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  m = s.match(/^(\d{1,2})[ -]([A-Za-zäąćęłńóśźż]{3})[A-Za-zäąćęłńóśźż]*\.?[ -](\d{2,4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`;
  m = s.match(/^([A-Za-zäąćęłńóśźż]{3})[A-Za-zäąćęłńóśźż]*\.? (\d{1,2}),? (\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${MONTHS[m[1].toLowerCase()]}-${m[2].padStart(2, '0')}`;
  return '';
}

const dates = (t: string) => [...t.matchAll(DATE_RE)].map(m => ({ index: m.index!, raw: m[0], iso: parseDate(m[0]) })).filter(d => d.iso);

const STOP_WORDS = new Set([
  'incluye', 'incluido', 'fecha', 'factura', 'total', 'subtotal', 'vencimiento', 'debe', 'haber',
  'gracias', 'order', 'pedido', 'pago', 'cliente', 'pagar', 'importes', 'anterior', 'anteriores',
  'periodo', 'servicio', 'invoice', 'date', 'amount', 'desde', 'hasta', 'referencia', 'nif', 'cif',
  'descripcion', 'cant', 'cantidad', 'precio', 'iva', 'neto', 'bruto', 'page', 'pagina',
  'original', 'copia', 'duplicado', 'rectificada', 'rectificativa', 'ausstellungsdatum',
  'ursprüngliche', 'ursprungliche', 'zeitraum', 'leistungsempfänger', 'leistungserbringer'
]);

function cleanInvoiceCandidate(raw: string): string {
  if (!raw) return '';
  const s = raw.trim().replace(/[.,;:]+$/, '');
  if (STOP_WORDS.has(s.toLowerCase())) return '';
  if (s.length < 3 || s.length > 35) return '';
  if (/^0+$/.test(s)) return '';
  return s;
}

function guessHeader(t: string, filename?: string) {
  let invoiceNo = '';

  // 1. Patrones específicos de abono / nota de crédito / rectificativa
  const creditNotePatterns = [
    /(?:n[úu]mero\s+(?:de\s+)?(?:la\s+)?nota\s+de\s+cr[eé]dito|n[úu]mero\s+(?:de\s+)?abono|n[úu]mero\s+(?:de\s+)?factura\s+rectificativa|n[º°o]\.?\s+(?:de\s+)?(?:abono|nota\s+de\s+cr[eé]dito|rectificativa))\s*[:.]?\s*([A-Z0-9][A-Z0-9\-_\/.]{2,})/i,
    /(?:factura\s+rectificativa|f\.?\s*rectificativa|factura\s+abono)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-_\/.]{2,})/i,
    /(?:gutschriftennummer|gutschriftsnummer|gutschrifts?-?nr\.?|gutschrifts?-?nummer)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-_\/.]{2,})/i,
    /(?:credit\s+note\s+(?:number|no\.?|#)|credit\s+memo\s+(?:number|no\.?|#))\s*[:.]?\s*([A-Z0-9][A-Z0-9\-_\/.]{2,})/i,
    /(?:num[ée]ro\s+(?:de\s+(?:la\s+)?)?(?:note\s+de\s+cr[ée]dit|l['’]avoir|avoir))\s*[:.]?\s*([A-Z0-9][A-Z0-9\-_\/.]{2,})/i,
    /(?:numer\s+(?:faktury\s+koryguj[ąa]cej|korekty))\s*[:.]?\s*([A-Z0-9][A-Z0-9\-_\/.]{2,})/i,
  ];
  for (const re of creditNotePatterns) {
    const m = t.match(re);
    if (m) {
      const candidate = cleanInvoiceCandidate(m[1]);
      if (candidate) {
        invoiceNo = candidate;
        break;
      }
    }
  }

  // 2. Patrones específicos por formato (ej. Microsoft Europa: E06010JC5O, E0100NQNZH)
  if (!invoiceNo) {
    const msMatch = t.match(/\b(E0[0-9A-Z]{8})\b/);
    if (msMatch) {
      const c = cleanInvoiceCandidate(msMatch[1]);
      if (c) invoiceNo = c;
    }
  }

  // 3. Patrones en español de alta precisión (con "Número" antes o después de "Factura")
  if (!invoiceNo) {
    const spanishPatterns = [
      /(?<!original\s+|rectificada\s+)(?:n[úu]mero\s+(?:de\s+)?factura|n[º°o]\.?\s+(?:de\s+)?factura|n[úu]m\.?\s+(?:de\s+)?factura)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-_\/.]{2,})/i,
      /(?<!original\s+|rectificada\s+)(?:factura\s+n[º°o]\.?|factura\s+n[úu]mero|factura\s+n[úu]m\.?)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-_\/.]{2,})/i,
      /(?<!original\s+|rectificada\s+)(?:factura\s*[:#]\s*)([A-Z0-9][A-Z0-9\-_\/.]{2,})/i,
      /(?:numer\s+faktury|fakturanummer)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-_\/.]{2,})/i,
      /(?<!original\s+)(?:invoice\s+(?:number|no\.?|#)|inv\s*#)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-_\/.]{2,})/i,
      /(?<!urspr[üu]ngliche\s+|original\s+)(?:rechnungs?nummer|belegnummer)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-_\/.]{2,})/i,
      /(?<!d['’]origine\s+)(?:facture\s+n[º°o]?)\s*[:.]?\s*([A-Z0-9][A-Z0-9\-_\/.]{2,})/i,
    ];

    for (const re of spanishPatterns) {
      const m = t.match(re);
      if (m) {
        const candidate = cleanInvoiceCandidate(m[1]);
        if (candidate) {
          invoiceNo = candidate;
          break;
        }
      }
    }
  }

  // 4. Patrón genérico internacional (rechazando palabras reservadas y números originales)
  if (!invoiceNo) {
    const genericMatch = t.match(/(?<!urspr[üu]ngliche\s+|original\s+|rectificada\s+)(?:Invoice|Rechnungs?|Debit Note|Credit Note|Gutschrift|Factura|Facture|Beleg|Faktury|Faktura)[ -]?(?:Number|No\.?|Nr\.?|nummer|n[º°o]\.?)\s*:?\s*([A-Z0-9][A-Z0-9\-\/.]{2,})/i);
    if (genericMatch) {
      const candidate = cleanInvoiceCandidate(genericMatch[1]);
      if (candidate) invoiceNo = candidate;
    }
  }

  // 5. Fallback al nombre del archivo
  if (!invoiceNo && filename) {
    const fnClean = filename.replace(/\.pdf$/i, '').trim();
    const fnWithoutAbono = fnClean.replace(/^abono\s+\d+\s*[-_]?\s*/i, '');
    const tokens = fnWithoutAbono.split(/[\s_\-]+/).filter(tok => tok.length >= 3 && !/microsoft|amazon|factura|invoice|pdf|abono|rappel/i.test(tok));
    for (const tok of tokens) {
      if (/\d/.test(tok) && t.includes(tok)) {
        invoiceNo = tok;
        break;
      }
    }
    if (!invoiceNo) {
      for (const rawTok of fnWithoutAbono.split(/\s*-\s*|\s*_\s*/)) {
        const squashed = rawTok.replace(/[^A-Za-z0-9]/g, '');
        if (squashed.length >= 3 && /\d/.test(squashed) && t.includes(squashed)) {
          invoiceNo = squashed;
          break;
        }
      }
    }
    if (!invoiceNo) {
      const longNum = fnClean.match(/\b\d{6,}\b/);
      if (longNum && t.includes(longNum[0])) invoiceNo = longNum[0];
    }
  }

  let invoiceDate = '';
  const DATE_KEYWORDS = [
    /(?:ausstellungsdatum(?:\s+der\s+gutschrift)?)\s*[:.]?\s*/i,
    /(?:fecha(?:\s+de\s+emisi[óo]n)?\s+de\s+(?:la\s+)?(?:nota\s+de\s+cr[eé]dito|factura\s+rectificativa))\s*[:.]?\s*/i,
    /(?:data\s+faktury|data\s+wystawienia)\s*[:.]?\s*/i,
    /(?:fakturadatum|rechnungsdatum|belegdatum)\s*[:.]?\s*/i,
    /(?:invoice\s+date|bill\s+date|doc(?:ument)?\s+date)\s*[:.]?\s*/i,
    /(?:fecha\s+(?:de\s+)?(?:la\s+)?factura|fecha\s+emisi[óo]n|fecha\s+expedici[óo]n)\s*[:.]?\s*/i,
    /(?:date\s+de\s+(?:la\s+)?facture|date\s+facture)\s*[:.]?\s*/i,
    /(?:datum|date|fecha)\s*[:.]?\s*/i,
  ];

  for (const re of DATE_KEYWORDS) {
    for (const m of t.matchAll(new RegExp(re, 'gi'))) {
      const slice = t.slice(m.index! + m[0].length, m.index! + m[0].length + 60);
      const dm = dates(slice);
      const valid = dm.find(d => parseInt(d.iso.slice(0, 4), 10) >= 2020);
      if (valid) {
        invoiceDate = valid.iso;
        break;
      }
    }
    if (invoiceDate) break;
  }
  if (!invoiceDate) {
    invoiceDate = dates(t.slice(0, 1500)).find(d => parseInt(d.iso.slice(0, 4), 10) >= 2020)?.iso || '';
  }

  let dueDate = '';
  const DUE_KEYWORDS = [
    /(?:termin\s+p[łl]atno[śs]ci|f[öo]rfallodatum|due\s+date|payment\s+due|fecha\s+(?:de\s+)?vencimiento|vencimiento|f[äa]lligkeitsdatum|date\s+d['’]?[eé]ch[eé]ance)\s*[:.]?\s*/i,
  ];
  for (const re of DUE_KEYWORDS) {
    const m = t.match(re);
    if (m) {
      const slice = t.slice(m.index! + m[0].length, m.index! + m[0].length + 60);
      const dm = dates(slice);
      if (dm[0]?.iso) {
        dueDate = dm[0].iso;
        break;
      }
    }
  }

  return { invoiceNo, invoiceDate, dueDate };
}

function parseAmount(s: string): number | null {
  if (!s) return null;
  const isNeg = /[-–—]/.test(s);
  const clean = s.trim().replace(/[A-Za-z$€£]+/g, '').replace(/\s+/g, '');
  const m = clean.match(/(?<![\d.,])\d{1,3}(?:([.,'])\d{3})*[.,]\d{2}(?![\d.,]?\d)|(?<![\d.,])\d+[.,]\d{2}(?![\d.,]?\d)/);
  if (!m) return null;
  const str = m[0];
  const dec = str.length - 3;
  const v = parseFloat(str.slice(0, dec).replace(/[.,']/g, '') + '.' + str.slice(dec + 1));
  if (!isFinite(v)) return null;
  const mag = Math.round(v * 100) / 100;
  return isNeg ? -mag : mag;
}

function amounts(t: string): number[] {
  const out: number[] = [];
  for (const m of t.matchAll(/(?<![\d.,])\d{1,3}(?:([.,'])\d{3})*[.,]\d{2}(?![\d.,]?\d)|(?<![\d.,])\d+[.,]\d{2}(?![\d.,]?\d)/g)) {
    const s = m[0], dec = s.length - 3;
    const v = parseFloat(s.slice(0, dec).replace(/[.,']/g, '') + '.' + s.slice(dec + 1));
    if (isFinite(v)) out.push(Math.round(v * 100) / 100);
  }
  return out;
}

const RATES = [0.21, 0.10, 0.04, 0.19, 0.07, 0.20, 0.22, 0.081, 0.077, 0.05, 0.16];
const r2 = (v: number) => Math.round(v * 100) / 100;

function totals(t: string) {
  const isReverseCharge = /odwrotna\s+op[łl]ata|omv[äa]nd\s+betalningsskyldighet|reverse\s+charge|inversi[óo]n\s+del\s+sujeto\s+pasivo|art(?:[.]|\s+)(?:44|196)|2006\/112/i.test(t);
  const isTaxFree = isReverseCharge || /tax ?free|steuerfrei|exento|no sujeto|0[.,]00\s*%/i.test(t);

  let total: number | null = null;
  let net: number | null = null;
  let vat: number | null = null;

  // 0. Línea de resumen de 3 importes (Amazon / SAP: "Total -EUR 2.54 EUR 0.00 -EUR 2.54" o "Gesamtsumme -EUR 1176.36 -EUR 247.04 -EUR 1423.40")
  const sum3Match = t.match(/(?:(?:total|gesamtsumme|summe)\s+)([-–—]?(?:[A-Z]{3}|[$€£])?\s*[-–—]?\s*[\d.,']+)\s+([-–—]?(?:[A-Z]{3}|[$€£])?\s*[-–—]?\s*[\d.,']+)\s+([-–—]?(?:[A-Z]{3}|[$€£])?\s*[-–—]?\s*[\d.,']+)/i);
  if (sum3Match) {
    const a1 = parseAmount(sum3Match[1]);
    const a2 = parseAmount(sum3Match[2]);
    const a3 = parseAmount(sum3Match[3]);
    if (a1 != null && a2 != null && a3 != null) {
      if (Math.abs(Math.round((a1 + a2) * 100) - Math.round(a3 * 100)) <= 2) {
        net = a1;
        vat = a2;
        total = a3;
      }
    }
  }

  const numRe = String.raw`[-–—]?(?:[A-Z]{3}|[$€£])?\s*[-–—]?\s*[\d.,'\s]+?`;

  // 1. Patrones explícitos de Total
  if (total == null) {
    const TOTAL_PATTERNS = [
      new RegExp(String.raw`(?:nale[żz]na\s+kwota\s+faktury|suma\s+do\s+zap[łl]aty)\s*[:.]?\s*(${numRe})(?:PLN|EUR|SEK|[a-z]{3}|[$€£]|\s|$)`, 'i'),
      new RegExp(String.raw`(?:f[öo]rfallna\s+fakturabelopp|totalt\s+belopp(?:\s*\(inkl[.]?\s*moms\))?)\s*[:.]?\s*(${numRe})(?:PLN|EUR|SEK|[a-z]{3}|[$€£]|\s|$)`, 'i'),
      new RegExp(String.raw`(?:total\s+amount\s+due|invoice\s+amount\s+due|total\s+due|amount\s+due)\s*[:.]?\s*(${numRe})(?:PLN|EUR|SEK|[a-z]{3}|[$€£]|\s|$)`, 'i'),
      new RegExp(String.raw`(?:total\s+(?:factura|a\s+pagar|importe|documento))\s*[:.]?\s*(${numRe})(?:PLN|EUR|SEK|[a-z]{3}|[$€£]|\s|$)`, 'i'),
      new RegExp(String.raw`(?:gesamtbetrag|endbetrag|rechnungsbetrag|zahlbetrag|gesamtsumme)\s*[:.]?\s*(${numRe})(?:PLN|EUR|SEK|[a-z]{3}|[$€£]|\s|$)`, 'i'),
      new RegExp(String.raw`(?:total\s+ttc|net\s+[àa]\s+payer)\s*[:.]?\s*(${numRe})(?:PLN|EUR|SEK|[a-z]{3}|[$€£]|\s|$)`, 'i'),
      new RegExp(String.raw`\b(?:total)\s*[:.]?\s*(${numRe})(?:PLN|EUR|SEK|[a-z]{3}|[$€£]|\s|$)`, 'i'),
    ];

    for (const p of TOTAL_PATTERNS) {
      const m = t.match(p);
      if (m) {
        total = parseAmount(m[1]);
        if (total != null) break;
      }
    }
  }

  // 2. Patrones explícitos de IVA (buscado antes del neto para asegurar cuadre aritmético)
  if (vat == null) {
    const VAT_PATTERNS = [
      new RegExp(String.raw`(?:vat\s*\(\s*21\s*%\s*\)[^:\d\n\r]*|tax\s+subtotal|vat\s*\(\s*0\s*%\s*\)|suma\s+cz[ęe][śs]ciowa\s+podatku|delsumma\s+f[öo]r\s+skatt)\s*[:.]?\s*(${numRe})(?:PLN|EUR|SEK|[a-z]{3}|[$€£]|\s|$)`, 'i'),
      new RegExp(String.raw`(?:total\s+tax(?:\s+amount)?|cuota\s+iva|importe\s+iva|total\s+iva|vat\s+amount|mwst\.?|ust\.?)\s*[:.]?\s*(${numRe})(?:PLN|EUR|SEK|[a-z]{3}|[$€£]|\s|$)`, 'i'),
    ];

    for (const p of VAT_PATTERNS) {
      const m = t.match(p);
      if (m) {
        vat = parseAmount(m[1]);
        if (vat != null) break;
      }
    }
  }

  // 3. Patrones explícitos de Subtotal / Base Imponible
  if (net == null) {
    const NET_PATTERNS = [
      new RegExp(String.raw`(?:\bsubtotal\b|\bbase\s+imponible\b)\s*[:.]?\s*(${numRe})(?:PLN|EUR|SEK|[a-z]{3}|[$€£]|\s|$)`, 'i'),
      new RegExp(String.raw`(?:net\s+amount|taxable\s+amount|total\s+neto|subtotal\s+neto|importe\s+base)\s*[:.]?\s*(${numRe})(?:PLN|EUR|SEK|[a-z]{3}|[$€£]|\s|$)`, 'i'),
      new RegExp(String.raw`(?:preis\s*\(ohne\s+ust\.\)|ohne\s+ust\.|nettobetrag|zwischensumme)\s*[:.]?\s*(${numRe})(?:PLN|EUR|SEK|[a-z]{3}|[$€£]|\s|$)`, 'i'),
      new RegExp(String.raw`(?:suma\s+cz[ęe][śs]ciowa|delsumma)\s*[:.]?\s*(${numRe})(?:PLN|EUR|SEK|[a-z]{3}|[$€£]|\s|$)`, 'i'),
    ];

    for (const p of NET_PATTERNS) {
      const m = t.match(p);
      if (m) {
        net = parseAmount(m[1]);
        if (net != null) break;
      }
    }
  }

  // Coherencia aritmética estricta: Total = Neto + IVA (Subtotal + IVA = Total factura)
  if (total != null && vat != null && vat > 0) {
    const calculatedNet = Math.round((total - vat) * 100) / 100;
    // Si el neto extraído es null o difiere de total - vat (ej. cogió un cargo de campaña parcial como 486.86 en vez de 500.48)
    if (net == null || Math.abs((net + vat) - total) > 0.05) {
      net = calculatedNet;
    }
  }

  if ((isReverseCharge || isTaxFree) && (!vat || vat === 0)) {
    const finalTotal = total ?? net;
    const finalNet = net ?? total;
    return {
      net: finalNet,
      vat: 0,
      total: finalTotal,
      taxable: 0,
      free: finalNet,
      isReverseCharge: true,
    };
  }

  if (total != null && net != null) {
    const diff = Math.round((total - net) * 100) / 100;
    return { net, vat: vat ?? diff, total, taxable: net, free: 0, isReverseCharge: false };
  }

  if (total != null && vat != null) {
    const n = Math.round((total - vat) * 100) / 100;
    return { net: n, vat, total, taxable: n, free: 0, isReverseCharge: false };
  }

  // Fallback: búsqueda por combinaciones de tipos de IVA comunes
  const list = amounts(t);
  const set = [...new Set(list)].filter(v => v > 0).sort((a, b) => b - a);
  const near = (v: number) => set.find(x => Math.abs(x - v) <= Math.max(0.02, v * 0.0002));

  for (const r of RATES) {
    for (const taxable of set) {
      const v = near(r2(taxable * r));
      if (v == null || v === taxable) continue;
      const tot = near(r2(taxable + v));
      if (tot != null && tot !== v) return { net: taxable, vat: v, total: tot, taxable, free: 0, isReverseCharge: false };
    }
  }

  return { net, vat, total, taxable: null, free: null, isReverseCharge: false };
}

export function propose(
  text: string,
  history: HistoryInvoice[],
  filename?: string,
  vendor?: VendorCandidate | null,
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

  // Divisa: Prioridad a la divisa explícita del documento, luego histórico, luego proveedor
  let currency = detectedCurr || detectCurrency(text) || (history[0]?.currency) || (vendor?.currency) || 'EUR';
  if (currency === 'EU') currency = 'EUR';

  // Detección de proveedor intracomunitario (miembro de la UE sin ser España)
  const isEuVendor = Boolean(
    vendor?.vat &&
    /^(AT|BE|BG|CY|CZ|DE|DK|EE|EL|GR|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK)/i.test(vendor.vat) &&
    !vendor.vat.toUpperCase().startsWith('ES')
  );
  // Operación intracomunitaria con inversión de sujeto pasivo solo si el IVA en factura es 0
  const reverseChargeEffective = Boolean(
    (isReverseCharge || (isEuVendor && (!absVat || absVat === 0))) && (!absVat || absVat === 0)
  );

  let defaultTaxCode = 'IVA21';
  if (reverseChargeEffective) {
    defaultTaxCode = 'IVA21'; // En Business Central se asigna IVA21 y la matriz UE aplica inversión del sujeto pasivo (0% en factura)
  } else if (absNet != null && absVat != null && absNet > 0) {
    const r = Math.round((absVat / absNet) * 100);
    if (r >= 18 && r <= 25) defaultTaxCode = 'IVA21';
    else if (r >= 8 && r <= 15) defaultTaxCode = 'IVA10';
    else if (r >= 3 && r <= 6) defaultTaxCode = 'IVA4';
    else if (absVat === 0) defaultTaxCode = 'EXENTO';
  }

  const isAmazonAds = Boolean(
    (vendor && (/B87523825/i.test(vendor.vat || '') || /Amazon\s+Online/i.test(vendor.name || ''))) ||
    /ESB87523825|Amazon\s+Online\s+Spain|Amazon\s+Advertising/i.test(t)
  );

  const model = history[0];
  let lines: OcrLine[] = [];
  if (model && model.lines.length) {
    lines = model.lines.map(l => ({
      ...l,
      taxCode: l.taxCode && !l.taxCode.startsWith('472') ? l.taxCode : defaultTaxCode,
      vatAmount: reverseChargeEffective ? 0 : (l.vatAmount != null ? Math.abs(l.vatAmount) : 0),
    }));
    if (absNet != null) {
      if (lines.length === 1) {
        lines[0].quantity = 1;
        lines[0].unitCost = absNet;
        lines[0].vatAmount = reverseChargeEffective ? 0 : (absVat != null ? absVat : r2(absNet * 0.21));
      } else {
        const sum = lines.reduce((a, l) => a + Math.abs(l.quantity) * Math.abs(l.unitCost), 0) || 1;
        lines.forEach(l => {
          const qty = Math.abs(l.quantity) || 1;
          const prevCost = Math.abs(l.unitCost);
          l.quantity = qty;
          l.unitCost = r2((absNet * (qty * prevCost)) / sum / qty);
          l.vatAmount = reverseChargeEffective ? 0 : (absVat != null ? r2((absVat * (qty * l.unitCost)) / absNet) : r2(l.unitCost * 0.21));
        });
      }
    }
  } else {
    // Si no hay histórico, sugerimos una línea genérica con el neto detectado
    lines = [{
      lineType: 'Account',
      number: '',
      description: 'Gasto según factura',
      description2: '',
      quantity: 1,
      unitCost: absNet || 0,
      taxCode: defaultTaxCode,
      vatAmount: reverseChargeEffective ? 0 : (absVat != null ? absVat : (absNet ? r2(absNet * 0.21) : 0)),
    }];
  }

  // Prioridad para facturas de Amazon Ads / Amazon Online Spain:
  // Balinvest registra la publicidad de Amazon como Artículo (Item) 1014
  if (isAmazonAds && (!model || lines.every(l => l.lineType !== 'Item'))) {
    lines = [{
      lineType: 'Item',
      number: '1014',
      description: 'PUBLICIDAD / ADS AMAZON',
      description2: '',
      quantity: 1,
      unitCost: absNet || 0,
      taxCode: defaultTaxCode,
      vatAmount: reverseChargeEffective ? 0 : (absVat != null ? absVat : (absNet ? r2(absNet * 0.21) : 0)),
    }];
  }

  let comment = '';
  if (reverseChargeEffective) {
    comment = 'Operación intracomunitaria con IVA revertido / Inversión de sujeto pasivo (art. 44 y 196 Directiva 2006/112/CE) · 0% IVA en factura.';
  } else if (isAmazonAds && lines[0]?.lineType === 'Item' && lines[0]?.number === '1014') {
    comment = model
      ? `Basado en el histórico de compras · Artículo 1014 (${lines[0].description})`
      : 'Factura Amazon Ads · Registrada como Artículo 1014 según histórico de compras';
  } else if (model) {
    comment = `Basado en la factura anterior ${model.number}`;
  } else {
    comment = 'Nuevo documento sin histórico previo.';
  }

  const isCreditNote = /\b(abono\s+de\s+factura|factura\s+rectificativa|rectificativa|credit\s+note|credit\s+memo|nota\s+de\s+cr[eé]dito|nota\s+de\s+abono|gutschrift|avoir)\b/i.test(t.slice(0, 2500))
    || (/\b(abono)\b/i.test(t.slice(0, 2500)) && !/\b(factura(?!\s+rectificativa))\b/i.test(t.slice(0, 400)))
    || (Boolean(filename) && /\babono\b/i.test(filename || ''))
    || (total != null && total < 0)
    || (net != null && net < 0);
  const documentType = isCreditNote ? 'credit_note' : 'invoice';

  return {
    documentType,
    invoiceNo,
    invoiceDate,
    postingDate,
    dueDate,
    postingDescription: invoiceNo
      ? (documentType === 'credit_note' ? `Abono ${invoiceNo}` : `Factura ${invoiceNo}`)
      : (documentType === 'credit_note' ? 'Abono proveedor' : 'Factura proveedor'),
    currency,
    net: absNet,
    vat: reverseChargeEffective ? 0 : absVat,
    total: reverseChargeEffective ? absNet : (absTotal ?? (absNet != null && absVat != null ? r2(absNet + absVat) : null)),
    lines: lines.map(l => ({ ...l, quantity: Math.abs(l.quantity), unitCost: Math.abs(l.unitCost), vatAmount: l.vatAmount != null ? Math.abs(l.vatAmount) : undefined })),
    comment,
    isReverseCharge: reverseChargeEffective,
  };
}

export async function processPdf(ctx: BcContext, file: string, data: Uint8Array, vendorNo?: string): Promise<OcrResult> {
  const warnings: string[] = [];
  let text = '';
  try { text = await pdfText(data); } catch (e: any) { warnings.push(`No se ha podido leer el texto del PDF (${e.message}).`); }
  const scanned = text.replace(/\s/g, '').length < 40;
  if (scanned) {
    text = '';
    warnings.push('PDF escaneado o sin capa de texto: por favor, selecciona el proveedor e introduce los importes manualmente.');
  }

  const ids = identifiers(text);
  const detectedCurr = detectCurrency(text) || 'EUR';
  const candidates = text ? await matchVendors(ctx, text, ids, detectedCurr) : [];
  const vendor = vendorNo ? await vendorByNumber(ctx, vendorNo) : candidates[0] || null;

  if (vendorNo && !vendor) warnings.push(`El proveedor ${vendorNo} no se encontró en ${ctx.companyName}.`);
  if (!vendor && !scanned) warnings.push('No se ha reconocido el proveedor con certeza: selecciónalo en el buscador.');

  const { history } = vendor ? await vendorHistory(ctx, vendor.number) : { history: [] };
  if (vendor && !history.length) warnings.push('Este proveedor no tiene facturas previas registradas: introduce la cuenta o artículo de gasto.');

  // Divisa final
  let finalCurrency = detectedCurr;
  if (!finalCurrency || finalCurrency === 'EUR') {
    if (history[0]?.currency && history[0].currency !== 'EU') finalCurrency = history[0].currency;
    else if (vendor?.currency && vendor.currency !== 'EU') finalCurrency = vendor.currency;
  }
  if (finalCurrency === 'EU') finalCurrency = 'EUR';

  const suggestion = propose(text, history, file, vendor, finalCurrency);
  if (suggestion) {
    if (suggestion.documentType === 'credit_note') {
      warnings.push('El documento ha sido detectado como abono / factura rectificativa.');
    }
    // Determinar la fecha de registro según política y periodos contables/IVA de Business Central
    try {
      const postingCheck = await determinePostingDate(suggestion.invoiceDate, ctx);
      suggestion.postingDate = postingCheck.postingDate;
      suggestion.postingDateAdjusted = postingCheck.wasAdjusted;
      suggestion.postingDateReason = postingCheck.reason;
      if (postingCheck.wasAdjusted && postingCheck.reason) {
        warnings.push(postingCheck.reason);
      }
    } catch (err: any) {
      console.error('Error al validar fecha de registro con periodos de BC:', err);
    }
  }

  const existing = vendor && suggestion?.invoiceNo ? await existingFor(ctx, vendor.number, suggestion.invoiceNo, suggestion.documentType) : [];
  if (existing.length) warnings.push(`¡Aviso! Ya existe un documento en BC con este número: ${existing.map(e => e.no).join(', ')}`);

  return { file, scanned, currency: finalCurrency, ids, candidates, vendor, history, suggestion, existing, warnings };
}

// ---------- Crear factura o abono en Business Central ----------
export type OcrCreateInput = {
  documentType?: 'invoice' | 'credit_note';
  vendor: string;
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

export async function createOcrInvoice(ctx: BcContext, input: OcrCreateInput, pdf?: { name: string; data: Uint8Array }) {
  const warnings: string[] = [];
  const head = await bcRequest('POST', `${ctx.apiBase}/purchaseInvoices`, ctx.token, {
    vendorNumber: input.vendor,
    vendorInvoiceNumber: input.invoiceNo,
    ...(input.currency && input.currency !== 'EUR' && input.currency !== 'EU' ? { currencyCode: input.currency } : {}),
    ...(input.invoiceDate ? { invoiceDate: input.invoiceDate } : {}),
    ...(input.postingDate ? { postingDate: input.postingDate } : {}),
  });

  const id: string = head.id, no: string = head.number;
  const headUrl = `${ctx.apiBase}/purchaseInvoices(${id})`;

  try {
    if (input.dueDate) await bcRequest('PATCH', headUrl, ctx.token, { dueDate: input.dueDate });

    // Eliminar líneas predeterminadas que añade BC al fijar el proveedor
    const auto = await bcRequest('GET', `${headUrl}/purchaseInvoiceLines?$select=id`, ctx.token);
    for (const l of auto?.value || []) await bcRequest('DELETE', `${headUrl}/purchaseInvoiceLines(${l.id})`, ctx.token);

    // Añadir líneas revisadas
    for (const l of input.lines) {
      const comment = l.lineType === 'Comment';
      await bcRequest('POST', `${headUrl}/purchaseInvoiceLines`, ctx.token, comment
        ? { lineType: 'Comment', description: l.description }
        : {
          lineType: l.lineType,
          lineObjectNumber: l.number,
          quantity: l.quantity,
          unitCost: l.unitCost,
          ...(l.description ? { description: l.description } : {}),
          ...(l.description2 ? { description2: l.description2 } : {}),
          ...(l.taxCode ? { taxCode: l.taxCode } : {}),
        });
    }
  } catch (e) {
    await bcRequest('DELETE', headUrl, ctx.token).catch(() => {});
    throw e;
  }

  // Posting Description vía OData
  if (input.postingDescription?.trim()) {
    try {
      await bcRequest('PATCH', `${ctx.odataCompanyBase}/purchaseDocuments(${id})`, ctx.token, {
        postingDescription: input.postingDescription.trim().substring(0, 100)
      });
    } catch (e: any) {
      warnings.push(`Aviso: No se pudo asignar la descripción de registro (${e.message})`);
    }
  }

  // Adjuntar PDF original a la factura
  if (pdf) {
    try {
      await attachFile(ctx, id, pdf, 'Purchase Invoice');
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
    warnings
  };
}

function toODataLineType(lineType: string): string {
  switch (lineType) {
    case 'Account':
      return 'G/L Account';
    case 'Item':
      return 'Item';
    case 'Resource':
      return 'Resource';
    case 'Fixed Asset':
      return 'Fixed Asset';
    case 'Charge':
      return 'Charge (Item)';
    case 'Comment':
      return ' ';
    default:
      return 'G/L Account';
  }
}

export async function createOcrCreditMemo(ctx: BcContext, input: OcrCreateInput, pdf?: { name: string; data: Uint8Array }) {
  const warnings: string[] = [];

  // Crear cabecera del abono de compra en Business Central (OData purchaseDocuments)
  const headPayload: any = {
    documentType: 'Credit Memo',
    buyFromVendorNumber: input.vendor,
    vendorCrMemoNumber: input.invoiceNo,
    ...(input.currency && input.currency !== 'EUR' && input.currency !== 'EU' ? { currencyCode: input.currency } : {}),
    ...(input.invoiceDate ? { orderDate: input.invoiceDate, documentDate: input.invoiceDate } : {}),
    ...(input.postingDate ? { postingDate: input.postingDate } : {}),
    ...(input.dueDate ? { dueDate: input.dueDate } : {}),
    ...(input.postingDescription?.trim() ? { postingDescription: input.postingDescription.trim().substring(0, 100) } : {}),
  };

  const head = await bcRequest('POST', `${ctx.odataCompanyBase}/purchaseDocuments`, ctx.token, headPayload);
  const id: string = head.id;
  const no: string = head.number;

  try {
    // Añadir líneas revisadas a purchaseDocumentLines
    for (const l of input.lines) {
      const isComment = l.lineType === 'Comment';
      const linePayload: any = {
        documentType: 'Credit Memo',
        documentNumber: no,
        type: toODataLineType(l.lineType),
        ...(isComment
          ? { description: l.description }
          : {
              number: l.number,
              description: l.description,
              ...(l.description2 ? { description2: l.description2 } : {}),
              quantity: Math.abs(l.quantity),
              directUnitCost: Math.abs(l.unitCost),
              ...(l.taxCode ? { vatProdPostingGroup: l.taxCode } : {}),
            }),
      };
      await bcRequest('POST', `${ctx.odataCompanyBase}/purchaseDocumentLines`, ctx.token, linePayload);
    }
  } catch (e) {
    // Si falla la inserción de líneas, eliminamos el abono borrador para no dejarlo incompleto
    await bcRequest('DELETE', `${ctx.odataCompanyBase}/purchaseDocuments(${id})`, ctx.token).catch(() => {});
    throw e;
  }

  // Adjuntar PDF original al abono
  if (pdf) {
    try {
      await attachFile(ctx, id, pdf, 'Purchase Credit Memo');
    } catch (e: any) {
      warnings.push(`Aviso: No se pudo adjuntar el PDF (${e.message})`);
    }
  }

  // Consultar totales finales calculados por Business Central
  const after = await bcRequest('GET', `${ctx.odataCompanyBase}/purchaseDocuments(${id})`, ctx.token).catch(() => null);

  return {
    id,
    no,
    documentType: 'credit_note' as const,
    net: after?.amount != null ? Math.abs(after.amount) : null,
    total: after?.amountIncludingVat != null ? Math.abs(after.amountIncludingVat) : null,
    currency: after?.currencyCode || 'EUR',
    warnings,
  };
}