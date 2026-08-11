import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { whatsappService } from '../src/services/whatsapp.service.js';

const prisma = new PrismaClient();

// One-off script to verify the DISPATCH_DRIVER Location-header fix
// (see whatsapp.service.ts) against a real recent dispatch, without
// messaging the real driver. Run with FAST2SMS_API_KEY/FAST2SMS_PHONE_NUMBER_ID/
// WHATSAPP_ENABLED=true present in the environment (only Render has these -
// run this from the Render shell, not a local dev machine):
//
//   npx tsx prisma/testDriverWhatsapp.ts [testNumber]
//
// Temporarily points WhatsApp test mode at `testNumber` (default below) so
// EVERY WhatsApp send - not just this one - lands there until you switch it
// back in Settings -> WhatsApp. Safe: it only touches the CompanyProfile
// test-mode target, never a real send.
const TEST_NUMBER = process.argv[2] ?? '8019965187';

async function main() {
  const before = await prisma.companyProfile.findUnique({ where: { id: 'default' } });
  console.log(`Current test mode: ${before?.whatsappTestMode} / test number: ${before?.whatsappTestNumber ?? '(none)'}`);

  await prisma.companyProfile.update({
    where: { id: 'default' },
    data: { whatsappTestMode: true, whatsappTestNumber: TEST_NUMBER },
  });
  console.log(`Test mode ON, test number set to ${TEST_NUMBER} for this run.`);

  const dispatch = await prisma.saleDispatch.findFirst({
    where: { driverPhone: { not: null } },
    orderBy: { dispatchDate: 'desc' },
    include: { saleOrder: { include: { buyer: true } } },
  });
  if (!dispatch) {
    console.log('No dispatch with a driver phone on file - nothing to test.');
    return;
  }

  const buyer = dispatch.saleOrder.buyer;
  console.log(
    `Using dispatch ${dispatch.id} (${dispatch.dispatchDate.toISOString().slice(0, 10)}) - ` +
      `lorry ${dispatch.vehicleNumber ?? '-'}, buyer "${buyer.name}", maps link ${buyer.locationLink ?? '(none)'}`,
  );

  const result = await whatsappService.notifyDispatchDriver(
    {
      id: dispatch.id,
      vehicleNumber: dispatch.vehicleNumber,
      driverName: dispatch.driverName,
      driverPhone: dispatch.driverPhone,
      weightKg: dispatch.weightKg,
    },
    { name: buyer.name, phone: buyer.phone, locationLink: buyer.locationLink, address: buyer.address, city: buyer.city },
    { destination: dispatch.saleOrder.destination, product: dispatch.saleOrder.product },
  );
  console.log('notifyDispatchDriver result:', result);

  const log = await prisma.whatsAppLog.findFirst({
    where: { template: 'DISPATCH_DRIVER', relatedId: dispatch.id },
    orderBy: { createdAt: 'desc' },
  });
  console.log('Latest WhatsAppLog row for this dispatch:', log);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
