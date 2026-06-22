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
  partyName?: string; // supplier/seller name printed on the invoice
  pricePerKg?: number; // rate per kg quoted on the invoice
  matchedPartyName?: string; // exact known-supplier name this invoice maps to, if any
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
- partyName: the SUPPLIER / SELLER / consignor name printed on the invoice — the business
  that issued the bill (usually at the top, near "From" / "Seller" / GSTIN). NOT the buyer
  ("RVP" / "M/s RVP" is the buyer — do not return that).
- pricePerKg: the unit RATE per KILOGRAM. If the rate is quoted per tonne or per quintal,
  convert it to a per-kg rate (1 tonne = 1000 kg, 1 quintal = 100 kg). A plain number.
Only include a field you can read with reasonable confidence. Do not guess.`,

  partyKata: `You are reading a supplier's WEIGHBRIDGE SLIP ("party kata") for a tamarind/agro business.
A weighbridge slip records a GROSS (loaded lorry) weight, a TARE (empty lorry) weight, and a
NET weight of the goods, where NET = GROSS − TARE. We want the NET weight, in kilograms.

CRITICAL: on these printed slips the LABELS are often shifted and DO NOT line up with the number
beside them (e.g. the gross value may be printed next to "Rupees" or "Tare Wt."). So do NOT trust
the label next to a number. Work out the weights from arithmetic instead:
- Look only at the numbers that are WEIGHTS in kg. Ignore date, time, serial/vehicle number, and
  any rupee/amount value.
- The GROSS weight is the LARGEST of those weight numbers.
- The NET weight you must return = GROSS − TARE, where TARE is the empty-lorry weight. NET must be
  POSITIVE and smaller than the gross.
- If THREE weight numbers are present and one of them equals (largest − one of the others), then
  that value IS the net — return it. (Example: weights 42870, 11350, 31520 → gross 42870, and
  42870 − 11350 = 31520, so the net is 31520.)
- If only TWO weight numbers are present, NET = larger − smaller.
- Never return a negative, zero, or the largest (gross) value as the net.

Return these fields as JSON:
- partyKataKg: the NET weight as worked out above. Convert tonnes/quintals to kg (1 tonne = 1000 kg,
  1 quintal = 100 kg) and return a whole number. Always return this if any weights are legible.
- lorryNumber: the lorry / vehicle registration number if shown (e.g. "TN28BA4946"). Remove spaces.`,

  rvpWeight: `You are reading OUR OWN weighbridge slip ("RVP Kata") for a loaded lorry of tamarind seed.
Extract these fields and return them as JSON:
- rvpFirstWeightKg: the FIRST / GROSS weight (the loaded lorry weight) in KILOGRAMS.
  Convert tonnes/quintals to kg (1 tonne = 1000 kg, 1 quintal = 100 kg). Whole number.
- lorryNumber: the lorry / vehicle registration number if shown (e.g. "AP02AB1234"). Remove spaces.
If the slip shows multiple weights, pick the larger (loaded) one as the first weight.
Only include a field you can read with reasonable confidence. Do not guess.`,
};

/**
 * Extra instructions appended to the invoice prompt when we know the list of
 * suppliers an invoice could belong to, asking Gemini to pick the matching one
 * (handling abbreviations, initials, "M/s", punctuation and minor spelling).
 */
function invoiceMatchPrompt(candidates: string[]): string {
  return `
Below is a list of KNOWN SUPPLIERS in our system. Decide which one (if any) issued this
invoice — the SELLER, not the buyer. Match by meaning, allowing for abbreviations, initials,
extra words like "M/s", dots and punctuation, and minor spelling differences. For example a
list entry "DCS" could appear on the invoice as "D.C.S." or "Devi Cotton Syndicate", and
"K.N.M. Traders" could be listed as "KNM Traders".
- matchedPartyName: copy the matching entry EXACTLY as written in the list below. If none of
  them clearly corresponds to the seller, omit this field entirely. Never invent a name.
Known suppliers: ${JSON.stringify(candidates)}`;
}

const SCHEMAS: Record<DocumentKind, object> = {
  invoice: {
    type: Type.OBJECT,
    properties: {
      invoiceNumber: { type: Type.STRING },
      lorryNumber: { type: Type.STRING },
      arrivalDate: { type: Type.STRING },
      billingWeightKg: { type: Type.NUMBER },
      partyName: { type: Type.STRING },
      pricePerKg: { type: Type.NUMBER },
      matchedPartyName: { type: Type.STRING },
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
      lorryNumber: { type: Type.STRING },
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
  kind: DocumentKind = 'invoice',
  candidates: string[] = []
): Promise<ExtractedInvoice> {
  const ai = getClient();

  // For invoices, append the known-supplier list so Gemini can map the seller
  // to one of our master parties despite abbreviations/spelling differences.
  const prompt =
    kind === 'invoice' && candidates.length > 0
      ? PROMPTS.invoice + '\n' + invoiceMatchPrompt(candidates)
      : PROMPTS[kind];

  let response;
  try {
    response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
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
  if (parsed.partyName?.toString().trim()) clean.partyName = parsed.partyName.toString().trim();
  if (typeof parsed.pricePerKg === 'number' && parsed.pricePerKg > 0) {
    clean.pricePerKg = parsed.pricePerKg;
  }
  // Only trust matchedPartyName if it is exactly one of the candidates we sent
  // (case-insensitive), so Gemini can't invent a supplier. Return the canonical
  // spelling from our list, not Gemini's echo.
  const matchEcho = parsed.matchedPartyName?.toString().trim().toLowerCase();
  if (matchEcho) {
    const canonical = candidates.find((c) => c.trim().toLowerCase() === matchEcho);
    if (canonical) clean.matchedPartyName = canonical;
  }
  return clean;
}

/**
 * Fields parsed from a free-text purchase-order instruction sent over Slack
 * (e.g. "22 Jun, DCS Traders, 50 tonnes, 25.5/kg"). Every field is optional —
 * the bot confirms/edits before anything is created.
 */
export interface ExtractedPurchaseOrder {
  poDate?: string; // ISO yyyy-mm-dd
  partyName?: string; // raw party name as written in the message
  matchedPartyName?: string; // exact known-supplier name this maps to, if any
  tonnageTonnes?: number; // committed quantity in TONNES
  pricePerKg?: number; // rate per kg
  priceType?: 'BASE' | 'DELIVERY';
}

const PO_TEXT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    poDate: { type: Type.STRING },
    partyName: { type: Type.STRING },
    matchedPartyName: { type: Type.STRING },
    tonnageTonnes: { type: Type.NUMBER },
    pricePerKg: { type: Type.NUMBER },
    priceType: { type: Type.STRING },
  },
} as const;

/**
 * Parse a short purchase-order instruction into structured fields, mapping the
 * party to one of our known suppliers where possible. Text-only (no document).
 */
export async function extractPurchaseOrderText(
  text: string,
  candidates: string[] = []
): Promise<ExtractedPurchaseOrder> {
  const ai = getClient();
  const today = new Date().toISOString().slice(0, 10);

  const prompt = `You are reading a SHORT purchase-order instruction for a tamarind/agro trading
business. Today's date is ${today}. Extract these fields and return them as JSON:
- poDate: the order date in ISO format yyyy-mm-dd. If only a day/month is given, assume the
  current or most recent matching date relative to today. If no date is given, use today.
- partyName: the SUPPLIER / party name exactly as written in the message.
- tonnageTonnes: the committed quantity in TONNES. If the quantity is stated in kg or quintals,
  convert to tonnes (1000 kg = 1 tonne, 1 quintal = 0.1 tonne). A plain number.
- pricePerKg: the rate per KILOGRAM. If quoted per tonne or per quintal, convert to per-kg
  (1 tonne = 1000 kg, 1 quintal = 100 kg). A plain number.
- priceType: "BASE" if the price is at the supplier's location / ex-works / loading point
  ("base", "ex", "at their place"); "DELIVERY" if landed / delivered to us. Omit if unclear.
Only include a field you can read with reasonable confidence. Do not guess.
${
  candidates.length > 0
    ? `\nBelow is a list of KNOWN SUPPLIERS. Decide which one (if any) this order is for. Match by
meaning, allowing for abbreviations, initials, "M/s", punctuation and minor spelling
differences.
- matchedPartyName: copy the matching entry EXACTLY as written in the list below. If none
  clearly corresponds, omit this field. Never invent a name.
Known suppliers: ${JSON.stringify(candidates)}`
    : ''
}

Message: ${JSON.stringify(text)}`;

  let response;
  try {
    response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { responseMimeType: 'application/json', responseSchema: PO_TEXT_SCHEMA },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    throw new HttpError(502, `Gemini could not read the message: ${message}`);
  }

  const out = response.text;
  if (!out) throw new HttpError(502, 'Gemini returned an empty response');

  let parsed: ExtractedPurchaseOrder;
  try {
    parsed = JSON.parse(out) as ExtractedPurchaseOrder;
  } catch {
    throw new HttpError(502, 'Gemini returned an unreadable response');
  }

  const clean: ExtractedPurchaseOrder = {};
  if (parsed.poDate?.toString().trim()) clean.poDate = parsed.poDate.toString().trim();
  if (parsed.partyName?.toString().trim()) clean.partyName = parsed.partyName.toString().trim();
  if (typeof parsed.tonnageTonnes === 'number' && parsed.tonnageTonnes > 0) {
    clean.tonnageTonnes = parsed.tonnageTonnes;
  }
  if (typeof parsed.pricePerKg === 'number' && parsed.pricePerKg > 0) {
    clean.pricePerKg = parsed.pricePerKg;
  }
  const pt = parsed.priceType?.toString().trim().toUpperCase();
  if (pt === 'BASE' || pt === 'DELIVERY') clean.priceType = pt;

  // Only trust a match that is exactly one of the candidates (case-insensitive).
  const matchEcho = parsed.matchedPartyName?.toString().trim().toLowerCase();
  if (matchEcho) {
    const canonical = candidates.find((c) => c.trim().toLowerCase() === matchEcho);
    if (canonical) clean.matchedPartyName = canonical;
  }
  return clean;
}

/**
 * Fields parsed from a free-text sale-order instruction sent over Slack
 * (e.g. "Krishna Exports, broker Ramesh, 20 tonnes pappu, 95/kg"). Optional —
 * the bot confirms/edits before anything is created.
 */
export interface ExtractedSaleOrder {
  saleDate?: string; // ISO yyyy-mm-dd
  buyerName?: string; // raw buyer name as written
  matchedBuyerName?: string; // exact known-buyer name this maps to, if any
  brokerName?: string; // raw broker name as written
  matchedBrokerName?: string; // exact known-broker name this maps to, if any
  tonnageTonnes?: number; // committed quantity in TONNES
  pricePerKg?: number; // rate per kg
  product?: 'PAPPU' | 'HUSK' | 'WASTE' | 'TPS' | 'SHELL';
}

const SALE_TEXT_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    saleDate: { type: Type.STRING },
    buyerName: { type: Type.STRING },
    matchedBuyerName: { type: Type.STRING },
    brokerName: { type: Type.STRING },
    matchedBrokerName: { type: Type.STRING },
    tonnageTonnes: { type: Type.NUMBER },
    pricePerKg: { type: Type.NUMBER },
    product: { type: Type.STRING },
  },
} as const;

const SALE_PRODUCTS = ['PAPPU', 'HUSK', 'WASTE', 'TPS', 'SHELL'] as const;

/**
 * Parse a short sale-order instruction into structured fields, mapping the buyer
 * and (optional) broker to known records where possible. Text-only.
 */
export async function extractSaleOrderText(
  text: string,
  buyers: string[] = [],
  brokers: string[] = []
): Promise<ExtractedSaleOrder> {
  const ai = getClient();
  const today = new Date().toISOString().slice(0, 10);

  const prompt = `You are reading a SHORT sale-order instruction for a tamarind/agro trading business.
Today's date is ${today}. Extract these fields and return them as JSON:
- saleDate: the order date in ISO yyyy-mm-dd. If only a day/month is given, resolve relative to
  today. If no date is given, use today.
- buyerName: the BUYER / customer name exactly as written.
- brokerName: the BROKER / commission-agent name exactly as written, if one is mentioned.
- tonnageTonnes: the committed quantity in TONNES (convert kg/quintals: 1000 kg = 1 t,
  1 quintal = 0.1 t). A plain number.
- pricePerKg: the rate per KILOGRAM (convert per-tonne/quintal to per-kg). A plain number.
- product: one of PAPPU, HUSK, WASTE, TPS, SHELL if clearly stated; omit otherwise.
Only include a field you can read with reasonable confidence. Do not guess.
${
  buyers.length > 0
    ? `\nKNOWN BUYERS — pick the one this order is for, matching by meaning (abbreviations,
initials, "M/s", punctuation, minor spelling). matchedBuyerName: copy the matching entry
EXACTLY as written below, or omit if none clearly matches. Never invent a name.
Known buyers: ${JSON.stringify(buyers)}`
    : ''
}
${
  brokers.length > 0
    ? `\nKNOWN BROKERS — if a broker is mentioned, pick the matching one. matchedBrokerName: copy
the matching entry EXACTLY as written below, or omit. Never invent a name.
Known brokers: ${JSON.stringify(brokers)}`
    : ''
}

Message: ${JSON.stringify(text)}`;

  let response;
  try {
    response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { responseMimeType: 'application/json', responseSchema: SALE_TEXT_SCHEMA },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    throw new HttpError(502, `Gemini could not read the message: ${message}`);
  }

  const out = response.text;
  if (!out) throw new HttpError(502, 'Gemini returned an empty response');

  let parsed: ExtractedSaleOrder;
  try {
    parsed = JSON.parse(out) as ExtractedSaleOrder;
  } catch {
    throw new HttpError(502, 'Gemini returned an unreadable response');
  }

  const clean: ExtractedSaleOrder = {};
  if (parsed.saleDate?.toString().trim()) clean.saleDate = parsed.saleDate.toString().trim();
  if (parsed.buyerName?.toString().trim()) clean.buyerName = parsed.buyerName.toString().trim();
  if (parsed.brokerName?.toString().trim()) clean.brokerName = parsed.brokerName.toString().trim();
  if (typeof parsed.tonnageTonnes === 'number' && parsed.tonnageTonnes > 0) {
    clean.tonnageTonnes = parsed.tonnageTonnes;
  }
  if (typeof parsed.pricePerKg === 'number' && parsed.pricePerKg > 0) {
    clean.pricePerKg = parsed.pricePerKg;
  }
  const prod = parsed.product?.toString().trim().toUpperCase();
  if (prod && (SALE_PRODUCTS as readonly string[]).includes(prod)) {
    clean.product = prod as ExtractedSaleOrder['product'];
  }

  const buyerEcho = parsed.matchedBuyerName?.toString().trim().toLowerCase();
  if (buyerEcho) {
    const canonical = buyers.find((c) => c.trim().toLowerCase() === buyerEcho);
    if (canonical) clean.matchedBuyerName = canonical;
  }
  const brokerEcho = parsed.matchedBrokerName?.toString().trim().toLowerCase();
  if (brokerEcho) {
    const canonical = brokers.find((c) => c.trim().toLowerCase() === brokerEcho);
    if (canonical) clean.matchedBrokerName = canonical;
  }
  return clean;
}
