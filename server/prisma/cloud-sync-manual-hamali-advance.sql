-- Cloud DB sync for ManualHamaliType enum: add ADVANCE (Advance Given)
-- Safe and idempotent: IF NOT EXISTS guard ensures re-running is a no-op.
-- Run in Supabase SQL Editor if needed.

ALTER TYPE "ManualHamaliType" ADD VALUE IF NOT EXISTS 'ADVANCE';
