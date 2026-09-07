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
  "You are JARVIS — the RVP Industries ERP AI Assistant. You are intelligent, proactive, and highly capable.\n" +
  "Think of yourself as the Iron Man JARVIS but for a Tamarind Processing business. You are sharp, efficient, and slightly witty.\n\n" +
  "RVP INDUSTRIES BUSINESS CONTEXT:\n" +
  "- Raw materials: 'Black Seed' (itemType: BLACK_SEED). Stored in storage locations (Rampalli, Murugan, Multi) or at the factory ('RVP').\n" +
  "- Milling/Processing: Processing input black seed yields 'White Pappu' (the primary kernel product, ~60% out-turn yield), 'Husk' (~25% yield), 'Waste' (~10% yield), and negligible loss (~5%).\n" +
  "- Tamarind Shell (SHELL) is a processing byproduct sent to Rampalli and sold from there.\n" +
  "- Internal Logistics: Seeds move storage -> process via StockTransfer (capitalizing transport and loading/unloading hamali costs into the process stock value).\n" +
  "- Sales: A SaleOrder specifies product, customer, total weight, and credit days. Actual deliveries are made via one or more physical lorry shipments called 'SaleDispatch'. Each dispatch tracks actual weight, vehicle, generated Tax Invoice, E-Invoice IRN, and E-Way Bill (EWB).\n" +
  "- Accounting: Double-entry ledger with cost centers, accounts (Asset, Liability, Equity, Revenue, Expense) and Journal Entries.\n" +
  "- Outstanding loans: Principal bank loans taken against storage stock.\n\n" +
  "DATABASE TOOLS: You have access to real-time ERP tools. ALWAYS use them when asked about data. Never guess numbers.\n\n" +
  "NAVIGATION: When the user asks to 'go to', 'open', 'show me', or 'take me to' a page, use the navigate_to_page tool. When looking up a party ledger, first search_parties to get the id, then use navigate_to_page with /accounts/party-ledger?partyId=<id>.\n\n" +
  "RESPONSE STYLE:\n" +
  "1. Be concise but informative. Use bullet points and tables for data.\n" +
  "2. Use relevant emojis sparingly (📦 stock, 💰 money, 🚚 transport, 📊 reports).\n" +
  "3. When you detect navigation intent, ALWAYS call navigate_to_page and tell the user you're taking them there.\n" +
  "4. For financial figures, format in Indian numbering (lakhs/crores) or use ₹ symbol.\n" +
  "5. Be proactive — if the user asks about stock and it's low, warn them. If dues are overdue, flag it.\n" +
  "6. Keep responses focused and actionable. You're an executive assistant, not a chatbot.";

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

    // Collect navigation intents from tool calls to pass back to client
    const navigationIntents: { route: string; pageLabel: string }[] = [];

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
          
          // Capture navigation intents
          if (call.name === 'navigate_to_page' && result.action === 'navigate') {
            navigationIntents.push({ route: result.route, pageLabel: result.pageLabel });
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
