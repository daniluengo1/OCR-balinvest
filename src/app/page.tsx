'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import { FileScan, Settings, History, CheckCircle2, AlertCircle, ArrowRight, ShieldCheck, Building2, FileText } from 'lucide-react';
import { useCompany } from '@/contexts/CompanyContext';

export default function DashboardPage() {
  const { companies, selectedCompany, isLoading } = useCompany();
  const [logs, setLogs] = useState<any[]>([]);
  const [connected, setConnected] = useState<boolean>(false);

  useEffect(() => {
    fetch('/api/bc-config')
      .then((res) => res.json())
      .then((data) => {
        setConnected(data.connectionStatus === 'connected');
      })
      .catch(() => {});
  }, []);

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8">
      {/* Welcome Hero */}
      <div className="bg-gradient-to-r from-indigo-700 via-indigo-600 to-blue-600 rounded-2xl p-8 text-white shadow-lg shadow-indigo-100 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div>
          <div className="flex items-center gap-2 text-indigo-100 text-xs font-semibold uppercase tracking-wider mb-2">
            <Building2 size={14} />
            <span>{selectedCompany || 'Entorno de Producción'}</span>
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight">Plataforma de Gestión Empresarial</h1>
          <p className="text-indigo-100 text-sm mt-2 max-w-xl">
            Automatización contable inteligente conectada en tiempo real a Microsoft Dynamics 365 Business Central.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/ocr"
            className="flex items-center gap-2 bg-white text-indigo-700 hover:bg-indigo-50 font-semibold px-5 py-3 rounded-xl shadow-md transition-all text-sm"
          >
            <FileScan size={18} />
            <span>Subir Facturas OCR</span>
          </Link>
          <Link
            href="/settings"
            className="flex items-center gap-2 bg-indigo-500/40 hover:bg-indigo-500/60 text-white font-medium px-4 py-3 rounded-xl border border-white/20 transition-all text-sm"
          >
            <Settings size={18} />
            <span>Ajustes</span>
          </Link>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="bg-white p-5 rounded-xl border border-gray-200/80 shadow-sm flex items-center justify-between">
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Estado Business Central</span>
            <div className="flex items-center gap-2 mt-1">
              {connected ? (
                <>
                  <CheckCircle2 size={18} className="text-emerald-500" />
                  <span className="text-lg font-bold text-gray-800">Conectado</span>
                </>
              ) : (
                <>
                  <AlertCircle size={18} className="text-amber-500" />
                  <span className="text-lg font-bold text-amber-700">Sin credenciales</span>
                </>
              )}
            </div>
            <span className="text-[11px] text-gray-500 mt-1 block">Tenant: 325946cd-5a64...</span>
          </div>
          <div className="w-12 h-12 rounded-xl bg-indigo-50 flex items-center justify-center text-indigo-600">
            <ShieldCheck size={24} />
          </div>
        </div>

        <div className="bg-white p-5 rounded-xl border border-gray-200/80 shadow-sm flex items-center justify-between">
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Empresas Detectadas</span>
            <div className="text-lg font-bold text-gray-800 mt-1">
              {companies.length > 0 ? `${companies.length} empresa(s)` : '0 configuradas'}
            </div>
            <span className="text-[11px] text-gray-500 mt-1 block">
              {selectedCompany ? `Activa: ${selectedCompany}` : 'Configura en Ajustes'}
            </span>
          </div>
          <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600">
            <Building2 size={24} />
          </div>
        </div>

        <div className="bg-white p-5 rounded-xl border border-gray-200/80 shadow-sm flex items-center justify-between">
          <div>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Módulo Activo</span>
            <div className="text-lg font-bold text-gray-800 mt-1">OCR Facturación</div>
            <span className="text-[11px] text-gray-500 mt-1 block">Extracción inteligente de PDFs y Outlook</span>
          </div>
          <div className="w-12 h-12 rounded-xl bg-purple-50 flex items-center justify-center text-purple-600">
            <FileScan size={24} />
          </div>
        </div>
      </div>

      {/* Main Feature Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white border border-gray-200/80 rounded-xl p-6 shadow-sm flex flex-col justify-between">
          <div>
            <div className="w-10 h-10 rounded-lg bg-indigo-100/70 text-indigo-700 flex items-center justify-center mb-4">
              <FileScan size={22} />
            </div>
            <h3 className="text-base font-bold text-gray-900">OCR de Facturas de Proveedores</h3>
            <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">
              Arrastra facturas en formato PDF o correos de Outlook (.msg, .eml). El sistema identifica el CIF/NIF del proveedor, busca en el histórico de Business Central y propone las líneas y cuentas contables para registrar la factura de compra directamente en tu entorno.
            </p>
          </div>
          <div className="mt-5 pt-4 border-t border-gray-100 flex items-center justify-between">
            <span className="text-xs text-indigo-600 font-semibold">Procesar facturas</span>
            <Link href="/ocr" className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:text-indigo-800">
              <span>Abrir OCR</span>
              <ArrowRight size={14} />
            </Link>
          </div>
        </div>

        <div className="bg-white border border-gray-200/80 rounded-xl p-6 shadow-sm flex flex-col justify-between">
          <div>
            <div className="w-10 h-10 rounded-lg bg-emerald-100/70 text-emerald-700 flex items-center justify-center mb-4">
              <Settings size={22} />
            </div>
            <h3 className="text-base font-bold text-gray-900">Conexión Business Central</h3>
            <p className="text-xs text-gray-500 mt-1.5 leading-relaxed">
              Configura y valida la conexión segura con Microsoft Dynamics 365 Business Central vía Microsoft Entra ID (OAuth 2.0). Incluye verificador de conexión en tiempo real y guía de integración paso a paso.
            </p>
          </div>
          <div className="mt-5 pt-4 border-t border-gray-100 flex items-center justify-between">
            <span className="text-xs text-emerald-600 font-semibold">Ajustes de API</span>
            <Link href="/settings" className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 hover:text-emerald-800">
              <span>Configurar</span>
              <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}