import { describe, it, expect } from 'vitest';
import {
  PRODUCTION_ORIGINS,
  isOriginAllowed,
  originPolicyFromEnv,
  parseAllowedOrigins,
  type OriginPolicy,
} from './corsOrigin.js';

const prod: OriginPolicy = {
  allowed: parseAllowedOrigins('https://erp.rvpindustries.com'),
  allowLocalhost: false,
};

describe('parseAllowedOrigins', () => {
  it('always includes the deployed client origin', () => {
    expect(parseAllowedOrigins(undefined)).toEqual(PRODUCTION_ORIGINS);
    expect(parseAllowedOrigins('')).toEqual(PRODUCTION_ORIGINS);
  });

  it('adds configured origins and normalises them', () => {
    const list = parseAllowedOrigins(' https://A.example.com/ , https://b.example.com ');
    expect(list).toContain('https://a.example.com');
    expect(list).toContain('https://b.example.com');
  });

  it('drops blank entries so a stray comma cannot widen the list', () => {
    expect(parseAllowedOrigins('https://a.example.com,,  ,')).toEqual([
      ...PRODUCTION_ORIGINS,
      'https://a.example.com',
    ]);
  });

  it('does not duplicate the production origin when it is also configured', () => {
    const list = parseAllowedOrigins('https://rvp-industries.vercel.app');
    expect(list.filter((o) => o === 'https://rvp-industries.vercel.app')).toHaveLength(1);
  });
});

describe('isOriginAllowed', () => {
  it('accepts the deployed client', () => {
    expect(isOriginAllowed('https://rvp-industries.vercel.app', prod)).toBe(true);
  });

  it('accepts a configured custom domain, with or without a trailing slash', () => {
    expect(isOriginAllowed('https://erp.rvpindustries.com', prod)).toBe(true);
    expect(isOriginAllowed('https://erp.rvpindustries.com/', prod)).toBe(true);
  });

  // The bugs this module exists to fix.
  it('rejects a hostname that merely CONTAINS localhost', () => {
    expect(isOriginAllowed('https://rvp-localhost.attacker.com', prod)).toBe(false);
    expect(isOriginAllowed('https://localhost.attacker.com', prod)).toBe(false);
    expect(isOriginAllowed('https://127.0.0.1.attacker.com', prod)).toBe(false);
  });

  it('rejects other vercel.app deployments', () => {
    expect(isOriginAllowed('https://someone-elses-app.vercel.app', prod)).toBe(false);
    expect(isOriginAllowed('https://rvp-industries.vercel.app.attacker.com', prod)).toBe(false);
  });

  it('rejects a subdomain of an allowed origin', () => {
    expect(isOriginAllowed('https://evil.erp.rvpindustries.com', prod)).toBe(false);
  });

  it('rejects the same host on the wrong scheme', () => {
    expect(isOriginAllowed('http://erp.rvpindustries.com', prod)).toBe(false);
  });

  it('rejects empty, malformed and non-http origins', () => {
    expect(isOriginAllowed('', prod)).toBe(false);
    expect(isOriginAllowed('null', prod)).toBe(false);
    expect(isOriginAllowed('not a url', prod)).toBe(false);
    expect(isOriginAllowed('file:///etc/passwd', prod)).toBe(false);
  });

  it('rejects localhost in production', () => {
    expect(isOriginAllowed('http://localhost:5173', prod)).toBe(false);
    expect(isOriginAllowed('http://127.0.0.1:5173', prod)).toBe(false);
  });

  it('accepts localhost on any port outside production', () => {
    const dev: OriginPolicy = { allowed: parseAllowedOrigins(undefined), allowLocalhost: true };
    expect(isOriginAllowed('http://localhost:5173', dev)).toBe(true);
    expect(isOriginAllowed('http://localhost:4000', dev)).toBe(true);
    expect(isOriginAllowed('https://127.0.0.1:8443', dev)).toBe(true);
    expect(isOriginAllowed('http://[::1]:5173', dev)).toBe(true);
    // Still a whole-hostname match, even in development.
    expect(isOriginAllowed('https://rvp-localhost.attacker.com', dev)).toBe(false);
  });
});

describe('originPolicyFromEnv', () => {
  it('trusts localhost only outside production', () => {
    expect(originPolicyFromEnv({ NODE_ENV: 'production' } as NodeJS.ProcessEnv).allowLocalhost).toBe(
      false
    );
    expect(originPolicyFromEnv({ NODE_ENV: 'development' } as NodeJS.ProcessEnv).allowLocalhost).toBe(
      true
    );
    expect(originPolicyFromEnv({} as NodeJS.ProcessEnv).allowLocalhost).toBe(true);
  });

  it('reads CLIENT_ORIGIN', () => {
    const policy = originPolicyFromEnv({
      NODE_ENV: 'production',
      CLIENT_ORIGIN: 'https://erp.rvpindustries.com',
    } as NodeJS.ProcessEnv);
    expect(policy.allowed).toContain('https://erp.rvpindustries.com');
    expect(policy.allowed).toContain('https://rvp-industries.vercel.app');
  });
});
