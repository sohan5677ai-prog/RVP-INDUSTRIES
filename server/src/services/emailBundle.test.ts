import { describe, it, expect, vi } from 'vitest';
import { invoiceEmailHtml } from '../lib/emailTemplates.js';
import { emailService } from './email.service.js';

describe('Document Email Bundle & Modern Templates', () => {
  it('renders modern invoice & dispatch bundle HTML template with EWB and LR info', () => {
    const html = invoiceEmailHtml({
      partyName: 'Sri Ganesh Traders',
      invoiceNumber: 'RVP/S/123/26-27',
      invoiceDate: new Date('2026-09-07'),
      amount: 157500,
      irn: 'abc123irn456789',
      vehicleNumber: 'AP 07 TB 4321',
      companyName: 'RVP INDUSTRIES',
      companyAddress: 'Punganur, AP',
      companyGstin: '37AABFR1234A1Z5',
      companyContact: '+91 98765 43210',
      ewbNumber: '331001234567',
      ewbValidUpto: new Date('2026-09-10'),
      lrNumber: 'GC-9942',
      attachedDocs: ['Tax Invoice', 'E-Way Bill', 'Lorry Receipt'],
    });

    expect(html).toContain('Tax Invoice & Dispatch Documents');
    expect(html).toContain('Sri Ganesh Traders');
    expect(html).toContain('RVP/S/123/26-27');
    expect(html).toContain('331001234567');
    expect(html).toContain('GC-9942');
    expect(html).toContain('Tax Invoice + E-Way Bill + Lorry Receipt');
    expect(html).toContain('combined document package');
  });

  it('emailService.sendEmail safely supports cc and bcc without throwing when unconfigured', async () => {
    const result = await emailService.sendEmail({
      to: 'buyer@example.com',
      cc: 'broker@example.com',
      bcc: 'company-bcc@rvpindustries.com',
      subject: 'Test Bundle',
      html: '<p>Test</p>',
    });

    // When RESEND_API_KEY is not set or in dev, it safely returns null without crash
    expect(result).toBeNull();
  });
});
