import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { signToken } from '../src/lib/jwt.js';

const prisma = new PrismaClient();

const sales = [
  { date: '2026-06-28T00:00:00.000Z', party: 'Babayya', vehicle: 'AP03TC9744', product: 'NALLA_POKKULU', tonnageKg: 1660, ratePerKg: 22.00 },
  { date: '2026-06-28T00:00:00.000Z', party: 'Babayya', vehicle: 'AP03TC9744', product: 'NALLA_CHINTAPANDU', tonnageKg: 1380, ratePerKg: 22.50 },
  { date: '2026-07-10T00:00:00.000Z', party: 'Babayya', vehicle: 'AP03TC9744', product: 'NALLA_CHINTAPANDU', tonnageKg: 570, ratePerKg: 22.50 }
];

async function main() {
  const token = signToken({ userId: 'admin', role: 'ADMIN' });
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  };

  for (const sale of sales) {
    let party = await prisma.party.findFirst({
      where: { name: sale.party, type: 'BUYER' }
    });
    if (!party) {
      party = await prisma.party.create({
        data: { name: sale.party, type: 'BUYER' }
      });
      console.log('Created party:', sale.party);
    }

    // 1. Create Sale Order
    const orderRes = await fetch('http://localhost:4000/api/sale-orders', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        saleDate: sale.date,
        product: sale.product,
        buyerId: party.id,
        tonnageKg: sale.tonnageKg,
        ratePerKg: sale.ratePerKg
      })
    });

    if (!orderRes.ok) {
      console.error('Failed to create order', await orderRes.text());
      continue;
    }
    const order = await orderRes.json();
    console.log('Created Order:', order.id);

    // 2. Dispatch Sale Order
    const dispatchRes = await fetch(`http://localhost:4000/api/sale-orders/${order.id}/dispatch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tonnageKg: sale.tonnageKg,
        vehicleNumber: sale.vehicle
      })
    });

    if (!dispatchRes.ok) {
      console.error('Failed to dispatch order', await dispatchRes.text());
      continue;
    }
    const dispatch = await dispatchRes.json();
    console.log('Dispatched Order:', dispatch.id);

    // 3. Optional: Raise invoice
    const invoiceRes = await fetch(`http://localhost:4000/api/sale-dispatches/${dispatch.id}/invoice`, {
        method: 'POST',
        headers
    });
    if (!invoiceRes.ok) {
        console.error('Failed to invoice', await invoiceRes.text());
    } else {
        console.log('Invoiced Order:', dispatch.id);
    }
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
