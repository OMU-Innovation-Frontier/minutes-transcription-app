-- Run once in the project's SQL Editor. This stores counters, never meeting content.
begin;
create schema if not exists minutes_private;
revoke all on schema minutes_private from public, anon, authenticated;
create table if not exists minutes_private.daily_usage (
  day date not null,
  counter text not null check (counter in ('starts', 'summary', 'correction', 'audioBytes')),
  amount bigint not null check (amount >= 0),
  primary key (day, counter)
);
alter table minutes_private.daily_usage enable row level security;
revoke all on minutes_private.daily_usage from public, anon, authenticated;

create or replace function public.minutes_quota_health()
returns boolean language sql security definer set search_path = '' as $$
  select exists(select 1 from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'minutes_private' and c.relname = 'daily_usage');
$$;

create or replace function public.reserve_minutes_quota(
  p_counter text, p_amount bigint, p_batch bigint, p_limit bigint
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_day date := (pg_catalog.now() at time zone 'UTC')::date;
  v_used bigint;
  v_grant bigint;
begin
  if p_counter is null or p_counter not in ('starts', 'summary', 'correction', 'audioBytes')
    or p_amount is null or p_batch is null or p_limit is null
    or p_amount < 1 or p_batch < p_amount or p_limit < 1
    or p_batch > 2764800000 or p_limit > 2764800000 then
    raise exception 'Invalid quota reservation';
  end if;
  insert into minutes_private.daily_usage(day, counter, amount)
    values(v_day, p_counter, 0) on conflict do nothing;
  select amount into v_used from minutes_private.daily_usage
    where day = v_day and counter = p_counter for update;
  if p_amount > p_limit - v_used then
    return pg_catalog.jsonb_build_object('day', v_day, 'granted', 0);
  end if;
  v_grant := least(p_batch, p_limit - v_used);
  update minutes_private.daily_usage set amount = amount + v_grant
    where day = v_day and counter = p_counter;
  return pg_catalog.jsonb_build_object('day', v_day, 'granted', v_grant);
end;
$$;
revoke all on function public.minutes_quota_health() from public, anon, authenticated;
revoke all on function public.reserve_minutes_quota(text, bigint, bigint, bigint) from public, anon, authenticated;
grant execute on function public.minutes_quota_health() to service_role;
grant execute on function public.reserve_minutes_quota(text, bigint, bigint, bigint) to service_role;
commit;
