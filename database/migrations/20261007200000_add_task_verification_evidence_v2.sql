-- v0.8 repository repair verification evidence.
-- Successful task steps record only a SHA-256 fingerprint of the structured
-- result. Full tool output remains in the existing command result path.

alter table public.kaito_pc_task_steps
  add column if not exists result_fingerprint text
  check (
    result_fingerprint is null
    or result_fingerprint ~ '^[a-f0-9]{64}$'
  );

alter table public.kaito_pc_task_runs
  add column if not exists last_result_fingerprint text
  check (
    last_result_fingerprint is null
    or last_result_fingerprint ~ '^[a-f0-9]{64}$'
  );

create or replace function public.finish_pc_agent_task_step_v2(
  p_task_id uuid,
  p_user_id uuid,
  p_step_run_id uuid,
  p_success boolean,
  p_result_fingerprint text default null,
  p_failure_fingerprint text default null,
  p_error_code text default null,
  p_command_id uuid default null
)
returns table(
  accepted boolean,
  reason text,
  task_status text,
  repeated_failure_count integer,
  result_fingerprint text
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
      select false, 'task_not_found', null::text, null::integer, null::text;
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
             v_task.repeated_failure_count, null::text;
    return;
  end if;

  if v_step.status <> 'running' then
    return query
      select false, 'step_already_finished', v_task.status,
             v_task.repeated_failure_count, v_step.result_fingerprint;
    return;
  end if;

  if p_success then
    if p_result_fingerprint is null
       or p_result_fingerprint !~ '^[a-f0-9]{64}$' then
      return query
        select false, 'invalid_result_fingerprint', v_task.status,
               v_task.repeated_failure_count, null::text;
      return;
    end if;
  else
    if p_failure_fingerprint is null
       or p_failure_fingerprint !~ '^[a-f0-9]{64}$' then
      return query
        select false, 'invalid_failure_fingerprint', v_task.status,
               v_task.repeated_failure_count, null::text;
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
    result_fingerprint = case when p_success then p_result_fingerprint else null end,
    failure_fingerprint = case when p_success then null else p_failure_fingerprint end,
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
      last_result_fingerprint = p_result_fingerprint,
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
      last_result_fingerprint = null,
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
           v_task.repeated_failure_count,
           case when p_success then p_result_fingerprint else null end;
end;
$function$;

create or replace function public.finish_pc_agent_task_v2(
  p_task_id uuid,
  p_user_id uuid,
  p_outcome text,
  p_summary text default null
)
returns table(
  accepted boolean,
  reason text,
  task_status text,
  verification_fingerprint text
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
      select false, 'invalid_outcome', null::text, null::text;
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
      select false, 'task_not_found', null::text, null::text;
    return;
  end if;

  if v_task.status <> 'active' then
    return query
      select false, 'task_not_active', v_task.status,
             v_task.last_result_fingerprint;
    return;
  end if;

  if v_task.deadline_at <= now() then
    update public.kaito_pc_task_runs
    set
      status = 'expired',
      completed_at = coalesce(completed_at, now())
    where task_id = v_task.task_id;

    return query
      select false, 'task_expired', 'expired'::text, null::text;
    return;
  end if;

  if p_outcome = 'succeeded'
     and (
       v_task.verify_count < 1
       or v_task.last_phase <> 'verify'
       or v_task.last_step_success is distinct from true
       or v_task.last_result_fingerprint is null
     ) then
    return query
      select false, 'verification_evidence_required', v_task.status,
             v_task.last_result_fingerprint;
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
  returning *
  into v_task;

  return query
    select true, null::text, v_task.status,
           v_task.last_result_fingerprint;
end;
$function$;

revoke all on function public.finish_pc_agent_task_step_v2(
  uuid, uuid, uuid, boolean, text, text, text, uuid
) from public, anon, authenticated;

revoke all on function public.finish_pc_agent_task_v2(
  uuid, uuid, text, text
) from public, anon, authenticated;

grant execute on function public.finish_pc_agent_task_step_v2(
  uuid, uuid, uuid, boolean, text, text, text, uuid
) to service_role;

grant execute on function public.finish_pc_agent_task_v2(
  uuid, uuid, text, text
) to service_role;

comment on column public.kaito_pc_task_steps.result_fingerprint is
  'SHA-256 fingerprint of the successful structured tool result; full result is intentionally not duplicated here.';

comment on column public.kaito_pc_task_runs.last_result_fingerprint is
  'Most recent successful task-step result fingerprint. A succeeded task must end with verify evidence.';
