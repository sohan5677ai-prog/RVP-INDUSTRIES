const { PrismaClient } = require('@prisma/client');
const { z } = require('zod');

const prisma = new PrismaClient();
const COMPANY_ID = 'default';

const companyProfileSchema = z.object({
  name: z.string().trim().min(1),
  address: z.string().optional().nullable(),
  gstin: z.string().optional().nullable(),
  stateName: z.string().optional().nullable(),
  stateCode: z.string().optional().nullable(),
  contact: z.string().optional().nullable(),
  bankAccountName: z.string().optional().nullable(),
  bankName: z.string().optional().nullable(),
  bankAccountNumber: z.string().optional().nullable(),
  bankBranchIfsc: z.string().optional().nullable(),
  invoicePrefix: z.string().trim().min(1).default('RVP'),
  companyVehicles: z.string().optional().nullable(),
  freightRetentionPerTrip: z.coerce.number().nonnegative().optional(),
  taxproGspId: z.string().optional().nullable(),
  taxproGspSecret: z.string().optional().nullable(),
  taxproGstUser: z.string().optional().nullable(),
  taxproGstPass: z.string().optional().nullable(),
  taxproSandbox: z.boolean().optional().default(true),
});

const form = {
  id: 'default',
  name: 'RVP INDUSTRIES',
  address: null,
  gstin: null,
  stateName: null,
  stateCode: null,
  contact: null,
  bankAccountName: null,
  bankName: null,
  bankAccountNumber: null,
  bankBranchIfsc: null,
  invoicePrefix: 'RVP',
  freightRetentionPerTrip: 3000,
  taxproGspId: null,
  taxproGspSecret: null,
  taxproGstUser: null,
  taxproGstPass: null,
  taxproSandbox: true,
};

async function main() {
  try {
    const data = companyProfileSchema.parse(form);
    console.log("Parsed data keys:", Object.keys(data));
    const saved = await prisma.companyProfile.upsert({
      where: { id: COMPANY_ID },
      update: data,
      create: { id: COMPANY_ID, ...data },
    });
    console.log("Success");
  } catch (e) {
    console.error("Error:");
    console.error(e.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
