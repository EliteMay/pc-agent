-- Extend the existing command queue with the v1 Agent command envelope.
-- This migration is additive and keeps the legacy relay path compatible.

alter table public.kaito_pc_commands
  add column if not exists operation_id uuid,
  add column if not exists tool_version text,
  add column if not exists protocol_version integer,
  add column if not exists request_metadata jsonb;

update public.kaito_pc_commands
set
  operation_id = coalesce(operation_id, command_id),
  tool_version = coalesce(tool_version, '1'),
  protocol_version = coalesce(protocol_version, 1),
  request_metadata = coalesce(request_metadata, '{}'::jsonb)
where
  operation_id is null
  or tool_version is null
  or protocol_version is null
  or request_metadata is null;

alter table public.kaito_pc_commands
  alter column operation_id set default gen_random_uuid(),
  alter column operation_id set not null,
  alter column tool_version set default '1',
  alter column tool_version set not null,
  alter column protocol_version set default 1,
  alter column protocol_version set not null,
  alter column request_metadata set default '{}'::jsonb,
  alter column request_metadata set not null;

create index if not exists pc_agent_commands_operation_id_idx
  on public.kaito_pc_commands(operation_id);

create index if not exists pc_agent_commands_device_status_created_idx
  on public.kaito_pc_commands(device_id, status, created_at);

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
    and c.status in ('queued', 'claimed')
    and c.expires_at <= now();

  return query
  with next_command as (
    select c.command_id
    from public.kaito_pc_commands c
    where c.device_id = p_device_id
      and c.status = 'queued'
      and c.expires_at > now()
    order by c.created_at, c.command_id
    for update skip locked
    limit 1
  )
  update public.kaito_pc_commands c
  set
    status = 'claimed',
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

comment on function public.claim_pc_agent_command_v1(uuid) is
  'Atomically expires stale commands and claims the next queued PC Agent command for one authenticated device.';
