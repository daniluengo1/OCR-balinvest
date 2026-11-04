'use client';

import { useState, useEffect } from 'react';
import { History, RefreshCw, FileText } from 'lucide-react';

export default function AuditPage() {
  const [logs, setLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const loadLogs = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/audit');
      const data = await res.json();
      setLogs(data.logs || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLogs();
  }, []);

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Registro de Actividad y Auditoría</h1>
          <p className="text-sm text-gray-500 mt-1">Historial de facturas procesadas y acciones creadas en Business Central</p>
        </div>
        <button
          onClick={loadLogs}
          disabled={loading}
          className="flex items-center gap-2 text-xs font-semibold text-gray-600 bg-white border border-gray-200 hover:bg-gray-50 px-3 py-2 rounded-lg shadow-sm"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          <span>Actualizar</span>
        </button>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm">
        {loading ? (
          <div className="p-8 text-center text-sm text-gray-400">Cargando registros...</div>
        ) : logs.length === 0 ? (
          <div className="p-12 text-center">
            <History size={32} className="mx-auto text-gray-300 mb-2" />
            <p className="text-sm text-gray-500">Aún no hay acciones registradas.</p>
            <p className="text-xs text-gray-400 mt-1">Cuando proceses y crees facturas con el OCR aparecerán aquí.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-gray-50/80 text-gray-500 border-b border-gray-100 uppercase tracking-wider text-[10px]">
                <tr>
                  <th className="py-3 px-4 font-semibold">Fecha y Hora</th>
                  <th className="py-3 px-4 font-semibold">Acción</th>
                  <th className="py-3 px-4 font-semibold">Detalles</th>
                  <th className="py-3 px-4 font-semibold">Empresa</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-gray-50/50">
                    <td className="py-3 px-4 text-gray-500 whitespace-nowrap">
                      {new Date(log.timestamp).toLocaleString('es-ES')}
                    </td>
                    <td className="py-3 px-4 font-medium text-gray-900">
                      {log.action}
                    </td>
                    <td className="py-3 px-4 text-gray-600 font-mono text-[11px]">
                      {log.details || '—'}
                    </td>
                    <td className="py-3 px-4 text-gray-500">
                      <span className="bg-gray-100 px-2 py-0.5 rounded text-[11px]">
                        {log.companyId || 'General'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}