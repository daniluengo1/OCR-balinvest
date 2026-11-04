import { NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { getAccessToken, getBcCompanies, getEffectiveBcConfig } from '@/lib/bcClient';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const config = await getEffectiveBcConfig();

    let companies: any[] = [];
    let connectionStatus = 'pending';
    let errorMessage = '';

    if (config.tenantId && config.clientId && config.clientSecret) {
      try {
        companies = await getBcCompanies();
        connectionStatus = 'connected';
      } catch (err: any) {
        connectionStatus = 'error';
        errorMessage = err.message;
      }
    }

    return NextResponse.json({
      config: {
        tenantId: config.tenantId,
        clientId: config.clientId,
        clientSecretSet: Boolean(config.clientSecret),
        environment: config.environment,
        companyId: config.companyId,
      },
      connectionStatus,
      errorMessage,
      companies,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { tenantId, clientId, clientSecret, environment, companyId, testOnly } = body;

    const current = await prisma.businessCentralConfig.findUnique({ where: { id: 1 } });
    const finalSecret = clientSecret ? clientSecret.trim() : current?.clientSecret || '';

    if (!tenantId || !clientId || !finalSecret) {
      return NextResponse.json({
        ok: false,
        error: 'Debes proporcionar Tenant ID, Client ID y Client Secret para conectar con Business Central.'
      }, { status: 400 });
    }

    // 1. Probar obtención de token OAuth en Microsoft Entra ID
    const token = await getAccessToken(tenantId.trim(), clientId.trim(), finalSecret);

    // 2. Probar acceso a la API de Business Central y listar empresas
    const env = environment?.trim() || 'Production';
    const root = `https://api.businesscentral.dynamics.com/v2.0/${tenantId.trim()}/${env}`;
    const compRes = await fetch(`${root}/api/v2.0/companies`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      cache: 'no-store',
    });

    if (!compRes.ok) {
      const errText = await compRes.text();
      return NextResponse.json({
        ok: false,
        error: `Conexión con Entra ID exitosa, pero Business Central devolvió error ${compRes.status}: ${errText}. Verifica que la aplicación esté dada de alta en "Aplicaciones de Microsoft Entra" dentro de Business Central.`
      }, { status: 400 });
    }

    const compData = await compRes.json();
    const companies = (compData.value || []).map((c: any) => ({
      id: c.id,
      name: c.name,
      displayName: c.displayName || c.name,
    }));

    // 3. Guardar en base de datos si no es solo test
    if (!testOnly) {
      await prisma.businessCentralConfig.upsert({
        where: { id: 1 },
        update: {
          tenantId: tenantId.trim(),
          clientId: clientId.trim(),
          clientSecret: finalSecret,
          environment: env,
          companyId: companyId || (companies[0]?.name ?? ''),
        },
        create: {
          id: 1,
          tenantId: tenantId.trim(),
          clientId: clientId.trim(),
          clientSecret: finalSecret,
          environment: env,
          companyId: companyId || (companies[0]?.name ?? ''),
        }
      });
    }

    return NextResponse.json({
      ok: true,
      message: 'Conexión verificada con éxito con Microsoft Dynamics 365 Business Central.',
      companies,
    });
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }
}