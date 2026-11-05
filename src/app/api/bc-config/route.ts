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

    let current: any = null;
    try {
      current = await prisma.businessCentralConfig.findUnique({ where: { id: 1 } });
    } catch (e: any) {
      console.warn('Advertencia al consultar BD en bc-config:', e.message);
    }

    const effective = await getEffectiveBcConfig();
    const finalTenant = (tenantId || current?.tenantId || effective.tenantId || '').trim();
    const finalClient = (clientId || current?.clientId || effective.clientId || '').trim();
    const finalSecret = clientSecret ? clientSecret.trim() : (current?.clientSecret || effective.clientSecret || '');

    if (!finalTenant || !finalClient || !finalSecret) {
      return NextResponse.json({
        ok: false,
        error: 'Debes proporcionar Tenant ID, Client ID y Client Secret para conectar con Business Central.'
      }, { status: 400 });
    }

    // 1. Probar obtención de token OAuth en Microsoft Entra ID
    const token = await getAccessToken(finalTenant, finalClient, finalSecret);

    // 2. Probar acceso a la API de Business Central y listar empresas
    let activeEnv = environment?.trim() || effective.environment || 'Production';
    let root = `https://api.businesscentral.dynamics.com/v2.0/${finalTenant}/${encodeURIComponent(activeEnv)}`;
    let compRes = await fetch(`${root}/api/v2.0/companies`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      cache: 'no-store',
    });

    // Si devuelve 404 NoEnvironment, probar automáticamente variantes comunes de nombres de entorno
    if (!compRes.ok && compRes.status === 404) {
      const errClone = compRes.clone();
      const errText = await errClone.text();
      if (/NoEnvironment|Environment does not exist/i.test(errText)) {
        const candidates = ['Produccion', 'Producción', 'PROD', 'Production', 'Sandbox', 'Sandbox1', 'Live', 'Test']
          .filter(c => c.toLowerCase() !== activeEnv.toLowerCase());

        for (const candidate of candidates) {
          const testRoot = `https://api.businesscentral.dynamics.com/v2.0/${finalTenant}/${encodeURIComponent(candidate)}`;
          try {
            const probe = await fetch(`${testRoot}/api/v2.0/companies`, {
              headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
              cache: 'no-store',
            });
            if (probe.ok) {
              activeEnv = candidate;
              compRes = probe;
              root = testRoot;
              break;
            }
          } catch {}
        }
      }
    }

    if (!compRes.ok) {
      const errText = await compRes.text();
      const isNoEnv = /NoEnvironment|Environment does not exist/i.test(errText);
      const helpMsg = isNoEnv
        ? ` El entorno "${activeEnv}" no existe en este Tenant de Business Central. Revisa el nombre exacto del entorno en la URL de Business Central (ej. https://businesscentral.dynamics.com/<tenant>/<entorno>) o en el Business Central Admin Center (suele ser "Produccion", "Sandbox", "PROD", etc.).`
        : ` Verifica que la aplicación esté dada de alta en "Aplicaciones de Microsoft Entra" dentro de Business Central.`;

      return NextResponse.json({
        ok: false,
        error: `Conexión con Entra ID exitosa, pero Business Central devolvió error ${compRes.status}: ${errText}.${helpMsg}`
      }, { status: 400 });
    }

    const compData = await compRes.json();
    const companies = (compData.value || []).map((c: any) => ({
      id: c.id,
      name: c.name,
      displayName: c.displayName || c.name,
    }));

    // 3. Guardar en base de datos si no es solo test (con tolerancia a entornos serverless de solo lectura)
    if (!testOnly) {
      try {
        await prisma.businessCentralConfig.upsert({
          where: { id: 1 },
          update: {
            tenantId: finalTenant,
            clientId: finalClient,
            clientSecret: finalSecret,
            environment: activeEnv,
            companyId: companyId || (companies[0]?.name ?? ''),
          },
          create: {
            id: 1,
            tenantId: finalTenant,
            clientId: finalClient,
            clientSecret: finalSecret,
            environment: activeEnv,
            companyId: companyId || (companies[0]?.name ?? ''),
          }
        });
      } catch (dbErr: any) {
        console.warn('Aviso: no se pudo escribir en SQLite en entorno serverless (Vercel):', dbErr.message);
      }
    }

    const res = NextResponse.json({
      ok: true,
      detectedEnvironment: activeEnv !== environment?.trim() ? activeEnv : undefined,
      message: activeEnv !== environment?.trim()
        ? `Conexión verificada con éxito con Business Central (entorno detectado: "${activeEnv}").`
        : 'Conexión verificada con éxito con Microsoft Dynamics 365 Business Central.',
      companies,
    });

    if (!testOnly && finalSecret) {
      res.cookies.set('bc_client_secret', finalSecret, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 31536000,
      });
    }

    return res;
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }
}