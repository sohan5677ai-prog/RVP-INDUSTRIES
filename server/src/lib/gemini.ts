import { GoogleGenAI, Type } from '@google/genai';
import { HttpError } from './httpError.js';

/**
 * Fields that can come back from reading a stock-in document. Every field is
 * optional — Gemini fills in whatever it can confidently read. Which fields are
 * requested depends on the document `kind` being read.
 */
export interface ExtractedInvoice {
  invoiceNumber?: string;
  lorryNumber?: string;
  arrivalDate?: string; // ISO yyyy-mm-dd
  billingWeightKg?: number;
  partyKataKg?: number;
  rvpFirstWeightKg?: number;
}

/** Which stock-in document is being read. */
export type DocumentKind = 'invoice' | 'partyKata' | 'rvpWeight';

const PROMPTS: Record<DocumentKind, string> = {
  invoice: `You are reading a supplier's lorry INVOICE for a tamarind/agro trading business.
Extract these fields and return them as JSON:
- invoiceNumber: the invoice / bill number printed on the document (string).
- lorryNumber: the lorry / vehicle registration number (e.g. "AP02AB1234"). Remove spaces.
- arrivalDate: the invoice date in ISO format yyyy-mm-dd.
- billingWeightKg: the billed net weight/quantity, CONVERTED TO KILOGRAMS. Invoices often
  state weight in tonnes ("MT") or quintals — convert: 1 tonne = 1000 kg, 1 quintal = 100 kg.
  Return a whole number of kilograms.
Only include a field you can read with reasonable confidence. Do not guess.`,

  partyKata: `You are reading a supplier's WEIGHBRIDGE SLIP ("party kata") for a tamarind/agro business.
Extract these fields and return them as JSON:
- partyKataKg: the net weight shown on the supplier's weighbridge slip, in KILOGRAMS.
  Convert tonnes/quintals to kg (1 tonne = 1000 kg, 1 quintal = 100 kg). Whole number.
- lorryNumber: the lorry / vehicle registration number if shown (e.g. "AP02AB1234"). Remove spaces.
Only include a field you can read with reasonable confidence. Do not guess.`,

  rvpWeight: `You are reading OUR OWN weighbridge slip ("RVP Kata") for a loaded lorry of tamarind seed.
Extract this field and return it as JSON:
- rvpFirstWeightKg: the FIRST / GROSS weight (the loaded lorry weight) in KILOGRAMS.
  Convert tonnes/quintals to kg (1 tonne = 1000 kg, 1 quintal = 100 kg). Whole number.
If the slip shows multiple weights, pick the larger (loaded) one as the first weight.
Only include the field if you can read it with reasonable confidence. Do not guess.`,
};

const SCHEMAS: Record<DocumentKind, object> = {
  invoice: {
    type: Type.OBJECT,
    properties: {
      invoiceNumber: { type: Type.STRING },
      lorryNumber: { type: Type.STRING },
      arrivalDate: { type: Type.STRING },
      billingWeightKg: { type: Type.NUMBER },
    },
  },
  partyKata: {
    type: Type.OBJECT,
    properties: {
      partyKataKg: { type: Type.NUMBER },
      lorryNumber: { type: Type.STRING },
    },
  },
  rvpWeight: {
    type: Type.OBJECT,
    properties: {
      rvpFirstWeightKg: { type: Type.NUMBER },
    },
  },
};

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new HttpError(
      503,
      'Invoice reading is not configured. Set GEMINI_API_KEY in the server environment.'
    );
  }
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

/**
 * Send a stock-in document (image or PDF) to Gemini and extract the fields
 * relevant to its `kind`. Throws HttpError on configuration or upstream failure.
 */
export async function extractInvoiceData(
  buffer: Buffer,
  mimeType: string,
  kind: DocumentKind = 'invoice'
): Promise<ExtractedInvoice> {
  const ai = getClient();

  let response;
  try {
    response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { text: PROMPTS[kind] },
            { inlineData: { mimeType, data: buffer.toString('base64') } },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: SCHEMAS[kind],
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    throw new HttpError(502, `Gemini could not read the document: ${message}`);
  }

  const text = response.text;
  if (!text) throw new HttpError(502, 'Gemini returned an empty response');

  let parsed: ExtractedInvoice;
  try {
    parsed = JSON.parse(text) as ExtractedInvoice;
  } catch {
    throw new HttpError(502, 'Gemini returned an unreadable response');
  }

  // Normalise: trim strings, round weights to whole positive kg, drop blanks.
  const clean: ExtractedInvoice = {};
  if (parsed.invoiceNumber?.toString().trim()) clean.invoiceNumber = parsed.invoiceNumber.toString().trim();
  if (parsed.lorryNumber?.toString().trim()) clean.lorryNumber = parsed.lorryNumber.toString().replace(/\s+/g, '').trim();
  if (parsed.arrivalDate?.toString().trim()) clean.arrivalDate = parsed.arrivalDate.toString().trim();
  if (typeof parsed.billingWeightKg === 'number' && parsed.billingWeightKg > 0) {
    clean.billingWeightKg = Math.round(parsed.billingWeightKg);
  }
  if (typeof parsed.partyKataKg === 'number' && parsed.partyKataKg > 0) {
    clean.partyKataKg = Math.round(parsed.partyKataKg);
  }
  if (typeof parsed.rvpFirstWeightKg === 'number' && parsed.rvpFirstWeightKg > 0) {
    clean.rvpFirstWeightKg = Math.round(parsed.rvpFirstWeightKg);
  }
  return clean;
}
