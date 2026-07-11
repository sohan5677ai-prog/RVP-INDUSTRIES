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
  }
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
    default:
      throw new Error(`Tool ${name} is not implemented`);
  }
}
