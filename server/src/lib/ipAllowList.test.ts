import { describe, it, expect } from 'vitest';
import { ipMatchesCidr, normaliseIp } from './ipAllowList.js';

describe('normaliseIp', () => {
  it('unwraps an IPv4-mapped IPv6 address', () => {
    // This is the form Express hands back behind Render's proxy, and it must
    // match a plain IPv4 rule or the allow-list would reject the office.
    expect(normaliseIp('::ffff:203.0.113.4')).toBe('203.0.113.4');
    expect(normaliseIp('::FFFF:203.0.113.4')).toBe('203.0.113.4');
  });

  it('passes other addresses through, trimmed', () => {
    expect(normaliseIp('203.0.113.4')).toBe('203.0.113.4');
    expect(normaliseIp('  203.0.113.4  ')).toBe('203.0.113.4');
    expect(normaliseIp('2001:db8::1')).toBe('2001:db8::1');
  });

  it('returns null for nothing', () => {
    expect(normaliseIp(undefined)).toBeNull();
    expect(normaliseIp('')).toBeNull();
  });
});

describe('ipMatchesCidr', () => {
  it('matches a bare address exactly', () => {
    expect(ipMatchesCidr('203.0.113.4', '203.0.113.4')).toBe(true);
    expect(ipMatchesCidr('203.0.113.5', '203.0.113.4')).toBe(false);
  });

  it('matches inside a /24', () => {
    expect(ipMatchesCidr('203.0.113.1', '203.0.113.0/24')).toBe(true);
    expect(ipMatchesCidr('203.0.113.255', '203.0.113.0/24')).toBe(true);
    expect(ipMatchesCidr('203.0.114.1', '203.0.113.0/24')).toBe(false);
  });

  it('handles /32 without the shift-by-32 trap', () => {
    // `0xffffffff << 0` is a no-op in JS, which is why /32 is special-cased.
    expect(ipMatchesCidr('203.0.113.4', '203.0.113.4/32')).toBe(true);
    expect(ipMatchesCidr('203.0.113.5', '203.0.113.4/32')).toBe(false);
  });

  it('treats /0 as everything', () => {
    expect(ipMatchesCidr('8.8.8.8', '0.0.0.0/0')).toBe(true);
  });

  it('handles prefixes that are not on a byte boundary', () => {
    // 203.0.113.0/25 covers .0-.127 only.
    expect(ipMatchesCidr('203.0.113.100', '203.0.113.0/25')).toBe(true);
    expect(ipMatchesCidr('203.0.113.128', '203.0.113.0/25')).toBe(false);
    // /20 spans 16 third-octet values from 113 & 0xf0 = 112.
    expect(ipMatchesCidr('203.0.112.1', '203.0.113.0/20')).toBe(true);
    expect(ipMatchesCidr('203.0.127.255', '203.0.113.0/20')).toBe(true);
    expect(ipMatchesCidr('203.0.128.1', '203.0.113.0/20')).toBe(false);
  });

  it('rejects malformed rules rather than matching broadly', () => {
    // A bad rule must never become a wildcard.
    for (const bad of ['', '   ', '203.0.113.0/33', '203.0.113.0/-1', '203.0.113.0/abc']) {
      expect(ipMatchesCidr('203.0.113.4', bad)).toBe(false);
    }
  });

  it('rejects malformed addresses', () => {
    expect(ipMatchesCidr('203.0.113', '203.0.113.0/24')).toBe(false);
    expect(ipMatchesCidr('203.0.113.999', '203.0.113.0/24')).toBe(false);
    expect(ipMatchesCidr('not-an-ip', '203.0.113.0/24')).toBe(false);
    expect(ipMatchesCidr('203.0.113.04x', '203.0.113.0/24')).toBe(false);
  });

  it('matches an IPv6 rule only literally, which is the documented behaviour', () => {
    expect(ipMatchesCidr('2001:db8::1', '2001:db8::1')).toBe(true);
    expect(ipMatchesCidr('2001:db8::2', '2001:db8::1')).toBe(false);
    // No IPv6 prefix maths is attempted; the base must match exactly.
    expect(ipMatchesCidr('2001:db8::1', '2001:db8::/32')).toBe(false);
  });

  it('does not let an IPv4 address match an IPv6 rule or vice versa', () => {
    expect(ipMatchesCidr('203.0.113.4', '2001:db8::/32')).toBe(false);
    expect(ipMatchesCidr('2001:db8::1', '203.0.113.0/24')).toBe(false);
  });
});
