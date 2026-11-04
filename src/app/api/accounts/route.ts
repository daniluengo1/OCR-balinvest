import { NextRequest, NextResponse } from 'next/server';
import { getBcContext, bcFetchAll } from '@/lib/bcClient';
import { cached, HOUR } from '@/lib/cache';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const company = url.searchParams.get('company') || req.cookies.get('empresa_activa')?.value || undefined;
    const ctx = await getBcContext(company);

    const force = url.searchParams.get('refresh') === 'true';
    const accounts = await cached(`accounts:v2:${ctx.companyName}`, 6 * HOUR, async () => {
      // 1. Intentar Plan_de_cuentas vía OData para filtrar estrictamente Tipo Mov. = 'Registro' y Registro Directo = true
      try {
        const odataEndpoint = `${ctx.odataCompanyBase}/Plan_de_cuentas?$filter=Account_Type eq 'Posting' and Direct_Posting eq true&$select=No,Name,VAT_Prod_Posting_Group,Account_Category,Account_Subcategory_Descript&$top=5000`;
        const rawOdata = await bcFetchAll(odataEndpoint, ctx.token);
        if (rawOdata && rawOdata.length > 0) {
          return rawOdata.map((a: any) => ({
            number: a.No,
            name: a.Name || '',
            category: a.Account_Category === ' ' ? 'Expense' : a.Account_Category || '',
            subCategory: a.Account_Subcategory_Descript || '',
            vatProdPostingGroup: a.VAT_Prod_Posting_Group || '',
            directPosting: true,
          })).sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
        }
      } catch (e) {
        console.warn('Fallback a API estándar para cuentas:', e);
      }

      // 2. Fallback a API estándar v2 filtrando directPosting y sin cabeceras
      const endpoint = `${ctx.apiBase}/accounts?$filter=accountType eq 'Posting' and directPosting eq true and blocked eq false&$select=id,number,displayName,category,subCategory,accountType,directPosting`;
      const raw = await bcFetchAll(endpoint, ctx.token);
      return raw
        .filter((a: any) => a.directPosting === true)
        .map((a: any) => ({
          number: a.number,
          name: a.displayName || '',
          category: a.category === '_x0020_' ? '' : a.category || '',
          subCategory: a.subCategory || '',
          vatProdPostingGroup: '',
          directPosting: Boolean(a.directPosting),
        }))
        .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
    }, force);

    return NextResponse.json({ accounts }, {
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' }
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
