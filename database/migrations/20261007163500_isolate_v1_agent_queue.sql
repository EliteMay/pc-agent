-- Isolate the production v1 Agent queue from the legacy worker queue.
-- Both paths keep the same terminal statuses for result compatibility.

alter table public.kaito_pc_commands
  drop constraint if exists kaito_pc_commands_status_check;

alter table public.kaito_pc_commands
  add constraint kaito_pc_commands_status_check
  check (
    status = any (
      array[
        'queued'::text,
        'claimed'::text,
        'agent_queued'::text,
        'agent_claimed'::text,
        'completed'::text,
        'failed'::text,
        'expired'::text
      ]
    )
  );

create or replace function public.claim_pc_agent_command_v1(p_device_id uuid)
returns table(
  command_id uuid,
  operation_id uuid,
  device_id uuid,
  tool_name text,
  tool_version text,
  protocol_version integer,
  arguments jsonb,
  request_metadata jsonb,
  created_at timestamptz,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $function$
begin
  update public.kaito_pc_commands c
  set
    status = 'expired',
    completed_at = coalesce(c.completed_at, now())
  where c.device_id = p_device_id
    and c.status in ('agent_queued', 'agent_claimed')
    and c.expires_at <= now();

  return query
  with next_command as (
    select c.command_id
    from public.kaito_pc_commands c
    where c.device_id = p_device_id
      and c.status = 'agent_queued'
      and c.expires_at > now()
    order by c.created_at, c.command_id
    for update skip locked
    limit 1
  )
  update public.kaito_pc_commands c
  set
    status = 'agent_claimed',
    claimed_at = now()
  from next_command n
  where c.command_id = n.command_id
  returning
    c.command_id,
    c.operation_id,
    c.device_id,
    c.tool_name,
    c.tool_version,
    c.protocol_version,
    c.arguments,
    c.request_metadata,
    c.created_at,
    c.expires_at;
end;
$function$;

revoke all on function public.claim_pc_agent_command_v1(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_pc_agent_command_v1(uuid)
  to service_role;
