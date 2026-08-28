import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

function makeRequest(url = 'http://localhost:3000/marketplace') {
  return new NextRequest(url);
}

describe('middleware — nonce-based CSP (issue #649)', () => {
  it('sets a Content-Security-Policy header with a nonce-based script-src', () => {
    const response = middleware(makeRequest());
    const csp = response.headers.get('Content-Security-Policy');

    expect(csp).toBeTruthy();
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  });

  it('never allows unsafe-inline or unsafe-eval in script-src', () => {
    const response = middleware(makeRequest());
    const csp = response.headers.get('Content-Security-Policy');
    const scriptSrcDirective = csp.split(';').find((d) => d.trim().startsWith('script-src'));

    expect(scriptSrcDirective).not.toContain('unsafe-inline');
    expect(scriptSrcDirective).not.toContain('unsafe-eval');
  });

  it('generates a different nonce on every request', () => {
    const csp1 = middleware(makeRequest()).headers.get('Content-Security-Policy');
    const csp2 = middleware(makeRequest()).headers.get('Content-Security-Policy');

    const nonce1 = csp1.match(/'nonce-([A-Za-z0-9+/=]+)'/)[1];
    const nonce2 = csp2.match(/'nonce-([A-Za-z0-9+/=]+)'/)[1];

    expect(nonce1).not.toBe(nonce2);
  });

  it('threads the same nonce through the x-nonce request header used by layout.js', () => {
    const response = middleware(makeRequest());
    const csp = response.headers.get('Content-Security-Policy');
    const nonceInCsp = csp.match(/'nonce-([A-Za-z0-9+/=]+)'/)[1];
    const nonceHeader = response.headers.get('x-middleware-request-x-nonce');

    expect(nonceHeader).toBe(nonceInCsp);
  });

  it('sets object-src none and frame-ancestors none', () => {
    const response = middleware(makeRequest());
    const csp = response.headers.get('Content-Security-Policy');

    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('includes a report-uri pointing at the CSP report endpoint', () => {
    const response = middleware(makeRequest());
    const csp = response.headers.get('Content-Security-Policy');

    expect(csp).toContain('report-uri /api/csp-report');
  });
});
