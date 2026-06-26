import { prisma } from '../lib/prisma.js';

export async function clearSales() {
  try {
    console.log('Clearing all sales data to fix stock...');
    await prisma.saleDispatch.deleteMany();
    await prisma.saleOrder.deleteMany();
    console.log('Sales data cleared successfully. Stock should now reappear.');
  } catch (err) {
    console.error('Failed to clear sales', err);
  }
}
