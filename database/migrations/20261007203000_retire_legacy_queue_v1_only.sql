-- v0.8.3: retire the legacy queue transport after all runtime traffic moved
-- to the production pc-agent-v1 path.
--
-- Fail closed if an old worker or gateway recreated legacy in-flight rows.

do $block$
begin
  if exists (
    select 1
    from public.kaito_pc_commands
    where status in ('queued', 'claimed')
  ) then
    raise exception
      'Cannot retire legacy PC Agent queue while queued/claimed rows still exist.';
  end if;
end;
$block$;

drop function if exists public.claim_kaito_pc_command(uuid);

alter table public.kaito_pc_commands
  drop constraint if exists kaito_pc_commands_status_check;

alter table public.kaito_pc_commands
  add constraint kaito_pc_commands_status_check
  check (
    status = any (
      array[
        'agent_queued'::text,
        'agent_claimed'::text,
        'completed'::text,
        'failed'::text,
        'expired'::text
      ]
    )
  );

comment on constraint kaito_pc_commands_status_check
  on public.kaito_pc_commands is
  'v0.8.3+: production queue is pc-agent-v1 only; legacy queued/claimed states are rejected.';
