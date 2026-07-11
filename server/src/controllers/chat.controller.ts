import { logger } from '../lib/logger.js';
import type { Request, Response } from 'express';
import { GoogleGenAI } from '@google/genai';
import { toolDeclarations, executeTool } from '../lib/chatTools.js';
import { HttpError } from '../lib/httpError.js';

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  logger.info('Gemini API key in chat controller:', apiKey ? `Loaded (starts with ${apiKey.slice(0, 6)}..., length ${apiKey.length})` : 'Not loaded');
  if (!apiKey) throw new HttpError(503, 'GEMINI_API_KEY is missing');
  if (!client) client = new GoogleGenAI({ apiKey });
  return client;
}

export async function handleChat(req: Request, res: Response) {
  const { messages } = req.body;
  if (!Array.isArray(messages)) throw new HttpError(400, 'messages array is required');

  const ai = getClient();
  const systemInstruction = 
    "You are the RVP Industries ERP Brain - a highly energetic, brilliant, and proactive AI assistant!\n" +
    "You help manage our Tamarind Processing ERP with maximum enthusiasm and intelligence.\n\n" +
    "RVP INDUSTRIES BUSINESS INFORMATION SUMMARY FOR YOUR TRAINING:\n" +
    "- Raw materials: 'Black Seed' (itemType: BLACK_SEED). Stored in storage locations (Rampalli, Murugan, Multi) or at the factory ('RVP').\n" +
    "- Milling/Processing: Processing input black seed yields 'White Pappu' (the primary kernel product, ~60% out-turn yield), 'Husk' (~25% yield), 'Waste' (~10% yield), and negligible loss (~5%).\n" +
    "- Tamarind Shell (SHELL) is a processing byproduct sent to Rampalli and sold from there.\n" +
    "- Internal Logistics: Seeds move storage -> process via StockTransfer (capitalizing transport and loading/unloading hamali costs into the process stock value).\n" +
    "- Sales: A SaleOrder specifies product, customer, total weight, and credit days. Actual deliveries are made via one or more physical lorry shipments called 'SaleDispatch'. Each dispatch tracks actual weight, vehicle, generated Tax Invoice, E-Invoice IRN, and E-Way Bill (EWB).\n" +
    "- Accounting: Double-entry ledger with cost centers, accounts (Asset, Liability, Equity, Revenue, Expense) and Journal Entries. Hamali expenses are tracked under account code 20200.\n" +
    "- Outstanding loans: Principal bank loans taken against storage stock. Carrying interest is capitalized on transfer to process.\n\n" +
    "DATABASE ACCESS TOOLS: You have access to real-time tools to fetch exact ERP information: get_stock_summary, get_all_stock, search_parties, get_outstanding_loans, get_recent_sales, get_recent_purchases, get_financial_summary, get_company_profile, get_brokers, get_freight_rates, get_recent_processing, get_recent_stock_transfers, get_recent_dispatches, and get_financial_accounts (trial balance ledger).\n\n" +
    "GUIDELINES:\n" +
    "1. ALWAYS call the corresponding tools immediately when asked about stocks, orders, sales, purchases, dispatches, processing runs, financial ledger balances, company data, brokers, freight rates, or loans. Do not guess numbers.\n" +
    "2. Explain findings dynamically, summarize numbers neatly using tables or bullet points, and use emojis to represent actions/products.\n" +
    "3. Maintain a positive, energetic, and highly professional tone.";

  // Format messages for @google/genai
  const contents: any[] = messages.map(m => ({
    role: m.role, // 'user' or 'model'
    parts: [{ text: m.content }]
  }));

  
    let response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents,
      config: {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        tools: [{ functionDeclarations: toolDeclarations }]
      }
    });

    let loops = 0;
    while (response.functionCalls && response.functionCalls.length > 0 && loops < 3) {
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
          systemInstruction: { parts: [{ text: systemInstruction }] },
          tools: [{ functionDeclarations: toolDeclarations }]
        }
      });
    }

    res.json({ text: response.text });
}
