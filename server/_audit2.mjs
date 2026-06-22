import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const orders = await prisma.saleOrder.findMany({ select:{ id:true, product:true, status:true, tonnageKg:true, createdAt:true, invoiceNumber:true }, orderBy:{ createdAt:'asc' } });
console.log('sale orders:'); orders.forEach(o=>console.log(' ', o.createdAt.toISOString(), o.product, o.status, o.tonnageKg+'kg', o.invoiceNumber||'', o.id));
const purch = await prisma.purchase.findMany({ include:{ stockIn:true, verification:true } });
console.log('purchases:'); purch.forEach(p=>console.log(' ', p.id, 'stockIn loc:', p.stockIn?.loadingLocation, 'billW:', p.verification?.billingWeightKg, 'kataW:', p.verification?.partyKataKg));
await prisma.$disconnect();
