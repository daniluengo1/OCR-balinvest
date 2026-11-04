import { getBcContext, BcContext, odataUrl } from './bcClient';
import { parseBankStatement, ParsedBankMovement } from './bankParser';

export interface BcBankAccount {
  id: string;
  number: string;
  name: string;
  currencyCode: string;
  iban?: string;
}

export interface BcJournalBatch {
  id: string;
  code: string;
  name: string;
  templateName: string;
  balAccountNumber?: string;
}

export interface ReconciledMovement extends ParsedBankMovement {
  status: 'POSTED_IN_BC' | 'IN_BATCH' | 'TO_REGISTER';
  matchedDocNo?: string;
  matchedLineDetail?: string;
  matchedDate?: string;
  matchedAccount?: string;
}

export interface ReconcileResult {
  bankAccount: string;
  journalBatch: string;
  currencyCode: string;
  summaryText: string;
  counts: {
    toRegister: number;
    inBatch: number;
    postedInBc: number;
    total: number;
  };
  movements: ReconciledMovement[];
}

// 1. Obtiene las cuentas bancarias configuradas en Business Central
export async function getBcBankAccounts(companyName?: string): Promise<BcBankAccount[]> {
  const ctx = await getBcContext(companyName);
  try {
    const res = await fetch(`${ctx.root}/api/v2.0/companies(${ctx.companyId})/bankAccounts`, {
      headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) {
      console.warn(`Error al consultar bankAccounts en BC (${res.status}):`, await res.text());
      return [];
    }
    const data = await res.json();
    return (data.value || []).map((b: any) => ({
      id: b.id,
      number: b.number,
      name: b.displayName || b.number,
      currencyCode: b.currencyCode || 'EUR',
      iban: b.iban || '',
    }));
  } catch (err) {
    console.error('Error en getBcBankAccounts:', err);
    return [];
  }
}

// 2. Obtiene los lotes del General Journal (Diario General) de Business Central
export async function getBcJournalBatches(companyName?: string): Promise<BcJournalBatch[]> {
  const ctx = await getBcContext(companyName);
  try {
    const res = await fetch(`${ctx.root}/api/v2.0/companies(${ctx.companyId})/journals`, {
      headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) {
      console.warn(`Error al consultar journals en BC (${res.status}):`, await res.text());
      return [];
    }
    const data = await res.json();
    return (data.value || []).map((j: any) => ({
      id: j.id,
      code: j.code,
      name: j.displayName || j.code,
      templateName: j.templateDisplayName || 'GENERAL',
      balAccountNumber: j.balancingAccountNumber || '',
    }));
  } catch (err) {
    console.error('Error en getBcJournalBatches:', err);
    return [];
  }
}

// 3. Obtiene los movimientos registrados en BC (Bank Account Ledger Entries)
export async function getBcBankLedgerEntries(ctx: BcContext, bankAccountNo?: string): Promise<any[]> {
  try {
    let url = `${ctx.root}/ODataV4/Company('${encodeURIComponent(ctx.companyName)}')/BankAccountLedgerEntries?$top=5000&$orderby=Posting_Date desc`;
    if (bankAccountNo) {
      url += `&$filter=Bank_Account_No eq '${encodeURIComponent(bankAccountNo)}'`;
    }
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' },
      cache: 'no-store',
    });
    if (res.ok) {
      const data = await res.json();
      return data.value || [];
    }
  } catch (err) {
    console.warn('Aviso: no se pudo consultar BankAccountLedgerEntries por OData:', err);
  }

  // Fallback a General Ledger Entries si no hubiera permiso directo a la página de banco
  try {
    const res = await fetch(`${ctx.root}/api/v2.0/companies(${ctx.companyId})/generalLedgerEntries?$top=1000&$orderby=postingDate desc`, {
      headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' },
      cache: 'no-store',
    });
    if (res.ok) {
      const data = await res.json();
      return (data.value || []).map((e: any) => ({
        Posting_Date: e.postingDate,
        Document_No: e.documentNumber,
        Document_Type: e.documentType,
        Description: e.description,
        Amount: e.debitAmount > 0 ? e.debitAmount : -e.creditAmount,
      }));
    }
  } catch (e) {}

  return [];
}

// 4. Obtiene las líneas pendientes en el lote de diario seleccionado
export async function getBcJournalLines(ctx: BcContext, journalId: string): Promise<any[]> {
  try {
    const res = await fetch(`${ctx.root}/api/v2.0/companies(${ctx.companyId})/journals(${journalId})/journalLines`, {
      headers: { Authorization: `Bearer ${ctx.token}`, Accept: 'application/json' },
      cache: 'no-store',
    });
    if (res.ok) {
      const data = await res.json();
      return data.value || [];
    }
  } catch (err) {
    console.warn('Aviso: no se pudieron obtener las líneas del diario:', err);
  }
  return [];
}

// 5. Algoritmo de Conciliación Bancaria Inteligente contra Business Central
export async function reconcileStatementWithBc(
  buffer: Buffer,
  filename: string,
  bankAccountNo: string,
  journalBatchId: string,
  companyName?: string
): Promise<ReconcileResult> {
  const ctx = await getBcContext(companyName);

  // 1. Parsear el archivo de extracto bancario (soporta Excel CaixaBank/Santander, CSV y Norma 43)
  const statement = parseBankStatement(buffer, filename);

  // 2. Consultar en paralelo los movimientos de BC y las líneas de diario pendientes
  const [bankLedgerEntries, journalLines] = await Promise.all([
    getBcBankLedgerEntries(ctx, bankAccountNo),
    journalBatchId ? getBcJournalLines(ctx, journalBatchId) : Promise.resolve([]),
  ]);

  // Sets para controlar matches ya consumidos (evitar que un mismo movimiento de BC concilie 2 veces)
  const usedLedgerIndices = new Set<number>();
  const usedJournalIndices = new Set<number>();

  const reconciledMovements: ReconciledMovement[] = [];

  for (const m of statement.movements) {
    const mAmount = Math.round(m.amount * 100) / 100;
    const mDate = m.date;

    // A) Primero buscar si YA ESTÁ EN BC (Bank Account Ledger Entries)
    let matchedLedger: any = null;
    let ledgerIndex = -1;

    for (let i = 0; i < bankLedgerEntries.length; i++) {
      if (usedLedgerIndices.has(i)) continue;
      const ble = bankLedgerEntries[i];
      const bleAmount = Math.round(parseFloat(ble.Amount || 0) * 100) / 100;

      // Coincidencia exacta de importe
      if (Math.abs(bleAmount - mAmount) < 0.01) {
        // Coincidencia de fecha (mismo día o tolerancia de +/- 7 días por fecha valor bancaria)
        const bleDate = ble.Posting_Date ? ble.Posting_Date.split('T')[0] : '';
        const daysDiff = bleDate && mDate
          ? Math.abs((new Date(bleDate).getTime() - new Date(mDate).getTime()) / (1000 * 3600 * 24))
          : 999;

        if (daysDiff <= 10) {
          matchedLedger = ble;
          ledgerIndex = i;
          break;
        }
      }
    }

    if (matchedLedger) {
      usedLedgerIndices.add(ledgerIndex);
      const docNo = matchedLedger.Document_No || matchedLedger.Entry_No || 'BC';
      const docType = matchedLedger.Document_Type ? `${matchedLedger.Document_Type} ` : '';
      const acc = matchedLedger.Bank_Account_Name || matchedLedger.Bank_Account_No || bankAccountNo;
      reconciledMovements.push({
        ...m,
        status: 'POSTED_IN_BC',
        matchedDocNo: docNo,
        matchedDate: matchedLedger.Posting_Date?.split('T')[0],
        matchedAccount: acc,
        matchedLineDetail: `${docNo} · ${matchedLedger.Posting_Date?.split('T')[0]?.split('-').reverse().join('.')} · ${docType}${acc}`,
      });
      continue;
    }

    // B) Si no está en el libro mayor, buscar si YA ESTÁ EN EL LOTE DEL DIARIO (General Journal Lines)
    let matchedJournal: any = null;
    let jIndex = -1;

    for (let i = 0; i < journalLines.length; i++) {
      if (usedJournalIndices.has(i)) continue;
      const jl = journalLines[i];
      const jlAmount = Math.round(parseFloat(jl.amount || 0) * 100) / 100;

      if (Math.abs(jlAmount - mAmount) < 0.01) {
        matchedJournal = jl;
        jIndex = i;
        break;
      }
    }

    if (matchedJournal) {
      usedJournalIndices.add(jIndex);
      const docNo = matchedJournal.documentNumber || matchedJournal.lineNumber || 'Lote';
      const desc = matchedJournal.description || '';
      const acc = matchedJournal.accountNumber ? `Cuenta ${matchedJournal.accountNumber}` : '';
      reconciledMovements.push({
        ...m,
        status: 'IN_BATCH',
        matchedDocNo: docNo,
        matchedDate: matchedJournal.postingDate,
        matchedAccount: acc,
        matchedLineDetail: `${docNo} · ${matchedJournal.postingDate ? matchedJournal.postingDate.split('-').reverse().join('.') : ''} · ${desc} ${acc}`.trim(),
      });
      continue;
    }

    // C) No está en BC ni en el lote -> Pendiente de registrar / conciliar
    reconciledMovements.push({
      ...m,
      status: 'TO_REGISTER',
      matchedLineDetail: 'Pendiente de registrar en el diario',
    });
  }

  const toRegister = reconciledMovements.filter((m) => m.status === 'TO_REGISTER').length;
  const inBatch = reconciledMovements.filter((m) => m.status === 'IN_BATCH').length;
  const postedInBc = reconciledMovements.filter((m) => m.status === 'POSTED_IN_BC').length;

  const earliestDate = statement.startDate ? statement.startDate.split('-').reverse().join('.') : '';
  const summaryText = `Cuadrado con ${bankLedgerEntries.length} Bank Ledger Entries de ${bankAccountNo || 'la cuenta'} desde el ${earliestDate || 'inicio'} y con las líneas pendientes del lote seleccionado.`;

  return {
    bankAccount: bankAccountNo,
    journalBatch: journalBatchId,
    currencyCode: statement.currencyCode || 'EUR',
    summaryText,
    counts: {
      toRegister,
      inBatch,
      postedInBc,
      total: reconciledMovements.length,
    },
    movements: reconciledMovements,
  };
}
