-- QuickBooks Purchase (expense) transactions name the paying/settlement account on the transaction header (AccountRef —
-- e.g. a bank, petty cash, or credit-card account). The importer never preserved it, so postExpenseToLedger always fell
-- back to the unordered accounts.bank default lookup, which resolves to whichever "11-1101%" account sorts first — an
-- Equity account (General Reserve) in charts that reuse that number range outside "Cash and Bank". `payments` already has
-- a settlement-account column (deposit_account_id, 057_quickbooks_deposit_materialization.sql); expenses has none.
--
-- Nullable and additive: native/CSV/recurring expenses that never resolve a source account are unaffected, and
-- postExpenseToLedger keeps falling back to accounts.bank for them.
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS settlement_account_id UUID REFERENCES public.chart_of_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS expenses_settlement_account_idx ON public.expenses (settlement_account_id) WHERE settlement_account_id IS NOT NULL;
