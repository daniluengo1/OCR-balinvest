import type { Metadata } from 'next';
import './globals.css';
import Sidebar from '@/components/Sidebar';
import { CompanyProvider } from '@/contexts/CompanyContext';

export const metadata: Metadata = {
  title: 'Plataforma de Gestión Empresarial | Business Central',
  description: 'Gestión empresarial automatizada con OCR conectada a Microsoft Dynamics 365 Business Central',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body className="flex h-screen bg-slate-50 text-slate-900 overflow-hidden font-sans antialiased">
        <CompanyProvider>
          <Sidebar />
          <main className="flex-1 overflow-auto bg-slate-50">
            {children}
          </main>
        </CompanyProvider>
      </body>
    </html>
  );
}