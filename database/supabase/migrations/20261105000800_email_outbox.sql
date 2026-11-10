-- M7: participation confirmation e-mail outbox. PREPARED, NOT APPLIED to any hosted project; applying it needs explicit approval.
-- Requires 00700. Adds one table and four service-role-only functions; changes nothing else (no existing table, policy or grant).
--
-- Why an outbox: after a final submission the app e-mails the verified parent a confirmation. Sending is a call to an outside provider that
-- can fail, so the intention to send is recorded in the SAME database first (one row per submission and kind), and a worker sends it. A failed
-- or crashed send is retried with a growing delay (at most 8 tries); a finalized submission is never touched by any of this.
-- No duplicates: (submission_id, kind) is unique, a row is claimed atomically (so two workers cannot both send it), and the provider is given
-- the row id as an idempotency key.
-- Privacy: the table holds no address and no text, only ids, states and counters. The address is read from the submission at send time.

create table public.email_outbox (
  id               uuid primary key default gen_random_uuid(),
  submission_id    uuid not null references public.submissions (id) on delete cascade,
  kind             text not null check (kind in ('participation')),
  status           text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'abandoned')),
  attempts         integer not null default 0 check (attempts between 0 and 8),
  next_attempt_at  timestamptz not null default now(),
  locked_until     timestamptz,
  last_error       text check (last_error is null or last_error in ('transient', 'permanent')),
  created_at       timestamptz not null default now(),
  sent_at          timestamptz,
  unique (submission_id, kind)
);

create index email_outbox_due_idx on public.email_outbox (status, next_attempt_at);

alter table public.email_outbox enable row level security;
revoke all on table public.email_outbox from public, anon, authenticated;

-- every state change leaves an audit row (ids and states only)
create trigger audit_email_outbox after insert or update on public.email_outbox
  for each row execute function private.audit_change('id');

-- 1. record the intention, once. Only a finalized submission may have a confirmation.
create function public.enqueue_participation_email(p_submission uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  new_id uuid;
begin
  if not exists (select 1 from public.submissions s where s.id = p_submission and s.status = 'finalized') then
    raise exception 'not_finalized';
  end if;
  insert into public.email_outbox (submission_id, kind) values (p_submission, 'participation')
  on conflict (submission_id, kind) do nothing
  returning id into new_id;
  if new_id is null then
    select o.id into new_id from public.email_outbox o where o.submission_id = p_submission and o.kind = 'participation';
  end if;
  return new_id;
end $$;

-- 2. take the right to send one row, atomically. Returns what the e-mail needs, or nothing if it is not due, is already being sent
--    (until its lock runs out), was sent, or its submission is no longer finalized.
create function public.claim_participation_email(p_id uuid)
returns table (parent_email text, entry_code text, event_id smallint, attempt integer)
language plpgsql security definer set search_path = '' as $$
begin
  return query
  update public.email_outbox o
     set status = 'sending', attempts = o.attempts + 1, locked_until = now() + interval '5 minutes'
    from public.submissions s
   where o.id = p_id
     and s.id = o.submission_id
     and s.status = 'finalized'
     and o.attempts < 8
     and ((o.status in ('pending', 'failed') and o.next_attempt_at <= now())
          or (o.status = 'sending' and o.locked_until < now()))
  returning s.parent_email, s.entry_code, s.event_id, o.attempts;
end $$;

-- 3. record how the attempt ended: sent, a failure worth retrying, or one that never will work
create function public.finish_participation_email(p_id uuid, p_outcome text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_outcome not in ('sent', 'transient', 'permanent') then
    raise exception 'invalid_outcome';
  end if;
  update public.email_outbox o set
    status = case p_outcome
               when 'sent' then 'sent'
               when 'permanent' then 'abandoned'
               when 'transient' then case when o.attempts >= 8 then 'abandoned' else 'failed' end
             end,
    sent_at = case when p_outcome = 'sent' then now() else o.sent_at end,
    locked_until = null,
    last_error = case p_outcome when 'sent' then null else p_outcome end,
    -- 2, 4, 8 ... minutes after each failed attempt, never more than six hours
    next_attempt_at = case when p_outcome = 'transient' then now() + least(interval '1 minute' * power(2, o.attempts), interval '6 hours') else o.next_attempt_at end
  where o.id = p_id and o.status = 'sending';
end $$;

-- 4. what a worker should try next (oldest first, never more than 50)
create function public.due_participation_emails(p_limit integer)
returns setof uuid
language sql security definer set search_path = '' stable as $$
  select o.id
  from public.email_outbox o
  where o.attempts < 8
    and ((o.status in ('pending', 'failed') and o.next_attempt_at <= now()) or (o.status = 'sending' and o.locked_until < now()))
  order by o.next_attempt_at
  limit greatest(1, least(coalesce(p_limit, 20), 50))
$$;

revoke all on function public.enqueue_participation_email(uuid) from public, anon, authenticated;
revoke all on function public.claim_participation_email(uuid) from public, anon, authenticated;
revoke all on function public.finish_participation_email(uuid, text) from public, anon, authenticated;
revoke all on function public.due_participation_emails(integer) from public, anon, authenticated;
grant execute on function public.enqueue_participation_email(uuid) to service_role;
grant execute on function public.claim_participation_email(uuid) to service_role;
grant execute on function public.finish_participation_email(uuid, text) to service_role;
grant execute on function public.due_participation_emails(integer) to service_role;
