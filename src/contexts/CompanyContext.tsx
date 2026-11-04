'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';

export type CompanyItem = {
  id: string;
  name: string;
  displayName: string;
};

type CompanyContextType = {
  companies: CompanyItem[];
  selectedCompany: string;
  setSelectedCompany: (company: string) => void;
  refreshCompanies: () => Promise<void>;
  isLoading: boolean;
};

const CompanyContext = createContext<CompanyContextType | undefined>(undefined);

export function CompanyProvider({ children }: { children: React.ReactNode }) {
  const [companies, setCompanies] = useState<CompanyItem[]>([]);
  const [selectedCompany, setSelectedCompanyState] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isMounted, setIsMounted] = useState<boolean>(false);

  const fetchCompanies = async () => {
    try {
      setIsLoading(true);
      const res = await fetch('/api/bc-config');
      if (res.ok) {
        const data = await res.json();
        const list: CompanyItem[] = data.companies || [];
        setCompanies(list);

        const stored = localStorage.getItem('empresa_activa');
        const defaultCompany = (data.config?.companyId && list.some(c => c.name === data.config.companyId))
          ? data.config.companyId
          : (list.find(c => /2023/i.test(c.name))?.name || list[0]?.name || '');

        if (stored && list.some(c => c.name === stored)) {
          setSelectedCompanyState(stored);
          document.cookie = `empresa_activa=${encodeURIComponent(stored)}; path=/; max-age=31536000`;
          document.cookie = `craze_selected_company=${encodeURIComponent(stored)}; path=/; max-age=31536000`;
        } else if (defaultCompany) {
          setSelectedCompanyState(defaultCompany);
          localStorage.setItem('empresa_activa', defaultCompany);
          document.cookie = `empresa_activa=${encodeURIComponent(defaultCompany)}; path=/; max-age=31536000`;
          document.cookie = `craze_selected_company=${encodeURIComponent(defaultCompany)}; path=/; max-age=31536000`;
        }
      }
    } catch (e) {
      console.error('Error al cargar empresas de BC:', e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    setIsMounted(true);
    fetchCompanies();
  }, []);

  const setSelectedCompany = (company: string) => {
    setSelectedCompanyState(company);
    localStorage.setItem('empresa_activa', company);
    document.cookie = `empresa_activa=${encodeURIComponent(company)}; path=/; max-age=31536000`;
    document.cookie = `craze_selected_company=${encodeURIComponent(company)}; path=/; max-age=31536000`;
  };

  if (!isMounted) {
    return null;
  }

  return (
    <CompanyContext.Provider
      value={{
        companies,
        selectedCompany,
        setSelectedCompany,
        refreshCompanies: fetchCompanies,
        isLoading,
      }}
    >
      {children}
    </CompanyContext.Provider>
  );
}

export function useCompany() {
  const context = useContext(CompanyContext);
  if (context === undefined) {
    throw new Error('useCompany must be used within a CompanyProvider');
  }
  return context;
}