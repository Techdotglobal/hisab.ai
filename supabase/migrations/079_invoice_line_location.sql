-- Location dimension for invoice lines. References cost_centers rows whose type is 'LOCATION'
-- (enforced in the application layer, as for project_id and class_id). Intentionally separate from
-- cost_center_id, which carries the ledger cost-center / Class dimension, and from project_id.

ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES public.cost_centers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS invoice_lines_location_id_idx
  ON public.invoice_lines (location_id)
  WHERE location_id IS NOT NULL;
