-- Atomic company ownership transfer. Reuses the existing company_users / company_role
-- model (no new role type, no new permission table). Two row updates must happen
-- together so a company is never left without an OWNER and never ends up with two:
-- the row-level locks and the final invariant check make this safe under concurrent calls.
--
-- Called only from the server with the service role, after the caller has already been
-- verified as the company's current OWNER (requireRole(['OWNER']) in the API route).
-- Not reachable by RLS-governed clients.

CREATE OR REPLACE FUNCTION public.transfer_company_ownership(
  p_company_id UUID,
  p_new_owner_user_id UUID,
  p_previous_owner_new_role public.company_role
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_previous_owner_id UUID;
  v_new_owner_active BOOLEAN;
  v_owner_count INT;
BEGIN
  IF p_previous_owner_new_role = 'OWNER' THEN
    RAISE EXCEPTION 'previous_owner_new_role cannot be OWNER';
  END IF;

  -- Lock the current owner row so a concurrent transfer cannot race this one.
  SELECT user_id INTO v_previous_owner_id
  FROM public.company_users
  WHERE company_id = p_company_id AND role = 'OWNER' AND is_active = true
  FOR UPDATE;

  IF v_previous_owner_id IS NULL THEN
    RAISE EXCEPTION 'Company has no active owner to transfer from';
  END IF;

  IF v_previous_owner_id = p_new_owner_user_id THEN
    RAISE EXCEPTION 'New owner is already the current owner';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.company_users
    WHERE company_id = p_company_id AND user_id = p_new_owner_user_id AND is_active = true
  ) INTO v_new_owner_active;

  IF NOT v_new_owner_active THEN
    RAISE EXCEPTION 'New owner must be an existing active member of the company';
  END IF;

  UPDATE public.company_users SET role = 'OWNER'
  WHERE company_id = p_company_id AND user_id = p_new_owner_user_id;

  UPDATE public.company_users SET role = p_previous_owner_new_role
  WHERE company_id = p_company_id AND user_id = v_previous_owner_id;

  SELECT count(*) INTO v_owner_count
  FROM public.company_users
  WHERE company_id = p_company_id AND role = 'OWNER' AND is_active = true;

  IF v_owner_count <> 1 THEN
    RAISE EXCEPTION 'Ownership transfer invariant violated: company must have exactly one owner';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.transfer_company_ownership(UUID, UUID, public.company_role) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transfer_company_ownership(UUID, UUID, public.company_role) TO service_role;
