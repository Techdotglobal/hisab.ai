-- Granular permissions, delegated access management and a tamper-resistant audit log.
--
-- Model (see docs/rbac-policy.md):
--   effective permissions = role baseline (code, src/lib/permissions/catalog.ts)
--                         + active rows in user_permission_grants
--   delegated authority   = one active row in access_delegations per delegate
--
-- Everything here is written/read by the server with the service role. No end-user
-- (JWT) policies are created on the new tables, so the anon key cannot read or change them.

CREATE TABLE IF NOT EXISTS public.user_permission_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  scope JSONB,                              -- e.g. {"costCenterIds": ["..."]}; NULL = company-wide
  granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoke_reason TEXT,
  FOREIGN KEY (company_id, user_id) REFERENCES public.company_users (company_id, user_id) ON DELETE CASCADE
);

-- One active grant per (company, user, permission); history rows (revoked) are kept.
CREATE UNIQUE INDEX IF NOT EXISTS user_permission_grants_active_uq
  ON public.user_permission_grants (company_id, user_id, permission)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS user_permission_grants_user_idx
  ON public.user_permission_grants (company_id, user_id);

CREATE TABLE IF NOT EXISTS public.access_delegations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  manageable_roles TEXT[] NOT NULL DEFAULT '{}',   -- roles the delegate may create/assign/edit/deactivate
  delegable_permissions TEXT[] NOT NULL DEFAULT '{}', -- individual permissions the delegate may grant/revoke
  granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT access_delegations_no_owner CHECK (NOT ('OWNER' = ANY (manageable_roles))),
  CONSTRAINT access_delegations_no_redelegation
    CHECK (NOT (delegable_permissions && ARRAY['permissions.manage', 'roles.manage']::TEXT[])),
  FOREIGN KEY (company_id, user_id) REFERENCES public.company_users (company_id, user_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS access_delegations_active_uq
  ON public.access_delegations (company_id, user_id)
  WHERE revoked_at IS NULL;

ALTER TABLE public.user_permission_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_delegations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_permission_grants_service_all ON public.user_permission_grants;
CREATE POLICY user_permission_grants_service_all ON public.user_permission_grants
  FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS access_delegations_service_all ON public.access_delegations;
CREATE POLICY access_delegations_service_all ON public.access_delegations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------------------------
-- Audit log: members previously had FOR ALL on audit_logs (031), i.e. any signed-in member could
-- rewrite or delete audit rows through PostgREST with their own JWT. Reads are now limited to
-- roles that may review the log; writes are service-role only (the server writes audit rows).
-- ---------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS audit_logs_tenant ON public.audit_logs;
DROP POLICY IF EXISTS audit_logs_select_reviewers ON public.audit_logs;
DROP POLICY IF EXISTS audit_logs_service_all ON public.audit_logs;

CREATE POLICY audit_logs_select_reviewers ON public.audit_logs
  FOR SELECT TO authenticated
  USING (
    company_id IN (SELECT public.user_company_ids())
    AND public.user_has_company_role(company_id, ARRAY['OWNER', 'ADMIN', 'AUDITOR']::public.company_role[])
  );

CREATE POLICY audit_logs_service_all ON public.audit_logs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Request correlation for audit rows (optional, written by the server).
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS request_id TEXT;
DO $$ BEGIN
  IF to_regclass('public.audit_logs_archive') IS NOT NULL THEN
    ALTER TABLE public.audit_logs_archive ADD COLUMN IF NOT EXISTS request_id TEXT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS audit_logs_company_user_idx ON public.audit_logs (company_id, user_id, created_at DESC);

-- Block UPDATE/DELETE of audit rows by anyone except the retention job (service role may still
-- archive via the existing retention function). Ordinary roles hold no write policy any more;
-- this trigger additionally stops accidental updates by application code.
CREATE OR REPLACE FUNCTION public.audit_logs_block_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs rows are append-only';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_no_update ON public.audit_logs;
CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.audit_logs_block_update();
