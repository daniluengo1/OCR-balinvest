'use client';

import { Fragment, useState, useEffect } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, ExternalLink, Eye, EyeOff, FileText, Paperclip, Plus, RefreshCw, RotateCcw, ScanText, Search, Trash2, Upload, X } from 'lucide-react';
import DocPdfLink from '@/components/DocPdfLink';
import { AccountCombobox, BcAccount } from '@/components/AccountCombobox';
import { ItemCombobox } from '@/components/ItemCombobox';
import type { BcItem } from '@/app/api/items/route';
import { useCompany } from '@/contexts/CompanyContext';
import { ACCEPT, droppedFiles, expandFiles, isPdf, pickInvoice } from './emailFiles';

export type TaxGroup = { code: string; name: string; rate: number };
type Line = { lineType: string; number: string; description: string; description2: string; quantity: number; unitCost: number; taxCode: string; vatAmount?: number };
type Candidate = { number: string; name: string; currency: string; score: number; reasons: string[]; invoices: number };
type HistoryInvoice = { number: string; vendorInvoiceNumber: string; invoiceDate: string; postingDate: string; currency: string; net: number; total: number; postingDescription: string; lines: Line[] };
type Suggestion = {
  documentType: string; invoiceNo: string; invoiceDate: string; postingDate: string; dueDate: string; postingDescription: string;
  currency: string; net: number | null; vat: number | null; total: number | null; lines: Line[]; comment: string;
  isReverseCharge?: boolean;
  postingDateAdjusted?: boolean;
  postingDateReason?: string | null;
};
type Doc = {
  file: string; error?: string; loading?: boolean; scanned: boolean; currency: string; ids: string[];
  candidates: Candidate[]; vendor: Candidate | null; history: HistoryInvoice[]; suggestion: Suggestion | null;
  existing: { no: string; status: string }[]; warnings: string[];
};
// Valores editables de cada factura antes de crearla (importes como texto, formato es-ES)
type FormLine = Omit<Line, 'quantity' | 'unitCost' | 'vatAmount'> & { quantity: string; unitCost: string; vatAmount: string };
type Form = {
  documentType: 'invoice' | 'credit_note';
  invoiceNo: string;
  invoiceDate: string;
  postingDate: string;
  dueDate: string;
  postingDescription: string;
  lines: FormLine[];
};
type Status = { saving?: boolean; created?: { id: string; no: string; net: number | null; total: number | null; currency: string }; warnings?: string[]; error?: string | null };

const nf = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (v: number | null | undefined) => (v == null ? '—' : nf.format(v));
const toNum = (s: string) => parseFloat(String(s).replace(/\./g, '').replace(',', '.')) || 0;
const toText = (v: number) => String(v).replace('.', ',');
const input = 'border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white';
const LINE_TYPES = ['Item', 'Account', 'Resource', 'Fixed Asset', 'Charge', 'Comment'];
const blank: FormLine = { lineType: 'Account', number: '', description: '', description2: '', quantity: '1', unitCost: '0', taxCode: 'IVA21', vatAmount: '0' };

// Adjunto (no se lee): va a su factura (target = nombre del PDF de la factura) al enviarla a BC
type Attachment = { file: File; target: string; done?: string; error?: string };
// Fila de "Factura + adjuntos" antes de procesar
type Row = { id: number; invoice: File | null; attachments: File[] };
const emptyRow = (): Row => ({ id: Date.now() + Math.random(), invoice: null, attachments: [] });

const toForm = (s: Suggestion | null, accountsMap?: Map<string, string>, itemsMap?: Map<string, string>): Form => ({
  documentType: (s?.documentType as 'invoice' | 'credit_note') || 'invoice',
  invoiceNo: s?.invoiceNo || '', invoiceDate: s?.invoiceDate || '', postingDate: s?.postingDate || '', dueDate: s?.dueDate || '',
  postingDescription: s?.postingDescription || '',
  lines: (s?.lines || []).map(l => {
    let desc = l.description || '';
    if (l.lineType === 'Account' && l.number && accountsMap?.has(l.number)) {
      desc = accountsMap.get(l.number)!;
    } else if (l.lineType === 'Item' && l.number && itemsMap?.has(l.number)) {
      desc = itemsMap.get(l.number)!;
    }
    return {
      ...l,
      description: desc,
      quantity: toText(l.quantity),
      unitCost: toText(l.unitCost),
      vatAmount: s?.isReverseCharge ? '0,00' : (l.vatAmount != null ? toText(l.vatAmount) : '0,00'),
    };
  }),
});

// OCR: facturas de proveedor en PDF → Purchase Invoice sin registrar en BC, con las líneas como en las facturas
// anteriores del mismo proveedor
export default function OcrPage() {
  const { selectedCompany } = useCompany();
  const [files, setFiles] = useState<File[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [forms, setForms] = useState<Record<string, Form>>({});
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Pendientes de procesar: opción 1 (solo facturas) y opción 2 (filas factura + adjuntos)
  const [batch, setBatch] = useState<File[]>([]);
  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const [notice, setNotice] = useState<string | null>(null);
  // Cuadro sobre el que se está arrastrando ("<fila>:invoice" / "<fila>:att")
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<BcAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState<boolean>(false);
  const [items, setItems] = useState<BcItem[]>([]);
  const [loadingItems, setLoadingItems] = useState<boolean>(false);
  const [taxGroups, setTaxGroups] = useState<TaxGroup[]>([
    { code: 'IVA21', name: 'IVA 21%', rate: 21 },
    { code: 'IVA10', name: 'IVA 10%', rate: 10 },
    { code: 'IVA4', name: 'IVA 4%', rate: 4 },
    { code: 'IVA5', name: 'IVA 5%', rate: 5 },
    { code: 'EXENTO', name: 'Exento (0%)', rate: 0 },
    { code: 'NO SUJETO', name: 'No sujeto (0%)', rate: 0 },
  ]);

  useEffect(() => {
    if (!selectedCompany || selectedCompany === 'ALL') return;
    let active = true;
    setLoadingAccounts(true);
    fetch(`/api/accounts?company=${encodeURIComponent(selectedCompany)}`)
      .then(r => r.json())
      .then(data => {
        if (active && Array.isArray(data.accounts)) {
          setAccounts(data.accounts);
        }
      })
      .catch(console.error)
      .finally(() => {
        if (active) setLoadingAccounts(false);
      });

    setLoadingItems(true);
    fetch(`/api/items?company=${encodeURIComponent(selectedCompany)}`)
      .then(r => r.json())
      .then(data => {
        if (active && Array.isArray(data.items)) {
          setItems(data.items);
        }
      })
      .catch(console.error)
      .finally(() => {
        if (active) setLoadingItems(false);
      });

    fetch(`/api/tax-groups?company=${encodeURIComponent(selectedCompany)}`)
      .then(r => r.json())
      .then(data => {
        if (active && Array.isArray(data.taxGroups) && data.taxGroups.length > 0) {
          setTaxGroups(data.taxGroups);
        }
      })
      .catch(console.error);

    return () => { active = false; };
  }, [selectedCompany]);

  // Auto-enriquecer descripciones de líneas con la descripción de la cuenta o del producto
  useEffect(() => {
    if (!accounts.length && !items.length) return;
    const accMap = new Map(accounts.map(a => [a.number, a.name]));
    const itmMap = new Map(items.map(it => [it.number, it.name]));
    setForms(prev => {
      let changed = false;
      const next: Record<string, Form> = {};
      for (const [file, form] of Object.entries(prev)) {
        const newLines = form.lines.map(line => {
          let updatedDesc = line.description;
          if (line.lineType === 'Account' && line.number && accMap.has(line.number)) {
            const accName = accMap.get(line.number)!;
            if (!line.description || line.description === 'Gasto según factura' || line.description === 'Gasto proveedor' || /^(?:factura|abono)\s+\w+/i.test(line.description)) {
              updatedDesc = accName;
              changed = true;
            }
          } else if (line.lineType === 'Item' && line.number && itmMap.has(line.number)) {
            const itmName = itmMap.get(line.number)!;
            if (!line.description || line.description === 'Gasto según factura' || line.description === 'Gasto proveedor' || /^(?:factura|abono)\s+\w+/i.test(line.description)) {
              updatedDesc = itmName;
              changed = true;
            }
          }
          return updatedDesc !== line.description ? { ...line, description: updatedDesc } : line;
        });
        next[file] = { ...form, lines: newLines };
      }
      return changed ? next : prev;
    });
  }, [accounts, items]);

  // Un PDF por llamada (límite de 4,5 MB por petición en Vercel), dos a la vez
  const parse = async (file: File, vendor?: string) => {
    setDocs(l => l.map(d => (d.file === file.name ? { ...d, loading: true, error: undefined } : d)));
    try {
      const form = new FormData();
      form.append('file', file);
      if (vendor) form.append('vendor', vendor);
      const res = await fetch('/api/ocr/parse', { method: 'POST', body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Error al leer el PDF');
      setDocs(l => l.map(d => (d.file === file.name ? { ...json, file: file.name, loading: false } : d)));
      const accMap = new Map(accounts.map(a => [a.number, a.name]));
      const itmMap = new Map(items.map(it => [it.number, it.name]));
      setForms(f => ({ ...f, [file.name]: toForm(json.suggestion, accMap, itmMap) }));
      setStatus(s => ({ ...s, [file.name]: {} }));
      if (json.vendor) setSelected(prev => new Set(prev).add(file.name));
    } catch (e: any) {
      setDocs(l => l.map(d => (d.file === file.name ? { ...d, loading: false, error: e.message } : d)));
    }
  };
  const read = async (list: File[]) => {
    const pdfs = list.filter(f => isPdf(f) && !files.some(x => x.name === f.name));
    const dup = list.filter(f => files.some(x => x.name === f.name));
    setNotice(dup.length ? `Ya están en la lista y no se procesan otra vez: ${dup.map(f => f.name).join(', ')}` : null);
    if (!pdfs.length) return;
    setFiles(l => [...l, ...pdfs]);
    setDocs(l => [...l, ...pdfs.map(f => ({ file: f.name, loading: true, scanned: false, currency: '', ids: [], candidates: [], vendor: null, history: [], suggestion: null, existing: [], warnings: [] }))]);
    const queue = [...pdfs];
    await Promise.all([0, 1].map(async () => { for (let f = queue.shift(); f; f = queue.shift()) await parse(f); }));
  };

  const setField = (file: string, k: Exclude<keyof Form, 'lines'>, v: string) => setForms(f => ({ ...f, [file]: { ...f[file], [k]: v } }));
  const setLine = (file: string, i: number, k: keyof FormLine, v: string) =>
    setForms(f => ({ ...f, [file]: { ...f[file], lines: f[file].lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) } }));
  const addLine = (file: string, from?: Line) => {
    let initialDesc = from?.description || '';
    if (from?.lineType === 'Account' && from.number && accounts.some(a => a.number === from.number)) {
      initialDesc = accounts.find(a => a.number === from.number)!.name;
    } else if (from?.lineType === 'Item' && from.number && items.some(it => it.number === from.number)) {
      initialDesc = items.find(it => it.number === from.number)!.name;
    }
    setForms(f => ({
      ...f,
      [file]: {
        ...f[file],
        lines: [
          ...f[file].lines,
          from
            ? { ...from, description: initialDesc, quantity: toText(from.quantity), unitCost: toText(from.unitCost), vatAmount: toText(from.vatAmount ?? 0) }
            : { ...blank },
        ],
      },
    }));
  };
  const removeLine = (file: string, i: number) => setForms(f => ({ ...f, [file]: { ...f[file], lines: f[file].lines.filter((_, j) => j !== i) } }));
  const remove = (file: string) => {
    setDocs(l => l.filter(d => d.file !== file));
    setFiles(l => l.filter(f => f.name !== file));
    setForms(({ [file]: _f, ...rest }) => rest);
    setStatus(({ [file]: _s, ...rest }) => rest);
    setSelected(prev => { const n = new Set(prev); n.delete(file); return n; });
    setAttachments(l => l.filter(a => a.target !== file));
  };

  // Opción 1: cada PDF es una factura
  const addBatch = (list: File[]) => setBatch(b => [...b, ...list.filter(f => isPdf(f) && !b.some(x => x.name === f.name))]);
  // Ficheros elegidos o soltados: PDFs, o correos de Outlook (.msg/.eml) de los que se sacan sus PDFs
  const expand = async (list: File[], types: string[] = []) => {
    if (!list.length) {
      setNotice(`No ha llegado ningún fichero${types.length ? ` (el navegador ha recibido: ${types.join(', ')})` : ''}. Si arrastras desde Outlook y no funciona, guarda el PDF en el escritorio y arrástralo desde ahí.`);
      return [];
    }
    const { pdfs, notes } = await expandFiles(list);
    setNotice(notes.length ? notes.join(' · ') : null);
    return pdfs;
  };
  const toBatch = async (list: File[], types?: string[]) => addBatch(await expand(list, types));
  // Fila: al cuadro de adjuntos todo son adjuntos; a la factura o a la fila sin factura, el que parece la factura
  // (por el nombre) es la factura y el resto adjuntos
  const toRow = async (r: Row, list: File[], box: 'invoice' | 'att' | 'row', types?: string[]) => {
    const pdfs = await expand(list, types);
    if (!pdfs.length) return;
    if (box === 'att' || r.invoice) { addRowAttachments(r.id, pdfs); return; }
    const { invoice, rest } = pickInvoice(pdfs);
    setRowInvoice(r.id, invoice);
    if (rest.length) addRowAttachments(r.id, rest);
  };
  const processBatch = () => { const list = batch; setBatch([]); read(list); };
  // Opción 2: filas factura + adjuntos; al poner la factura en la última fila se añade otra vacía
  const setRowInvoice = (id: number, f: File | null) => setRows(rs => {
    const next = rs.map(r => (r.id === id ? { ...r, invoice: f } : r));
    return next[next.length - 1].invoice ? [...next, emptyRow()] : next;
  });
  const addRowAttachments = (id: number, list: File[]) =>
    setRows(rs => rs.map(r => (r.id === id ? { ...r, attachments: [...r.attachments, ...list.filter(f => !r.attachments.some(x => x.name === f.name))] } : r)));
  const removeRowAttachment = (id: number, name: string) => setRows(rs => rs.map(r => (r.id === id ? { ...r, attachments: r.attachments.filter(a => a.name !== name) } : r)));
  const removeRow = (id: number) => setRows(rs => { const next = rs.filter(r => r.id !== id); return next.length && !next[next.length - 1].invoice ? next : [...next, emptyRow()]; });
  const filledRows = rows.filter(r => r.invoice);
  // Arrastrar ficheros sobre un cuadro de la fila (factura o adjuntos)
  const drop = (key: string, onFiles: (l: File[], types: string[]) => void) => ({
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOver(key); },
    onDragLeave: () => setDragOver(k => (k === key ? null : k)),
    onDrop: async (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOver(null); const d = await droppedFiles(e); onFiles(d.files, d.types); },
  });
  const processRows = () => {
    const ready = filledRows.filter(r => !files.some(x => x.name === r.invoice!.name));
    setAttachments(a => [...a, ...ready.flatMap(r => r.attachments.map(f => ({ file: f, target: r.invoice!.name })))]);
    setRows([emptyRow()]);
    read(filledRows.map(r => r.invoice!));
  };
  const uploadAttachments = async (file: string, id: string) => {
    for (const a of attachments.filter(x => x.target === file && !x.done)) {
      try {
        const form = new FormData();
        form.append('id', id);
        form.append('file', a.file);
        const res = await fetch('/api/ocr/attach', { method: 'POST', body: form });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Error al adjuntar');
        setAttachments(l => l.map(x => (x.file === a.file ? { ...x, done: id, error: undefined } : x)));
      } catch (e: any) {
        setAttachments(l => l.map(x => (x.file === a.file ? { ...x, error: e.message } : x)));
      }
    }
  };

  const changeVendor = (d: Doc, vendor: string) => { const f = files.find(x => x.name === d.file); if (f && vendor) parse(f, vendor); };

  const create = async (d: Doc, confirmed = false) => {
    const f = forms[d.file];
    const isCredit = f?.documentType === 'credit_note';
    const docLabel = isCredit ? 'el abono' : 'la factura';
    if (!d.vendor || !f.invoiceNo.trim()) { setStatus(s => ({ ...s, [d.file]: { error: `Elige el proveedor y escribe el nº de ${isCredit ? 'abono' : 'factura'}.` } })); return; }
    const force = d.existing.length > 0;
    if (force && !confirmed && !confirm(`El documento ${f.invoiceNo} de ${d.vendor.name} ya existe en BC (${d.existing.map(e => e.no).join(', ')}). ¿Crearlo de nuevo?`)) return;
    setStatus(s => ({ ...s, [d.file]: { saving: true } }));
    try {
      const form = new FormData();
      form.append('data', JSON.stringify({
        documentType: f.documentType,
        vendor: d.vendor.number, invoiceNo: f.invoiceNo.trim(), invoiceDate: f.invoiceDate, postingDate: f.postingDate, dueDate: f.dueDate,
        currency: d.suggestion?.currency || d.currency || d.vendor?.currency || 'EUR',
        postingDescription: f.postingDescription, ids: d.ids, force,
        lines: f.lines.map(l => ({ ...l, quantity: toNum(l.quantity), unitCost: toNum(l.unitCost), vatAmount: toNum(l.vatAmount) })),
      }));
      const pdf = files.find(x => x.name === d.file);
      if (pdf) form.append('pdf', pdf);
      const res = await fetch('/api/ocr/create', { method: 'POST', body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Error al crear ${docLabel}`);
      setStatus(s => ({ ...s, [d.file]: { created: json, warnings: json.warnings } }));
      await uploadAttachments(d.file, json.id);
      setSelected(prev => { const n = new Set(prev); n.delete(d.file); return n; });
    } catch (e: any) {
      setStatus(s => ({ ...s, [d.file]: { error: e.message } }));
    }
  };
  const ready = (d: Doc) => !d.error && !d.loading && !!d.vendor && !status[d.file]?.created;
  const toSend = docs.filter(d => ready(d) && selected.has(d.file));
  const createSelected = async () => {
    const again = toSend.filter(d => d.existing.length);
    if (again.length && !confirm(`${again.length} de las ${toSend.length} facturas ya existen en BC (${again.map(d => forms[d.file]?.invoiceNo).join(', ')}). ¿Crearlas de nuevo también?`)) return;
    for (const d of toSend) await create(d, true);
  };
  const toggle = (file: string) => setSelected(prev => { const n = new Set(prev); if (n.has(file)) n.delete(file); else n.add(file); return n; });
  const valid = docs.filter(ready);
  const allSelected = valid.length > 0 && valid.every(d => selected.has(d.file));

  return (
    <div className="min-h-screen bg-[#F3F4F7] pb-24">
      <main className="w-full px-4 md:px-8 pt-6 space-y-4">
        <header>
          <h1 className="text-3xl font-black text-black tracking-tight flex items-center gap-2"><ScanText /> OCR</h1>
          <p className="text-gray-500 mt-1 text-sm">
            Sube facturas de proveedor en PDF: se reconoce el proveedor y se proponen la cabecera y las líneas igual que en sus últimas facturas registradas en BC ({selectedCompany}).
            Revisa y crea cada una como Purchase Invoice sin registrar, con el PDF adjunto; regístrala (Post) en BC.
          </p>
        </header>

        {selectedCompany === 'ALL' ? (
          <div className="bg-white border rounded-lg p-4 text-sm text-gray-600">Selecciona una empresa en el menú.</div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2 items-start">
            {/* Opción 1: varios PDFs, cada uno una factura */}
            <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3"
              onDragOver={e => e.preventDefault()}
              onDrop={async e => { e.preventDefault(); const d = await droppedFiles(e); toBatch(d.files, d.types); }}>
              <div>
                <p className="font-bold text-gray-900">1 · Solo facturas</p>
                <p className="text-xs text-gray-500">Cada PDF es una factura. Elige o arrastra todos los que quieras, también desde Outlook (adjuntos o el correo entero).</p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="cursor-pointer inline-flex items-center gap-2 bg-white border border-gray-300 text-gray-900 text-sm font-semibold px-4 py-2 rounded-lg hover:bg-gray-50">
                  <Upload size={16} /> Elegir facturas PDF
                  <input type="file" accept={ACCEPT} multiple className="hidden" onChange={e => { toBatch(Array.from(e.target.files || [])); e.target.value = ''; }} />
                </label>
                <button onClick={processBatch} disabled={!batch.length}
                  className="ml-auto inline-flex items-center gap-2 bg-black text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-gray-800 disabled:opacity-40">
                  <ScanText size={16} /> Procesar{batch.length ? ` (${batch.length})` : ''}
                </button>
              </div>
              {batch.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {batch.map(f => <FileChip key={f.name} name={f.name} onRemove={() => setBatch(b => b.filter(x => x !== f))} />)}
                </div>
              ) : <p className="text-sm text-gray-400 border border-dashed border-gray-300 rounded-lg px-3 py-4 text-center">Arrastra aquí las facturas</p>}
            </div>

            {/* Opción 2: una fila por factura con sus adjuntos */}
            <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
              <div className="flex items-start gap-3">
                <div>
                  <p className="font-bold text-gray-900">2 · Factura + adjuntos</p>
                  <p className="text-xs text-gray-500">Una fila por factura: se lee la factura y los adjuntos se añaden como Attachment al enviarla a BC.</p>
                </div>
                <button onClick={processRows} disabled={!filledRows.length}
                  className="ml-auto inline-flex items-center gap-2 bg-black text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-gray-800 disabled:opacity-40">
                  <ScanText size={16} /> Procesar{filledRows.length ? ` (${filledRows.length})` : ''}
                </button>
              </div>
              <div className="space-y-2">
                {rows.map((r, i) => (
                  <div key={r.id} {...drop(`${r.id}:row`, (l, t) => toRow(r, l, 'row', t))}
                    className={`flex flex-wrap items-center gap-2 border rounded-lg px-3 py-2 ${dragOver === `${r.id}:row` ? 'border-indigo-500 border-dashed bg-indigo-50/40' : 'border-gray-200'}`}>
                    <span className="text-xs font-bold text-gray-400 w-5">{i + 1}</span>
                    {r.invoice ? <FileChip name={r.invoice.name} strong onRemove={() => setRowInvoice(r.id, null)} /> : (
                      <label {...drop(`${r.id}:invoice`, (l, t) => toRow(r, l, 'invoice', t))}
                        className={`cursor-pointer inline-flex items-center gap-1.5 text-sm font-semibold text-gray-900 border rounded-lg px-3 py-1.5 hover:bg-gray-50 ${dragOver === `${r.id}:invoice` ? 'border-indigo-500 bg-indigo-50 border-dashed' : 'border-gray-300'}`}
                        title="Elige o arrastra aquí la factura">
                        <Upload size={14} /> Factura PDF
                        <input type="file" accept={ACCEPT} className="hidden" onChange={e => { toRow(r, Array.from(e.target.files || []), 'invoice'); e.target.value = ''; }} />
                      </label>
                    )}
                    {r.attachments.map(a => <FileChip key={a.name} name={a.name} attachment onRemove={() => removeRowAttachment(r.id, a.name)} />)}
                    <label {...(r.invoice ? drop(`${r.id}:att`, (l, t) => toRow(r, l, 'att', t)) : {})}
                      title={r.invoice ? 'Elige o arrastra aquí los adjuntos' : 'Primero la factura'}
                      className={`inline-flex items-center gap-1.5 text-sm font-semibold rounded-lg px-3 py-1.5 border ${!r.invoice ? 'text-gray-300 border-gray-200 cursor-not-allowed' : dragOver === `${r.id}:att` ? 'cursor-pointer text-gray-700 border-indigo-500 bg-indigo-50 border-dashed' : 'cursor-pointer text-gray-700 border-gray-300 hover:bg-gray-50'}`}>
                      <Paperclip size={14} /> Adjuntos
                      <input type="file" accept={ACCEPT} multiple disabled={!r.invoice} className="hidden" onChange={e => { toRow(r, Array.from(e.target.files || []), 'att'); e.target.value = ''; }} />
                    </label>
                    {(r.invoice || r.attachments.length > 0) && (
                      <button onClick={() => removeRow(r.id)} title="Quitar la fila" className="ml-auto p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"><Trash2 size={14} /></button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {notice && <div className="rounded-lg border px-4 py-2 text-sm bg-amber-50 border-amber-200 text-amber-800">{notice}</div>}
        {(docs.some(d => d.loading) || valid.length > 1) && (
          <div className="flex flex-wrap items-center gap-3">
            {docs.some(d => d.loading) && <span className="text-sm text-gray-500 flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Leyendo y buscando las facturas anteriores del proveedor…</span>}
            {valid.length > 1 && (
              <div className="ml-auto flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(valid.map(d => d.file)))} />
                  Marcar todas
                </label>
                <button onClick={createSelected} disabled={!toSend.length || Object.values(status).some(s => s.saving)}
                  className="inline-flex items-center gap-2 bg-indigo-600 text-white text-sm font-semibold px-4 py-2.5 rounded-lg hover:bg-indigo-700 disabled:opacity-40">
                  Enviar seleccionadas a BC ({toSend.length})
                </button>
              </div>
            )}
          </div>
        )}

        {docs.map(d => (
          <DocCard key={d.file} d={d} f={forms[d.file]} fileObj={files.find(x => x.name === d.file)} attachments={attachments.filter(a => a.target === d.file)}
            accounts={accounts} loadingAccounts={loadingAccounts} items={items} loadingItems={loadingItems} taxGroups={taxGroups}
            onAttachNow={() => status[d.file]?.created && uploadAttachments(d.file, status[d.file].created!.id)} st={status[d.file] || {}} selected={selected.has(d.file)}
            onToggle={() => toggle(d.file)} onRemove={() => remove(d.file)} onVendor={v => changeVendor(d, v)} onCreate={() => create(d)}
            setField={(k, v) => setField(d.file, k, v)} setLine={(i, k, v) => setLine(d.file, i, k, v)}
            addLine={l => addLine(d.file, l)} removeLine={i => removeLine(d.file, i)} />
        ))}
      </main>
    </div>
  );
}

function DocCard({ d, f, fileObj, attachments, accounts, loadingAccounts, items, loadingItems, taxGroups, onAttachNow, st, selected, onToggle, onRemove, onVendor, onCreate, setField, setLine, addLine, removeLine }: {
  d: Doc; f?: Form; fileObj?: File; attachments: Attachment[]; accounts: BcAccount[]; loadingAccounts?: boolean; items: BcItem[]; loadingItems?: boolean; taxGroups: TaxGroup[]; onAttachNow: () => void; st: Status; selected: boolean;
  onToggle: () => void; onRemove: () => void; onVendor: (v: string) => void; onCreate: () => void;
  setField: (k: Exclude<keyof Form, 'lines'>, v: string) => void; setLine: (i: number, k: keyof FormLine, v: string) => void;
  addLine: (l?: Line) => void; removeLine: (i: number) => void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!fileObj) return;
    const url = URL.createObjectURL(fileObj);
    setPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [fileObj]);

  const s = d.suggestion;
  const isCredit = f?.documentType === 'credit_note';

  const head = (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 border-b transition-colors ${
      isCredit ? 'bg-emerald-100/70 border-emerald-300' : 'bg-white border-gray-200'
    }`}>
      {!d.loading && !d.error && d.vendor && !st.created && <input type="checkbox" checked={selected} onChange={onToggle} title="Marcar para enviar junto con las demás" />}
      <div className="flex items-center gap-1.5">
        {isCredit ? <RotateCcw size={16} className="text-emerald-700" /> : <FileText size={16} className="text-indigo-600" />}
        <span className="font-bold text-gray-900">{d.vendor ? `${d.vendor.number} · ${d.vendor.name}` : 'Proveedor sin reconocer'}</span>
      </div>

      {/* Selector de Tipo: Factura vs Abono */}
      {f && (
        <div className="flex items-center gap-1.5">
          <select
            value={f.documentType}
            onChange={e => setField('documentType', e.target.value)}
            className={`text-xs font-bold rounded-lg px-2.5 py-1 border transition-colors ${
              isCredit
                ? 'bg-emerald-700 text-white border-emerald-800 shadow-xs'
                : 'bg-gray-50 text-gray-800 border-gray-300'
            }`}
          >
            <option value="invoice" className="bg-white text-gray-800">📄 Factura de compra</option>
            <option value="credit_note" className="bg-white text-gray-800">↩️ Abono / Rectificativa</option>
          </select>
          {isCredit && (
            <span className="text-[11px] font-black uppercase tracking-wider px-2 py-0.5 rounded bg-emerald-600 text-white border border-emerald-700 shadow-xs flex items-center gap-1">
              <RotateCcw size={12} /> ABONO
            </span>
          )}
        </div>
      )}

      {/* Botones de Previsualización del PDF */}
      {previewUrl && (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowPreview(!showPreview)}
            className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-lg border transition-all ${
              showPreview
                ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50 hover:border-gray-400'
            }`}
            title={showPreview ? 'Ocultar previsualización del PDF' : 'Previsualizar el PDF original para validar la información'}
          >
            {showPreview ? <EyeOff size={13} /> : <Eye size={13} />}
            <span>{showPreview ? 'Ocultar PDF' : 'Ver PDF'}</span>
          </button>
          <a
            href={previewUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs font-semibold text-gray-600 hover:text-indigo-600 bg-white hover:bg-indigo-50 border border-gray-300 hover:border-indigo-300 px-2 py-1 rounded-lg"
            title="Abrir PDF en pestaña nueva"
          >
            <ExternalLink size={12} />
          </a>
        </div>
      )}

      <span className="text-xs text-gray-500">{d.file}{d.scanned ? ' · escaneado (sin texto)' : ''}</span>
      {s && <span className="ml-auto text-sm text-gray-600">PDF: neto <b>{fmt(s.net)}</b> · IVA {fmt(s.vat)} · total <b>{fmt(s.total)} {s.currency || d.currency}</b></span>}
      <button onClick={onRemove} title="Quitar de la lista (no se envía a BC)" className={`${s ? '' : 'ml-auto '}p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50`}><X size={16} /></button>
    </div>
  );
  if (d.loading) return <section className="bg-white border border-gray-200 rounded-xl shadow-sm">{head}<p className="p-4 text-sm text-gray-500 flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Leyendo el PDF…</p></section>;
  if (d.error) return <div className="rounded-lg border px-4 py-3 text-sm bg-red-50 border-red-200 text-red-800"><b>{d.file}</b>: {d.error}</div>;
  if (!f) return null;

  const sumNet = f.lines.filter(l => l.lineType !== 'Comment').reduce((a, l) => a + toNum(l.quantity) * toNum(l.unitCost), 0);
  const sumVat = f.lines.filter(l => l.lineType !== 'Comment').reduce((a, l) => a + toNum(l.vatAmount), 0);
  const sumTotal = Math.round((sumNet + sumVat) * 100) / 100;
  const diffNet = s?.net != null ? Math.round((sumNet - s.net) * 100) / 100 : null;
  const diffTotal = s?.total != null ? Math.round((sumTotal - s.total) * 100) / 100 : null;

  const updateVat = (i: number, qtyStr: string, costStr: string, taxCode: string) => {
    if (s?.isReverseCharge) {
      setLine(i, 'vatAmount', '0,00');
      return;
    }
    const tg = taxGroups.find(t => t.code === taxCode);
    const rate = tg ? tg.rate : (taxCode === 'IVA21' ? 21 : taxCode === 'IVA10' ? 10 : taxCode === 'IVA4' ? 4 : taxCode === 'IVA5' ? 5 : 0);
    const net = toNum(qtyStr) * toNum(costStr);
    const computedVat = Math.round(net * (rate / 100) * 100) / 100;
    setLine(i, 'vatAmount', toText(computedVat));
  };
  return (
    <section className={`transition-all overflow-hidden rounded-xl ${
      isCredit
        ? 'bg-white border-2 border-emerald-500 shadow-md ring-2 ring-emerald-500/20'
        : 'bg-white border border-gray-200 shadow-sm'
    }`}>
      {head}
      <div className={`p-4 ${showPreview ? '2xl:grid 2xl:grid-cols-12 2xl:gap-6 2xl:space-y-0 space-y-4' : 'space-y-3'}`}>
        {/* Visor PDF embebido si se activa */}
        {showPreview && previewUrl && (
          <div className="2xl:col-span-5 border border-gray-300 rounded-xl overflow-hidden bg-gray-100 flex flex-col shadow-inner sticky top-4" style={{ height: '740px' }}>
            <div className="px-3 py-2 bg-gray-200/90 border-b border-gray-300 flex items-center justify-between text-xs text-gray-700">
              <span className="font-semibold truncate flex items-center gap-1.5" title={d.file}>
                <FileText size={13} className="text-gray-500 shrink-0" />
                <span className="truncate">{d.file}</span>
              </span>
              <div className="flex items-center gap-2 shrink-0 ml-2">
                <a href={previewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-indigo-700 hover:underline font-medium text-xs">
                  <ExternalLink size={12} /> Abrir grande
                </a>
                <button type="button" onClick={() => setShowPreview(false)} className="p-0.5 rounded text-gray-500 hover:text-red-600 hover:bg-gray-300/50" title="Cerrar previsualización">
                  <X size={14} />
                </button>
              </div>
            </div>
            <iframe
              src={`${previewUrl}#toolbar=1`}
              title={`PDF de ${d.file}`}
              className="w-full flex-1 border-0 bg-white"
            />
          </div>
        )}

        <div className={`${showPreview ? '2xl:col-span-7' : 'w-full'} space-y-3`}>
          {/* Banner destacado para Abonos */}
          {isCredit && (
            <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 bg-emerald-50 border border-emerald-300 rounded-lg text-emerald-950 text-xs shadow-xs">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-600 text-white shrink-0 shadow-xs">
                  <RotateCcw size={13} />
                </span>
                <span>
                  <b>Documento de Abono / Factura Rectificativa:</b> Este documento se creará en Business Central en <b>Abonos de compra</b> (<i>Purchase Credit Memos</i>) con importes positivos.
                </span>
              </div>
              <span className="font-mono font-bold text-[11px] uppercase px-2 py-0.5 rounded bg-emerald-200 text-emerald-900 border border-emerald-400 shrink-0">
                ABONO DE COMPRA
              </span>
            </div>
          )}

          <VendorPicker d={d} onVendor={onVendor} />
          <div className="flex flex-wrap gap-3 items-end">
            <label className="text-xs font-semibold text-gray-500">
              {isCredit ? 'Nº abono / rectificativa (Vendor Cr. Memo No.)' : 'Nº factura proveedor (Vendor Invoice No.)'}
              <input value={f.invoiceNo} onChange={e => setField('invoiceNo', e.target.value)} className={`${input} block mt-1 w-64 font-mono`} />
            </label>
            <label className="text-xs font-semibold text-gray-500">
              {isCredit ? 'Fecha abono' : 'Fecha factura'}
              <input type="date" value={f.invoiceDate} onChange={e => setField('invoiceDate', e.target.value)} className={`${input} block mt-1`} />
            </label>
            <label className="text-xs font-semibold text-gray-500">
              <span className="flex items-center gap-1.5">
                <span>Fecha registro</span>
                {(d.suggestion?.postingDateAdjusted || (f.postingDate && f.invoiceDate && f.postingDate !== f.invoiceDate)) && (
                  <span
                    className="text-[10px] font-medium text-amber-800 bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded cursor-help"
                    title={d.suggestion?.postingDateReason || `Fecha ajustada a hoy (${f.postingDate.split('-').reverse().join('/')}) por periodo cerrado o política de setup`}
                  >
                    ⚡ Ajustada a hoy
                  </span>
                )}
              </span>
              <input type="date" value={f.postingDate} onChange={e => setField('postingDate', e.target.value)} className={`${input} block mt-1`} />
            </label>
            <label className="text-xs font-semibold text-gray-500">Vencimiento <span className="font-normal">(vacío: según términos de pago)</span>
              <input type="date" value={f.dueDate} onChange={e => setField('dueDate', e.target.value)} className={`${input} block mt-1`} />
            </label>
            <label className="text-xs font-semibold text-gray-500 flex-1 min-w-[260px]">Posting Description
              <input value={f.postingDescription} maxLength={100} onChange={e => setField('postingDescription', e.target.value)} className={`${input} block mt-1 w-full`} />
            </label>
          </div>

        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wider text-gray-500 bg-gray-50">
            <tr>
              <th className="p-2 text-left">Tipo</th>
              <th className="p-2 text-left">Nº</th>
              <th className="p-2 text-left">Descripción</th>
              <th className="p-2 text-left">Description 2</th>
              <th className="p-2 text-right">Cantidad</th>
              <th className="p-2 text-right">Coste unit. ({s?.currency || d.currency || d.vendor?.currency || 'EUR'})</th>
              <th className="p-2 text-right">Neto línea</th>
              <th className="p-2 text-left">
                Grupo IVA
                {s?.isReverseCharge && (
                  <span className="ml-1 inline-block text-[10px] normal-case text-indigo-700 bg-indigo-50 border border-indigo-200 px-1 py-0.5 rounded font-normal">
                    Revertido (0%)
                  </span>
                )}
              </th>
              <th className="p-2 text-right">Importe IVA</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {f.lines.map((l, i) => (
              <tr key={i} className="border-t border-gray-100">
                <td className="p-1"><select value={l.lineType} onChange={e => setLine(i, 'lineType', e.target.value)} className={input}>{LINE_TYPES.map(t => <option key={t}>{t}</option>)}</select></td>
                <td className="p-1">
                  {l.lineType === 'Account' ? (
                    <AccountCombobox
                      value={l.number}
                      accounts={accounts}
                      loading={loadingAccounts}
                      disabled={false}
                      onChange={(num, name, vatProdGroup) => {
                        setLine(i, 'number', num);
                        if (name) {
                          setLine(i, 'description', name);
                        }
                        const effectiveVat = vatProdGroup || l.taxCode || 'IVA21';
                        setLine(i, 'taxCode', effectiveVat);
                        updateVat(i, l.quantity, l.unitCost, effectiveVat);
                      }}
                    />
                  ) : l.lineType === 'Item' ? (
                    <ItemCombobox
                      value={l.number}
                      items={items}
                      loading={loadingItems}
                      disabled={false}
                      onChange={(num, name, taxGroup) => {
                        setLine(i, 'number', num);
                        if (name) {
                          setLine(i, 'description', name);
                        }
                        const effectiveVat = taxGroup || l.taxCode || 'IVA21';
                        setLine(i, 'taxCode', effectiveVat);
                        updateVat(i, l.quantity, l.unitCost, effectiveVat);
                      }}
                    />
                  ) : (
                    <input
                      value={l.number}
                      onChange={e => setLine(i, 'number', e.target.value)}
                      disabled={l.lineType === 'Comment'}
                      placeholder={l.lineType === 'Comment' ? '' : 'Nº'}
                      className={`${input} w-28 font-mono ${!l.number && l.lineType !== 'Comment' ? 'border-red-400' : ''}`}
                    />
                  )}
                </td>
                <td className="p-1"><input value={l.description} maxLength={100} onChange={e => setLine(i, 'description', e.target.value)} className={`${input} w-full min-w-[220px]`} /></td>
                <td className="p-1"><input value={l.description2} maxLength={50} onChange={e => setLine(i, 'description2', e.target.value)} disabled={l.lineType === 'Comment'} className={`${input} w-full min-w-[120px]`} /></td>
                <td className="p-1"><input value={l.quantity} onChange={e => { setLine(i, 'quantity', e.target.value); updateVat(i, e.target.value, l.unitCost, l.taxCode); }} disabled={l.lineType === 'Comment'} className={`${input} w-16 text-right tabular-nums`} /></td>
                <td className="p-1"><input value={l.unitCost} onChange={e => { setLine(i, 'unitCost', e.target.value); updateVat(i, l.quantity, e.target.value, l.taxCode); }} disabled={l.lineType === 'Comment'} className={`${input} w-24 text-right tabular-nums`} /></td>
                <td className="p-2 text-right tabular-nums whitespace-nowrap font-medium text-gray-700">{l.lineType === 'Comment' ? '' : fmt(toNum(l.quantity) * toNum(l.unitCost))}</td>
                <td className="p-1">
                  {l.lineType === 'Comment' ? (
                    <span className="text-gray-400 text-xs px-2">—</span>
                  ) : (
                    <select
                      value={l.taxCode}
                      onChange={e => {
                        const code = e.target.value;
                        setLine(i, 'taxCode', code);
                        updateVat(i, l.quantity, l.unitCost, code);
                      }}
                      className={`${input} w-36 font-semibold text-xs`}
                    >
                      {!l.taxCode && <option value="">— Seleccionar —</option>}
                      {taxGroups.map(tg => (
                        <option key={tg.code} value={tg.code}>
                          {tg.code} ({tg.rate}%)
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td className="p-1">
                  {l.lineType === 'Comment' ? (
                    <span className="text-gray-400 text-xs px-2">—</span>
                  ) : (
                    <input
                      value={l.vatAmount}
                      onChange={e => setLine(i, 'vatAmount', e.target.value)}
                      placeholder="0,00"
                      className={`${input} w-24 text-right tabular-nums font-mono text-xs`}
                    />
                  )}
                </td>
                <td className="p-1"><button onClick={() => removeLine(i)} title="Quitar línea" className="p-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"><Trash2 size={14} /></button></td>
              </tr>
            ))}
            <tr className="border-t border-gray-200 bg-gray-50/60 font-semibold text-xs text-gray-700">
              <td colSpan={6} className="p-2">
                <button onClick={() => addLine()} className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-700 hover:underline"><Plus size={13} /> Añadir línea</button>
              </td>
              <td className="p-2 text-right tabular-nums whitespace-nowrap text-gray-900 font-bold" title="Total Neto">
                {fmt(sumNet)}
              </td>
              <td className="p-2 text-left uppercase text-gray-500 font-bold text-[11px]">
                Total IVA:
              </td>
              <td className="p-2 text-right tabular-nums whitespace-nowrap text-indigo-700 font-bold" title="Total IVA">
                {fmt(sumVat)}
              </td>
              <td />
            </tr>
          </tbody>
        </table>

        <div className={`flex flex-wrap items-center justify-between gap-4 p-3 rounded-lg text-xs border ${
          isCredit
            ? 'bg-emerald-50/70 border-emerald-200 text-emerald-950'
            : 'bg-indigo-50/50 border-indigo-100 text-gray-700'
        }`}>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <span>Neto líneas: <b className="font-mono text-gray-900">{fmt(sumNet)}</b></span>
            <span>+ IVA líneas: <b className={`font-mono ${isCredit ? 'text-emerald-700' : 'text-indigo-700'}`}>{fmt(sumVat)}</b></span>
            <span className="text-sm font-bold text-gray-900">
              = Total {isCredit ? 'Abono' : 'Factura'}: <b className="font-mono text-base text-gray-900">{fmt(sumTotal)}</b> {s?.currency || d.currency || d.vendor?.currency || 'EUR'}
            </span>
            {s?.isReverseCharge && (
              <span className="inline-flex items-center gap-1 text-indigo-800 bg-indigo-100/70 border border-indigo-200 px-2 py-0.5 rounded font-medium text-[11px]">
                Operación intracomunitaria · Inversión de sujeto pasivo (0% IVA en factura)
              </span>
            )}
          </div>
          {s?.total != null && (
            <div className="flex items-center gap-2">
              {Math.abs(diffTotal ?? 0) < 0.02 ? (
                <span className="inline-flex items-center gap-1 text-emerald-700 font-medium bg-emerald-50 px-2 py-1 rounded border border-emerald-200">
                  <CheckCircle2 size={13} /> Coincide con total PDF ({fmt(s.total)} {s.currency || d.currency || 'EUR'})
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-amber-800 font-medium bg-amber-50 px-2 py-1 rounded border border-amber-200" title={`Líneas: ${fmt(sumTotal)}, PDF: ${fmt(s.total)}`}>
                  <AlertCircle size={13} /> Diferencia con total PDF ({fmt(s.total)} {s.currency || d.currency || 'EUR'}): {diffTotal! > 0 ? `+${fmt(diffTotal)}` : fmt(diffTotal)}
                </span>
              )}
            </div>
          )}
        </div>
        {attachments.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-600">
            <Paperclip size={13} /> Adjuntos:
            {attachments.map(a => (
              <span key={a.file.name} className={`inline-flex items-center gap-1 border rounded px-2 py-0.5 ${a.done ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : a.error ? 'border-red-200 bg-red-50 text-red-700' : 'border-gray-200 bg-gray-50'}`} title={a.error}>
                {a.done && <CheckCircle2 size={12} />}{a.file.name}{a.error ? ' (error)' : ''}
              </span>
            ))}
            {st.created && attachments.some(a => !a.done) && <button onClick={onAttachNow} className="font-semibold text-indigo-700 hover:underline">Adjuntar ahora a {st.created.no}</button>}
          </div>
        )}
        {s?.comment && <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2"><b>Propuesta:</b> {s.comment}</p>}
        {d.warnings.map(w => <p key={w} className="text-xs text-amber-800 flex items-center gap-1"><AlertCircle size={13} /> {w}</p>)}
        {d.existing.map(e => <p key={e.no} className="text-xs text-amber-800 flex items-center gap-1"><AlertCircle size={13} /> Ya existe en BC: {e.no} ({e.status === 'Draft' ? 'pendiente' : 'registrada'})<DocPdfLink documentNo={e.no} /></p>)}

        {d.history.length > 0 && (
          <div className="border border-gray-200 rounded-lg">
            <button onClick={() => setShowHistory(!showHistory)} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-50">
              {showHistory ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <span className="font-semibold text-gray-900">Últimas facturas de {d.vendor?.name}</span>
              <span className="text-gray-500">{d.history.length} registradas · modelo de la propuesta</span>
            </button>
            {showHistory && (
              <table className="w-full text-sm border-t border-gray-200">
                <thead className="text-xs uppercase tracking-wider text-gray-500 bg-gray-50">
                  <tr><th className="p-2 text-left">Factura</th><th className="p-2 text-left">Fecha</th><th className="p-2 text-left">Tipo · Nº</th><th className="p-2 text-left">Descripción</th>
                    <th className="p-2 text-right">Cant.</th><th className="p-2 text-right">Coste unit.</th><th className="p-2 text-left">Grupo IVA</th><th /></tr>
                </thead>
                <tbody>
                  {d.history.map(h => (
                    <Fragment key={h.number}>
                      {h.lines.map((l, i) => (
                        <tr key={i} className={i ? '' : 'border-t border-gray-200'}>
                          <td className="p-2 whitespace-nowrap">{i ? '' : <><b>{h.number}</b> <span className="text-xs text-gray-500">{h.vendorInvoiceNumber}</span><DocPdfLink documentNo={h.number} />{h.postingDescription && <span className="block text-xs text-gray-500">{h.postingDescription}</span>}</>}</td>
                          <td className="p-2 text-gray-500 whitespace-nowrap">{i ? '' : h.postingDate}</td>
                          <td className="p-2 font-mono text-xs whitespace-nowrap">{l.lineType} · {l.number}</td>
                          <td className="p-2">{l.description}{l.description2 && <span className="text-gray-500"> · {l.description2}</span>}</td>
                          <td className="p-2 text-right tabular-nums">{l.lineType === 'Comment' ? '' : l.quantity}</td>
                          <td className="p-2 text-right tabular-nums">{l.lineType === 'Comment' ? '' : `${fmt(l.unitCost)} ${h.currency}`}</td>
                          <td className="p-2 text-xs">{l.taxCode}</td>
                          <td className="p-2"><button onClick={() => addLine(l)} title="Copiar esta línea a la factura" className="text-xs font-semibold text-indigo-700 hover:underline whitespace-nowrap">+ copiar</button></td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {st.warnings?.map(w => <p key={w} className="text-xs text-amber-800 flex items-center gap-1"><AlertCircle size={13} /> {w}</p>)}
        {st.error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{st.error}</p>}
        <div className="flex items-center gap-3">
          {st.created ? (
            <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold">
              <CheckCircle2 size={16} /> {isCredit ? 'Purchase Credit Memo' : 'Purchase Invoice'} {st.created.no} creada · neto {fmt(st.created.net)} {st.created.currency}
              <DocPdfLink documentNo={st.created.no} kind={isCredit ? 'purchCrMemo' : 'purchInv'} />
            </span>
          ) : (
            <button onClick={onCreate} disabled={st.saving || !d.vendor}
              className={`inline-flex items-center gap-2 text-white text-sm font-semibold px-4 py-2 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed ${
                isCredit
                  ? 'bg-emerald-600 hover:bg-emerald-700 shadow-sm ring-2 ring-emerald-600/30'
                  : 'bg-indigo-600 hover:bg-indigo-700'
              }`}>
              {st.saving ? <RefreshCw size={14} className="animate-spin" /> : (isCredit ? <RotateCcw size={15} /> : null)}
              {isCredit ? 'Enviar abono a BC' : 'Enviar a BC'}{d.existing.length ? ' de nuevo' : ''}
            </button>
          )}
        </div>
        </div>
      </div>
    </section>
  );
}

// Proveedor: los candidatos reconocidos en el PDF o uno buscado por nº/nombre (vuelve a proponer las líneas)
function VendorPicker({ d, onVendor }: { d: Doc; onVendor: (v: string) => void }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<{ number: string; name: string; currency: string; invoices: number }[]>([]);
  const [searching, setSearching] = useState(false);
  const search = async () => {
    if (term.trim().length < 2) return;
    setSearching(true);
    try {
      const json = await (await fetch(`/api/ocr/vendors?q=${encodeURIComponent(term.trim())}`)).json();
      setResults(json.vendors || []);
    } finally {
      setSearching(false);
    }
  };
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-xs font-semibold text-gray-500">Proveedor
        <select value={d.vendor?.number || ''} onChange={e => onVendor(e.target.value)} className={`${input} block mt-1 max-w-[520px]`}>
          {!d.vendor && <option value="">— elige un proveedor —</option>}
          {d.vendor && !d.candidates.some(c => c.number === d.vendor!.number) && <option value={d.vendor.number}>{d.vendor.number} · {d.vendor.name}</option>}
          {d.candidates.map(c => (
            <option key={c.number} value={c.number}>{c.number} · {c.name} ({c.currency}, {c.invoices} fact./año) — {c.reasons.join(', ')}</option>
          ))}
          {results.filter(r => r.number !== d.vendor?.number && !d.candidates.some(c => c.number === r.number)).map(r => (
            <option key={r.number} value={r.number}>{r.number} · {r.name} ({r.currency}, {r.invoices} fact./año)</option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-1">
        <input value={term} onChange={e => setTerm(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()} placeholder="Buscar otro proveedor (nº o nombre)" className={`${input} w-64`} />
        <button onClick={search} className="p-2 rounded-lg border border-gray-300 bg-white hover:bg-gray-50" title="Buscar">
          {searching ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />}
        </button>
      </div>
      {results.length > 0 && <span className="text-xs text-gray-500">{results.length} encontrados: elígelo en el desplegable</span>}
    </div>
  );
}

function FileChip({ name, onRemove, strong, attachment }: { name: string; onRemove: () => void; strong?: boolean; attachment?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs max-w-[280px] ${strong ? 'border-gray-900 bg-gray-50 font-semibold text-gray-900' : 'border-gray-200 bg-gray-50 text-gray-700'}`}>
      {attachment ? <Paperclip size={12} className="shrink-0" /> : <FileText size={12} className="shrink-0" />}
      <span className="truncate" title={name}>{name}</span>
      <button onClick={onRemove} title="Quitar" className="shrink-0 text-gray-400 hover:text-red-600"><X size={12} /></button>
    </span>
  );
}
