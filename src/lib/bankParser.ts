import * as XLSX from 'xlsx';

export interface ParsedBankMovement {
  date: string; // YYYY-MM-DD
  valutaDate?: string; // YYYY-MM-DD
  beneficiary?: string;
  description: string;
  amount: number; // positive = income, negative = expense
  balance?: number;
  bankAccount?: string;
  reference?: string;
  sourceFile?: string;
  bookingText?: string;
  iban?: string;
  info?: string;
  isPending?: boolean;
}

export interface BankStatementParseResult {
  movements: ParsedBankMovement[];
  bankAccount?: string;
  currencyCode: string;
  initialBalance?: number;
  finalBalance?: number;
  totalIncome: number;
  totalExpense: number;
  startDate?: string;
  endDate?: string;
}

// Limpia y convierte textos con importes a número flotante soportando formato español (1.234,56) e internacional (1,234.56)
export function parseAmount(val: any): number {
  if (val == null) return 0;
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  let str = String(val).trim();
  if (!str) return 0;

  // Signo negativo entre paréntesis ej: (150.00)
  const isParenNegative = /^\((.*)\)$/.test(str);
  if (isParenNegative) {
    str = str.replace(/[()]/g, '');
  }

  // Quitar símbolos de moneda y espacios
  str = str.replace(/[€$£CHF\s]/gi, '');

  // Detectar formato español/europeo (puntos de miles y coma decimal: 1.500,25)
  if (str.includes(',') && str.includes('.')) {
    if (str.lastIndexOf(',') > str.lastIndexOf('.')) {
      // 1.500,25 -> 1500.25
      str = str.replace(/\./g, '').replace(',', '.');
    } else {
      // 1,500.25 -> 1500.25
      str = str.replace(/,/g, '');
    }
  } else if (str.includes(',')) {
    // Si solo tiene coma ej "1500,25" -> coma es decimal
    str = str.replace(',', '.');
  }

  const num = parseFloat(str);
  if (isNaN(num)) return 0;
  return isParenNegative ? -Math.abs(num) : num;
}

// Normaliza fechas en formato YYYY-MM-DD
export function parseDate(val: any): string | null {
  if (!val) return null;

  // Fecha numérica de Excel (ej: 45492)
  if (typeof val === 'number') {
    const excelEpoch = new Date(Math.round((val - 25569) * 86400 * 1000));
    if (!isNaN(excelEpoch.getTime())) {
      return excelEpoch.toISOString().split('T')[0];
    }
  }

  if (val instanceof Date && !isNaN(val.getTime())) {
    return val.toISOString().split('T')[0];
  }

  const str = String(val).trim();

  // Formato YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    return str.substring(0, 10);
  }

  // Formato DD/MM/YYYY o DD-MM-YYYY
  const dmy = str.match(/^(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{2,4})/);
  if (dmy) {
    let year = dmy[3];
    if (year.length === 2) {
      year = parseInt(year, 10) > 50 ? `19${year}` : `20${year}`;
    }
    const month = dmy[2].padStart(2, '0');
    const day = dmy[1].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // Formato YYYYMMDD (común en bancos y Norma 43)
  const ymd = str.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (ymd) {
    return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  }

  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0];
  }

  return null;
}

// Parser de formato Norma 43 (Cuaderno 43 - Asociación Española de Banca)
export function parseNorma43(content: string, filename: string): BankStatementParseResult {
  const lines = content.split(/\r?\n/);
  const movements: ParsedBankMovement[] = [];
  let bankAccount = '';
  let currencyCode = 'EUR';
  let initialBalance: number | undefined;
  let finalBalance: number | undefined;
  let currentMovement: ParsedBankMovement | null = null;

  for (const line of lines) {
    if (line.length < 2) continue;
    const recordCode = line.substring(0, 2);

    if (recordCode === '11') {
      // Cabecera de cuenta
      // Pos 2..6 banco, 6..10 oficina, 10..20 num cuenta
      const bank = line.substring(2, 6);
      const branch = line.substring(6, 10);
      const acc = line.substring(10, 20);
      bankAccount = `${bank}-${branch}-${acc}`.trim();

      // Pos 20..26 fecha inicio YYMMDD
      // Pos 26..27 clave debe/haber (1 = debe/negativo, 2 = haber/positivo)
      const signCode = line.substring(26, 27);
      // Pos 27..41 saldo inicial (14 dígitos, últimos 2 son decimales)
      const balStr = line.substring(27, 41);
      const balNum = parseInt(balStr, 10) / 100;
      initialBalance = signCode === '1' ? -balNum : balNum;

      // Pos 47..50 divisa
      const curr = line.substring(47, 50).trim();
      if (curr === '978' || curr === 'EUR') currencyCode = 'EUR';
      else if (curr) currencyCode = curr;
    } else if (recordCode === '22') {
      // Registro principal de movimiento
      if (currentMovement) {
        movements.push(currentMovement);
        currentMovement = null;
      }

      // Pos 10..16 fecha operacion YYMMDD
      const yymmdd = line.substring(10, 16);
      const year = `20${yymmdd.substring(0, 2)}`;
      const month = yymmdd.substring(2, 4);
      const day = yymmdd.substring(4, 6);
      const date = `${year}-${month}-${day}`;

      // Pos 26..27 signo (1 = debe/cargo, 2 = haber/abono)
      const sign = line.substring(26, 27);
      // Pos 27..41 importe (14 digitos con 2 decimales)
      const amtStr = line.substring(27, 41);
      const amtNum = parseInt(amtStr, 10) / 100;
      const amount = sign === '1' ? -amtNum : amtNum;

      // Pos 52..80 concepto complementario / referencia
      const concept = line.substring(52).trim();

      currentMovement = {
        date,
        description: concept || 'Movimiento bancario',
        amount,
        bankAccount,
        sourceFile: filename,
      };
    } else if (recordCode === '23') {
      // Registro complementario de concepto
      if (currentMovement) {
        const extra = line.substring(4).trim();
        if (extra) {
          currentMovement.description = `${currentMovement.description} ${extra}`.trim();
        }
      }
    } else if (recordCode === '33') {
      // Fin de cuenta
      if (currentMovement) {
        movements.push(currentMovement);
        currentMovement = null;
      }
      // Pos 26..27 clave saldo final
      const signCode = line.substring(26, 27);
      const balStr = line.substring(27, 41);
      const balNum = parseInt(balStr, 10) / 100;
      finalBalance = signCode === '1' ? -balNum : balNum;
    }
  }

  if (currentMovement) {
    movements.push(currentMovement);
  }

  let totalIncome = 0;
  let totalExpense = 0;
  for (const m of movements) {
    if (m.amount > 0) totalIncome += m.amount;
    else totalExpense += Math.abs(m.amount);
  }

  return {
    movements,
    bankAccount,
    currencyCode,
    initialBalance,
    finalBalance,
    totalIncome: Math.round(totalIncome * 100) / 100,
    totalExpense: Math.round(totalExpense * 100) / 100,
    startDate: movements[0]?.date,
    endDate: movements[movements.length - 1]?.date,
  };
}

// Parser universal para hojas de cálculo Excel (.xlsx, .xls) y CSV
export function parseBankExcel(buffer: Buffer, filename: string): BankStatementParseResult {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  // Convertir a matriz de filas crudas
  const rawRows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  if (!rawRows || rawRows.length === 0) {
    throw new Error('El archivo está vacío o no contiene filas legibles.');
  }

  // 1. Detectar cabecera buscando en las primeras 20 filas
  let headerRowIndex = -1;
  let dateCol = -1;
  let descCol = -1;
  let amountCol = -1;
  let incomeCol = -1;
  let expenseCol = -1;
  let balanceCol = -1;
  let refCol = -1;
  let currencyCol = -1;

  for (let r = 0; r < Math.min(rawRows.length, 25); r++) {
    const row = rawRows[r].map((cell: any) => String(cell || '').trim().toLowerCase());

    const dCol = row.findIndex((c: string) =>
      c === 'fecha' || c === 'date' || c.includes('fecha registro') || c.includes('fecha valor') || c.includes('f. valor') || c === 'f. operacion' || c === 'fecha op'
    );
    const descC = row.findIndex((c: string) =>
      c.includes('descrip') || c.includes('concepto') || c.includes('detalle') || c.includes('establecimiento') || c.includes('proveedor') || c.includes('supplier') || c.includes('titular')
    );
    const amtC = row.findIndex((c: string) =>
      c === 'importe' || c === 'amount' || c === 'importe neto' || c === 'importe bruto' || c === 'neto' || c === 'total' || c.includes('importe operacion')
    );
    const incC = row.findIndex((c: string) => c.includes('haber') || c.includes('ingreso') || c.includes('abono') || c.includes('credit'));
    const expC = row.findIndex((c: string) => c.includes('debe') || c.includes('gasto') || c.includes('cargo') || c.includes('debit'));

    if (dCol !== -1 && (amtC !== -1 || (incC !== -1 && expC !== -1) || descC !== -1)) {
      headerRowIndex = r;
      dateCol = dCol;
      descCol = descC;
      amountCol = amtC;
      incomeCol = incC;
      expenseCol = expC;
      balanceCol = row.findIndex((c: string) => c.includes('saldo') || c.includes('balance'));
      refCol = row.findIndex((c: string) => c.includes('referencia') || c.includes('nº doc') || c.includes('documento'));
      currencyCol = row.findIndex((c: string) => c.includes('divisa') || c.includes('currency') || c.includes('moneda'));
      break;
    }
  }

  // Fallback si no hay cabecera explícita
  if (headerRowIndex === -1) {
    headerRowIndex = 0;
    dateCol = 0;
    descCol = 1;
    amountCol = 2;
  }

  // Detectar cuenta bancaria o divisa en metadatos de las primeras filas
  let detectedAccount = '';
  let detectedCurrency = 'EUR';

  for (let r = 0; r < headerRowIndex; r++) {
    const lineText = rawRows[r].join(' ');
    const ibanMatch = lineText.match(/([A-Z]{2}\d{2}[A-Z0-9\s]{16,30})/i);
    if (ibanMatch && !detectedAccount) {
      detectedAccount = ibanMatch[1].replace(/\s+/g, '');
    }
    if (lineText.includes('USD') || lineText.includes('$')) detectedCurrency = 'USD';
    else if (lineText.includes('GBP') || lineText.includes('£')) detectedCurrency = 'GBP';
    else if (lineText.includes('CHF')) detectedCurrency = 'CHF';
  }

  const movements: ParsedBankMovement[] = [];
  let totalIncome = 0;
  let totalExpense = 0;

  for (let r = headerRowIndex + 1; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (!row || row.length === 0) continue;

    const rawDate = row[dateCol];
    const parsedDate = parseDate(rawDate);
    if (!parsedDate) continue;

    let description = descCol !== -1 ? String(row[descCol] || '').trim() : '';
    if (!description && refCol !== -1 && row[refCol]) {
      description = String(row[refCol]).trim();
    }
    if (!description) description = 'Movimiento bancario';

    // Determinar importe
    let amount = 0;
    if (amountCol !== -1 && row[amountCol] !== undefined && row[amountCol] !== '') {
      amount = parseAmount(row[amountCol]);
    } else if (incomeCol !== -1 || expenseCol !== -1) {
      const inc = incomeCol !== -1 ? parseAmount(row[incomeCol]) : 0;
      const exp = expenseCol !== -1 ? parseAmount(row[expenseCol]) : 0;
      if (inc > 0) amount = inc;
      else if (exp > 0) amount = -exp;
      else amount = inc - exp;
    }

    if (amount === 0 && !row[amountCol] && !row[incomeCol] && !row[expenseCol]) {
      continue;
    }

    const balance = balanceCol !== -1 && row[balanceCol] !== '' ? parseAmount(row[balanceCol]) : undefined;
    const reference = refCol !== -1 ? String(row[refCol] || '').trim() : undefined;

    if (currencyCol !== -1 && row[currencyCol]) {
      const c = String(row[currencyCol]).trim().toUpperCase();
      if (c && c.length === 3) detectedCurrency = c;
    }

    if (amount > 0) totalIncome += amount;
    else totalExpense += Math.abs(amount);

    movements.push({
      date: parsedDate,
      description,
      amount: Math.round(amount * 100) / 100,
      balance,
      bankAccount: detectedAccount || undefined,
      reference,
      sourceFile: filename,
    });
  }

  // Ordenar cronológicamente (más antiguo primero para el cálculo de saldo progresivo)
  movements.sort((a, b) => a.date.localeCompare(b.date));

  return {
    movements,
    bankAccount: detectedAccount || undefined,
    currencyCode: detectedCurrency,
    initialBalance: movements[0]?.balance != null ? movements[0].balance - movements[0].amount : undefined,
    finalBalance: movements[movements.length - 1]?.balance,
    totalIncome: Math.round(totalIncome * 100) / 100,
    totalExpense: Math.round(totalExpense * 100) / 100,
    startDate: movements[0]?.date,
    endDate: movements[movements.length - 1]?.date,
  };
}

// Parsea una línea CSV respetando comillas y delimitador
export function parseCsvLine(line: string, delimiter = ';'): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === delimiter && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur.trim());
  return result;
}

// Parser especializado para extractos bancarios en CSV con punto y coma (Sparkasse, bancos alemanes y europeos)
export function parseSparkasseOrSemicolonCsv(text: string, filename: string): BankStatementParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { movements: [], currencyCode: 'EUR', totalIncome: 0, totalExpense: 0 };
  }

  // Parse cabecera
  const headerCols = parseCsvLine(lines[0], ';').map((c) => c.toLowerCase().trim().replace(/['"]/g, ''));
  const auftragIdx = headerCols.findIndex((c) => c.includes('auftragskonto') || c.includes('cuenta'));
  const buchungstagIdx = headerCols.findIndex((c) => c.includes('buchungstag') || c.includes('fecha'));
  const valutaIdx = headerCols.findIndex((c) => c.includes('valutadatum') || c.includes('valor'));
  const zweckIdx = headerCols.findIndex((c) => c.includes('verwendungszweck') || c.includes('concepto'));
  const partyIdx = headerCols.findIndex((c) => c.includes('beguenstigter') || c.includes('empf') || c.includes('contrapartida') || c.includes('titular'));
  const ibanIdx = headerCols.findIndex((c) => c.includes('kontonummer/iban') || c.includes('iban'));
  const betragIdx = headerCols.findIndex((c) => c.includes('betrag') || c.includes('importe'));
  const waehrungIdx = headerCols.findIndex((c) => c.includes('waehrung') || c.includes('divisa'));
  const infoIdx = headerCols.findIndex((c) => c.includes('info'));

  const movements: ParsedBankMovement[] = [];
  let totalIncome = 0;
  let totalExpense = 0;
  let detectedCurrency = 'EUR';
  let detectedAccount = '';

  for (let i = 1; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine.trim()) continue;
    const cols = parseCsvLine(rawLine, ';').map((c) => c.replace(/^"|"$/g, '').trim());
    if (cols.length < 2) continue;

    const rawDate = buchungstagIdx !== -1 ? cols[buchungstagIdx] : cols[1];
    const parsedDate = parseDate(rawDate);
    if (!parsedDate) continue;

    const rawValuta = valutaIdx !== -1 ? cols[valutaIdx] : undefined;
    const parsedValuta = parseDate(rawValuta);

    const beneficiary = partyIdx !== -1 ? cols[partyIdx]?.trim() : '';
    const zweck = zweckIdx !== -1 ? cols[zweckIdx]?.trim() : '';
    const iban = ibanIdx !== -1 ? cols[ibanIdx]?.trim() : '';
    const rawInfo = infoIdx !== -1 ? cols[infoIdx]?.trim() : '';
    const isPending = rawInfo ? /vorgemerkt/i.test(rawInfo) : false;

    // Concatenar descripción con Zweck e IBAN
    let description = '';
    if (zweck && iban) description = `${zweck} ${iban}`;
    else if (zweck) description = zweck;
    else if (iban) description = iban;
    else if (beneficiary) description = beneficiary;
    else description = 'Movimiento bancario';

    const rawAmt = betragIdx !== -1 ? cols[betragIdx] : cols[cols.length - 3];
    const amount = parseAmount(rawAmt);

    const currency = waehrungIdx !== -1 && cols[waehrungIdx] ? cols[waehrungIdx].trim() : 'EUR';
    if (currency) detectedCurrency = currency;

    const account = auftragIdx !== -1 && cols[auftragIdx] ? cols[auftragIdx].trim() : '';
    if (account && !detectedAccount) detectedAccount = account;

    if (amount > 0) totalIncome += amount;
    else totalExpense += Math.abs(amount);

    movements.push({
      date: parsedDate,
      valutaDate: parsedValuta || parsedDate,
      beneficiary: beneficiary || undefined,
      description,
      amount: Math.round(amount * 100) / 100,
      bankAccount: account || undefined,
      sourceFile: filename,
      info: rawInfo || undefined,
      isPending,
      iban: iban || undefined,
    });
  }

  return {
    movements,
    bankAccount: detectedAccount || undefined,
    currencyCode: detectedCurrency,
    totalIncome: Math.round(totalIncome * 100) / 100,
    totalExpense: Math.round(totalExpense * 100) / 100,
    startDate: movements[movements.length - 1]?.date,
    endDate: movements[0]?.date,
  };
}

// Función maestra de parseo que detecta formato por extensión y contenido
export function parseBankStatement(buffer: Buffer, filename: string): BankStatementParseResult {
  const lowerName = filename.toLowerCase();

  // Si es Norma 43
  if (lowerName.endsWith('.n43') || lowerName.endsWith('.c43')) {
    const text = buffer.toString('latin1');
    return parseNorma43(text, filename);
  }

  // Comprobar si es CSV o archivo de texto
  if (lowerName.endsWith('.csv') || lowerName.endsWith('.txt')) {
    // Probar primero con latin1 que cubre caracteres alemanes (ä, ö, ü, ß) y españoles (ñ, acentos)
    const textLatin = buffer.toString('latin1');
    const firstLine = textLatin.split(/\r?\n/)[0] || '';
    if (firstLine.includes(';') && (
      firstLine.toLowerCase().includes('buchungstag') ||
      firstLine.toLowerCase().includes('auftragskonto') ||
      firstLine.toLowerCase().includes('betrag') ||
      firstLine.toLowerCase().includes('verwendungszweck') ||
      firstLine.toLowerCase().includes('fecha') ||
      firstLine.toLowerCase().includes('importe')
    )) {
      return parseSparkasseOrSemicolonCsv(textLatin, filename);
    }
    if (firstLine.includes(';')) {
      return parseSparkasseOrSemicolonCsv(textLatin, filename);
    }
    if (firstLine.startsWith('11') || textLatin.includes('\n11') || textLatin.includes('\r11')) {
      return parseNorma43(textLatin, filename);
    }
  }

  // Por defecto (xlsx, xls, o csv estándar con coma)
  return parseBankExcel(buffer, filename);
}
