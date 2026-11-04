'use client';

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { ChevronDown, Search, X, Check } from 'lucide-react';

export type BcAccount = {
  number: string;
  name: string;
  category?: string;
  subCategory?: string;
  vatProdPostingGroup?: string;
  directPosting?: boolean;
};

interface AccountComboboxProps {
  value: string;
  accounts: BcAccount[];
  loading?: boolean;
  disabled?: boolean;
  onChange: (accountNumber: string, accountName?: string, vatProdGroup?: string) => void;
  className?: string;
}

export function AccountCombobox({
  value,
  accounts,
  loading = false,
  disabled = false,
  onChange,
  className = '',
}: AccountComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Solo cuentas de tipo registro directo
  const postingAccounts = useMemo(() => {
    return accounts.filter(a => a.directPosting !== false);
  }, [accounts]);

  // Cuenta seleccionada actualmente
  const selectedAccount = useMemo(() => {
    return postingAccounts.find(a => a.number === value);
  }, [postingAccounts, value]);

  // Filtrado de cuentas por número o nombre
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      // Priorizar cuentas de gastos (Grupo 6) al abrir sin filtro
      const expenses = postingAccounts.filter(a => a.number.startsWith('6'));
      const others = postingAccounts.filter(a => !a.number.startsWith('6'));
      return [...expenses, ...others].slice(0, 50);
    }
    return postingAccounts
      .filter(a => a.number.toLowerCase().includes(q) || a.name.toLowerCase().includes(q))
      .slice(0, 50);
  }, [postingAccounts, query]);

  // Cerrar al hacer clic fuera
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (acc: BcAccount) => {
    onChange(acc.number, acc.name, acc.vatProdPostingGroup);
    setOpen(false);
    setQuery('');
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    onChange(v);
    setQuery(v);
    if (!open) setOpen(true);
  };

  return (
    <div ref={containerRef} className={`relative inline-block w-48 ${className}`}>
      <div className="relative flex items-center">
        <input
          ref={inputRef}
          type="text"
          value={open ? (query !== '' ? query : value) : value}
          onChange={handleInputChange}
          onFocus={() => {
            setQuery(value);
            setOpen(true);
          }}
          disabled={disabled}
          placeholder={loading ? 'Cargando cuentas...' : 'Nº de cuenta'}
          title={selectedAccount ? `${selectedAccount.number} - ${selectedAccount.name}` : value}
          className={`w-full font-mono text-xs border rounded px-2 py-1 pr-6 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-colors ${
            !value ? 'border-amber-400 bg-amber-50/30' : 'border-gray-300 bg-white hover:border-gray-400'
          }`}
        />
        <button
          type="button"
          tabIndex={-1}
          disabled={disabled}
          onClick={() => {
            if (!disabled) {
              setOpen(!open);
              if (!open) {
                setQuery(value);
                inputRef.current?.focus();
              }
            }
          }}
          className="absolute right-1 text-gray-400 hover:text-gray-600 p-0.5"
        >
          <ChevronDown size={13} className={`transform transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {open && (
        <div className="absolute left-0 mt-1 w-80 max-h-64 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-xl z-50 py-1 text-xs">
          <div className="px-2 py-1 border-b border-gray-100 flex items-center justify-between text-gray-400">
            <span className="font-semibold text-gray-600">Plan de cuentas (Registro)</span>
            <span className="text-[10px]">{accounts.length} cuentas</span>
          </div>

          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-center text-gray-400">
              No se encontraron cuentas con "{query}"
            </div>
          ) : (
            filtered.map(acc => {
              const isSelected = acc.number === value;
              const isExpense = acc.number.startsWith('6');
              return (
                <button
                  key={acc.number}
                  type="button"
                  onClick={() => handleSelect(acc)}
                  className={`w-full text-left px-2.5 py-1.5 flex items-center justify-between hover:bg-indigo-50 transition-colors ${
                    isSelected ? 'bg-indigo-50 text-indigo-900 font-semibold' : 'text-gray-800'
                  }`}
                >
                  <div className="flex items-center gap-2 overflow-hidden flex-1 min-w-0">
                    <span className={`font-mono px-1 rounded text-[11px] shrink-0 ${
                      isExpense ? 'bg-amber-100 text-amber-900 font-bold' : 'bg-gray-100 text-gray-700'
                    }`}>
                      {acc.number}
                    </span>
                    <span className="truncate text-xs" title={acc.name}>
                      {acc.name}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 ml-1">
                    {acc.vatProdPostingGroup && (
                      <span className="text-[10px] font-mono px-1 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200" title={`Grupo IVA: ${acc.vatProdPostingGroup}`}>
                        {acc.vatProdPostingGroup}
                      </span>
                    )}
                    {isSelected && <Check size={13} className="text-indigo-600" />}
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
