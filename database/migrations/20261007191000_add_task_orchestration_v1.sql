-- v0.7 bounded Observe -> Plan -> Act -> Verify task orchestration.
-- Task state lives in Supabase. PC execution remains one command at a time
-- through the existing Agent Tool Registry and local approval boundary.

create table if not exists public.kaito_pc_task_runs (
  task_id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  device_id uuid not null
    references public.kaito_pc_devices(device_id)
    on delete cascade,
  title text not null
    check (char_length(title) between 1 and 200),
  status text not null default 'active'
    check (status in (
      'active',
      'succeeded',
      'partial',
      'failed',
      'cancelled',
      'blocked',
      'expired'
    )),
  completion_criteria jsonb not null default '[]'::jsonb
    check (jsonb_typeof(completion_criteria) = 'array'),
  max_actions integer not null
    check (max_actions between 1 and 12),
  max_retries integer not null
    check (max_retries between 0 and 5),
  max_steps integer not null
    check (max_steps between 1 and 32),
  max_duration_ms integer not null
    check (max_duration_ms between 1000 and 900000),
  step_count integer not null default 0
    check (step_count >= 0),
  action_count integer not null default 0
    check (action_count >= 0),
  retry_count integer not null default 0
    check (retry_count >= 0),
  observe_count integer not null default 0
    check (observe_count >= 0),
  verify_count integer not null default 0
    check (verify_count >= 0),
  last_phase text
    check (last_phase is null or last_phase in ('observe', 'act', 'verify')),
  last_step_success boolean,
  last_failure_fingerprint text,
  repeated_failure_count integer not null default 0
    check (repeated_failure_count >= 0),
  blocked_reason text,
  summary text,
  started_at timestamptz not null default now(),
  deadline_at timestamptz not null,
  completed_at timestamptz
);

create table if not exists public.kaito_pc_task_steps (
  step_run_id uuid primary key default gen_random_uuid(),
  task_id uuid not null
    references public.kaito_pc_task_runs(task_id)
    on delete cascade,
  logical_step_id text not null
    check (
      char_length(logical_step_id) between 1 and 64
      and logical_step_id ~ '^[A-Za-z0-9._:-]+$'
    ),
  attempt integer not null
    check (attempt between 1 and 6),
  phase text not null
    check (phase in ('observe', 'act', 'verify')),
  tool_name text not null
    check (char_length(tool_name) between 1 and 64),
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'failed')),
  command_id uuid,
  failure_fingerprint text,
  error_code text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(task_id, logical_step_id, attempt)
);

create index if not exists kaito_pc_task_runs_user_status_idx
  on public.kaito_pc_task_runs(user_id, status, started_at desc);

create index if not exists kaito_pc_task_runs_device_status_idx
  on public.kaito_pc_task_runs(device_id, status, started_at desc);

create index if not exists kaito_pc_task_steps_task_started_idx
  on public.kaito_pc_task_steps(task_id, started_at, step_run_id);

alter table public.kaito_pc_task_runs enable row level security;
alter table public.kaito_pc_task_steps enable row level security;

revoke all on table public.kaito_pc_task_runs
  from public, anon, authenticated;
revoke all on table public.kaito_pc_task_steps
  from public, anon, authenticated;

grant select, insert, update on table public.kaito_pc_task_runs
  to service_role;
grant select, insert, update on table public.kaito_pc_task_steps
  to service_role;

create or replace function public.begin_pc_agent_task_step_v1(
  p_task_id uuid,
  p_user_id uuid,
  p_logical_step_id text,
  p_phase text,
  p_tool_name text
)
returns table(
  accepted boolean,
  reason text,
  step_run_id uuid,
  attempt integer,
  task_status text,
  step_count integer,
  action_count integer,
  retry_count integer,
  deadline_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_task public.kaito_pc_task_runs%rowtype;
  v_previous public.kaito_pc_task_steps%rowtype;
  v_step_run_id uuid;
  v_attempt integer := 1;
  v_retry_increment integer := 0;
begin
  if p_phase not in ('observe', 'act', 'verify') then
    return query
      select false, 'invalid_phase', null::uuid, null::integer,
             null::text, null::integer, null::integer, null::integer,
             null::timestamptz;
    return;
  end if;

  if p_logical_step_id is null
     or char_length(p_logical_step_id) not between 1 and 64
     or p_logical_step_id !~ '^[A-Za-z0-9._:-]+$' then
    return query
      select false, 'invalid_step_id', null::uuid, null::integer,
             null::text, null::integer, null::integer, null::integer,
             null::timestamptz;
    return;
  end if;

  if p_tool_name is null
     or char_length(p_tool_name) not between 1 and 64 then
    return query
      select false, 'invalid_tool_name', null::uuid, null::integer,
             null::text, null::integer, null::integer, null::integer,
             null::timestamptz;
    return;
  end if;

  select *
  into v_task
  from public.kaito_pc_task_runs
  where task_id = p_task_id
    and user_id = p_user_id
  for update;

  if not found then
    return query
      select false, 'task_not_found', null::uuid, null::integer,
             null::text, null::integer, null::integer, null::integer,
             null::timestamptz;
    return;
  end if;

  if v_task.status = 'active'
     and v_task.deadline_at <= now() then
    update public.kaito_pc_task_runs
    set
      status = 'expired',
      completed_at = coalesce(completed_at, now())
    where task_id = v_task.task_id;

    return query
      select false, 'task_expired', null::uuid, null::integer,
             'expired'::text, v_task.step_count, v_task.action_count,
             v_task.retry_count, v_task.deadline_at;
    return;
  end if;

  if v_task.status <> 'active' then
    return query
      select false, 'task_not_active', null::uuid, null::integer,
             v_task.status, v_task.step_count, v_task.action_count,
             v_task.retry_count, v_task.deadline_at;
    return;
  end if;

  if v_task.step_count >= v_task.max_steps then
    return query
      select false, 'step_budget_exhausted', null::uuid, null::integer,
             v_task.status, v_task.step_count, v_task.action_count,
             v_task.retry_count, v_task.deadline_at;
    return;
  end if;

  if p_phase = 'act'
     and v_task.action_count >= v_task.max_actions then
    return query
      select false, 'action_budget_exhausted', null::uuid, null::integer,
             v_task.status, v_task.step_count, v_task.action_count,
             v_task.retry_count, v_task.deadline_at;
    return;
  end if;

  select *
  into v_previous
  from public.kaito_pc_task_steps
  where task_id = v_task.task_id
    and logical_step_id = p_logical_step_id
  order by attempt desc
  limit 1;

  if found then
    if v_previous.status <> 'failed' then
      return query
        select false, 'step_already_executed', null::uuid, null::integer,
               v_task.status, v_task.step_count, v_task.action_count,
               v_task.retry_count, v_task.deadline_at;
      return;
    end if;

    if v_previous.phase <> p_phase
       or v_previous.tool_name <> p_tool_name then
      return query
        select false, 'retry_step_mismatch', null::uuid, null::integer,
               v_task.status, v_task.step_count, v_task.action_count,
               v_task.retry_count, v_task.deadline_at;
      return;
    end if;

    if v_task.retry_count >= v_task.max_retries then
      return query
        select false, 'retry_budget_exhausted', null::uuid, null::integer,
               v_task.status, v_task.step_count, v_task.action_count,
               v_task.retry_count, v_task.deadline_at;
      return;
    end if;

    v_attempt := v_previous.attempt + 1;
    v_retry_increment := 1;

    if v_attempt > 6 then
      return query
        select false, 'attempt_limit_exhausted', null::uuid, null::integer,
               v_task.status, v_task.step_count, v_task.action_count,
               v_task.retry_count, v_task.deadline_at;
      return;
    end if;
  end if;

  insert into public.kaito_pc_task_steps(
    task_id,
    logical_step_id,
    attempt,
    phase,
    tool_name,
    status
  )
  values(
    v_task.task_id,
    p_logical_step_id,
    v_attempt,
    p_phase,
    p_tool_name,
    'running'
  )
  returning kaito_pc_task_steps.step_run_id
  into v_step_run_id;

  update public.kaito_pc_task_runs as task
  set
    step_count = task.step_count + 1,
    action_count = task.action_count + case when p_phase = 'act' then 1 else 0 end,
    retry_count = task.retry_count + v_retry_increment,
    observe_count = task.observe_count + case when p_phase = 'observe' then 1 else 0 end,
    verify_count = task.verify_count + case when p_phase = 'verify' then 1 else 0 end
  where task.task_id = v_task.task_id
  returning task.*
  into v_task;

  return query
    select true, null::text, v_step_run_id, v_attempt,
           v_task.status, v_task.step_count, v_task.action_count,
           v_task.retry_count, v_task.deadline_at;
end;
$function$;

create or replace function public.finish_pc_agent_task_step_v1(
  p_task_id uuid,
  p_user_id uuid,
  p_step_run_id uuid,
  p_success boolean,
  p_failure_fingerprint text default null,
  p_error_code text default null,
  p_command_id uuid default null
)
returns table(
  accepted boolean,
  reason text,
  task_status text,
  repeated_failure_count integer
)
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_task public.kaito_pc_task_runs%rowtype;
  v_step public.kaito_pc_task_steps%rowtype;
  v_repeated integer := 0;
begin
  select *
  into v_task
  from public.kaito_pc_task_runs
  where task_id = p_task_id
    and user_id = p_user_id
  for update;

  if not found then
    return query
      select false, 'task_not_found', null::text, null::integer;
    return;
  end if;

  select *
  into v_step
  from public.kaito_pc_task_steps
  where step_run_id = p_step_run_id
    and task_id = v_task.task_id
  for update;

  if not found then
    return query
      select false, 'step_not_found', v_task.status,
             v_task.repeated_failure_count;
    return;
  end if;

  if v_step.status <> 'running' then
    return query
      select false, 'step_already_finished', v_task.status,
             v_task.repeated_failure_count;
    return;
  end if;

  if not p_success then
    if p_failure_fingerprint is null
       or p_failure_fingerprint !~ '^[a-f0-9]{64}$' then
      return query
        select false, 'invalid_failure_fingerprint', v_task.status,
               v_task.repeated_failure_count;
      return;
    end if;

    v_repeated := case
      when v_task.last_failure_fingerprint = p_failure_fingerprint
        then v_task.repeated_failure_count + 1
      else 1
    end;
  end if;

  update public.kaito_pc_task_steps
  set
    status = case when p_success then 'succeeded' else 'failed' end,
    command_id = p_command_id,
    failure_fingerprint = case
      when p_success then null
      else p_failure_fingerprint
    end,
    error_code = case
      when p_success then null
      else left(coalesce(p_error_code, 'UNKNOWN_ERROR'), 128)
    end,
    completed_at = now()
  where step_run_id = v_step.step_run_id;

  if p_success then
    update public.kaito_pc_task_runs
    set
      last_phase = v_step.phase,
      last_step_success = true,
      last_failure_fingerprint = null,
      repeated_failure_count = 0,
      blocked_reason = null
    where task_id = v_task.task_id
    returning *
    into v_task;
  else
    update public.kaito_pc_task_runs
    set
      last_phase = v_step.phase,
      last_step_success = false,
      last_failure_fingerprint = p_failure_fingerprint,
      repeated_failure_count = v_repeated,
      status = case
        when v_repeated >= 2 then 'blocked'
        else status
      end,
      blocked_reason = case
        when v_repeated >= 2 then 'repeated_failure_fingerprint'
        else blocked_reason
      end,
      completed_at = case
        when v_repeated >= 2 then coalesce(completed_at, now())
        else completed_at
      end
    where task_id = v_task.task_id
    returning *
    into v_task;
  end if;

  return query
    select true, null::text, v_task.status,
           v_task.repeated_failure_count;
end;
$function$;

create or replace function public.finish_pc_agent_task_v1(
  p_task_id uuid,
  p_user_id uuid,
  p_outcome text,
  p_summary text default null
)
returns table(
  accepted boolean,
  reason text,
  task_status text
)
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_task public.kaito_pc_task_runs%rowtype;
begin
  if p_outcome not in ('succeeded', 'partial', 'failed', 'cancelled') then
    return query
      select false, 'invalid_outcome', null::text;
    return;
  end if;

  select *
  into v_task
  from public.kaito_pc_task_runs
  where task_id = p_task_id
    and user_id = p_user_id
  for update;

  if not found then
    return query
      select false, 'task_not_found', null::text;
    return;
  end if;

  if v_task.status <> 'active' then
    return query
      select false, 'task_not_active', v_task.status;
    return;
  end if;

  if v_task.deadline_at <= now() then
    update public.kaito_pc_task_runs
    set
      status = 'expired',
      completed_at = coalesce(completed_at, now())
    where task_id = v_task.task_id;

    return query
      select false, 'task_expired', 'expired'::text;
    return;
  end if;

  if p_outcome = 'succeeded'
     and (
       v_task.verify_count < 1
       or v_task.last_phase <> 'verify'
       or v_task.last_step_success is distinct from true
     ) then
    return query
      select false, 'verification_required', v_task.status;
    return;
  end if;

  update public.kaito_pc_task_runs
  set
    status = p_outcome,
    summary = case
      when p_summary is null then null
      else left(p_summary, 2000)
    end,
    completed_at = now()
  where task_id = v_task.task_id
  returning status
  into v_task.status;

  return query
    select true, null::text, v_task.status;
end;
$function$;

revoke all on function public.begin_pc_agent_task_step_v1(uuid, uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.finish_pc_agent_task_step_v1(uuid, uuid, uuid, boolean, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.finish_pc_agent_task_v1(uuid, uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.begin_pc_agent_task_step_v1(uuid, uuid, text, text, text)
  to service_role;
grant execute on function public.finish_pc_agent_task_step_v1(uuid, uuid, uuid, boolean, text, text, uuid)
  to service_role;
grant execute on function public.finish_pc_agent_task_v1(uuid, uuid, text, text)
  to service_role;

comment on table public.kaito_pc_task_runs is
  'Bounded v0.7 orchestration tasks. This table does not bypass Agent authorization or local approval.';
comment on table public.kaito_pc_task_steps is
  'Minimal task-step audit metadata; arguments and full tool results are intentionally not duplicated here.';
