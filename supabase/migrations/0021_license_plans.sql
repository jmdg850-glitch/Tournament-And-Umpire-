-- 0021_license_plans.sql
-- Adds a license PLAN so License Admin can issue Monthly, Yearly and 30-Day Trial
-- licenses whose expiry the `license` Edge Function computes server-side:
--
--     monthly   expires_at = issue time + 1 calendar month  (renewable by an admin)
--     yearly    expires_at = issue time + 1 calendar year   (renewable by an admin)
--     trial_30  expires_at = issue time + exactly 30 days   (never renewed)
--     legacy    every license issued before this migration, and plan-less creates
--               from older License Admin builds: expiry as chosen at issue (or none)
--
-- Additive only. Every existing license becomes 'legacy' with its expires_at,
-- status and devices untouched — no customer is moved onto a plan. Expiry stays
-- enforced exactly where it already is (license function, license_register_device,
-- packages/api requireLicense); this adds no second expiry system. No grant or
-- RLS change: licenses stays reachable only through the service role.
--
-- Deploy this migration BEFORE the `license` function that writes `plan`.

alter table public.licenses
  add column plan text not null default 'legacy'
    constraint licenses_plan_valid check (plan in ('legacy', 'monthly', 'yearly', 'trial_30'));

-- A plan license always has an expiry; only legacy licenses may have none.
alter table public.licenses
  add constraint licenses_plan_has_expiry check (plan = 'legacy' or expires_at is not null);
