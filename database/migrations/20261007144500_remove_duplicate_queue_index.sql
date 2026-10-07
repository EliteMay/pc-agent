-- Remove the redundant queue index created by the preceding envelope migration.
-- The legacy index has the same key definition and remains in place.

drop index if exists public.pc_agent_commands_device_status_created_idx;
