import { Type, FunctionDeclaration } from '@google/genai';
import { prisma } from './prisma.js';

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
      const parties = await prisma.party.findMany({
        where: { name: { contains: query, mode: 'insensitive' } },
        select: { id: true, name: true, type: true, phone: true, gstin: true, destination: true },
        take: 5,
      });
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
      // The actual navigation happens client-side. We just return the intent.
      return {
        action: 'navigate',
        route: args.route as string,
        pageLabel: args.pageLabel as string,
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
    default:
      throw new Error(`Tool ${name} is not implemented`);
  }
}
