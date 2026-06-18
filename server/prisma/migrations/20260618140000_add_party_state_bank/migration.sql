-- Party master: state and bank account details
ALTER TABLE "Party" ADD COLUMN "state" TEXT;
ALTER TABLE "Party" ADD COLUMN "bankAccountNumber" TEXT;
ALTER TABLE "Party" ADD COLUMN "bankIfsc" TEXT;
ALTER TABLE "Party" ADD COLUMN "bankName" TEXT;
