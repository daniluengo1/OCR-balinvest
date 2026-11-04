import prisma from '@/lib/prisma';

export type BcContext = {
  token: string;
  companyId: string;
  companyName: string;          // Nombre exacto de la empresa en BC
  apiBase: string;              // API estándar v2.0, con /companies(id)
  customApiBase: string;        // API custom si existe
  odataCompanyBase: string;     // ODataV4, con /Company('nombre')
  root: string;
};

// Obtiene el token OAuth 2.0 mediante Microsoft Entra ID
export async function getAccessToken(tenantId: string, clientId: string, clientSecret: string): Promise<string> {
  const tokenEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  
  const params = new URLSearchParams();
  params.append('client_id', clientId.trim());
  params.append('client_secret', clientSecret.trim());
  params.append('grant_type', 'client_credentials');
  params.append('scope', 'https://api.businesscentral.dynamics.com/.default');

  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    body: params,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  if (!res.ok) {
    const errorText = await res.text();
    let errorDetail = errorText;
    try {
      const parsed = JSON.parse(errorText);
      errorDetail = parsed.error_description || parsed.error || errorText;
    } catch {}
    throw new Error(`Error de autenticación en Microsoft Entra ID (${res.status}): ${errorDetail}`);
  }

  const data = await res.json();
  return data.access_token;
}

// Obtiene la lista de empresas registradas en Business Central
export async function getBcCompanies(): Promise<Array<{ id: string; name: string; displayName: string }>> {
  const config = await prisma.businessCentralConfig.findUnique({ where: { id: 1 } });
  if (!config || !config.tenantId || !config.clientId || !config.clientSecret) {
    return [];
  }

  const token = await getAccessToken(config.tenantId, config.clientId, config.clientSecret);
  const root = `https://api.businesscentral.dynamics.com/v2.0/${config.tenantId}/${config.environment || 'Production'}`;

  const res = await fetch(`${root}/api/v2.0/companies`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`No se pudieron obtener las empresas de BC (${res.status}): ${await res.text()}`);
  }

  const data = await res.json();
  return (data.value || []).map((c: any) => ({
    id: c.id,
    name: c.name,
    displayName: c.displayName || c.name,
  }));
}

// Prepara token y URLs base de BC para la empresa seleccionada
export async function getBcContext(companyName?: string): Promise<BcContext> {
  const config = await prisma.businessCentralConfig.findUnique({ where: { id: 1 } });
  if (!config || !config.tenantId || !config.clientId || !config.clientSecret) {
    throw new Error('La configuración de Business Central está incompleta. Por favor, introduce el Client ID y Client Secret en Ajustes.');
  }

  const token = await getAccessToken(config.tenantId, config.clientId, config.clientSecret);
  const root = `https://api.businesscentral.dynamics.com/v2.0/${config.tenantId}/${config.environment || 'Production'}`;

  const compRes = await fetch(`${root}/api/v2.0/companies`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    cache: 'no-store',
  });

  if (!compRes.ok) {
    throw new Error(`No se pudieron obtener las empresas de BC (${compRes.status}): ${await compRes.text()}`);
  }

  const compData = await compRes.json();
  const companies: any[] = compData.value || [];
  if (!companies.length) {
    throw new Error('No se encontraron empresas en este entorno de Business Central.');
  }

  let company = companyName
    ? companies.find((c: any) => c.name.toLowerCase() === companyName.toLowerCase() || c.displayName?.toLowerCase() === companyName.toLowerCase())
    : null;

  // Si no se especifica o no coincide, usar la guardada en config o la primera disponible
  if (!company) {
    company = companies.find((c: any) => c.name.toLowerCase() === (config.companyId || '').toLowerCase()) || companies[0];
  }

  const escapedName = company.name.replace(/'/g, "''");
  return {
    token,
    companyId: company.id,
    companyName: company.name,
    apiBase: `${root}/api/v2.0/companies(${company.id})`,
    customApiBase: `${root}/api/craze/integrations/v1.0/companies(${company.id})`,
    odataCompanyBase: `${root}/ODataV4/Company('${encodeURIComponent(escapedName)}')`,
    root,
  };
}

// Descarga todas las páginas de una consulta OData (con paginación)
export async function bcFetchAll(url: string, token: string, timeoutMs = 45000): Promise<any[]> {
  let nextUrl: string | null = url;
  const results: any[] = [];
  let pages = 0;

  while (nextUrl && pages < 200) {
    pages++;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res: Response = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', Prefer: 'odata.maxpagesize=20000' },
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`Consulta a BC fallida (${res.status}): ${await res.text()}`);
      const data: any = await res.json();
      if (Array.isArray(data.value)) results.push(...data.value);
      const newNext: string | null = data['@odata.nextLink'] || null;
      nextUrl = newNext === nextUrl ? null : newNext;
    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw new Error(`Business Central tardó más de ${timeoutMs / 1000} segundos en responder.`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  return results;
}

// Construye una URL OData con parámetros ($filter, $select...) codificados
export function odataUrl(base: string, params: Record<string, string | undefined>): string {
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join('&');
  return query ? `${base}?${query}` : base;
}