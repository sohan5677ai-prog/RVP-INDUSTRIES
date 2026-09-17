ALTER TABLE "WeighbridgeTicket"
  ADD COLUMN "paymentStatus" TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "paidAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN "paidAt" TIMESTAMP(3),
  ADD COLUMN "paymentVerifiedBy" TEXT,
  ADD COLUMN "paymentReference" TEXT,
  ADD COLUMN "slipWhatsappSentAt" TIMESTAMP(3),
  ADD COLUMN "secondWeightReminderSentAt" TIMESTAMP(3);

CREATE INDEX "WeighbridgeTicket_paymentStatus_idx"
  ON "WeighbridgeTicket"("paymentStatus");
