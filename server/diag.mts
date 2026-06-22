import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const codes = ['20200','20250','20255','20260','20270','40030','50050'];
const accts = await p.account.findMany({ where: { code: { in: codes } }, orderBy: { code: 'asc' } });
console.log('EXISTING ACCOUNTS:');
for (const c of codes) {
  const a = accts.find(x => x.code === c);
  console.log(' ', c, a ? `OK  ${a.name}` : 'MISSING');
}
const so = await p.saleOrder.findMany({ select: { id:true, status:true, freightCharge:true, vehicleNumber:true } });
console.log('\nSALE ORDERS:', so.map(s => `${s.status} freight=${s.freightCharge} veh=${s.vehicleNumber}`).join(' | '));
// journal lines hitting hamali account
const hamali = accts.find(a=>a.code==='20200');
if (hamali) {
  const lines = await p.journalLine.findMany({ where: { accountId: hamali.id }, include: { journalEntry: true } });
  console.log('\n20200 hamali lines:', lines.length);
  lines.slice(0,8).forEach(l=>console.log('  ', l.journalEntry.reference, 'D', l.debit.toString(), 'C', l.credit.toString()));
}
await p.$disconnect();
