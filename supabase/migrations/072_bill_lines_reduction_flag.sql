-- QuickBooks bills can carry a negative AccountBasedExpenseLineDetail line — an
-- in-document reduction against the same expense/asset account (e.g. NETKOM
-- Bills 4630, 4759). `bill_lines.amount` is constrained non-negative
-- (bill_lines_amount_nonneg_chk, 010_database_hardening.sql), so the reducing
-- line's magnitude is stored positive and this flag records that it posts as a
-- credit (reduction) rather than a debit, preserving the original accounting
-- direction instead of silently flipping it into a larger debit.
ALTER TABLE public.bill_lines ADD COLUMN IF NOT EXISTS is_reduction BOOLEAN NOT NULL DEFAULT false;
