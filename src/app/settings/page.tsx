'use client';

import { useState, useEffect } from 'react';
import {
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  KeyRound,
  Building2,
  HelpCircle,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
  Calendar,
  CalendarCheck,
  Clock,
  Lock,
  AlertTriangle,
  Save,
  Check,
} from 'lucide-react';
import { useCompany } from '@/contexts/CompanyContext';

export default function SettingsPage() {
  const { refreshCompanies } = useCompany();
  const [tenantId, setTenantId] = useState('39ce8e6c-69fa-4426-951c-4eea455664f9');
  const [clientId, setClientId] = useState('e83d177b-afea-448a-87ca-f665c3d9f651');
  const [clientSecret, setClientSecret] = useState('');
  const [environment, setEnvironment] = useState('Production');
  const [secretSet, setSecretSet] = useState(false);
  const [companies, setCompanies] = useState<any[]>([]);
  const [status, setStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState<string>('');
  const [showInstructions, setShowInstructions] = useState<boolean>(true);
  const [loading, setLoading] = useState<boolean>(true);

  // Política de fecha de registro (Posting Date)
  const [postingPolicy, setPostingPolicy] = useState<'auto' | 'today' | 'document'>('auto');
  const [customPostingFrom, setCustomPostingFrom] = useState<string>('');
  const [postingLimits, setPostingLimits] = useState<any>(null);
  const [postingLoading, setPostingLoading] = useState<boolean>(true);
  const [postingSaving, setPostingSaving] = useState<boolean>(false);
  const [postingSuccess, setPostingSuccess] = useState<boolean>(false);
  const [postingError, setPostingError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/bc-config')
      .then((res) => res.json())
      .then((data) => {
        if (data.config) {
          if (data.config.tenantId) setTenantId(data.config.tenantId);
          if (data.config.clientId) setClientId(data.config.clientId);
          if (data.config.environment) setEnvironment(data.config.environment);
          setSecretSet(data.config.clientSecretSet);
        }
        if (data.companies && data.companies.length > 0) {
          setCompanies(data.companies);
          setStatus('success');
          setMessage(`Conectado. Se han detectado ${data.companies.length} empresa(s) en Business Central.`);
        } else if (data.errorMessage) {
          setStatus('error');
          setMessage(data.errorMessage);
        }
      })
      .catch((e) => {
        console.error('Error al cargar configuración:', e);
      })
      .finally(() => setLoading(false));

    // Cargar política de fecha de registro y límites de periodos de BC
    fetch('/api/bc-config/posting-policy')
      .then((res) => res.json())
      .then((data) => {
        if (data.ok) {
          if (data.policy) setPostingPolicy(data.policy);
          if (data.customPostingFrom) setCustomPostingFrom(data.customPostingFrom);
          if (data.limits) setPostingLimits(data.limits);
        }
      })
      .catch((e) => console.error('Error al cargar política de registro:', e))
      .finally(() => setPostingLoading(false));
  }, []);

  const handleSaveAndTest = async () => {
    setStatus('testing');
    setMessage('Verificando credenciales con Microsoft Entra ID y Business Central...');

    try {
      const res = await fetch('/api/bc-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId,
          clientId,
          clientSecret,
          environment,
        }),
      });

      const data = await res.json();
      if (data.ok) {
        setStatus('success');
        setMessage(data.message || 'Conexión completada con éxito.');
        setCompanies(data.companies || []);
        if (data.detectedEnvironment) {
          setEnvironment(data.detectedEnvironment);
        }
        setSecretSet(true);
        setClientSecret('');
        await refreshCompanies();
      } else {
        setStatus('error');
        setMessage(data.error || 'No se pudo conectar a Business Central.');
      }
    } catch (err: any) {
      setStatus('error');
      setMessage(err.message || 'Error de red al intentar conectar.');
    }
  };

  const handleSavePostingPolicy = async () => {
    setPostingSaving(true);
    setPostingSuccess(false);
    setPostingError(null);
    try {
      const res = await fetch('/api/bc-config/posting-policy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          policy: postingPolicy,
          customPostingFrom: customPostingFrom || null,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setPostingSuccess(true);
        setTimeout(() => setPostingSuccess(false), 4000);
      } else {
        setPostingError(data.error || 'Error al guardar la política.');
      }
    } catch (e: any) {
      setPostingError(e.message || 'Error de red.');
    } finally {
      setPostingSaving(false);
    }
  };

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Configuración de Business Central</h1>
        <p className="text-sm text-gray-500 mt-1">
          Gestiona las credenciales de conexión API (OAuth 2.0) entre la plataforma y tu entorno de Microsoft Dynamics 365 Business Central.
        </p>
      </div>

      {/* Estado actual de la conexión */}
      {status === 'success' && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-start gap-3">
          <CheckCircle2 className="text-emerald-600 mt-0.5 flex-shrink-0" size={20} />
          <div>
            <h3 className="text-sm font-semibold text-emerald-900">Conexión activa con Business Central</h3>
            <p className="text-xs text-emerald-700 mt-0.5">{message}</p>
            {companies.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {companies.map((c) => (
                  <span key={c.id} className="text-[11px] font-medium bg-emerald-100/70 text-emerald-800 px-2.5 py-1 rounded-md border border-emerald-200">
                    🏢 {c.displayName || c.name}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {status === 'error' && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
          <AlertCircle className="text-red-600 mt-0.5 flex-shrink-0" size={20} />
          <div>
            <h3 className="text-sm font-semibold text-red-900">Error de conexión</h3>
            <p className="text-xs text-red-700 mt-0.5 break-words">{message}</p>
          </div>
        </div>
      )}

      {/* Formulario de Credenciales */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 space-y-6">
        <div className="flex items-center gap-2 border-b border-gray-100 pb-4">
          <KeyRound className="text-indigo-600" size={20} />
          <h2 className="text-base font-semibold text-gray-900">Credenciales de Microsoft Entra (Azure AD)</h2>
        </div>

        {loading ? (
          <div className="py-8 text-center text-sm text-gray-500">Cargando configuración...</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                Id. de suscriptor Microsoft Entra (Tenant ID)
              </label>
              <input
                type="text"
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 bg-gray-50 font-mono text-gray-800 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <span className="text-[11px] text-gray-400 mt-1 block">Identificador de tu directorio de Azure / Entra</span>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                Entorno de Business Central
              </label>
              <input
                type="text"
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
                placeholder="Production"
                className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 font-mono text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <span className="text-[11px] text-gray-400 mt-1 block">Nombre del entorno en Business Central</span>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                Id. de aplicación / cliente (Client ID)
              </label>
              <input
                type="text"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="Copia aquí el Application ID de Azure"
                className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 font-mono text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <span className="text-[11px] text-gray-400 mt-1 block">Generado en Azure Portal &gt; Registros de aplicaciones</span>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-700 mb-1">
                Secreto de cliente (Client Secret)
              </label>
              <input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={secretSet ? '•••••••••••••••• (Guardado - introduce nuevo para cambiar)' : 'Pega aquí el valor del secreto'}
                className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 font-mono text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <span className="text-[11px] text-gray-400 mt-1 block">Valor del secreto generado en Certificados y secretos</span>
            </div>
          </div>
        )}

        <div className="pt-4 border-t border-gray-100 flex items-center justify-between">
          <span className="text-xs text-gray-500">
            {secretSet ? '✅ Credenciales configuradas previamente.' : '⚠️ Requiere Client ID y Secret para activar la API.'}
          </span>
          <button
            onClick={handleSaveAndTest}
            disabled={status === 'testing' || !tenantId || !clientId || (!clientSecret && !secretSet)}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-medium text-sm px-5 py-2.5 rounded-lg shadow-sm transition-all"
          >
            {status === 'testing' ? (
              <>
                <RefreshCw size={16} className="animate-spin" />
                <span>Verificando conexión...</span>
              </>
            ) : (
              <>
                <ShieldCheck size={16} />
                <span>Probar y Guardar Conexión</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Tarjeta de Política de Fecha de Registro (Posting Date) */}
      <div className="bg-white border border-gray-200 rounded-xl shadow-sm p-6 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-gray-100 pb-4">
          <div className="flex items-start sm:items-center gap-3">
            <div className="p-2 bg-indigo-50 text-indigo-600 rounded-lg">
              <CalendarCheck size={22} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900">Fecha de Registro en Business Central (Posting Date)</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Define cómo debe asignarse la fecha de registro al procesar facturas y abonos, protegiendo periodos contables e IVA ya cerrados.
              </p>
            </div>
          </div>
          {postingLimits?.companyName && (
            <span className="text-xs self-start sm:self-auto bg-slate-100 text-slate-700 font-medium px-2.5 py-1 rounded-md border border-slate-200">
              🏢 {postingLimits.companyName}
            </span>
          )}
        </div>

        {/* Opciones de Política */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Opción 1: Auto */}
          <div
            onClick={() => setPostingPolicy('auto')}
            className={`cursor-pointer rounded-xl p-4 border-2 transition-all relative flex flex-col justify-between ${
              postingPolicy === 'auto'
                ? 'border-indigo-600 bg-indigo-50/30 shadow-xs'
                : 'border-gray-200 hover:border-gray-300 bg-white'
            }`}
          >
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">
                  Recomendado
                </span>
                <input
                  type="radio"
                  name="postingPolicy"
                  checked={postingPolicy === 'auto'}
                  onChange={() => setPostingPolicy('auto')}
                  className="text-indigo-600 focus:ring-indigo-500"
                />
              </div>
              <h3 className="text-sm font-bold text-gray-900 mb-1 flex items-center gap-1.5">
                <Clock size={16} className="text-indigo-600" />
                Automático (Inteligente)
              </h3>
              <p className="text-xs text-gray-600 leading-relaxed">
                Usa la fecha de la factura si el periodo contable e IVA están abiertos en BC. Si el periodo está cerrado o bloqueado, asigna automáticamente la <strong>fecha de hoy</strong> para evitar errores.
              </p>
            </div>
            <div className="mt-3 pt-2.5 border-t border-gray-100 text-[11px] text-gray-500">
              Evita bloqueos de Business Central si llegan facturas atrasadas.
            </div>
          </div>

          {/* Opción 2: Siempre fecha de hoy */}
          <div
            onClick={() => setPostingPolicy('today')}
            className={`cursor-pointer rounded-xl p-4 border-2 transition-all relative flex flex-col justify-between ${
              postingPolicy === 'today'
                ? 'border-indigo-600 bg-indigo-50/30 shadow-xs'
                : 'border-gray-200 hover:border-gray-300 bg-white'
            }`}
          >
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-indigo-700 bg-indigo-100 px-2 py-0.5 rounded-full">
                  Cierre estricto
                </span>
                <input
                  type="radio"
                  name="postingPolicy"
                  checked={postingPolicy === 'today'}
                  onChange={() => setPostingPolicy('today')}
                  className="text-indigo-600 focus:ring-indigo-500"
                />
              </div>
              <h3 className="text-sm font-bold text-gray-900 mb-1 flex items-center gap-1.5">
                <Calendar size={16} className="text-indigo-600" />
                Siempre fecha de hoy
              </h3>
              <p className="text-xs text-gray-600 leading-relaxed">
                Registra siempre con la fecha del día actual, sin importar la fecha que indique el documento escaneado.
              </p>
            </div>
            <div className="mt-3 pt-2.5 border-t border-gray-100 text-[11px] text-gray-500">
              Ideal para empresas que cierran meses y nunca alteran periodos pasados.
            </div>
          </div>

          {/* Opción 3: Siempre fecha del documento */}
          <div
            onClick={() => setPostingPolicy('document')}
            className={`cursor-pointer rounded-xl p-4 border-2 transition-all relative flex flex-col justify-between ${
              postingPolicy === 'document'
                ? 'border-indigo-600 bg-indigo-50/30 shadow-xs'
                : 'border-gray-200 hover:border-gray-300 bg-white'
            }`}
          >
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
                  Manual
                </span>
                <input
                  type="radio"
                  name="postingPolicy"
                  checked={postingPolicy === 'document'}
                  onChange={() => setPostingPolicy('document')}
                  className="text-indigo-600 focus:ring-indigo-500"
                />
              </div>
              <h3 className="text-sm font-bold text-gray-900 mb-1 flex items-center gap-1.5">
                <AlertTriangle size={16} className="text-amber-600" />
                Siempre fecha del documento
              </h3>
              <p className="text-xs text-gray-600 leading-relaxed">
                Mantiene siempre la fecha original que consta en el OCR de la factura, incluso si el periodo está cerrado en BC.
              </p>
            </div>
            <div className="mt-3 pt-2.5 border-t border-gray-100 text-[11px] text-gray-500">
              Puede provocar errores de registro en BC si el periodo no está abierto.
            </div>
          </div>
        </div>

        {/* Panel de estado detectado en Business Central */}
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-2">
              <Lock size={14} className="text-slate-500" />
              Estado contable y periodos detectados en Business Central
            </h4>
            {postingLoading && (
              <span className="text-[11px] text-slate-500 flex items-center gap-1">
                <RefreshCw size={12} className="animate-spin" /> Consultando BC...
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            <div className="bg-white p-3 rounded-lg border border-slate-200">
              <span className="text-gray-500 block mb-0.5">Configuración Contabilidad (GL):</span>
              <span className="font-semibold text-gray-900">
                {postingLimits?.allowPostingFrom && postingLimits.allowPostingFrom !== '0001-01-01'
                  ? `Permitir desde: ${postingLimits.allowPostingFrom.split('-').reverse().join('/')}`
                  : 'Sin fecha límite fijada (abierto)'}
              </span>
            </div>

            <div className="bg-white p-3 rounded-lg border border-slate-200">
              <span className="text-gray-500 block mb-0.5">Último periodo cerrado en BC:</span>
              <span className="font-semibold text-amber-700">
                {postingLimits?.latestClosedPeriod
                  ? `${postingLimits.latestClosedPeriod.name} (${postingLimits.latestClosedPeriod.startingDate.split('-').reverse().join('/')})`
                  : 'Ninguno bloqueado'}
              </span>
            </div>

            <div className="bg-white p-3 rounded-lg border border-slate-200">
              <span className="text-gray-500 block mb-0.5">Fecha mínima permitida para registro:</span>
              <span className="font-bold text-emerald-700 text-sm">
                {postingLimits?.earliestAllowedDate
                  ? postingLimits.earliestAllowedDate.split('-').reverse().join('/')
                  : 'Sin restricción'}
              </span>
            </div>
          </div>

          {/* Override manual opcional */}
          <div className="pt-2 border-t border-slate-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="text-xs text-gray-600">
              <span className="font-medium text-gray-800">Fecha mínima manual adicional (opcional):</span>
              <p className="text-[11px] text-gray-500">
                Si deseas adelantar el corte contable/IVA manualmente antes de bloquear los periodos en BC.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={customPostingFrom}
                onChange={(e) => setCustomPostingFrom(e.target.value)}
                className="text-xs border border-gray-300 rounded-lg px-2.5 py-1.5 bg-white font-mono text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              {customPostingFrom && (
                <button
                  type="button"
                  onClick={() => setCustomPostingFrom('')}
                  className="text-[11px] text-gray-400 hover:text-red-500 underline"
                >
                  Limpiar
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Feedback y botón de guardar */}
        <div className="pt-4 border-t border-gray-100 flex items-center justify-between">
          <div className="text-xs">
            {postingSuccess && (
              <span className="text-emerald-600 font-medium flex items-center gap-1">
                <Check size={16} /> Política de fecha de registro guardada con éxito.
              </span>
            )}
            {postingError && (
              <span className="text-red-600 font-medium flex items-center gap-1">
                <AlertCircle size={16} /> {postingError}
              </span>
            )}
            {!postingSuccess && !postingError && (
              <span className="text-gray-500">
                Los cambios se aplicarán inmediatamente a las facturas procesadas con el OCR.
              </span>
            )}
          </div>
          <button
            onClick={handleSavePostingPolicy}
            disabled={postingSaving}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-medium text-sm px-5 py-2.5 rounded-lg shadow-sm transition-all"
          >
            {postingSaving ? (
              <>
                <RefreshCw size={16} className="animate-spin" />
                <span>Guardando...</span>
              </>
            ) : (
              <>
                <Save size={16} />
                <span>Guardar Política de Fecha</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Guía Paso a Paso para obtener las credenciales */}
      <div className="bg-indigo-50/50 border border-indigo-100 rounded-xl overflow-hidden shadow-sm">
        <button
          onClick={() => setShowInstructions(!showInstructions)}
          className="w-full flex items-center justify-between p-5 text-left font-semibold text-indigo-950 hover:bg-indigo-50/80 transition-colors"
        >
          <div className="flex items-center gap-2">
            <HelpCircle className="text-indigo-600" size={18} />
            <span>Guía paso a paso: Cómo generar el Client ID y Secret en Microsoft Entra ID</span>
          </div>
          {showInstructions ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>

        {showInstructions && (
          <div className="p-6 pt-0 space-y-6 text-xs text-gray-700 border-t border-indigo-100/60 mt-2">
            <div>
              <h4 className="font-bold text-gray-900 text-sm mb-1.5 flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-indigo-600 text-white inline-flex items-center justify-center text-[10px]">1</span>
                Registrar la aplicación en Microsoft Entra ID (Portal de Azure)
              </h4>
              <ol className="list-decimal list-inside space-y-1 pl-2 text-gray-600">
                <li>Accede a <a href="https://portal.azure.com" target="_blank" rel="noopener noreferrer" className="text-indigo-600 underline">portal.azure.com</a> con tu usuario administrador.</li>
                <li>En la barra de búsqueda superior busca <strong>Microsoft Entra ID</strong> (o Azure Active Directory).</li>
                <li>En el menú de la izquierda, haz clic en <strong>Registros de aplicaciones</strong> y pulsa en <strong>+ Nuevo registro</strong>.</li>
                <li>Nombre: ej. <code className="bg-white px-1.5 py-0.5 rounded border">Plataforma Gestión OCR</code>.</li>
                <li>Tipos de cuenta admitidos: <strong>Solo las cuentas de este directorio organizativo (inquilino único)</strong>.</li>
                <li>Pulsa <strong>Registrar</strong>. Copia el <strong>Id. de aplicación (cliente)</strong> que aparece en Información general.</li>
              </ol>
            </div>

            <div>
              <h4 className="font-bold text-gray-900 text-sm mb-1.5 flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-indigo-600 text-white inline-flex items-center justify-center text-[10px]">2</span>
                Crear el Secreto de Cliente (Client Secret)
              </h4>
              <ol className="list-decimal list-inside space-y-1 pl-2 text-gray-600">
                <li>En el menú izquierdo de tu registro de aplicación, ve a <strong>Certificados y secretos</strong>.</li>
                <li>En la pestaña <em>Secretos de cliente</em>, pulsa en <strong>+ Nuevo secreto de cliente</strong>.</li>
                <li>Añade una descripción (ej. <em>API Business Central</em>) y elige la caducidad (ej. 12 o 24 meses).</li>
                <li>Pulsa <strong>Agregar</strong>.</li>
                <li><strong>¡Importante!</strong> Copia inmediatamente el campo <strong>Valor (Value)</strong> (no el ID de secreto). Pégalo en el campo <em>Secreto de cliente</em> de esta pantalla.</li>
              </ol>
            </div>

            <div>
              <h4 className="font-bold text-gray-900 text-sm mb-1.5 flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-indigo-600 text-white inline-flex items-center justify-center text-[10px]">3</span>
                Asignar Permisos de API para Business Central
              </h4>
              <ol className="list-decimal list-inside space-y-1 pl-2 text-gray-600">
                <li>En el menú izquierdo, haz clic en <strong>Permisos de API</strong> &gt; <strong>+ Agregar un permiso</strong>.</li>
                <li>Selecciona <strong>Dynamics 365 Business Central</strong>.</li>
                <li>Elige <strong>Permisos de aplicación</strong> (Application permissions).</li>
                <li>Marca el permiso <strong>API.ReadWrite.All</strong> y pulsa <strong>Agregar permisos</strong>.</li>
                <li>Haz clic en el botón <strong>Conceder consentimiento de administrador para [Tu Empresa]</strong> y pulsa Sí.</li>
              </ol>
            </div>

            <div>
              <h4 className="font-bold text-gray-900 text-sm mb-1.5 flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-indigo-600 text-white inline-flex items-center justify-center text-[10px]">4</span>
                Dar de alta la aplicación en Business Central (Paso imprescindible)
              </h4>
              <ol className="list-decimal list-inside space-y-1 pl-2 text-gray-600">
                <li>Abre Business Central en tu navegador en el entorno <strong>Production</strong>.</li>
                <li>En la lupa de búsqueda superior derecha (o Alt+Q), escribe <strong>Aplicaciones de Microsoft Entra</strong> (<em>Microsoft Entra Applications</em>).</li>
                <li>Pulsa <strong>+ Nuevo</strong>.</li>
                <li>En <strong>Id. de cliente</strong>, pega el <em>Id. de aplicación (cliente)</em> del paso 1.</li>
                <li>En <strong>Descripción</strong> escribe ej. <em>Plataforma Gestión OCR</em>.</li>
                <li>Cambia el <strong>Estado</strong> a <strong>Habilitado</strong>.</li>
                <li>En la subtabla inferior de <em>Conjuntos de permisos de usuario</em>, añade el permiso <strong>D365 BUS PREMIUM</strong> o <strong>D365 AUTOMATION</strong>.</li>
              </ol>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}