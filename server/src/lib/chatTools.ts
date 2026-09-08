import { Type, FunctionDeclaration } from '@google/genai';
import { prisma } from './prisma.js';
import { TaxproService } from '../services/taxpro.service.js';
import { sendInvoiceEmail } from '../services/saleDocumentEmail.service.js';
import { logger } from './logger.js';

/**
 * Calculate Damerau-Levenshtein distance between two strings
 */
function levenshteinDistance(s1: string, s2: string): number {
  const m = s1.length;
  const n = s2.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && s1[i - 1] === s2[j - 2] && s1[i - 2] === s2[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[m][n];
}

/**
 * Fuzzy party search against all parties in database
 * Handles voice transcription typos like "spectermum" -> "Spectrum Auxi Chem Private Limited"
 */
export async function searchPartiesFuzzy(query: string, limit = 5) {
  const q = query.toLowerCase().trim().replace(/[^a-z0-9 ]/g, '');
  if (!q) return [];

  const parties = await prisma.party.findMany({
    select: {
      id: true,
      name: true,
      nickname: true,
      type: true,
      phone: true,
      email: true,
      gstin: true,
      destination: true,
      openingBalance: true,
      openingBalanceType: true,
    },
  });

  const scored = parties.map(p => {
    const pName = p.name.toLowerCase();
    const pNick = (p.nickname || '').toLowerCase();
    const cleanName = pName.replace(/[^a-z0-9 ]/g, '');
    const cleanNick = pNick.replace(/[^a-z0-9 ]/g, '');

    let score = 0;

    // Exact match or substring contains gets highest score
    if (cleanName === q || cleanNick === q) {
      score += 150;
    } else if (cleanName.includes(q) || (cleanNick && cleanNick.includes(q))) {
      score += 100;
    }

    const nameWords = [...cleanName.split(/\s+/), ...cleanNick.split(/\s+/)].filter(Boolean);
    const qWords = q.split(/\s+/).filter(Boolean);

    for (const qw of qWords) {
      for (const nw of nameWords) {
        if (nw === qw) {
          score += 60;
        } else if (nw.startsWith(qw) || qw.startsWith(nw)) {
          score += 40;
        } else {
          const dist = levenshteinDistance(qw, nw);
          const maxLen = Math.max(qw.length, nw.length);
          if (dist <= 2 || (maxLen >= 6 && dist <= 3)) {
            const similarity = 1 - dist / maxLen;
            score += Math.round(similarity * 50);
          }
        }
      }
    }

    return { party: p, score };
  });

  return scored
    .filter(s => s.score > 20)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.party);
}

export const toolDeclarations: FunctionDeclaration[] = [
  {
    name: 'get_stock_summary',
    description: 'Get the total weight and value of black seed stock currently in the inventory',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'get_all_stock',
    description: 'Get the inventory weight and value for all products (BLACK_SEED, WHITE_PAPPU, HUSK, WASTE, etc.) grouped by product type and location',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'search_parties',
    description: 'Search for buyers or suppliers in the system by name',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'The search query (e.g. party name)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_outstanding_loans',
    description: 'Get a summary of all outstanding bank loans',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'get_recent_sales',
    description: 'Get the latest sale orders, including buyer name, product, weight, rate, and order status',
    parameters: {
      type: Type.OBJECT,
      properties: {
        limit: {
          type: Type.INTEGER,
          description: 'Number of orders to retrieve (default 5)',
        }
      },
    },
  },
  {
    name: 'get_recent_purchases',
    description: 'Get the latest purchase orders, including supplier name, price, weight, and status',
    parameters: {
      type: Type.OBJECT,
      properties: {
        limit: {
          type: Type.INTEGER,
          description: 'Number of orders to retrieve (default 5)',
        }
      },
    },
  },
  {
    name: 'get_financial_summary',
    description: 'Get a summary of recent payments and receipts, and totals',
    parameters: {
      type: Type.OBJECT,
      properties: {
        limit: {
          type: Type.INTEGER,
          description: 'Number of transactions to retrieve (default 5)',
        }
      },
    },
  },
  {
    name: 'get_company_profile',
    description: 'Get the company profile details, including name, GSTIN, address, bank accounts, and invoice prefix',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'get_brokers',
    description: 'Get the list of active brokers in the ERP',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'get_freight_rates',
    description: 'Get all the outward freight rates configured per destination',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'get_recent_processing',
    description: 'Get the details of recent factory milling/processing runs (input weights, yields of Pappu/Husk/Waste, and electric/wage overheads)',
    parameters: {
      type: Type.OBJECT,
      properties: {
        limit: {
          type: Type.INTEGER,
          description: 'Number of milling runs to retrieve (default 5)',
        }
      },
    },
  },
  {
    name: 'get_recent_stock_transfers',
    description: 'Get recent internal stock transfers of black seeds from storage locations (Rampalli, Murugan, Multi) to process',
    parameters: {
      type: Type.OBJECT,
      properties: {
        limit: {
          type: Type.INTEGER,
          description: 'Number of transfers to retrieve (default 5)',
        }
      },
    },
  },
  {
    name: 'get_recent_dispatches',
    description: 'Get details of physical dispatches (shipments/lorries) shipped against sale orders, including buyer name, weights, vehicle number, invoice number, and e-way bill status',
    parameters: {
      type: Type.OBJECT,
      properties: {
        limit: {
          type: Type.INTEGER,
          description: 'Number of dispatches to retrieve (default 5)',
        }
      },
    },
  },
  {
    name: 'get_financial_accounts',
    description: 'Get the general ledger accounts trial balance (list of accounts and their current net debit/credit balance)',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'navigate_to_page',
    description: 'Navigate the user to a specific ERP page. Use this when the user asks to go to / show / open a page. Return the route path that the client should navigate to. Available pages: / (Home), /dashboard, /parties, /brokers, /transports, /purchase-orders, /stock-in, /purchases, /verification, /pappu-calculator, /stock/overview, /stock/location, /stock/transfer, /stock/date, /stock/party, /stock/price, /stock/state, /loans, /private-loans, /sale-orders, /sales/pappu, /sales/husk, /sales/tps, /sales/byproducts, /sales/profit-loss, /sales/internal-weight, /sales/dues-today, /accounts/party-ledger (add ?partyId=X to go to a specific party), /accounts/hamali-ledger, /accounts/brokerage-ledger, /accounts/chart-of-accounts, /accounts/balance-sheet, /accounts/profit-loss, /accounts/journal-entries, /transactions/payments, /transactions/receipts, /reports/sale-dues, /reports/purchase-dues, /reports/payment-planner, /reports/brokerage-dues, /reports/freight-dues, /reports/gunny-bags, /reports/electricity, /reports/maintenance, /reports/drawings, /reports/interest, /reports/expenses, /reports/irn-ewb, /reports/email-logs, /reports/taxes, /settings, /users',
    parameters: {
      type: Type.OBJECT,
      properties: {
        route: {
          type: Type.STRING,
          description: 'The route path to navigate to (e.g. /purchase-orders or /accounts/party-ledger?partyId=abc123)',
        },
        pageLabel: {
          type: Type.STRING,
          description: 'Human-readable name of the page (e.g. "Purchase Orders")',
        },
      },
      required: ['route', 'pageLabel'],
    },
  },
  {
    name: 'get_party_ledger_summary',
    description: 'Get the outstanding balance summary for a specific party (supplier or buyer). Searches by name and returns the net position (payable/receivable), total purchases, sales, payments, and receipts.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        partyName: {
          type: Type.STRING,
          description: 'Name (or partial name) of the party to look up',
        },
      },
      required: ['partyName'],
    },
  },
  {
    name: 'get_overdue_dues',
    description: 'Get sale dispatches that are past their due date (delivered but not fully paid). Shows overdue buyers with amounts.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        limit: {
          type: Type.INTEGER,
          description: 'Max number of overdue entries to return (default 10)',
        },
      },
    },
  },
  {
    name: 'open_party_ledger',
    description: 'Open the party ledger for a specific customer or supplier. Automatically matches fuzzy or voice-transcribed party names (e.g. "spectermum" -> "Spectrum Auxi Chem Private Limited", "kannan", "murugan"). Navigates immediately to the ledger on screen.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        partyName: {
          type: Type.STRING,
          description: 'Name or spoken name of the party (e.g. "spectermum", "Spectrum", "Kannan")',
        },
      },
      required: ['partyName'],
    },
  },
  {
    name: 'send_einvoice',
    description: 'Generate E-Invoice (IRN) and/or send/email the official Tax Invoice & E-Invoice bundle to the buyer for a sale dispatch. Use this when the user says "send e-invoice", "send e-invoice for Spectrum", "generate e-invoice", or similar.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        partyName: {
          type: Type.STRING,
          description: 'Name or spoken name of the buyer (optional if invoiceNumber is provided)',
        },
        invoiceNumber: {
          type: Type.STRING,
          description: 'Invoice number (e.g. "RVP/79/26-27" or "79")',
        },
        action: {
          type: Type.STRING,
          description: 'Action to perform: "GENERATE_IRN", "SEND_EMAIL", or "BOTH" (default)',
        },
      },
    },
  },
  {
    name: 'get_dispatches_for_einvoice',
    description: 'Find recent sale dispatches to check their E-Invoice IRN status, invoice number, and email readiness.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        buyerName: {
          type: Type.STRING,
          description: 'Filter by buyer name (e.g. "Spectrum")',
        },
        status: {
          type: Type.STRING,
          description: 'Filter by status: "PENDING_IRN" (no IRN yet), "GENERATED" (IRN generated), or "ALL"',
        },
      },
    },
  },
  {
    name: 'get_todays_summary',
    description: 'Get a summary of today\'s ERP activity: arrivals, dispatches, payments made, and receipts collected today.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
];

export async function executeTool(name: string, args: Record<string, any>): Promise<any> {
  switch (name) {
    case 'get_stock_summary': {
      const result = await prisma.siloInventory.aggregate({
        where: { itemType: 'BLACK_SEED' },
        _sum: { weightKg: true, totalValue: true },
      });
      return {
        totalWeightKg: result._sum.weightKg || 0,
        totalValue: result._sum.totalValue || 0,
      };
    }
    case 'get_all_stock': {
      const items = await prisma.siloInventory.findMany({
        orderBy: { itemType: 'asc' }
      });
      return {
        stocks: items.map(i => ({
          location: i.location,
          itemType: i.itemType,
          weightKg: i.weightKg,
          totalValue: Number(i.totalValue),
        }))
      };
    }
    case 'search_parties': {
      const query = args.query as string;
      const parties = await searchPartiesFuzzy(query, 5);
      return { parties };
    }
    case 'get_outstanding_loans': {
      const loans = await prisma.bankLoan.findMany({
        where: { status: 'OPEN' },
        include: { repayments: true },
      });
      let totalOutstanding = 0;
      const outstandingDetails = [];
      for (const loan of loans) {
        const repaid = loan.repayments.reduce((s, r) => s + Number(r.amount), 0);
        const outstanding = Number(loan.principal) - repaid;
        totalOutstanding += outstanding;
        outstandingDetails.push({
          loanRef: loan.loanRef,
          bankName: loan.bankName,
          principal: Number(loan.principal),
          outstanding,
          interestRatePct: Number(loan.interestRatePct),
          drawdownDate: loan.drawdownDate,
        });
      }
      return { outstandingLoansAmount: totalOutstanding, loans: outstandingDetails };
    }
    case 'get_recent_sales': {
      const limit = Number(args.limit) || 5;
      const sales = await prisma.saleOrder.findMany({
        orderBy: { saleDate: 'desc' },
        take: limit,
        include: {
          buyer: {
            select: { name: true }
          }
        }
      });
      return {
        sales: sales.map(s => ({
          id: s.id,
          date: s.saleDate,
          product: s.product,
          buyerName: s.buyer.name,
          tonnageKg: s.tonnageKg,
          ratePerKg: Number(s.ratePerKg),
          status: s.status,
        }))
      };
    }
    case 'get_recent_purchases': {
      const limit = Number(args.limit) || 5;
      const purchases = await prisma.purchaseOrder.findMany({
        orderBy: { poDate: 'desc' },
        take: limit,
        include: {
          party: {
            select: { name: true }
          }
        }
      });
      return {
        purchases: purchases.map(p => ({
          id: p.id,
          poNumber: p.poNumber,
          date: p.poDate,
          supplierName: p.party.name,
          pricePerKg: Number(p.pricePerKg),
          priceType: p.priceType,
          tonnageKg: p.tonnageKg,
          status: p.status,
        }))
      };
    }
    case 'get_financial_summary': {
      const limit = Number(args.limit) || 5;
      const payments = await prisma.payment.findMany({
        orderBy: { date: 'desc' },
        take: limit,
        include: {
          party: { select: { name: true } },
          broker: { select: { name: true } }
        }
      });
      const receipts = await prisma.receipt.findMany({
        orderBy: { date: 'desc' },
        take: limit,
        include: {
          party: { select: { name: true } }
        }
      });
      return {
        recentPayments: payments.map(p => ({
          date: p.date,
          amount: Number(p.amount),
          type: p.type,
          partyName: p.party?.name || p.broker?.name || 'Other',
          description: p.description,
        })),
        recentReceipts: receipts.map(r => ({
          date: r.date,
          amount: Number(r.amount),
          type: r.type,
          partyName: r.party?.name || 'Other',
          description: r.description,
        }))
      };
    }
    case 'get_company_profile': {
      const profile = await prisma.companyProfile.findUnique({
        where: { id: 'default' }
      });
      return { profile };
    }
    case 'get_brokers': {
      const brokers = await prisma.broker.findMany({
        select: { id: true, name: true, phone: true }
      });
      return { brokers };
    }
    case 'get_freight_rates': {
      const rates = await prisma.freightRate.findMany({
        orderBy: { destination: 'asc' }
      });
      return { rates };
    }
    case 'get_recent_processing': {
      const limit = Number(args.limit) || 5;
      const runs = await prisma.processing.findMany({
        orderBy: { processDate: 'desc' },
        take: limit,
      });
      return {
        runs: runs.map(r => ({
          date: r.processDate,
          blackWeightKg: r.blackWeightKg,
          outTurnPct: Number(r.outTurnPct),
          pappuWeightKg: r.pappuWeightKg,
          huskWeightKg: r.huskWeightKg,
          wasteWeightKg: r.wasteWeightKg,
          overheadElectricity: Number(r.overheadElectricity),
          overheadWages: Number(r.overheadWages),
          overheadMaintenance: Number(r.overheadMaintenance),
        }))
      };
    }
    case 'get_recent_stock_transfers': {
      const limit = Number(args.limit) || 5;
      const transfers = await prisma.stockTransfer.findMany({
        orderBy: { transferDate: 'desc' },
        take: limit,
      });
      return {
        transfers: transfers.map(t => ({
          date: t.transferDate,
          fromLocation: t.fromLocation,
          toLocation: t.toLocation,
          weightKg: t.weightKg,
          lorryNumber: t.lorryNumber,
          transportCharge: Number(t.transportCharge),
          movedValue: Number(t.movedValue),
        }))
      };
    }
    case 'get_recent_dispatches': {
      const limit = Number(args.limit) || 5;
      const dispatches = await prisma.saleDispatch.findMany({
        orderBy: { dispatchDate: 'desc' },
        take: limit,
        include: {
          saleOrder: {
            include: {
              buyer: { select: { name: true } }
            }
          }
        }
      });
      return {
        dispatches: dispatches.map(d => ({
          id: d.id,
          date: d.dispatchDate,
          buyerName: d.saleOrder.buyer.name,
          product: d.saleOrder.product,
          weightKg: d.weightKg,
          vehicleNumber: d.vehicleNumber,
          invoiceNumber: d.invoiceNumber,
          status: d.status,
          ewbNumber: d.ewbNumber,
          irnStatus: d.irnStatus,
        }))
      };
    }
    case 'get_financial_accounts': {
      const accounts = await prisma.account.findMany({
        include: {
          lines: {
            select: { debit: true, credit: true }
          }
        }
      });
      return {
        accounts: accounts.map(a => {
          const totalDebit = a.lines.reduce((sum, l) => sum + Number(l.debit), 0);
          const totalCredit = a.lines.reduce((sum, l) => sum + Number(l.credit), 0);
          return {
            code: a.code,
            name: a.name,
            type: a.type,
            debit: totalDebit,
            credit: totalCredit,
            balance: totalDebit - totalCredit,
          };
        })
      };
    }
    case 'navigate_to_page': {
      // The actual navigation happens client-side. We return the intent with autoExecute.
      return {
        action: 'navigate',
        route: args.route as string,
        pageLabel: args.pageLabel as string,
        autoExecute: args.autoExecute !== false,
      };
    }
    case 'get_party_ledger_summary': {
      const partyName = args.partyName as string;
      const party = await prisma.party.findFirst({
        where: { name: { contains: partyName, mode: 'insensitive' } },
        select: { id: true, name: true, type: true, phone: true, destination: true, openingBalance: true, openingBalanceType: true },
      });
      if (!party) return { error: `No party found matching "${partyName}"` };

      const [purchases, sales, payments, receipts] = await Promise.all([
        prisma.weightVerification.aggregate({
          _sum: { totalAmount: true },
          where: { purchase: { stockIn: { purchaseOrder: { partyId: party.id } } } },
        }),
        prisma.saleDispatch.aggregate({
          _sum: { weightKg: true },
          where: { saleOrder: { buyerId: party.id } },
        }),
        prisma.payment.aggregate({
          _sum: { amount: true },
          _count: true,
          where: { partyId: party.id },
        }),
        prisma.receipt.aggregate({
          _sum: { amount: true },
          _count: true,
          where: { partyId: party.id },
        }),
      ]);

      return {
        party: { id: party.id, name: party.name, type: party.type, phone: party.phone, destination: party.destination },
        totalPurchases: Number(purchases._sum.totalAmount ?? 0),
        totalSaleDispatchKg: sales._sum.weightKg ?? 0,
        totalPaymentsMade: Number(payments._sum.amount ?? 0),
        paymentCount: payments._count,
        totalReceiptsCollected: Number(receipts._sum.amount ?? 0),
        receiptCount: receipts._count,
        openingBalance: Number(party.openingBalance ?? 0),
        openingBalanceType: party.openingBalanceType,
      };
    }
    case 'get_overdue_dues': {
      const limit = Number(args.limit) || 10;
      const now = new Date();
      // Find dispatches that are delivered and whose sale order has dueDays set
      const dispatches = await prisma.saleDispatch.findMany({
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
      });

      const overdue: any[] = [];
      for (const d of dispatches) {
        if (!d.deliveredDate || !d.saleOrder.dueDays) continue;
        const dueDate = new Date(d.deliveredDate);
        dueDate.setDate(dueDate.getDate() + d.saleOrder.dueDays);
        if (dueDate >= now) continue; // not yet overdue

        const rate = Number(d.saleOrder.ratePerKg);
        const billed = Math.round(d.weightKg * rate + Number(d.gstAmount));
        const received = d.receipts.reduce((s, r) => s + Number(r.amount), 0);
        const outstanding = Math.round(billed - received);
        if (outstanding <= 0) continue; // fully paid

        const daysOverdue = Math.floor((now.getTime() - dueDate.getTime()) / 86400000);
        overdue.push({
          buyerName: d.saleOrder.buyer.name,
          invoiceNumber: d.invoiceNumber,
          product: d.saleOrder.product,
          billed,
          received: Math.round(received),
          outstanding,
          dueDate: dueDate.toISOString(),
          daysOverdue,
        });
        if (overdue.length >= limit) break;
      }
      return { overdueCount: overdue.length, overdueDues: overdue };
    }
    case 'get_todays_summary': {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);
      const dateFilter = { gte: todayStart, lte: todayEnd };

      const [arrivals, dispatches, payments, receipts] = await Promise.all([
        prisma.stockIn.findMany({
          where: { arrivalDate: dateFilter },
          include: { purchaseOrder: { include: { party: { select: { name: true } } } } },
        }),
        prisma.saleDispatch.findMany({
          where: { dispatchDate: dateFilter },
          include: { saleOrder: { include: { buyer: { select: { name: true } } } } },
        }),
        prisma.payment.findMany({
          where: { date: dateFilter },
          include: { party: { select: { name: true } } },
        }),
        prisma.receipt.findMany({
          where: { date: dateFilter },
          include: { party: { select: { name: true } } },
        }),
      ]);

      return {
        arrivals: arrivals.map(a => ({
          supplier: a.purchaseOrder.party.name,
          lorry: a.lorryNumber,
          weightKg: a.rvpKataKg,
          invoice: a.invoiceNumber,
        })),
        dispatches: dispatches.map(d => ({
          buyer: d.saleOrder.buyer.name,
          product: d.saleOrder.product,
          weightKg: d.weightKg,
          vehicle: d.vehicleNumber,
          invoice: d.invoiceNumber,
        })),
        payments: payments.map(p => ({
          partyName: p.party?.name || 'Other',
          amount: Number(p.amount),
          type: p.type,
        })),
        receipts: receipts.map(r => ({
          partyName: r.party?.name || 'Other',
          amount: Number(r.amount),
          type: r.type,
        })),
        totals: {
          arrivalsCount: arrivals.length,
          arrivalsKg: arrivals.reduce((s, a) => s + a.rvpKataKg, 0),
          dispatchesCount: dispatches.length,
          dispatchesKg: dispatches.reduce((s, d) => s + d.weightKg, 0),
          paymentTotal: Math.round(payments.reduce((s, p) => s + Number(p.amount), 0)),
          receiptTotal: Math.round(receipts.reduce((s, r) => s + Number(r.amount), 0)),
        },
      };
    }
    case 'open_party_ledger': {
      const partyName = (args.partyName || '').trim();
      const matches = await searchPartiesFuzzy(partyName, 3);
      if (matches.length === 0) {
        return {
          success: false,
          error: `Could not find any party matching "${partyName}". Please check the party name.`,
        };
      }
      const matchedParty = matches[0];
      return {
        success: true,
        action: 'navigate',
        route: `/accounts/party-ledger?partyId=${matchedParty.id}`,
        pageLabel: `Party Ledger - ${matchedParty.name}`,
        autoExecute: true,
        party: {
          id: matchedParty.id,
          name: matchedParty.name,
          type: matchedParty.type,
          destination: matchedParty.destination,
        },
        message: `Opening party ledger for ${matchedParty.name}.`,
      };
    }
    case 'send_einvoice': {
      const { partyName, invoiceNumber, action = 'BOTH' } = args;
      let dispatch = null;

      if (invoiceNumber) {
        dispatch = await prisma.saleDispatch.findFirst({
          where: {
            invoiceNumber: { contains: String(invoiceNumber).trim(), mode: 'insensitive' },
          },
          include: {
            saleOrder: { include: { buyer: true } },
          },
          orderBy: { dispatchDate: 'desc' },
        });
      } else if (partyName) {
        const matches = await searchPartiesFuzzy(partyName, 1);
        if (matches.length > 0) {
          dispatch = await prisma.saleDispatch.findFirst({
            where: {
              saleOrder: { buyerId: matches[0].id },
              invoiceNumber: { not: null },
            },
            include: {
              saleOrder: { include: { buyer: true } },
            },
            orderBy: { dispatchDate: 'desc' },
          });
        }
      } else {
        dispatch = await prisma.saleDispatch.findFirst({
          where: { invoiceNumber: { not: null } },
          include: {
            saleOrder: { include: { buyer: true } },
          },
          orderBy: { dispatchDate: 'desc' },
        });
      }

      if (!dispatch) {
        return {
          success: false,
          error: `No invoice dispatch found ${partyName ? `for party "${partyName}"` : invoiceNumber ? `for invoice "${invoiceNumber}"` : 'to send'}. Please verify the party or invoice number.`,
        };
      }

      const buyer = dispatch.saleOrder.buyer;
      const results: any = {
        success: true,
        dispatchId: dispatch.id,
        invoiceNumber: dispatch.invoiceNumber,
        buyerName: buyer.name,
        buyerEmail: buyer.email || null,
        buyerPhone: buyer.phone || null,
        vehicleNumber: dispatch.vehicleNumber,
        weightKg: dispatch.weightKg,
      };

      // 1. Generate IRN if needed
      if (action === 'GENERATE_IRN' || action === 'BOTH') {
        if (dispatch.irn && dispatch.irnStatus !== 'CANCELLED') {
          results.irn = dispatch.irn;
          results.irnStatus = dispatch.irnStatus;
          results.irnMessage = 'Active E-Invoice IRN already exists.';
        } else {
          try {
            const taxproRes = await TaxproService.generateIRN(dispatch.id);
            await prisma.saleDispatch.update({
              where: { id: dispatch.id },
              data: {
                irn: taxproRes.irn,
                irnAckNo: taxproRes.ackNo,
                irnAckDate: taxproRes.ackDate,
                irnSignedQr: taxproRes.signedQr,
                irnStatus: 'GENERATED',
              },
            });
            results.irn = taxproRes.irn;
            results.irnStatus = 'GENERATED';
          } catch (err: any) {
            results.irnError = err.message || 'Failed to generate IRN via Taxpro';
            logger.error(`[JARVIS send_einvoice] IRN error: ${results.irnError}`);
          }
        }
      }

      // 2. Email invoice if requested
      if (action === 'SEND_EMAIL' || action === 'BOTH') {
        if (!buyer.email) {
          results.emailStatus = 'SKIPPED';
          results.emailMessage = `Buyer ${buyer.name} does not have an email address configured.`;
        } else {
          try {
            const emailRes = await sendInvoiceEmail(dispatch.id);
            if (emailRes.ok) {
              results.emailStatus = 'SENT';
              results.emailMessage = `Tax invoice bundle emailed to ${buyer.email}.`;
            } else {
              results.emailStatus = 'FAILED';
              results.emailError = emailRes.error || 'Failed to send email';
            }
          } catch (err: any) {
            results.emailStatus = 'FAILED';
            results.emailError = err.message || 'Error occurred while sending email';
          }
        }
      }

      results.summary = `Invoice ${dispatch.invoiceNumber} for ${buyer.name}: ` +
        (results.irn ? `IRN active. ` : results.irnError ? `IRN: ${results.irnError}. ` : '') +
        (results.emailStatus === 'SENT' ? `Email sent to ${buyer.email}.` : results.emailMessage ? results.emailMessage : '');

      return results;
    }
    case 'get_dispatches_for_einvoice': {
      const { buyerName, status = 'ALL' } = args;
      let buyerId: string | undefined = undefined;
      if (buyerName) {
        const matches = await searchPartiesFuzzy(buyerName, 1);
        if (matches.length > 0) buyerId = matches[0].id;
      }

      const where: any = { invoiceNumber: { not: null } };
      if (buyerId) where.saleOrder = { buyerId };
      if (status === 'PENDING_IRN') {
        where.OR = [{ irn: null }, { irnStatus: 'CANCELLED' }];
      } else if (status === 'GENERATED') {
        where.irn = { not: null };
        where.irnStatus = 'GENERATED';
      }

      const dispatches = await prisma.saleDispatch.findMany({
        where,
        take: 8,
        orderBy: { dispatchDate: 'desc' },
        include: {
          saleOrder: { include: { buyer: { select: { id: true, name: true, email: true, phone: true } } } },
        },
      });

      return {
        dispatches: dispatches.map(d => ({
          id: d.id,
          invoiceNumber: d.invoiceNumber,
          buyerName: d.saleOrder.buyer.name,
          buyerEmail: d.saleOrder.buyer.email,
          buyerPhone: d.saleOrder.buyer.phone,
          date: d.dispatchDate,
          weightKg: d.weightKg,
          vehicleNumber: d.vehicleNumber,
          irn: d.irn,
          irnStatus: d.irnStatus,
          ewbNumber: d.ewbNumber,
        })),
      };
    }
    default:
      throw new Error(`Tool ${name} is not implemented`);
  }
}
