'use client';

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Check, ChevronsUpDown, Loader2, Search } from 'lucide-react';
import type { BcItem } from '@/app/api/items/route';

interface ItemComboboxProps {
  value: string;
  items: BcItem[];
  loading?: boolean;
  disabled?: boolean;
  onChange: (itemNumber: string, itemName: string, taxGroupCode?: string) => void;
  className?: string;
}

export function ItemCombobox({
  value,
  items,
  loading = false,
  disabled = false,
  onChange,
  className = '',
}: ItemComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedItem = useMemo(() => {
    return items.find(i => i.number.toLowerCase() === (value || '').toLowerCase());
  }, [items, value]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (open) {
      setSearch('');
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const filtered = useMemo(() => {
    if (!search.trim()) return items.slice(0, 100);
    const q = search.toLowerCase().trim();
    return items
      .filter(i => i.number.toLowerCase().includes(q) || i.name.toLowerCase().includes(q))
      .slice(0, 100);
  }, [items, search]);

  const handleSelect = (item: BcItem) => {
    onChange(item.number, item.name, item.taxGroupCode);
    setOpen(false);
  };

  return (
    <div className={`relative inline-block ${className}`} ref={containerRef}>
      <button
        type="button"
        disabled={disabled || loading}
        onClick={() => setOpen(!open)}
        className={`w-28 text-left text-xs font-mono px-2 py-1 border rounded bg-white hover:bg-gray-50 flex items-center justify-between gap-1 transition-colors ${
          !value ? 'border-red-400 text-gray-400' : 'border-gray-300 text-gray-900'
        } ${disabled ? 'opacity-50 cursor-not-allowed bg-gray-100' : 'cursor-pointer'}`}
        title={selectedItem ? `${selectedItem.number} · ${selectedItem.name}` : 'Seleccionar producto / artículo'}
      >
        <span className="truncate">{value || 'Nº art.'}</span>
        {loading ? (
          <Loader2 size={12} className="animate-spin text-gray-400 shrink-0" />
        ) : (
          <ChevronsUpDown size={12} className="text-gray-400 shrink-0" />
        )}
      </button>

      {open && (
        <div className="absolute left-0 mt-1 w-80 bg-white border border-gray-300 rounded-lg shadow-xl z-50 overflow-hidden text-xs">
          <div className="p-2 border-b border-gray-200 bg-gray-50 flex items-center gap-1.5">
            <Search size={14} className="text-gray-400 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar producto por código o nombre..."
              className="w-full bg-transparent border-0 text-xs focus:outline-none focus:ring-0 text-gray-900 placeholder-gray-400"
            />
          </div>

          <div className="max-h-60 overflow-y-auto divide-y divide-gray-100">
            {filtered.length === 0 ? (
              <div className="p-3 text-center text-gray-400 text-xs">
                No se encontraron productos coincidentes
              </div>
            ) : (
              filtered.map(item => {
                const isSelected = item.number === value;
                return (
                  <button
                    key={item.number}
                    type="button"
                    onClick={() => handleSelect(item)}
                    className={`w-full text-left px-3 py-2 flex items-start gap-2 hover:bg-emerald-50 transition-colors ${
                      isSelected ? 'bg-emerald-100/60 font-semibold' : ''
                    }`}
                  >
                    <Check
                      size={14}
                      className={`mt-0.5 shrink-0 ${
                        isSelected ? 'text-emerald-700 opacity-100' : 'opacity-0'
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono font-bold text-gray-900">{item.number}</span>
                        {item.taxGroupCode && (
                          <span className="text-[10px] bg-gray-100 text-gray-600 px-1 py-0.2 rounded font-sans">
                            {item.taxGroupCode}
                          </span>
                        )}
                      </div>
                      <div className="text-gray-600 truncate text-[11px] font-sans">
                        {item.name}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
