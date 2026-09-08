import type { Request, Response } from 'express';
import { GoogleGenAI } from '@google/genai';
import { toolDeclarations, executeTool } from '../lib/chatTools.js';
import { HttpError } from '../lib/httpError.js';
import { prisma } from '../lib/prisma.js';

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new HttpError(503, 'GEMINI_API_KEY is missing');
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

const JARVIS_SYSTEM_PROMPT =
  "You are JARVIS — the RVP Industries ERP AI Assistant. You are intelligent, proactive, voice-interactive, and highly capable.\n" +
  "Think of yourself as the Iron Man JARVIS but for a Tamarind Processing business. You are sharp, efficient, and slightly witty.\n\n" +
  "RVP INDUSTRIES BUSINESS CONTEXT:\n" +
  "- Raw materials: 'Black Seed' (itemType: BLACK_SEED). Stored in storage locations (Rampalli, Murugan, Multi) or at the factory ('RVP').\n" +
  "- Milling/Processing: Processing input black seed yields 'White Pappu' (the primary kernel product, ~60% out-turn yield), 'Husk' (~25% yield), 'Waste' (~10% yield), and negligible loss (~5%).\n" +
  "- Tamarind Shell (SHELL) is a processing byproduct sent to Rampalli and sold from there.\n" +
  "- Internal Logistics: Seeds move storage -> process via StockTransfer (capitalizing transport and loading/unloading hamali costs into the process stock value).\n" +
  "- Sales: A SaleOrder specifies product, customer, total weight, and credit days. Actual deliveries are made via one or more physical lorry shipments called 'SaleDispatch'. Each dispatch tracks actual weight, vehicle, generated Tax Invoice, E-Invoice IRN, and E-Way Bill (EWB).\n" +
  "- Accounting: Double-entry ledger with cost centers, accounts (Asset, Liability, Equity, Revenue, Expense) and Journal Entries.\n" +
  "- Outstanding loans: Principal bank loans taken against storage stock.\n\n" +
  "VOICE & REAL-TIME COMMANDS:\n" +
  "- Users interact with you via voice and speech-to-text. Voice transcription often produces phonetic typos (e.g. 'spectermum' or 'spectram' -> 'Spectrum Auxi Chem Private Limited', 'kannan' -> 'Kannan Katpadi', 'murugan' -> 'Murugan and Co', etc.).\n" +
  "- When the user says 'open party ledger of <party>' or 'show ledger of <party>', IMMEDIATELY call the open_party_ledger tool with that party name. It will automatically fuzzy match the party and navigate to their ledger.\n" +
  "- When the user says 'send e invoice' or 'send e-invoice for <party>', IMMEDIATELY call the send_einvoice tool. If they mention a party, pass the partyName. If they mention an invoice number, pass invoiceNumber.\n" +
  "- When the user asks to navigate to any other page (e.g. 'take me to purchase orders', 'open stock overview'), use navigate_to_page.\n\n" +
  "RESPONSE STYLE:\n" +
  "1. Be concise, fast, and conversational. Since your response is spoken aloud via text-to-speech, keep your voice confirmation punchy and clear (1-2 sentences), followed by any tables/details.\n" +
  "2. For voice commands like opening a ledger or sending an invoice, confirm the action cleanly: e.g. 'Opening party ledger for Spectrum Auxi Chem Private Limited.' or 'Processing E-Invoice for Spectrum Auxi Chem.'\n" +
  "3. Always format financial figures in Indian notation (₹ or Lakhs/Crores).\n" +
  "4. Use relevant tools. Never guess numbers.";

export async function handleChat(req: Request, res: Response) {
  const { messages } = req.body;
  if (!Array.isArray(messages)) throw new HttpError(400, 'messages array is required');

  const ai = getClient();

  // Format messages for @google/genai
  const contents: any[] = messages.map(m => ({
    role: m.role, // 'user' or 'model'
    parts: [{ text: m.content }]
  }));

  let response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents,
    config: {
      systemInstruction: { parts: [{ text: JARVIS_SYSTEM_PROMPT }] },
      tools: [{ functionDeclarations: toolDeclarations }]
    }
  });

  // Collect navigation intents and action cards from tool calls
  const navigationIntents: { route: string; pageLabel: string; autoExecute?: boolean }[] = [];
  const actions: { type: string; title: string; description: string; status: 'SUCCESS' | 'WARNING' | 'ERROR'; data?: any }[] = [];

  let loops = 0;
  while (response.functionCalls && response.functionCalls.length > 0 && loops < 5) {
    loops++;
    // Add model's function call to history
    contents.push({
      role: 'model',
      parts: response.functionCalls.map(call => ({
        functionCall: {
          name: call.name,
          args: call.args || {},
          id: call.id
        }
      }))
    });

    const functionResponses = [];
    for (const call of response.functionCalls) {
      try {
        if (!call.name) throw new Error('Function call missing name');
        const result = await executeTool(call.name, call.args || {});

        // Capture navigation intents & actions
        if (call.name === 'open_party_ledger' && result.action === 'navigate') {
          navigationIntents.push({ route: result.route, pageLabel: result.pageLabel, autoExecute: true });
          actions.push({
            type: 'NAVIGATE',
            title: result.pageLabel,
            description: result.message || 'Opening party ledger',
            status: 'SUCCESS',
            data: result.party,
          });
        } else if (call.name === 'navigate_to_page' && result.action === 'navigate') {
          navigationIntents.push({ route: result.route, pageLabel: result.pageLabel, autoExecute: result.autoExecute !== false });
          actions.push({
            type: 'NAVIGATE',
            title: result.pageLabel,
            description: `Navigating to ${result.pageLabel}`,
            status: 'SUCCESS',
          });
        } else if (call.name === 'send_einvoice') {
          actions.push({
            type: 'EINVOICE',
            title: `E-Invoice: ${result.invoiceNumber || 'Dispatch'}`,
            description: result.summary || 'E-Invoice action executed',
            status: result.success ? (result.emailStatus === 'FAILED' || result.irnError ? 'WARNING' : 'SUCCESS') : 'ERROR',
            data: result,
          });
        }

        functionResponses.push({
          functionResponse: { id: call.id, name: call.name, response: result }
        });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        functionResponses.push({
          functionResponse: { id: call.id, name: call.name, response: { error: errMsg } }
        });
      }
    }

    contents.push({
      role: 'user', // function responses are sent from 'user'
      parts: functionResponses
    });

    response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents,
      config: {
        systemInstruction: { parts: [{ text: JARVIS_SYSTEM_PROMPT }] },
        tools: [{ functionDeclarations: toolDeclarations }]
      }
    });
  }

  res.json({
    text: response.text,
    navigationIntents: navigationIntents.length > 0 ? navigationIntents : undefined,
    actions: actions.length > 0 ? actions : undefined,
  });
}

// ---------------------------------------------------------------------------
// JARVIS Proactive Insights — lightweight queries for the insight cards
// ---------------------------------------------------------------------------
export async function getJarvisInsights(_req: Request, res: Response) {
  const now = new Date();

  // 1. Overdue sale dues (delivered, past credit days, still outstanding)
  const overdueDuesRaw = await prisma.saleDispatch.findMany({
    where: {
      status: 'DELIVERED',
      deliveredDate: { not: null },
      saleOrder: { dueDays: { not: null } },
    },
    include: {
      saleOrder: { include: { buyer: { select: { name: true } } } },
      receipts: { select: { amount: true } },
    },
    orderBy: { deliveredDate: 'asc' },
    take: 200, // cap scan
  });

  let overdueCount = 0;
  let overdueTotal = 0;
  const overdueTop: { buyer: string; amount: number; days: number }[] = [];
  for (const d of overdueDuesRaw) {
    if (!d.deliveredDate || !d.saleOrder.dueDays) continue;
    const dueDate = new Date(d.deliveredDate);
    dueDate.setDate(dueDate.getDate() + d.saleOrder.dueDays);
    if (dueDate >= now) continue;
    const rate = Number(d.saleOrder.ratePerKg);
    const billed = Math.round(d.weightKg * rate + Number(d.gstAmount));
    const received = d.receipts.reduce((s, r) => s + Number(r.amount), 0);
    const outstanding = Math.round(billed - received);
    if (outstanding <= 0) continue;
    overdueCount++;
    overdueTotal += outstanding;
    if (overdueTop.length < 3) {
      overdueTop.push({
        buyer: d.saleOrder.buyer.name,
        amount: outstanding,
        days: Math.floor((now.getTime() - dueDate.getTime()) / 86400000),
      });
    }
  }

  // 2. Pending POs (awaiting arrival)
  const pendingPOs = await prisma.purchaseOrder.count({ where: { status: 'PENDING' } });

  // 3. Dispatches awaiting delivery confirmation
  const pendingDispatches = await prisma.saleDispatch.count({ where: { status: 'DISPATCHED' } });

  // 4. Today's activity snapshot
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  const dateFilter = { gte: todayStart, lte: todayEnd };

  const [todayArrivals, todayDispatches, todayPayments, todayReceipts] = await Promise.all([
    prisma.stockIn.count({ where: { arrivalDate: dateFilter } }),
    prisma.saleDispatch.count({ where: { dispatchDate: dateFilter } }),
    prisma.payment.aggregate({ _sum: { amount: true }, where: { date: dateFilter } }),
    prisma.receipt.aggregate({ _sum: { amount: true }, where: { date: dateFilter } }),
  ]);

  // 5. Low stock check (less than 50 MT black seed at RVP)
  const rvpStock = await prisma.siloInventory.aggregate({
    _sum: { weightKg: true },
    where: { itemType: 'BLACK_SEED', location: 'RVP' },
  });
  const rvpStockKg = rvpStock._sum.weightKg ?? 0;
  const lowStock = rvpStockKg < 50000; // less than 50 MT

  const insights: any[] = [];

  if (overdueCount > 0) {
    insights.push({
      id: 'overdue-dues',
      type: 'warning',
      icon: '⚠️',
      title: `${overdueCount} Overdue Payment${overdueCount > 1 ? 's' : ''}`,
      description: `₹${(overdueTotal / 100000).toFixed(1)}L outstanding past credit terms`,
      detail: overdueTop,
      action: { route: '/reports/sale-dues', label: 'View Sale Dues' },
    });
  }

  if (pendingPOs > 0) {
    insights.push({
      id: 'pending-pos',
      type: 'info',
      icon: '📋',
      title: `${pendingPOs} Pending PO${pendingPOs > 1 ? 's' : ''}`,
      description: 'Purchase orders awaiting lorry arrival',
      action: { route: '/purchase-orders', label: 'View POs' },
    });
  }

  if (pendingDispatches > 0) {
    insights.push({
      id: 'pending-dispatches',
      type: 'info',
      icon: '🚚',
      title: `${pendingDispatches} In-Transit`,
      description: 'Dispatches awaiting delivery confirmation',
      action: { route: '/sales/pappu', label: 'View Sales' },
    });
  }

  if (lowStock) {
    insights.push({
      id: 'low-stock',
      type: 'alert',
      icon: '📦',
      title: 'Low Stock at RVP',
      description: `Only ${Math.round(rvpStockKg / 1000)} MT black seed remaining at factory`,
      action: { route: '/stock/overview', label: 'View Stock' },
    });
  }

  const todayPaymentTotal = Math.round(Number(todayPayments._sum.amount ?? 0));
  const todayReceiptTotal = Math.round(Number(todayReceipts._sum.amount ?? 0));
  if (todayArrivals > 0 || todayDispatches > 0 || todayPaymentTotal > 0 || todayReceiptTotal > 0) {
    insights.push({
      id: 'today-activity',
      type: 'success',
      icon: '📊',
      title: "Today's Activity",
      description: [
        todayArrivals > 0 ? `${todayArrivals} arrival${todayArrivals > 1 ? 's' : ''}` : null,
        todayDispatches > 0 ? `${todayDispatches} dispatch${todayDispatches > 1 ? 'es' : ''}` : null,
        todayPaymentTotal > 0 ? `₹${(todayPaymentTotal / 100000).toFixed(1)}L paid` : null,
        todayReceiptTotal > 0 ? `₹${(todayReceiptTotal / 100000).toFixed(1)}L received` : null,
      ].filter(Boolean).join(' • '),
      action: { route: '/dashboard', label: 'Dashboard' },
    });
  }

  res.json({ insights, generatedAt: now.toISOString() });
}
