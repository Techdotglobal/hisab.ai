-- Vendor-visible AP open items originating from a Journal Entry's Accounts-Payable line or a Purchase (expense)'s
-- Accounts-Payable line. Confirmed on NETKOM: 29 vendor payments settle a JournalEntry-only "bill", and 13 expenses
-- (SAR 148,750.00) debit AP directly, both of which are already correctly posted to the general ledger but are
-- invisible to AP aging, vendor balances, and vendor statements — those all read `bills`/`vendor_credits` only.
--
-- Design A from the JE-linked-vendor-payment design review: the source document (journal_entries or expenses) remains
-- the SOLE general-ledger posting. This table is a pure subledger index — it is never posted to `ledger_entries` itself
-- (see the total absence of any INSERT into ledger_entries anywhere near this table's writers). A vendor_open_items row
-- is either:
--   'PAYABLE' — the JE/expense credited AP for this vendor (an open liability, like an unpaid bill), or
--   'CREDIT'  — the JE debited AP for this vendor (a reduction, like a vendor credit).
--
-- Idempotency and authority: `source_reference` is the immutable QuickBooks source id the item was derived from
-- (never regenerated), matching the same UNIQUE(company_id, ..., source_reference) idempotency convention already used
-- by payment_allocations (source_line_key) and journal_entries (legacy_id).
CREATE TABLE IF NOT EXISTS public.vendor_open_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('PAYABLE','CREDIT')),
  source_type TEXT NOT NULL CHECK (source_type IN ('JOURNAL_ENTRY','EXPENSE')),
  source_id UUID NOT NULL,
  source_line_id TEXT,
  source_system TEXT NOT NULL DEFAULT 'QUICKBOOKS',
  source_reference TEXT NOT NULL,
  date TIMESTAMPTZ NOT NULL,
  currency TEXT NOT NULL,
  exchange_rate NUMERIC(18,8),
  total NUMERIC(18,4) NOT NULL,
  applied_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
  balance NUMERIC(18,4) NOT NULL,
  description TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT vendor_open_items_company_vendor_fkey FOREIGN KEY (company_id,vendor_id)
    REFERENCES public.vendors(company_id,id) ON DELETE RESTRICT,
  CONSTRAINT vendor_open_items_amount_chk CHECK (total>0 AND applied_amount>=0 AND balance>=0 AND applied_amount<=total),
  CONSTRAINT vendor_open_items_rate_chk CHECK (exchange_rate IS NULL OR exchange_rate>0),
  UNIQUE (company_id,source_system,source_type,source_reference)
);

CREATE INDEX IF NOT EXISTS vendor_open_items_vendor_idx ON public.vendor_open_items (company_id,vendor_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS vendor_open_items_source_idx ON public.vendor_open_items (company_id,source_type,source_id);
CREATE INDEX IF NOT EXISTS vendor_open_items_open_idx ON public.vendor_open_items (company_id,vendor_id) WHERE deleted_at IS NULL AND balance>0;

ALTER TABLE public.vendor_open_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vendor_open_items_tenant ON public.vendor_open_items;
CREATE POLICY vendor_open_items_tenant ON public.vendor_open_items FOR ALL TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS vendor_open_items_service ON public.vendor_open_items;
CREATE POLICY vendor_open_items_service ON public.vendor_open_items FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE TRIGGER vendor_open_items_set_updated_at
  BEFORE UPDATE ON public.vendor_open_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------------------------------------------
-- payment_allocations: a third allocation target alongside invoice_id/bill_id, following the exact same shape
-- (nullable FK, single-target CHECK, no other column changes). A vendor payment can now allocate against exactly one
-- JE/expense-originating AP item, using the same one-row-per-target convention payment_allocations already has.
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE public.payment_allocations
  ADD COLUMN IF NOT EXISTS vendor_open_item_id UUID REFERENCES public.vendor_open_items(id) ON DELETE RESTRICT;

ALTER TABLE public.payment_allocations DROP CONSTRAINT IF EXISTS payment_allocations_single_target_chk;
ALTER TABLE public.payment_allocations ADD CONSTRAINT payment_allocations_single_target_chk CHECK (
  num_nonnulls(invoice_id,bill_id,vendor_open_item_id) = 1
);

CREATE INDEX IF NOT EXISTS payment_allocations_open_item_idx ON public.payment_allocations(company_id,vendor_open_item_id) WHERE vendor_open_item_id IS NOT NULL;

-- Recomputes applied_amount/balance for the given open items from their payment_allocations rows — the same pattern
-- as refresh_payment_document_balances (056_payment_allocations.sql), scoped to vendor_open_items instead of
-- invoices/bills. Never touches ledger_entries.
--
-- An open item accumulates from TWO distinct allocation shapes, matching the two ways items 2/4 use it:
--   - TARGET  (payment 2625-unrelated, "29 JE-linked vendor payments"): the payment directly settles the JE/expense
--     AP liability — one allocation row with vendor_open_item_id = this item, amount = the settled amount.
--   - CREDIT SOURCE (payment 2625: JE 2495 credits Bills 2624/4767): the payment settles a Bill, and this item's id
--     appears in that SAME allocation row's local_credit_ids, credit_amount = the portion this item covered — the
--     exact convention vendor_credits/invoices(credit notes) already use in replace_payment_allocations.
-- Correlated subqueries (not JOINs) avoid a fan-out double-count when an item has rows on both sides.
CREATE OR REPLACE FUNCTION public.refresh_vendor_open_item_balances(
  p_company_id UUID, p_open_item_ids UUID[]
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  UPDATE public.vendor_open_items item SET
    applied_amount=LEAST(item.total,COALESCE(applied.total,0)),
    balance=GREATEST(item.total-COALESCE(applied.total,0),0),
    updated_at=now()
  FROM (
    SELECT candidate.id,
      (SELECT COALESCE(SUM(a.amount),0) FROM public.payment_allocations a
        WHERE a.company_id=candidate.company_id AND a.vendor_open_item_id=candidate.id)
      +
      (SELECT COALESCE(SUM(a.credit_amount),0) FROM public.payment_allocations a
        WHERE a.company_id=candidate.company_id AND a.local_credit_ids ? candidate.id::TEXT)
      AS total
    FROM public.vendor_open_items candidate
    WHERE candidate.company_id=p_company_id AND candidate.id=ANY(COALESCE(p_open_item_ids,'{}'::UUID[]))
  ) applied
  WHERE item.company_id=p_company_id AND item.id=applied.id;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_vendor_open_item_balances(UUID,UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_vendor_open_item_balances(UUID,UUID[]) TO service_role;

-- replace_payment_allocations gains the open-item column and a matching post-write balance refresh, mirroring exactly
-- how it already refreshes invoice/bill balances. Additive: the invoice/bill branches are unchanged.
CREATE OR REPLACE FUNCTION public.replace_payment_allocations(
  p_company_id UUID,p_payment_id UUID,p_allocations JSONB
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  payment_row public.payments%ROWTYPE;
  old_invoice_ids UUID[];
  old_bill_ids UUID[];
  old_credit_ids UUID[];
  old_open_item_ids UUID[];
  new_invoice_ids UUID[];
  new_bill_ids UUID[];
  new_credit_ids UUID[];
  new_open_item_ids UUID[];
  cash_total NUMERIC(18,4);
  credit_total NUMERIC(18,4);
BEGIN
  SELECT * INTO payment_row FROM public.payments
    WHERE company_id=p_company_id AND id=p_payment_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF jsonb_typeof(COALESCE(p_allocations,'[]'::jsonb))<>'array' THEN RAISE EXCEPTION 'Allocations must be an array'; END IF;

  SELECT array_agg(DISTINCT invoice_id) FILTER(WHERE invoice_id IS NOT NULL),
         array_agg(DISTINCT bill_id) FILTER(WHERE bill_id IS NOT NULL),
         array_agg(DISTINCT vendor_open_item_id) FILTER(WHERE vendor_open_item_id IS NOT NULL)
    INTO old_invoice_ids,old_bill_ids,old_open_item_ids FROM public.payment_allocations
    WHERE company_id=p_company_id AND payment_id=p_payment_id;
  SELECT array_agg(DISTINCT credit_id::UUID) INTO old_credit_ids FROM public.payment_allocations allocation
    CROSS JOIN LATERAL jsonb_array_elements_text(allocation.local_credit_ids) credit_id
    WHERE allocation.company_id=p_company_id AND allocation.payment_id=p_payment_id;
  DELETE FROM public.payment_allocations WHERE company_id=p_company_id AND payment_id=p_payment_id;

  INSERT INTO public.payment_allocations(
    company_id,payment_id,invoice_id,bill_id,vendor_open_item_id,amount,cash_amount,credit_amount,currency,exchange_rate,
    source_system,source_payment_id,source_line_key,source_target_id,source_credit_ids,local_credit_ids,metadata
  ) SELECT p_company_id,p_payment_id,item.invoice_id,item.bill_id,item.vendor_open_item_id,ROUND(item.amount,4),ROUND(item.cash_amount,4),
      ROUND(item.credit_amount,4),UPPER(item.currency),item.exchange_rate,COALESCE(item.source_system,'HISAB'),
      item.source_payment_id,item.source_line_key,item.source_target_id,COALESCE(item.source_credit_ids,'[]'::jsonb),
      COALESCE(item.local_credit_ids,'[]'::jsonb),COALESCE(item.metadata,'{}'::jsonb)
    FROM jsonb_to_recordset(COALESCE(p_allocations,'[]'::jsonb)) AS item(
      invoice_id UUID,bill_id UUID,vendor_open_item_id UUID,amount NUMERIC,cash_amount NUMERIC,credit_amount NUMERIC,currency TEXT,
      exchange_rate NUMERIC,source_system TEXT,source_payment_id TEXT,source_line_key TEXT,source_target_id TEXT,
      source_credit_ids JSONB,local_credit_ids JSONB,metadata JSONB
    );

  SELECT COALESCE(SUM(cash_amount),0),COALESCE(SUM(credit_amount),0),
         array_agg(DISTINCT invoice_id) FILTER(WHERE invoice_id IS NOT NULL),
         array_agg(DISTINCT bill_id) FILTER(WHERE bill_id IS NOT NULL),
         array_agg(DISTINCT vendor_open_item_id) FILTER(WHERE vendor_open_item_id IS NOT NULL)
    INTO cash_total,credit_total,new_invoice_ids,new_bill_ids,new_open_item_ids FROM public.payment_allocations
    WHERE company_id=p_company_id AND payment_id=p_payment_id;
  SELECT array_agg(DISTINCT credit_id::UUID) INTO new_credit_ids FROM public.payment_allocations allocation
    CROSS JOIN LATERAL jsonb_array_elements_text(allocation.local_credit_ids) credit_id
    WHERE allocation.company_id=p_company_id AND allocation.payment_id=p_payment_id;
  IF cash_total>payment_row.amount THEN RAISE EXCEPTION 'Cash allocations exceed payment amount'; END IF;

  UPDATE public.payments SET
    invoice_id=(SELECT invoice_id FROM public.payment_allocations WHERE company_id=p_company_id AND payment_id=p_payment_id AND invoice_id IS NOT NULL ORDER BY source_line_key LIMIT 1),
    bill_id=(SELECT bill_id FROM public.payment_allocations WHERE company_id=p_company_id AND payment_id=p_payment_id AND bill_id IS NOT NULL ORDER BY source_line_key LIMIT 1),
    customer_id=COALESCE((SELECT invoice.customer_id FROM public.payment_allocations allocation JOIN public.invoices invoice ON invoice.company_id=allocation.company_id AND invoice.id=allocation.invoice_id WHERE allocation.company_id=p_company_id AND allocation.payment_id=p_payment_id LIMIT 1),payment_row.customer_id),
    vendor_id=COALESCE((SELECT bill.vendor_id FROM public.payment_allocations allocation JOIN public.bills bill ON bill.company_id=allocation.company_id AND bill.id=allocation.bill_id WHERE allocation.company_id=p_company_id AND allocation.payment_id=p_payment_id LIMIT 1),
      (SELECT item.vendor_id FROM public.payment_allocations allocation JOIN public.vendor_open_items item ON item.company_id=allocation.company_id AND item.id=allocation.vendor_open_item_id WHERE allocation.company_id=p_company_id AND allocation.payment_id=p_payment_id LIMIT 1),
      payment_row.vendor_id),
    applied_amount=cash_total,credit_applied_amount=credit_total,unapplied_amount=GREATEST(payment_row.amount-cash_total,0)
  WHERE company_id=p_company_id AND id=p_payment_id;

  PERFORM public.refresh_payment_document_balances(p_company_id,
    ARRAY(SELECT DISTINCT value FROM unnest(COALESCE(old_invoice_ids,'{}'::UUID[])||COALESCE(new_invoice_ids,'{}'::UUID[])) value),
    ARRAY(SELECT DISTINCT value FROM unnest(COALESCE(old_bill_ids,'{}'::UUID[])||COALESCE(new_bill_ids,'{}'::UUID[])) value));
  -- old/new_credit_ids is a generic pool of every local_credit_ids UUID this payment ever referenced (vendor credits,
  -- invoice credit notes, AND vendor_open_items alike) — folding it in here lets a JournalEntry used as a credit
  -- source (payment 2625's JE 2495) get its balance refreshed the same way a target open item does; ids that are not
  -- actually a vendor_open_items row simply match nothing in the function's WHERE candidate.id=ANY(...) join.
  PERFORM public.refresh_vendor_open_item_balances(p_company_id,
    ARRAY(SELECT DISTINCT value FROM unnest(
      COALESCE(old_open_item_ids,'{}'::UUID[])||COALESCE(new_open_item_ids,'{}'::UUID[])||
      COALESCE(old_credit_ids,'{}'::UUID[])||COALESCE(new_credit_ids,'{}'::UUID[])
    ) value));

  UPDATE public.invoices credit SET amount_paid=LEAST(credit.total,COALESCE(applied.total,0)),balance=GREATEST(credit.total-COALESCE(applied.total,0),0),
    status=CASE WHEN COALESCE(applied.total,0)>=credit.total THEN 'PAID' WHEN COALESCE(applied.total,0)>0 THEN 'PARTIAL' ELSE 'SENT' END,updated_at=now()
  FROM (SELECT document.id,COALESCE(SUM(allocation.credit_amount),0) total FROM public.invoices document
    LEFT JOIN public.payment_allocations allocation ON allocation.company_id=document.company_id AND allocation.local_credit_ids ? document.id::TEXT
    WHERE document.company_id=p_company_id AND document.invoice_type='CREDIT_NOTE' AND document.id=ANY(COALESCE(old_credit_ids,'{}'::UUID[])||COALESCE(new_credit_ids,'{}'::UUID[])) GROUP BY document.id) applied
  WHERE credit.company_id=p_company_id AND credit.id=applied.id;

  UPDATE public.vendor_credits credit SET applied_amount=LEAST(credit.total,COALESCE(applied.total,0)),balance=GREATEST(credit.total-COALESCE(applied.total,0),0),
    status=CASE WHEN COALESCE(applied.total,0)>=credit.total THEN 'CLOSED' WHEN COALESCE(applied.total,0)>0 THEN 'PARTIAL' ELSE 'OPEN' END
  FROM (SELECT document.id,COALESCE(SUM(allocation.credit_amount),0) total FROM public.vendor_credits document
    LEFT JOIN public.payment_allocations allocation ON allocation.company_id=document.company_id AND allocation.local_credit_ids ? document.id::TEXT
    WHERE document.company_id=p_company_id AND document.id=ANY(COALESCE(old_credit_ids,'{}'::UUID[])||COALESCE(new_credit_ids,'{}'::UUID[])) GROUP BY document.id) applied
  WHERE credit.company_id=p_company_id AND credit.id=applied.id;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_payment_allocations(UUID,UUID,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.replace_payment_allocations(UUID,UUID,JSONB) TO service_role;
