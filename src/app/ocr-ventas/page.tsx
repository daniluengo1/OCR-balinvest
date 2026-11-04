'use client';

import { Fragment, useState, useEffect } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Eye,
  EyeOff,
  FileCheck,
  FileMinus,
  FileText,
  Paperclip,
  Plus,
  Receipt,
  RefreshCw,
  RotateCcw,
  ScanText,
  Search,
  ShoppingCart,
  Trash2,
  TrendingUp,
  Upload,
  X
} from 'lucide-react';
import DocPdfLink from '@/components/DocPdfLink';
import { AccountCombobox, BcAccount } from '@/components/AccountCombobox';
import { ItemCombobox } from '@/components/ItemCombobox';
import type { BcItem } from '@/app/api/items/route';
import { useCompany } from '@/contexts/CompanyContext';
import { ACCEPT, droppedFiles, expandFiles, isPdf, pickInvoice } from '@/app/ocr/emailFiles';

export type TaxGroup = { code: string; name: string; rate: number };
type Line = { lineType: string; number: string; description: string; description2: string; quantity: number; unitCost: number; taxCode: string; vatAmount?: number };
type CustomerCandidate = { number: string; name: string; currency: string; score: number; reasons: string[]; invoices: number };
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
  candidates: CustomerCandidate[]; customer: CustomerCandidate | null; history: HistoryInvoice[]; suggestion: Suggestion | null;
  existing: { no: string; status: string }[]; warnings: string[];
};

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
const blank: FormLine = { lineType: 'Account', number: '70000000', description: '', description2: '', quantity: '1', unitCost: '0', taxCode: 'IVA21', vatAmount: '0' };

type Attachment = { file: File; target: string; done?: string; error?: string };
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

export default function OcrVentasPage() {
  const { selectedCompany } = useCompany();
  const [files, setFiles] = useState<File[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [forms, setForms] = useState<Record<string, Form>>({});
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState<File[]>([]);
  const [rows, setRows] = useState<Row[]>([emptyRow()]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [viewing, setViewing] = useState<Record<string, boolean>>({});
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  // Catálogos auxiliares de BC
  const [accounts, setAccounts] = useState<BcAccount[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [items, setItems] = useState<BcItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [taxGroups, setTaxGroups] = useState<TaxGroup[]>([
    { code: 'IVA21', name: 'IVA 21%', rate: 0.21 },
    { code: 'IVA10', name: 'IVA 10%', rate: 0.10 },
    { code: 'IVA4', name: 'IVA 4%', rate: 0.04 },
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
            if (!line.description || line.description === 'Ingreso venta' || line.description === 'Venta de mercaderías' || /^(?:factura|abono)\s+\w+/i.test(line.description)) {
              updatedDesc = accName;
              changed = true;
            }
          } else if (line.lineType === 'Item' && line.number && itmMap.has(line.number)) {
            const itmName = itmMap.get(line.number)!;
            if (!line.description || line.description === 'Ingreso venta' || line.description === 'Venta de mercaderías' || /^(?:factura|abono)\s+\w+/i.test(line.description)) {
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

  const parse = async (file: File, customer?: string) => {
    setDocs(l => l.map(d => (d.file === file.name ? { ...d, loading: true, error: undefined } : d)));
    try {
      const form = new FormData();
      form.append('file', file);
      if (customer) form.append('customer', customer);
      const res = await fetch('/api/ocr-ventas/parse', { method: 'POST', body: form });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Error al leer el PDF de venta');
      setDocs(l => l.map(d => (d.file === file.name ? { ...json, file: file.name, loading: false } : d)));
      const accMap = new Map(accounts.map(a => [a.number, a.name]));
      const itmMap = new Map(items.map(it => [it.number, it.name]));
      setForms(f => ({ ...f, [file.name]: toForm(json.suggestion, accMap, itmMap) }));
      setStatus(s => ({ ...s, [file.name]: {} }));
      if (json.customer) setSelected(prev => new Set(prev).add(file.name));
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
    setDocs(l => [...l, ...pdfs.map(f => ({ file: f.name, loading: true, scanned: false, currency: '', ids: [], candidates: [], customer: null, history: [], suggestion: null, existing: [], warnings: [] }))]);
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

  const addBatch = (list: File[]) => setBatch(b => [...b, ...list.filter(f => isPdf(f) && !b.some(x => x.name === f.name))]);
  const expand = async (list: File[], types: string[] = []) => {
    if (!list.length) {
      setNotice(`No ha llegado ningún fichero${types.length ? ` (el navegador ha recibido: ${types.join(', ')})` : ''}.`);
      return [];
    }
    const { pdfs, notes } = await expandFiles(list);
    setNotice(notes.length ? notes.join(' · ') : null);
    return pdfs;
  };
  const toBatch = async (list: File[], types?: string[]) => addBatch(await expand(list, types));
  const toRow = async (r: Row, list: File[], box: 'invoice' | 'att' | 'row', types?: string[]) => {
    const pdfs = await expand(list, types);
    if (!pdfs.length) return;
    if (box === 'att' || r.invoice) { addRowAttachments(r.id, pdfs); return; }
    const { invoice, rest: atts } = pickInvoice(pdfs);
    setRows(l => l.map(x => (x.id === r.id ? { ...x, invoice, attachments: [...x.attachments, ...atts] } : x)));
  };
  const addRowAttachments = (id: number, list: File[]) =>
    setRows(l => l.map(r => (r.id === id ? { ...r, attachments: [...r.attachments, ...list.filter(f => !r.attachments.some(a => a.name === f.name))] } : r)));
  const processBatch = async () => { const list = [...batch]; setBatch([]); await read(list); };
  const processRows = async () => {
    const ready = rows.filter(r => r.invoice);
    if (!ready.length) return;
    const invs: File[] = [];
    const newAtts: Attachment[] = [];
    for (const r of ready) {
      invs.push(r.invoice!);
      for (const a of r.attachments) newAtts.push({ file: a, target: r.invoice!.name });
    }
    setAttachments(l => [...l, ...newAtts]);
    setRows(rows.filter(r => !r.invoice));
    if (!rows.some(r => !r.invoice)) setRows([emptyRow()]);
    await read(invs);
  };

  const create = async (file: string, force = false) => {
    const d = docs.find(x => x.file === file), f = forms[file];
    if (!d || !f || !d.customer) return;
    setStatus(s => ({ ...s, [file]: { saving: true, error: null } }));
    try {
      const data = new FormData();
      data.append('data', JSON.stringify({
        documentType: f.documentType,
        customer: d.customer.number,
        invoiceNo: f.invoiceNo,
        invoiceDate: f.invoiceDate,
        postingDate: f.postingDate || f.invoiceDate,
        dueDate: f.dueDate,
        postingDescription: f.postingDescription,
        currency: d.currency,
        lines: f.lines.map(l => ({ ...l, quantity: toNum(l.quantity), unitCost: toNum(l.unitCost), vatAmount: toNum(l.vatAmount) })),
        ids: d.ids,
        force,
      }));
      const pdf = files.find(x => x.name === file);
      if (pdf) data.append('pdf', pdf);
      const res = await fetch('/api/ocr-ventas/create', { method: 'POST', body: data });
      const json = await res.json();
      if (!res.ok) {
        if (res.status === 409) {
          setStatus(s => ({ ...s, [file]: { saving: false, error: json.error, warnings: d.warnings } }));
          return;
        }
        throw new Error(json.error || 'Error al crear documento de venta en BC');
      }
      setStatus(s => ({ ...s, [file]: { saving: false, created: json, warnings: json.warnings } }));

      // Subir adjuntos secundarios si existen
      const myAtts = attachments.filter(a => a.target === file && !a.done);
      for (const a of myAtts) {
        try {
          const af = new FormData();
          af.append('id', json.id);
          af.append('file', a.file);
          af.append('parentType', f.documentType === 'credit_note' ? 'Sales Credit Memo' : 'Sales Invoice');
          const ar = await fetch('/api/ocr-ventas/attach', { method: 'POST', body: af });
          const aj = await ar.json();
          if (!ar.ok) throw new Error(aj.error || 'Error al adjuntar');
          setAttachments(l => l.map(x => (x === a ? { ...x, done: 'Adjuntado' } : x)));
        } catch (e: any) {
          setAttachments(l => l.map(x => (x === a ? { ...x, error: e.message } : x)));
        }
      }
    } catch (e: any) {
      setStatus(s => ({ ...s, [file]: { saving: false, error: e.message } }));
    }
  };

  const createAll = async () => {
    const list = docs.filter(d => selected.has(d.file) && d.customer && !status[d.file]?.created && !status[d.file]?.saving);
    for (const d of list) await create(d.file);
  };

  const setCustomerFor = (file: string, customerNo: string) => {
    const d = docs.find(x => x.file === file);
    if (!d) return;
    const cand = d.candidates.find(c => c.number === customerNo);
    if (cand) {
      setDocs(l => l.map(x => (x.file === file ? { ...x, customer: cand } : x)));
      parse(files.find(f => f.name === file)!, customerNo);
    } else if (customerNo) {
      parse(files.find(f => f.name === file)!, customerNo);
    }
  };

  const preview = (name: string) => {
    const f = files.find(x => x.name === name);
    if (!f) return;
    if (!previewUrls[name]) {
      const url = URL.createObjectURL(f);
      setPreviewUrls(u => ({ ...u, [name]: url }));
    }
    setViewing(v => ({ ...v, [name]: !v[name] }));
  };

  const selectAll = () => {
    const all = docs.every(d => selected.has(d.file));
    setSelected(all ? new Set() : new Set(docs.map(d => d.file)));
  };

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-6">
      {/* Cabecera y Selector Compras / Ventas */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-gray-200">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-2 rounded-lg bg-emerald-100 text-emerald-700">
              <TrendingUp size={24} />
            </span>
            <div>
              <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
                OCR Facturas y Abonos de Venta
                <span className="text-xs px-2.5 py-0.5 rounded-full font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">
                  Clientes
                </span>
              </h1>
              <p className="text-xs text-gray-500 mt-0.5">
                Procesa facturas y abonos emitidos a clientes. Las líneas se modelan automáticamente a partir de los <strong>Posted Sales Lines</strong> registrados en Business Central.
              </p>
            </div>
          </div>
        </div>

        {/* Pestañas de cambio rápido Compra / Venta */}
        <div className="flex items-center bg-gray-100 p-1 rounded-xl text-xs font-semibold">
          <Link
            href="/ocr"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-gray-600 hover:text-gray-900 transition-colors"
          >
            <ShoppingCart size={14} /> Facturas Compra
          </Link>
          <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white text-emerald-800 shadow-sm border border-gray-200 font-bold">
            <TrendingUp size={14} className="text-emerald-600" /> Facturas Venta
          </span>
        </div>
      </div>

      {notice && (
        <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-xs text-blue-800 flex items-center justify-between">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} className="text-blue-500 hover:text-blue-800"><X size={14} /></button>
        </div>
      )}

      {/* Cajas de carga de ficheros */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Opción 1: Cada PDF es una factura de venta */}
        <div
          onDragOver={e => e.preventDefault()}
          onDrop={async e => { e.preventDefault(); const d = await droppedFiles(e); toBatch(d.files, d.types); }}
          className="border-2 border-dashed border-emerald-200 rounded-xl p-4 bg-emerald-50/30 hover:bg-emerald-50/60 transition-colors flex flex-col justify-between"
        >
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-emerald-800 flex items-center gap-1.5">
                <FileText size={15} /> 1 · Solo facturas / abonos de venta
              </span>
              <span className="text-[11px] text-gray-400">PDFs individuales</span>
            </div>
            <p className="text-xs text-gray-600 mb-3">
              Cada PDF es una factura o abono de venta. Elige o arrastra varios archivos.
            </p>
            {batch.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-3 max-h-24 overflow-y-auto p-1 bg-white rounded-lg border border-gray-200">
                {batch.map(f => (
                  <span key={f.name} className="inline-flex items-center gap-1 text-[11px] bg-emerald-50 text-emerald-800 px-2 py-0.5 rounded border border-emerald-200">
                    <span className="truncate max-w-[150px]">{f.name}</span>
                    <button onClick={() => setBatch(b => b.filter(x => x !== f))}><X size={11} /></button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 pt-2 border-t border-emerald-100">
            <label className="cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 shadow-sm">
              <Upload size={13} /> Elegir facturas de venta
              <input type="file" multiple accept={ACCEPT} onChange={e => { if (e.target.files) toBatch(Array.from(e.target.files)); }} className="hidden" />
            </label>
            {batch.length > 0 && (
              <button
                onClick={processBatch}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm flex items-center gap-1.5 ml-auto"
              >
                <ScanText size={13} /> Procesar ({batch.length})
              </button>
            )}
          </div>
        </div>

        {/* Opción 2: Factura de venta con adjuntos */}
        <div className="border-2 border-dashed border-gray-200 rounded-xl p-4 bg-gray-50/50 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-gray-700 flex items-center gap-1.5">
                <Paperclip size={15} /> 2 · Factura de venta + Documentación adjunta
              </span>
              <span className="text-[11px] text-gray-400">Albaranes, pedidos, etc.</span>
            </div>
            <p className="text-xs text-gray-600 mb-3">
              Agrupa la factura de venta principal con sus anexos (albaranes de entrega, contratos o pedidos firmados).
            </p>
            <div className="space-y-2 max-h-36 overflow-y-auto pr-1">
              {rows.map((r, i) => (
                <div key={r.id} className="p-2 bg-white rounded-lg border border-gray-200 text-xs flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 overflow-hidden flex-1">
                    <span className="font-semibold text-gray-500 w-4">{i + 1}</span>
                    {r.invoice ? (
                      <span className="truncate font-semibold text-emerald-800">{r.invoice.name}</span>
                    ) : (
                      <label className="cursor-pointer text-emerald-600 hover:underline">
                        + Subir factura venta
                        <input type="file" accept={ACCEPT} onChange={e => { if (e.target.files?.[0]) toRow(r, [e.target.files[0]], 'invoice'); }} className="hidden" />
                      </label>
                    )}
                    {r.attachments.length > 0 && (
                      <span className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                        +{r.attachments.length} adjuntos
                      </span>
                    )}
                  </div>
                  <button onClick={() => setRows(l => l.filter(x => x.id !== r.id))} className="text-gray-400 hover:text-red-500"><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between pt-2 border-t border-gray-200 mt-2">
            <button onClick={() => setRows(l => [...l, emptyRow()])} className="text-xs font-semibold text-emerald-700 hover:underline flex items-center gap-1">
              <Plus size={13} /> Añadir otra fila
            </button>
            {rows.some(r => r.invoice) && (
              <button
                onClick={processRows}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm flex items-center gap-1.5"
              >
                <ScanText size={13} /> Procesar ({rows.filter(r => r.invoice).length})
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Lista de documentos procesados */}
      {docs.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={docs.length > 0 && docs.every(d => selected.has(d.file))}
                onChange={selectAll}
                className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
              />
              <span className="text-sm font-semibold text-gray-700">
                {selected.size} de {docs.length} seleccionados
              </span>
            </div>
            {selected.size > 0 && (
              <button
                onClick={createAll}
                className="px-4 py-2 rounded-lg text-xs font-bold bg-emerald-600 hover:bg-emerald-700 text-white shadow-md flex items-center gap-2"
              >
                <FileCheck size={14} /> Crear seleccionados en Business Central
              </button>
            )}
          </div>

          {docs.map(d => {
            const f = forms[d.file];
            const s = status[d.file] || {};
            const isSelected = selected.has(d.file);
            const isCredit = f?.documentType === 'credit_note';
            const isViewing = viewing[d.file];
            const previewUrl = previewUrls[d.file];

            // Colores condicionales según sea FACTURA DE VENTA o ABONO DE VENTA
            const cardBorder = isCredit ? 'border-rose-300' : 'border-emerald-200';
            const cardBg = isCredit ? 'bg-rose-50/20' : 'bg-white';
            const badgeClass = isCredit
              ? 'bg-rose-100 text-rose-800 border-rose-200 font-bold'
              : 'bg-emerald-100 text-emerald-800 border-emerald-200 font-bold';

            return (
              <div
                key={d.file}
                className={`border rounded-xl shadow-sm transition-all overflow-hidden ${cardBorder} ${cardBg} ${
                  s.created ? 'opacity-90 bg-gray-50/80 border-gray-200' : ''
                }`}
              >
                {/* Cabecera del documento */}
                <div className={`p-4 flex flex-wrap items-center justify-between gap-3 border-b ${isCredit ? 'border-rose-100 bg-rose-50/40' : 'border-emerald-100/60 bg-emerald-50/20'}`}>
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={!!s.created}
                      onChange={() => setSelected(prev => {
                        const n = new Set(prev);
                        if (n.has(d.file)) n.delete(d.file); else n.add(d.file);
                        return n;
                      })}
                      className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                    />
                    <div className="flex items-center gap-2">
                      <span className={`px-2.5 py-1 rounded-md text-xs border flex items-center gap-1.5 ${badgeClass}`}>
                        {isCredit ? <RotateCcw size={12} /> : <TrendingUp size={12} />}
                        {isCredit ? 'Abono de venta' : 'Factura de venta'}
                      </span>
                      <span className="font-bold text-gray-900 text-sm truncate max-w-md">{d.file}</span>
                      {d.currency && (
                        <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-gray-100 text-gray-700">
                          {d.currency}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => preview(d.file)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-medium border flex items-center gap-1 transition-colors ${
                        isViewing ? 'bg-emerald-100 border-emerald-300 text-emerald-800' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      {isViewing ? <EyeOff size={13} /> : <Eye size={13} />}
                      {isViewing ? 'Ocultar PDF' : 'Ver PDF'}
                    </button>
                    {previewUrl && (
                      <a href={previewUrl} target="_blank" rel="noopener noreferrer" className="p-1 text-gray-400 hover:text-gray-600" title="Abrir en pestaña nueva">
                        <ExternalLink size={14} />
                      </a>
                    )}
                    <button onClick={() => remove(d.file)} className="p-1 text-gray-400 hover:text-red-600" title="Eliminar documento">
                      <X size={16} />
                    </button>
                  </div>
                </div>

                {/* Mensajes de estado, avisos o duplicados */}
                {d.error && (
                  <div className="p-3 bg-red-50 text-red-800 text-xs border-b border-red-200 flex items-center gap-2">
                    <AlertCircle size={14} className="shrink-0 text-red-600" />
                    <span>{d.error}</span>
                  </div>
                )}
                {s.error && (
                  <div className="p-3 bg-red-50 text-red-800 text-xs border-b border-red-200 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <AlertCircle size={14} className="shrink-0 text-red-600" />
                      <span>{s.error}</span>
                    </div>
                    {s.error.includes('Ya existe') && (
                      <button
                        onClick={() => create(d.file, true)}
                        className="px-2.5 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-[11px] font-bold"
                      >
                        Crear de todas formas
                      </button>
                    )}
                  </div>
                )}
                {s.created && (
                  <div className="p-3 bg-emerald-50 text-emerald-900 text-xs border-b border-emerald-200 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 size={16} className="text-emerald-600" />
                      <span>
                        <strong>¡Creado con éxito en Business Central!</strong> Nº de documento:{' '}
                        <strong className="font-mono text-sm">{s.created.no}</strong>
                        {s.created.total != null && ` · Total: ${fmt(s.created.total)} ${s.created.currency}`}
                      </span>
                    </div>
                    <DocPdfLink documentNo={s.created.no} kind={isCredit ? 'salesCrMemo' : 'salesInv'} />
                  </div>
                )}
                {d.warnings.length > 0 && !s.created && (
                  <div className="p-2.5 bg-amber-50 text-amber-900 text-xs border-b border-amber-200 space-y-1">
                    {d.warnings.map((w, idx) => (
                      <div key={idx} className="flex items-center gap-1.5">
                        <AlertCircle size={13} className="shrink-0 text-amber-600" />
                        <span>{w}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Contenido dividido: Visualizador PDF (izquierda) + Formulario editable (derecha) */}
                <div className={`p-4 grid gap-6 ${isViewing ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1'}`}>
                  {/* Visor de PDF */}
                  {isViewing && previewUrl && (
                    <div className="border border-gray-200 rounded-xl overflow-hidden bg-gray-100 h-[650px] flex flex-col">
                      <div className="px-3 py-1.5 bg-gray-200 text-gray-700 text-xs font-semibold flex items-center justify-between border-b border-gray-300">
                        <span className="truncate">{d.file}</span>
                        <a href={previewUrl} target="_blank" rel="noopener noreferrer" className="hover:underline flex items-center gap-1 text-emerald-800">
                          Abrir grande <ExternalLink size={11} />
                        </a>
                      </div>
                      <iframe src={previewUrl} className="w-full h-full border-none" title={`Vista previa de ${d.file}`} />
                    </div>
                  )}

                  {/* Formulario de Factura / Abono de Venta */}
                  {f && (
                    <div className="space-y-4">
                      {/* Selector de Cliente */}
                      <CustomerPicker
                        d={d}
                        onCustomer={cNo => setCustomerFor(d.file, cNo)}
                      />

                      {/* Cabecera del documento */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-gray-50/80 p-3 rounded-xl border border-gray-200">
                        <div>
                          <label className="text-[11px] font-semibold text-gray-500 uppercase block mb-1">
                            Tipo de documento
                          </label>
                          <select
                            value={f.documentType}
                            onChange={e => setField(d.file, 'documentType', e.target.value)}
                            className={`${input} w-full text-xs font-semibold ${isCredit ? 'text-rose-700 border-rose-300' : 'text-emerald-800 border-emerald-300'}`}
                          >
                            <option value="invoice">Factura de venta</option>
                            <option value="credit_note">Abono de venta (Rectificativa)</option>
                          </select>
                        </div>
                        <div>
                          <label className="text-[11px] font-semibold text-gray-500 uppercase block mb-1">
                            Nº Factura / Doc.
                          </label>
                          <input
                            type="text"
                            value={f.invoiceNo}
                            onChange={e => setField(d.file, 'invoiceNo', e.target.value)}
                            placeholder="FV24-0001"
                            className={`${input} w-full font-mono text-xs`}
                          />
                        </div>
                        <div>
                          <label className="text-[11px] font-semibold text-gray-500 uppercase block mb-1">
                            Fecha Factura
                          </label>
                          <input
                            type="date"
                            value={f.invoiceDate}
                            onChange={e => setField(d.file, 'invoiceDate', e.target.value)}
                            className={`${input} w-full text-xs`}
                          />
                        </div>
                        <div>
                          <label className="text-[11px] font-semibold text-gray-500 uppercase block mb-1">
                            Fecha Registro
                          </label>
                          <input
                            type="date"
                            value={f.postingDate}
                            onChange={e => setField(d.file, 'postingDate', e.target.value)}
                            className={`${input} w-full text-xs`}
                          />
                        </div>
                        <div className="sm:col-span-2">
                          <label className="text-[11px] font-semibold text-gray-500 uppercase block mb-1">
                            Fecha Vencimiento
                          </label>
                          <input
                            type="date"
                            value={f.dueDate}
                            onChange={e => setField(d.file, 'dueDate', e.target.value)}
                            className={`${input} w-full text-xs`}
                          />
                        </div>
                        <div className="sm:col-span-2">
                          <label className="text-[11px] font-semibold text-gray-500 uppercase block mb-1">
                            Descripción de Registro (Posting Desc.)
                          </label>
                          <input
                            type="text"
                            value={f.postingDescription}
                            onChange={e => setField(d.file, 'postingDescription', e.target.value)}
                            placeholder={isCredit ? `Abono Venta ${f.invoiceNo}` : `Factura Venta ${f.invoiceNo}`}
                            className={`${input} w-full text-xs`}
                          />
                        </div>
                      </div>

                      {/* Tabla de Líneas de Venta */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <label className="text-xs font-bold text-gray-700 uppercase tracking-wider flex items-center gap-1.5">
                            Líneas de la factura de venta
                          </label>
                          <button
                            type="button"
                            onClick={() => addLine(d.file)}
                            className="text-xs text-emerald-700 hover:text-emerald-900 font-semibold flex items-center gap-1"
                          >
                            <Plus size={13} /> Añadir línea
                          </button>
                        </div>

                        <div className="border border-gray-200 rounded-xl overflow-x-auto bg-white">
                          <table className="w-full text-left text-xs border-collapse">
                            <thead>
                              <tr className="bg-gray-50 border-b border-gray-200 text-gray-500 font-semibold text-[11px]">
                                <th className="p-2 w-24">Tipo</th>
                                <th className="p-2 w-48">Nº</th>
                                <th className="p-2 min-w-[200px]">Descripción</th>
                                <th className="p-2 w-20 text-right">Cant.</th>
                                <th className="p-2 w-24 text-right">Precio Unit.</th>
                                <th className="p-2 w-24 text-right">Neto Línea</th>
                                <th className="p-2 w-24">Grupo IVA</th>
                                <th className="p-2 w-24 text-right">IVA</th>
                                <th className="p-2 w-8"></th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                              {f.lines.map((l, i) => {
                                const qty = toNum(l.quantity);
                                const price = toNum(l.unitCost);
                                const netLine = Math.round(qty * price * 100) / 100;
                                const isItem = l.lineType === 'Item';

                                const updateVat = (qVal: string, cVal: string, tCode: string) => {
                                  const qn = toNum(qVal), cn = toNum(cVal);
                                  const net = qn * cn;
                                  const grp = taxGroups.find(t => t.code === tCode);
                                  const rate = grp ? grp.rate : (tCode === 'IVA21' ? 0.21 : tCode === 'IVA10' ? 0.10 : tCode === 'IVA4' ? 0.04 : 0);
                                  const newVat = d.suggestion?.isReverseCharge ? 0 : Math.round(net * rate * 100) / 100;
                                  setLine(d.file, i, 'vatAmount', toText(newVat));
                                };

                                return (
                                  <tr key={i} className="hover:bg-gray-50/60">
                                    <td className="p-1.5">
                                      <select
                                        value={l.lineType}
                                        onChange={e => {
                                          const nextType = e.target.value;
                                          setLine(d.file, i, 'lineType', nextType);
                                          if (nextType === 'Account' && !l.number) {
                                            setLine(d.file, i, 'number', '70000000');
                                          }
                                        }}
                                        className="border border-gray-200 rounded px-1.5 py-1 text-xs w-full bg-white"
                                      >
                                        {LINE_TYPES.map(t => (
                                          <option key={t} value={t}>{t === 'Account' ? 'Cuenta (G/L)' : t === 'Item' ? 'Artículo' : t}</option>
                                        ))}
                                      </select>
                                    </td>
                                    <td className="p-1.5">
                                      {isItem ? (
                                        <ItemCombobox
                                          value={l.number}
                                          items={items}
                                          loading={loadingItems}
                                          onChange={(num, name, tCode) => {
                                            setLine(d.file, i, 'number', num);
                                            if (name) setLine(d.file, i, 'description', name);
                                            if (tCode) {
                                              setLine(d.file, i, 'taxCode', tCode);
                                              updateVat(l.quantity, l.unitCost, tCode);
                                            }
                                          }}
                                          className="w-full"
                                        />
                                      ) : l.lineType === 'Account' ? (
                                        <AccountCombobox
                                          value={l.number}
                                          accounts={accounts}
                                          loading={loadingAccounts}
                                          onChange={(num, name, tCode) => {
                                            setLine(d.file, i, 'number', num);
                                            if (name) setLine(d.file, i, 'description', name);
                                            if (tCode) {
                                              setLine(d.file, i, 'taxCode', tCode);
                                              updateVat(l.quantity, l.unitCost, tCode);
                                            }
                                          }}
                                          className="w-full"
                                        />
                                      ) : (
                                        <input
                                          value={l.number}
                                          onChange={e => setLine(d.file, i, 'number', e.target.value)}
                                          className="border border-gray-200 rounded px-1.5 py-1 text-xs w-full font-mono"
                                          placeholder="Nº objeto"
                                        />
                                      )}
                                    </td>
                                    <td className="p-1.5">
                                      <input
                                        value={l.description}
                                        onChange={e => setLine(d.file, i, 'description', e.target.value)}
                                        className="border border-gray-200 rounded px-2 py-1 text-xs w-full"
                                        placeholder="Descripción de la venta"
                                      />
                                    </td>
                                    <td className="p-1.5">
                                      <input
                                        value={l.quantity}
                                        onChange={e => {
                                          setLine(d.file, i, 'quantity', e.target.value);
                                          updateVat(e.target.value, l.unitCost, l.taxCode);
                                        }}
                                        className="border border-gray-200 rounded px-1.5 py-1 text-xs w-full text-right font-mono"
                                      />
                                    </td>
                                    <td className="p-1.5">
                                      <input
                                        value={l.unitCost}
                                        onChange={e => {
                                          setLine(d.file, i, 'unitCost', e.target.value);
                                          updateVat(l.quantity, e.target.value, l.taxCode);
                                        }}
                                        className="border border-gray-200 rounded px-1.5 py-1 text-xs w-full text-right font-mono"
                                      />
                                    </td>
                                    <td className="p-1.5 text-right font-mono font-medium text-gray-800">
                                      {fmt(netLine)}
                                    </td>
                                    <td className="p-1.5">
                                      <select
                                        value={l.taxCode}
                                        onChange={e => {
                                          const code = e.target.value;
                                          setLine(d.file, i, 'taxCode', code);
                                          updateVat(l.quantity, l.unitCost, code);
                                        }}
                                        className="border border-gray-200 rounded px-1.5 py-1 text-xs w-full bg-white"
                                      >
                                        {taxGroups.map(tg => (
                                          <option key={tg.code} value={tg.code}>{tg.code}</option>
                                        ))}
                                      </select>
                                    </td>
                                    <td className="p-1.5">
                                      <input
                                        value={l.vatAmount}
                                        onChange={e => setLine(d.file, i, 'vatAmount', e.target.value)}
                                        className="border border-gray-200 rounded px-1.5 py-1 text-xs w-full text-right font-mono"
                                      />
                                    </td>
                                    <td className="p-1.5 text-center">
                                      {f.lines.length > 1 && (
                                        <button onClick={() => removeLine(d.file, i)} className="text-gray-400 hover:text-red-500">
                                          <Trash2 size={13} />
                                        </button>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      {/* Resumen de totales del formulario */}
                      {(() => {
                        const sumNet = f.lines.filter(l => l.lineType !== 'Comment').reduce((acc, l) => acc + (toNum(l.quantity) * toNum(l.unitCost)), 0);
                        const sumVat = f.lines.filter(l => l.lineType !== 'Comment').reduce((acc, l) => acc + toNum(l.vatAmount), 0);
                        const totalDoc = Math.round((sumNet + sumVat) * 100) / 100;
                        const matchPdf = d.suggestion?.total != null && Math.abs(totalDoc - Math.abs(d.suggestion.total)) < 0.05;

                        return (
                          <div className={`p-3 rounded-xl border flex flex-wrap items-center justify-between gap-3 text-xs ${
                            isCredit ? 'bg-rose-50 border-rose-200' : 'bg-emerald-50/60 border-emerald-200'
                          }`}>
                            <div className="flex items-center gap-4 font-medium">
                              <span>Neto líneas: <strong>{fmt(sumNet)} {d.currency}</strong></span>
                              <span>+ IVA: <strong>{fmt(sumVat)} {d.currency}</strong></span>
                              <span className="text-sm font-bold text-gray-900">
                                = Total {isCredit ? 'Abono' : 'Factura'}: {fmt(totalDoc)} {d.currency}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              {d.suggestion?.total != null && (
                                <span className={`px-2 py-0.5 rounded text-[11px] font-semibold border flex items-center gap-1 ${
                                  matchPdf ? 'bg-emerald-100 text-emerald-800 border-emerald-300' : 'bg-amber-100 text-amber-800 border-amber-300'
                                }`}>
                                  {matchPdf ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                                  {matchPdf ? `Coincide con total PDF (${fmt(d.suggestion.total)} ${d.currency})` : `Total PDF: ${fmt(d.suggestion.total)} ${d.currency}`}
                                </span>
                              )}
                              {!s.created && (
                                <button
                                  type="button"
                                  disabled={s.saving}
                                  onClick={() => create(d.file)}
                                  className={`px-4 py-2 rounded-lg text-xs font-bold text-white shadow-md flex items-center gap-1.5 transition-all ${
                                    isCredit ? 'bg-rose-600 hover:bg-rose-700 shadow-rose-200' : 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-200'
                                  }`}
                                >
                                  {s.saving ? <RefreshCw size={13} className="animate-spin" /> : isCredit ? <RotateCcw size={13} /> : <FileCheck size={13} />}
                                  {isCredit ? 'Enviar Abono Venta a BC' : 'Enviar Factura Venta a BC'}
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })()}

                      {/* Comentario de la propuesta */}
                      {d.suggestion?.comment && (
                        <div className="text-xs text-gray-500 italic px-1">
                          Propuesta: {d.suggestion.comment}
                        </div>
                      )}

                      {/* Histórico de Posted Sales Lines de este cliente */}
                      {d.history && d.history.length > 0 && (
                        <details className="text-xs border border-gray-200 rounded-xl bg-gray-50/50 p-3">
                          <summary className="cursor-pointer font-semibold text-gray-700 flex items-center justify-between">
                            <span className="flex items-center gap-1.5">
                              <Receipt size={14} className="text-emerald-700" />
                              Últimas ventas de {d.customer?.name} ({d.history.length} registradas en BC · Posted Sales Lines)
                            </span>
                            <span className="text-[11px] text-gray-400">Ver líneas anteriores</span>
                          </summary>
                          <div className="mt-3 space-y-2 max-h-60 overflow-y-auto">
                            {d.history.map(h => (
                              <div key={h.number} className="bg-white p-2.5 rounded-lg border border-gray-200 text-xs">
                                <div className="flex items-center justify-between font-semibold mb-1 text-gray-700">
                                  <span>{h.number} · {h.vendorInvoiceNumber} ({h.postingDate || h.invoiceDate})</span>
                                  <span className="font-mono text-emerald-800">{fmt(h.total)} {h.currency}</span>
                                </div>
                                <div className="space-y-1">
                                  {h.lines.map((hl, hidx) => (
                                    <div key={hidx} className="flex items-center justify-between text-gray-500 text-[11px] pl-2 border-l-2 border-gray-200">
                                      <span className="truncate max-w-md">{hl.lineType} · {hl.number} - {hl.description}</span>
                                      <div className="flex items-center gap-2 font-mono">
                                        <span>{hl.quantity} uds x {fmt(hl.unitCost)} {h.currency}</span>
                                        <button
                                          type="button"
                                          onClick={() => addLine(d.file, hl)}
                                          className="text-emerald-600 hover:underline font-semibold ml-2"
                                        >
                                          + copiar línea
                                        </button>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CustomerPicker({ d, onCustomer }: { d: Doc; onCustomer: (no: string) => void }) {
  const [term, setTerm] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<CustomerCandidate[]>([]);

  const search = async () => {
    if (!term.trim()) return;
    setSearching(true);
    try {
      const res = await fetch(`/api/ocr-ventas/customers?q=${encodeURIComponent(term.trim())}`);
      const json = await res.json();
      setResults(json.customers || []);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-3 bg-white p-3 rounded-xl border border-gray-200 shadow-sm">
      <div className="flex-1 min-w-[280px]">
        <label className="text-xs font-bold text-gray-700 uppercase tracking-wider block mb-1">
          Cliente (Customer)
        </label>
        <select
          value={d.customer?.number || ''}
          onChange={e => onCustomer(e.target.value)}
          className={`${input} w-full text-xs font-medium`}
        >
          {!d.customer && <option value="">— Selecciona un cliente —</option>}
          {d.customer && !d.candidates.some(c => c.number === d.customer!.number) && (
            <option value={d.customer.number}>{d.customer.number} · {d.customer.name}</option>
          )}
          {d.candidates.map(c => (
            <option key={c.number} value={c.number}>
              {c.number} · {c.name} ({c.currency}, {c.invoices} ventas/año) — {c.reasons.join(', ')}
            </option>
          ))}
          {results.filter(r => r.number !== d.customer?.number && !d.candidates.some(c => c.number === r.number)).map(r => (
            <option key={r.number} value={r.number}>
              {r.number} · {r.name} ({r.currency}, {r.invoices} ventas/año)
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-1.5">
        <input
          value={term}
          onChange={e => setTerm(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && search()}
          placeholder="Buscar cliente en BC (nº o nombre)"
          className={`${input} w-60 text-xs`}
        />
        <button
          type="button"
          onClick={search}
          disabled={searching}
          className="p-2 rounded-lg border border-gray-300 bg-gray-50 hover:bg-gray-100 text-gray-700"
          title="Buscar en BC"
        >
          {searching ? <RefreshCw size={13} className="animate-spin" /> : <Search size={13} />}
        </button>
      </div>

      {results.length > 0 && (
        <span className="text-xs text-emerald-700 font-medium">
          {results.length} clientes encontrados: selecciónalo en el menú desplegable.
        </span>
      )}
    </div>
  );
}
