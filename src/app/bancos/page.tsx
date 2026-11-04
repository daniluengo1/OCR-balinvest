'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  Landmark,
  Upload,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  FileSpreadsheet,
  Download,
  Search,
  Filter,
  ArrowUpRight,
  ArrowDownLeft,
  X,
  FileText,
  Send,
  Building2,
  Calendar,
  Layers
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { useCompany } from '@/contexts/CompanyContext';
import { BcBankAccount, BcJournalBatch, ReconciledMovement } from '@/lib/bcBankReconcile';

export default function BancosPage() {
  const { selectedCompany } = useCompany();

  // Estados de Business Central
  const [bankAccounts, setBankAccounts] = useState<BcBankAccount[]>([]);
  const [journalBatches, setJournalBatches] = useState<BcJournalBatch[]>([]);
  const [selectedBankAccount, setSelectedBankAccount] = useState('');
  const [selectedJournalBatch, setSelectedJournalBatch] = useState('');
  const [loadingBc, setLoadingBc] = useState(true);

  // Archivo de extracto
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Conciliación
  const [analyzing, setAnalyzing] = useState(false);
  const [reconcileResult, setReconcileResult] = useState<{
    summaryText: string;
    counts: { toRegister: number; inBatch: number; postedInBc: number; total: number };
    movements: ReconciledMovement[];
    currencyCode: string;
  } | null>(null);

  // Pestaña activa: TO_REGISTER, IN_BATCH, POSTED_IN_BC, ALL
  const [activeTab, setActiveTab] = useState<'TO_REGISTER' | 'IN_BATCH' | 'POSTED_IN_BC' | 'ALL'>('ALL');
  const [search, setSearch] = useState('');
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Cargar cuentas bancarias y lotes de Business Central
  const loadBcData = async () => {
    setLoadingBc(true);
    try {
      const res = await fetch(`/api/bancos/bc-reconcile?company=${encodeURIComponent(selectedCompany || '')}`);
      const data = await res.json();
      if (data.ok) {
        setBankAccounts(data.bankAccounts || []);
        setJournalBatches(data.journalBatches || []);

        if (data.bankAccounts?.length > 0 && !selectedBankAccount) {
          setSelectedBankAccount(data.bankAccounts[0].number);
        }
        if (data.journalBatches?.length > 0 && !selectedJournalBatch) {
          setSelectedJournalBatch(data.journalBatches[0].id);
        }
      }
    } catch (err) {
      console.error('Error al cargar datos de BC:', err);
    } finally {
      setLoadingBc(false);
    }
  };

  useEffect(() => {
    loadBcData();
  }, [selectedCompany]);

  // Ejecutar Conciliación inteligente
  const handleAnalyze = async () => {
    if (!file) {
      setStatusMessage({ type: 'error', text: 'Por favor, selecciona un archivo de extracto bancario (CSV o Excel).' });
      return;
    }

    setAnalyzing(true);
    setStatusMessage(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('bankAccount', selectedBankAccount);
    formData.append('journalBatch', selectedJournalBatch);
    if (selectedCompany && selectedCompany !== 'ALL') {
      formData.append('company', selectedCompany);
    }

    try {
      const res = await fetch('/api/bancos/bc-reconcile', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (data.ok && data.result) {
        setReconcileResult(data.result);
        setStatusMessage({
          type: 'success',
          text: `Análisis completado: ${data.result.counts.total} movimientos procesados contra Business Central.`,
        });
        // Si hay pendientes por registrar, poner el foco en esa pestaña
        if (data.result.counts.toRegister > 0) {
          setActiveTab('TO_REGISTER');
        } else {
          setActiveTab('ALL');
        }
      } else {
        setStatusMessage({ type: 'error', text: data.error || 'Error al analizar el extracto bancario.' });
      }
    } catch (e: any) {
      setStatusMessage({ type: 'error', text: e.message || 'Error de conexión al conciliar con Business Central.' });
    } finally {
      setAnalyzing(false);
    }
  };

  // Filtrar movimientos según la pestaña activa y la búsqueda
  const filteredMovements = (reconcileResult?.movements || []).filter((m) => {
    if (activeTab === 'TO_REGISTER' && m.status !== 'TO_REGISTER') return false;
    if (activeTab === 'IN_BATCH' && m.status !== 'IN_BATCH') return false;
    if (activeTab === 'POSTED_IN_BC' && m.status !== 'POSTED_IN_BC') return false;

    if (search) {
      const term = search.toLowerCase();
      const matchDesc = m.description.toLowerCase().includes(term);
      const matchDoc = (m.matchedDocNo || '').toLowerCase().includes(term);
      const matchLine = (m.matchedLineDetail || '').toLowerCase().includes(term);
      if (!matchDesc && !matchDoc && !matchLine) return false;
    }
    return true;
  });

  const formatCurrency = (val: number, curr = 'EUR') => {
    return new Intl.NumberFormat('es-ES', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(val);
  };

  const handleExportExcel = () => {
    if (!reconcileResult || reconcileResult.movements.length === 0) return;

    const dataToExport = filteredMovements.map((m) => ({
      Fecha: m.date.split('-').reverse().join('/'),
      'Concepto / Contrapartida': m.description,
      Importe: m.amount,
      Estado: m.status === 'POSTED_IN_BC' ? 'Ya en BC' : m.status === 'IN_BATCH' ? 'En el lote' : 'Por registrar',
      'Líneas del Diario': m.matchedLineDetail || '',
      'Documento BC': m.matchedDocNo || '',
    }));

    const ws = XLSX.utils.json_to_sheet(dataToExport);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Conciliacion');
    XLSX.writeFile(wb, `Conciliacion_${selectedBankAccount || 'Banco'}_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] pb-24">
      <main className="w-full px-4 lg:px-8 pt-6 space-y-5 max-w-[1850px] mx-auto">
        {/* Cabecera Principal al estilo Craze */}
        <div>
          <h1 className="text-2xl font-black text-slate-900 tracking-tight flex items-center gap-2">
            BANCO
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {selectedCompany || 'Empresa activa'} · extracto del banco → General Journal
          </p>
        </div>

        {/* Panel Superior de Selección y Carga */}
        <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            {/* 1. BANK ACCOUNT */}
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                BANK ACCOUNT
              </label>
              {loadingBc ? (
                <div className="h-10 bg-slate-100 rounded-xl animate-pulse"></div>
              ) : bankAccounts.length > 0 ? (
                <select
                  value={selectedBankAccount}
                  onChange={(e) => setSelectedBankAccount(e.target.value)}
                  className="w-full text-xs font-semibold border border-slate-300 rounded-xl px-3 py-2.5 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 shadow-2xs"
                >
                  {bankAccounts.map((b) => (
                    <option key={b.id} value={b.number}>
                      {b.number} · {b.name} {b.iban ? `#${b.iban}` : ''} ({b.currencyCode})
                    </option>
                  ))}
                </select>
              ) : (
                <select disabled className="w-full text-xs border border-slate-200 rounded-xl px-3 py-2.5 bg-slate-50 text-slate-400">
                  <option>01 · BANCO EMPRESA (EUR)</option>
                </select>
              )}
            </div>

            {/* 2. LOTE DEL GENERAL JOURNAL */}
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                LOTE DEL GENERAL JOURNAL
              </label>
              {loadingBc ? (
                <div className="h-10 bg-slate-100 rounded-xl animate-pulse"></div>
              ) : journalBatches.length > 0 ? (
                <select
                  value={selectedJournalBatch}
                  onChange={(e) => setSelectedJournalBatch(e.target.value)}
                  className="w-full text-xs font-semibold border border-slate-300 rounded-xl px-3 py-2.5 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500 shadow-2xs"
                >
                  {journalBatches.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.code} · {j.name} {j.balAccountNumber ? `→ ${j.balAccountNumber}` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <select disabled className="w-full text-xs border border-slate-200 rounded-xl px-3 py-2.5 bg-slate-50 text-slate-400">
                  <option>MENSUAL · Entradas de diario mensuales → 01</option>
                </select>
              )}
            </div>

            {/* 3. EXTRACTO (CSV O EXCEL) */}
            <div>
              <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                EXTRACTO (CSV O EXCEL)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={(e) => {
                    if (e.target.files?.[0]) {
                      setFile(e.target.files[0]);
                    }
                  }}
                  accept=".csv,.xlsx,.xls,.n43,.txt"
                  className="hidden"
                />

                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="flex-1 flex items-center justify-between border border-slate-300 rounded-xl px-3 py-2 bg-slate-50 hover:bg-slate-100/80 cursor-pointer text-xs transition-all shadow-2xs"
                >
                  {file ? (
                    <span className="flex items-center gap-1.5 font-mono text-indigo-700 font-semibold truncate">
                      <FileSpreadsheet size={15} className="shrink-0 text-indigo-600" />
                      <span className="truncate">{file.name}</span>
                    </span>
                  ) : (
                    <span className="text-slate-400 flex items-center gap-1.5">
                      <Upload size={14} /> Seleccionar archivo...
                    </span>
                  )}
                  {file && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFile(null);
                        if (fileInputRef.current) fileInputRef.current.value = '';
                      }}
                      className="text-slate-400 hover:text-red-500 p-0.5 ml-2"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Botón Analizar */}
          <div className="pt-2 flex items-center justify-between border-t border-slate-100">
            <button
              onClick={handleAnalyze}
              disabled={analyzing || !file}
              className="inline-flex items-center gap-2 bg-slate-900 hover:bg-black text-white text-xs font-bold px-5 py-2.5 rounded-xl shadow-xs transition-all disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
            >
              {analyzing ? <RefreshCw size={14} className="animate-spin text-white" /> : <Upload size={14} />}
              <span>{analyzing ? 'Analizando con Business Central...' : 'Analizar'}</span>
            </button>

            {reconcileResult && (
              <button
                onClick={handleExportExcel}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 px-3 py-1.5 rounded-lg shadow-2xs"
              >
                <Download size={13} /> Exportar Excel
              </button>
            )}
          </div>
        </div>

        {/* Notificación de Estado */}
        {statusMessage && (
          <div
            className={`p-3 rounded-xl flex items-start gap-2.5 text-xs font-medium border ${
              statusMessage.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-rose-50 border-rose-200 text-rose-900'
            }`}
          >
            {statusMessage.type === 'success' ? (
              <CheckCircle2 size={16} className="text-emerald-600 shrink-0 mt-0.5" />
            ) : (
              <AlertCircle size={16} className="text-rose-600 shrink-0 mt-0.5" />
            )}
            <span className="flex-1">{statusMessage.text}</span>
            <button onClick={() => setStatusMessage(null)} className="text-slate-400 hover:text-slate-600">
              <X size={14} />
            </button>
          </div>
        )}

        {/* Pestañas de Estado con Contadores y Resumen de Cuadre */}
        {reconcileResult && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-4">
              {/* Tabs */}
              <div className="flex items-center bg-slate-200/80 p-1 rounded-xl text-xs font-bold text-slate-600">
                <button
                  onClick={() => setActiveTab('TO_REGISTER')}
                  className={`px-3.5 py-1.5 rounded-lg transition-all ${
                    activeTab === 'TO_REGISTER' ? 'bg-white text-slate-900 shadow-xs' : 'hover:text-slate-900'
                  }`}
                >
                  Por registrar{' '}
                  <span className="ml-1 font-mono text-[11px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">
                    {reconcileResult.counts.toRegister}
                  </span>
                </button>

                <button
                  onClick={() => setActiveTab('IN_BATCH')}
                  className={`px-3.5 py-1.5 rounded-lg transition-all ${
                    activeTab === 'IN_BATCH' ? 'bg-white text-slate-900 shadow-xs' : 'hover:text-slate-900'
                  }`}
                >
                  En el lote{' '}
                  <span className="ml-1 font-mono text-[11px] text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-200">
                    {reconcileResult.counts.inBatch}
                  </span>
                </button>

                <button
                  onClick={() => setActiveTab('POSTED_IN_BC')}
                  className={`px-3.5 py-1.5 rounded-lg transition-all ${
                    activeTab === 'POSTED_IN_BC' ? 'bg-white text-slate-900 shadow-xs' : 'hover:text-slate-900'
                  }`}
                >
                  Ya en BC{' '}
                  <span className="ml-1 font-mono text-[11px] text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200">
                    {reconcileResult.counts.postedInBc}
                  </span>
                </button>

                <button
                  onClick={() => setActiveTab('ALL')}
                  className={`px-3.5 py-1.5 rounded-lg transition-all ${
                    activeTab === 'ALL' ? 'bg-white text-slate-900 shadow-xs' : 'hover:text-slate-900'
                  }`}
                >
                  Todos{' '}
                  <span className="ml-1 font-mono text-[11px] text-slate-700 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-300">
                    {reconcileResult.counts.total}
                  </span>
                </button>
              </div>

              {/* Búsqueda rápida */}
              <div className="relative w-72">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filtrar por concepto o documento..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 shadow-2xs"
                />
              </div>
            </div>

            {/* Subtítulo de cuadre */}
            <p className="text-xs text-slate-500 font-medium">{reconcileResult.summaryText}</p>
          </div>
        )}

        {/* Tabla de Conciliación Bancaria */}
        <div className="bg-white rounded-2xl border border-slate-200/90 shadow-xs overflow-hidden">
          <div className="overflow-x-auto w-full">
            <table className="w-full text-xs min-w-[900px] divide-y divide-slate-100">
              <thead className="bg-slate-50/80 text-slate-400 uppercase tracking-wider font-bold text-[10px]">
                <tr>
                  <th className="py-3 px-4 text-left w-36">FECHA</th>
                  <th className="py-3 px-4 text-left">CONTRAPARTIDA / CONCEPTO</th>
                  <th className="py-3 px-4 text-right w-36">IMPORTE</th>
                  <th className="py-3 px-4 text-left w-96">LÍNEAS DEL DIARIO</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {!reconcileResult ? (
                  <tr>
                    <td colSpan={4} className="py-16 text-center text-slate-400">
                      <Landmark size={36} className="mx-auto mb-3 text-slate-300 stroke-1" />
                      <p className="font-semibold text-slate-700 text-sm">Carga un extracto y pulsa en "Analizar"</p>
                      <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
                        Se cruzarán automáticamente los movimientos contra el libro mayor (Bank Ledger Entries) y el lote del General Journal de Business Central.
                      </p>
                    </td>
                  </tr>
                ) : filteredMovements.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-12 text-center text-slate-400">
                      No hay movimientos en la categoría seleccionada ({activeTab}).
                    </td>
                  </tr>
                ) : (
                  filteredMovements.map((m, idx) => {
                    const isPositive = m.amount > 0;
                    return (
                      <tr key={idx} className="hover:bg-slate-50/70 transition-colors">
                        {/* FECHA */}
                        <td className="py-3.5 px-4 font-mono font-medium text-slate-800 whitespace-nowrap align-top">
                          <div>{m.date.split('-').reverse().join('.')}</div>
                          {m.status === 'POSTED_IN_BC' && (
                            <span className="text-[10px] text-emerald-600 font-sans block mt-0.5 font-normal">
                              contabilizado
                            </span>
                          )}
                          {m.status === 'IN_BATCH' && (
                            <span className="text-[10px] text-blue-600 font-sans block mt-0.5 font-normal">
                              en borrador
                            </span>
                          )}
                          {m.status === 'TO_REGISTER' && (
                            <span className="text-[10px] text-amber-600 font-sans block mt-0.5 font-normal">
                              pendiente
                            </span>
                          )}
                        </td>

                        {/* CONTRAPARTIDA / CONCEPTO */}
                        <td className="py-3.5 px-4 align-top">
                          <p className="font-bold text-slate-900 leading-snug">{m.description.split('/')[0].trim() || m.description}</p>
                          <p className="text-[11px] text-slate-500 font-mono mt-0.5 leading-relaxed break-all">
                            {m.description}
                          </p>
                        </td>

                        {/* IMPORTE */}
                        <td className="py-3.5 px-4 text-right font-mono font-bold whitespace-nowrap align-top">
                          <span className={isPositive ? 'text-emerald-600' : 'text-slate-900'}>
                            {isPositive ? '' : ''}
                            {formatCurrency(m.amount, reconcileResult.currencyCode)}
                          </span>
                        </td>

                        {/* LÍNEAS DEL DIARIO */}
                        <td className="py-3.5 px-4 text-xs font-mono align-top">
                          {m.status === 'POSTED_IN_BC' ? (
                            <div className="bg-emerald-50/60 border border-emerald-200/80 rounded-lg px-2.5 py-1 text-emerald-900 text-[11px]">
                              {m.matchedLineDetail}
                            </div>
                          ) : m.status === 'IN_BATCH' ? (
                            <div className="bg-blue-50/60 border border-blue-200/80 rounded-lg px-2.5 py-1 text-blue-900 text-[11px]">
                              {m.matchedLineDetail}
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <span className="text-[11px] text-amber-800 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                                Sin conciliar en BC
                              </span>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}
