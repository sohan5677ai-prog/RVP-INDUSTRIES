/**
 * Preview script — renders all 7 email templates to HTML files in /tmp
 * for visual verification in a browser.
 *
 * Usage: npx tsx src/lib/previewEmailTemplates.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  invoiceEmailHtml,
  ewbEmailHtml,
  creditNoteEmailHtml,
  debitNoteEmailHtml,
  paymentReceivedEmailHtml,
  receiptEmailHtml,
  paymentReminderEmailHtml,
} from './emailTemplates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '../../email-previews');
fs.mkdirSync(outDir, { recursive: true });

const companyDefaults = {
  companyName: 'RVP INDUSTRIES',
  companyAddress: '3-97, Mangalapuram, Mangalagiri Mandal, Guntur District, Andhra Pradesh - 522503',
  companyGstin: '37AABFR1234A1Z5',
  companyContact: 'Phone: +91 98765 43210 | Email: accounts@rvpindustries.com',
};

const templates = [
  {
    name: '01-invoice',
    html: invoiceEmailHtml({
      partyName: 'Sri Ganesh Traders',
      invoiceNumber: 'RVP/S/042/25-26',
      invoiceDate: new Date('2025-09-15'),
      amount: 125400.00,
      irn: 'abc1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcde',
      vehicleNumber: 'AP 07 TB 4321',
      ...companyDefaults,
    }),
  },
  {
    name: '02-ewb',
    html: ewbEmailHtml({
      partyName: 'Sri Ganesh Traders',
      ewbNumber: '331001234567',
      invoiceNumber: 'RVP/S/042/25-26',
      invoiceDate: new Date('2025-09-15'),
      validUpto: new Date('2025-09-18'),
      vehicleNumber: 'AP 07 TB 4321',
      ...companyDefaults,
    }),
  },
  {
    name: '03-credit-note',
    html: creditNoteEmailHtml({
      partyName: 'Balaji Enterprises',
      creditNoteNumber: 'RVP/CN/005/25-26',
      creditNoteDate: new Date('2025-09-10'),
      amount: 18750.00,
      againstInvoice: 'RVP/S/038/25-26',
      reason: 'Quality difference - Grade B supplied instead of Grade A',
      ...companyDefaults,
    }),
  },
  {
    name: '04-debit-note',
    html: debitNoteEmailHtml({
      partyName: 'Sai Krishna Foods',
      debitNoteNumber: 'RVP/DN/003/25-26',
      debitNoteDate: new Date('2025-09-12'),
      amount: 8500.00,
      againstInvoice: 'RVP/S/035/25-26',
      reason: 'Freight charge adjustment',
      ...companyDefaults,
    }),
  },
  {
    name: '05-payment-received',
    html: paymentReceivedEmailHtml({
      partyName: 'Mahalakshmi Trading Co.',
      amount: 250000.00,
      paymentDate: new Date('2025-09-14'),
      paymentMode: 'NEFT',
      referenceNumber: 'UTIB0002345678901',
      againstInvoices: 'RVP/S/030, RVP/S/031',
      balanceOutstanding: 75400.00,
      ...companyDefaults,
    }),
  },
  {
    name: '06-receipt',
    html: receiptEmailHtml({
      partyName: 'Mahalakshmi Trading Co.',
      receiptNumber: 'RVP/RCT/018/25-26',
      receiptDate: new Date('2025-09-14'),
      amount: 250000.00,
      paymentMode: 'NEFT',
      referenceNumber: 'UTIB0002345678901',
      againstInvoices: 'RVP/S/030, RVP/S/031',
      ...companyDefaults,
    }),
  },
  {
    name: '07-payment-reminder',
    html: paymentReminderEmailHtml({
      partyName: 'Vijay Laxmi Spices Pvt Ltd',
      totalOutstanding: 487500.00,
      invoiceCount: 4,
      invoiceSummary: 'RVP/S/028 (₹1,25,000) · RVP/S/031 (₹98,750) · RVP/S/033 (₹1,50,000) · RVP/S/037 (₹1,13,750)',
      overdueSince: new Date('2025-08-20'),
      bankName: 'State Bank of India',
      bankAccountNumber: '39876543210',
      bankIfsc: 'SBIN0001234',
      bankAccountName: 'RVP Industries',
      ...companyDefaults,
    }),
  },
];

for (const t of templates) {
  const filePath = path.join(outDir, `${t.name}.html`);
  fs.writeFileSync(filePath, t.html, 'utf-8');
  console.log(`✅ ${filePath}`);
}

console.log(`\n🎉 All ${templates.length} templates written to: ${outDir}`);
console.log('Open any HTML file in your browser to preview.');
