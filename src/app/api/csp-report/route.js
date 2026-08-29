// Issue #649: CSP violation reporting endpoint (middleware.js's
// `report-uri /api/csp-report`).
//
// A CSP report body can contain `blocked-uri`, `source-file`, and
// `script-sample` fields that may include full URLs with query strings
// (potentially carrying session tokens or material access tokens) or
// fragments of the actual blocked script/inline content. This endpoint
// deliberately logs only the violated directive and a stripped-down,
// query-free version of the document/blocked URI — never the raw report
// body — so a violation report can't itself become a way to leak
// sensitive material metadata or tokens into logs.

import { NextResponse } from 'next/server'
import { auditLog } from '@/lib/api/audit'

function stripQueryAndFragment(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null
  try {
    const url = new URL(rawUrl, 'https://placeholder.invalid')
    return `${url.origin === 'https://placeholder.invalid' ? '' : url.origin}${url.pathname}`
  } catch {
    // Not a parseable absolute/relative URL (e.g. "inline", "eval") — these
    // values are already safe, fixed keywords, not user/token-bearing data.
    return rawUrl.split('?')[0]
  }
}

export async function POST(request) {
  try {
    const body = await request.json()
    // Both the modern Reporting API shape ({ "csp-report": {...} }) and a
    // raw-object shape are accepted, since browser support for the report
    // format has changed over time.
    const report = body['csp-report'] || body

    auditLog({
      event: 'csp_violation',
      route: 'csp-report',
      method: 'POST',
      status: 200,
      reason: `${report['violated-directive'] || report.violatedDirective || 'unknown-directive'}::${stripQueryAndFragment(
        report['blocked-uri'] || report.blockedURI
      )}`,
    })
  } catch {
    // A malformed report body is not itself actionable — still return 200
    // so the browser doesn't retry indefinitely, but don't log anything
    // for a body we couldn't even safely parse.
  }

  return NextResponse.json({ received: true }, { status: 200 })
}
