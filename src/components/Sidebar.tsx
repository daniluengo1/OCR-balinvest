'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Building2, FileScan, LayoutDashboard, Settings, History, CheckCircle2, AlertCircle, Landmark, ReceiptText } from 'lucide-react';
import { useCompany } from '@/contexts/CompanyContext';

export default function Sidebar() {
  const pathname = usePathname();
  const { companies, selectedCompany, setSelectedCompany, isLoading } = useCompany();

  const menuItems = [
    { href: '/', label: 'Panel Principal', icon: LayoutDashboard },
    { href: '/ocr', label: 'OCR Facturas Compra', icon: FileScan },
    { href: '/ocr-ventas', label: 'OCR Facturas Venta', icon: ReceiptText },
    { href: '/bancos', label: 'Extractos Bancarios', icon: Landmark },
    { href: '/audit', label: 'Registro de Actividad', icon: History },
    { href: '/settings', label: 'Conexión Business Central', icon: Settings },
  ];

  return (
    <aside className="w-64 flex-shrink-0 border-r border-gray-200 bg-white flex flex-col h-full shadow-sm">
      {/* Brand Header */}
      <div className="p-5 border-b border-gray-100 flex flex-col justify-center">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold shadow-md shadow-indigo-100">
            BC
          </div>
          <div>
            <h1 className="font-bold text-gray-900 leading-none">Gestión Empresa</h1>
            <span className="text-[11px] text-gray-500 font-medium">Business Central 28.5</span>
          </div>
        </div>

        {/* Selector de Empresa */}
        <div className="mt-4">
          <label className="text-[10px] font-semibold tracking-wider text-gray-400 uppercase flex items-center gap-1 mb-1">
            <Building2 size={11} /> Empresa activa
          </label>
          {isLoading ? (
            <div className="h-8 bg-gray-100 rounded-md animate-pulse"></div>
          ) : companies.length > 0 ? (
            <select
              value={selectedCompany}
              onChange={(e) => setSelectedCompany(e.target.value)}
              className="w-full text-xs font-medium border border-gray-200 rounded-md px-2.5 py-1.5 bg-gray-50 text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {companies.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.displayName || c.name}
                </option>
              ))}
            </select>
          ) : (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2">
              Sin empresas (configura BC en Ajustes)
            </div>
          )}
        </div>
      </div>

      {/* Navegación Principal */}
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {menuItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                isActive
                  ? 'bg-indigo-50 text-indigo-700 shadow-sm'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              }`}
            >
              <Icon size={18} className={isActive ? 'text-indigo-600' : 'text-gray-400'} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Pie de navegación con Estado de BC */}
      <div className="p-4 border-t border-gray-100 bg-gray-50/60">
        <div className="flex items-center justify-between text-xs">
          <span className="text-gray-500 font-medium">Entorno:</span>
          <span className="font-semibold text-gray-800 px-2 py-0.5 bg-white border border-gray-200 rounded text-[11px]">
            Production
          </span>
        </div>
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-gray-600">
          {companies.length > 0 ? (
            <>
              <CheckCircle2 size={13} className="text-emerald-500" />
              <span className="text-emerald-700 font-medium">Conectado a BC</span>
            </>
          ) : (
            <>
              <AlertCircle size={13} className="text-amber-500" />
              <span className="text-amber-700 font-medium">Configuración pendiente</span>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}