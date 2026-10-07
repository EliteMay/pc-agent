-- Repair v0.7 task-step budget RPC after production validation found
-- PL/pgSQL output-column names shadowing unqualified table columns.

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

revoke all on function public.begin_pc_agent_task_step_v1(uuid, uuid, text, text, text)
  from public, anon, authenticated;

grant execute on function public.begin_pc_agent_task_step_v1(uuid, uuid, text, text, text)
  to service_role;
