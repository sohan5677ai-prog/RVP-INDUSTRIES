import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

export async function clearSales() {
  try {
    logger.info('Clearing all sales data to fix stock...');
    await prisma.saleDispatch.deleteMany();
    await prisma.saleOrder.deleteMany();
    logger.info('Sales data cleared successfully. Stock should now reappear.');
  } catch (err) {
    logger.error('Failed to clear sales', err);
  }
}
