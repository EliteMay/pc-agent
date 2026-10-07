# PC Agent — Architecture & Security Design

Date: 2026-10-07
Status: Draft for review

## 1. Purpose

PC Agent is a Windows-focused remote agent platform that allows ChatGPT to inspect and eventually modify a user's PC through a controlled, auditable, and fail-closed execution path.

Primary goal:

```text
User request
  -> ChatGPT
  -> OAuth-protected cloud gateway
  -> command queue
  -> Windows Agent
  -> local policy enforcement
  -> execution
  -> verification
  -> structured result
  -> ChatGPT
```

The final user experience should not require opening PowerShell, manually starting the agent, or copying commands between ChatGPT and Windows.

## 2. Core Security Principle

The Windows Agent is the final security boundary.

The system must not rely on ChatGPT, the cloud gateway, database contents, or prompt interpretation being correct in order to remain safe.

The Agent must fail closed when:

- a tool is unknown
- capability is denied
- the target path is outside the allowed scope
- the command is expired
- the operation is a duplicate
- required approval is missing
- arguments fail validation
- policy cannot be loaded or verified

## 3. High-Level Architecture

```text
ChatGPT
   |
   | OAuth 2.1
   v
Supabase OAuth Gateway
   |
   v
Command Queue
   |
   | HTTPS
   v
Windows Node.js Agent
   |
   +-- Tool Registry
   +-- Command Validator
   +-- Permission / Capability Engine
   +-- Path Security
   +-- Sensitive Path Rules
   +-- Local Command Journal
   +-- Execution / Verification
   |
   v
Windows

Windows Agent
   ^
   | Named Pipe
   v
C# / .NET PC Agent Manager
   |
   +-- Start / Stop / Restart
   +-- Watchdog
   +-- Heartbeat
   +-- Diagnostics
   +-- Logs
   +-- Emergency Stop
   +-- Update / Rollback
```

## 4. Component Responsibilities

### 4.1 ChatGPT / Private Plugin

Responsibilities:

- authenticate through Supabase OAuth
- expose safe tools from the gateway
- create requests and plans
- interpret structured results
- perform Observe -> Plan -> Act -> Verify workflows

Must not be the final authorization authority.

### 4.2 Supabase Gateway

Responsibilities:

- authenticate the user
- bind user identity to the correct device
- validate incoming MCP/tool requests
- create commands in the queue
- return structured command results
- enforce command TTL and basic server-side validation

Supabase `service_role` must remain server-side only.

### 4.3 Windows Agent

The Agent is the final execution boundary.

Responsibilities:

- poll the command queue
- validate command envelope
- reject expired or duplicate operations
- enforce Tool Registry rules
- enforce capability policy
- enforce allowed roots and sensitive path rules
- execute tools with safe process/file APIs
- verify results
- write structured results back
- maintain a local execution journal

### 4.4 PC Agent Manager

The Manager is a supervisor, not a second security engine.

Responsibilities:

- start / stop / restart the Agent
- prevent duplicate Agent instances
- track process state
- monitor heartbeat and health
- restart after crashes with backoff
- detect crash loops
- provide diagnostics
- provide tray UI
- provide Emergency Stop
- later manage updates and rollback

The Manager must NOT duplicate Tool Registry, path policy, capability, or risk logic.

## 5. Manager Technology

Preferred implementation:

- C# / .NET 8+
- Windows desktop UI
- Named Pipe IPC
- Mutex for single-instance Manager
- Windows Job Object for Agent containment
- normal user privileges by default

The Node.js Agent remains separate to reuse the existing implementation and reduce migration risk.

## 6. Manager <-> Agent IPC

Use Windows Named Pipes.

Example:

```text
\\.\pipe\PcAgent-{UserSID}
```

Allowed IPC operations should remain minimal:

- `hello`
- `get_status`
- `get_health`
- `get_version`
- `prepare_shutdown`
- `reload_config`

IPC must NOT expose remote-PC execution tools such as:

- `run_command`
- `write_text_file`
- `delete_file`

Remote PC operations must continue to flow through ChatGPT -> OAuth -> Gateway -> Queue -> Agent.

## 7. Heartbeat & State Model

The Manager must not treat process existence as health.

The Agent should emit heartbeat information containing at least:

- agent state
- last poll time
- queue connectivity
- active command ID, if any
- agent version
- protocol version

Suggested health states:

- `STOPPED`
- `STARTING`
- `HEALTHY`
- `DEGRADED`
- `RECONNECTING`
- `CRASHED`
- `CRASH_LOOP`
- `UPDATING`
- `EMERGENCY_STOPPED`

Crash recovery must use exponential backoff and stop automatically after a configured crash-loop threshold.

## 8. Tool Registry

Every remotely executable operation must be registered explicitly.

Each tool definition should include:

- name
- tool version
- category
- required capability
- risk level
- timeout
- retry policy
- idempotency classification
- confirmation requirement
- allowed root rules where applicable
- input validator
- execution handler
- verification strategy

Unknown tools are rejected.

Initial read-only tools:

- `gateway_probe`
- `relay_ping`
- `ping`
- `system_info`
- `list_directory`
- `read_text_file`
- `list_processes`

## 9. Capability Model

Use capability-based authorization rather than a single read/write toggle.

Examples:

- `file.read`
- `file.write`
- `file.delete`
- `command.development`
- `process.inspect`
- `process.start`
- `process.stop`
- `system.modify`

Policy values:

- `ALLOW`
- `CONFIRM`
- `DENY`

Suggested user-facing profiles:

- Observe
- Safe
- Development
- Manual
- Locked

The Agent, not the Manager, enforces the policy.

## 10. Path Security

Initial writable scope should be restricted to `D:\AI` or explicitly configured roots.

Simple string prefix checks are prohibited.

Existing paths:

1. convert to absolute path
2. resolve actual target with `fs.realpathSync.native()`
3. normalize Windows path semantics
4. compare against real allowed-root boundaries

New paths:

1. identify the nearest existing parent
2. resolve that parent through `realpath`
3. verify the parent is inside an allowed root
4. validate the proposed child name/path
5. only then create the target

Security checks must account for:

- case-insensitive Windows paths
- path traversal
- junctions
- symbolic links
- short 8.3 names
- sibling-prefix confusion (`D:\AI2` must not match `D:\AI`)

## 11. Sensitive Paths

Even inside allowed roots, sensitive files require stronger rules.

Initial examples:

- `.env`
- `.env.*`
- `*.pem`
- `*.key`
- `id_rsa`
- `id_ed25519`
- `credentials.json`
- `token.json`
- credential or SSH directories

Prevent access first; output redaction is only a secondary defense.

## 12. Command Envelope

Each queued command should carry at least:

- `command_id`
- `operation_id`
- `device_id`
- `tool_name`
- `tool_version`
- arguments
- created timestamp
- expiry timestamp
- protocol version
- request identity metadata

`command_id` identifies one queue message.

`operation_id` identifies one logical action across retries/re-deliveries.

## 13. Command Lifecycle

Suggested lifecycle:

```text
CREATED
  -> QUEUED
  -> CLAIMED
  -> RUNNING
  -> SUCCEEDED
```

Additional terminal/intermediate states:

- `FAILED`
- `CANCELLED`
- `EXPIRED`
- `REJECTED`
- `WAITING_APPROVAL`
- `UNKNOWN_OUTCOME`

`UNKNOWN_OUTCOME` is required when execution may have occurred but the result cannot be confirmed. Such commands must not be blindly retried.

## 14. Local Command Journal

The Agent should keep a small SQLite journal.

Minimum data:

- command ID
- operation ID
- tool name
- status
- start time
- completion time
- retry policy
- result hash / outcome metadata

Avoid storing full file contents, credentials, or unnecessary command payloads.

The journal is used to prevent duplicate non-idempotent execution and to recover safely after Agent/PC restarts.

## 15. Retry Policy

Tool definitions should classify retry behavior:

- `SAFE_RETRY`
- `VERIFY_BEFORE_RETRY`
- `NEVER_AUTO_RETRY`

Examples:

- read/list operations -> `SAFE_RETRY`
- file writes -> `VERIFY_BEFORE_RETRY`
- arbitrary development commands -> normally `NEVER_AUTO_RETRY`

## 16. Safe Write Foundation

Write tools must not be enabled until the safety foundation is working.

Initial write tools:

- `create_directory`
- `write_text_file`
- `edit_text_file`

No delete tool in the first write phase.

Requirements:

- allowed-root validation
- sensitive-path validation
- expected file hash / optimistic concurrency
- atomic write
- backup when appropriate
- read-back verification
- command journal
- operation ID deduplication
- expiry checks

## 17. Development Command Runner

Do not expose a generic shell string.

Use structured execution:

```json
{
  "program": "npm",
  "args": ["test"],
  "cwd": "D:\\AI\\project"
}
```

Mandatory constraints:

- `shell: false`
- stdin disabled / ignored
- stdout/stderr piped
- default timeout required
- hard maximum timeout enforced by Agent
- cwd must be within allowed roots
- environment variables must be sanitized
- output size must be capped
- full process tree must be terminated on timeout

Program allowlist alone is insufficient. Subcommand policies are required.

Example:

```text
git status   -> ALLOW
git diff     -> ALLOW
git log      -> ALLOW
git add      -> CONFIRM
git commit   -> CONFIRM
git push     -> CONFIRM
git clean    -> DENY
git reset    -> DENY
```

## 18. Observe -> Plan -> Act -> Verify

Long-term workflow:

```text
USER REQUEST
  -> OBSERVE
  -> PLAN
  -> RISK / POLICY CHECK
  -> OPTIONAL APPROVAL
  -> ACT
  -> LOCAL VERIFY
  -> REMOTE VERIFY
  -> COMPLETION CRITERIA
```

On failure:

```text
OBSERVE FAILURE
  -> REPLAN
  -> ACT
  -> VERIFY
```

Plans must have bounded execution budgets such as:

- max actions
- max retries
- max duration

Repeated identical failure fingerprints should stop the loop and require user review.

## 19. Completion Criteria

ChatGPT must not declare success solely because a mutation call returned successfully.

Examples of completion criteria:

- target file hash matches expected output
- `npm test` exit code is 0
- build command exit code is 0
- required output exists

Partial completion should be represented separately from full success.

## 20. Manager UI MVP

Initial Manager UI should stay small.

```text
PC Agent

Agent       Running / Stopped / Error
Supabase    Connected / Unreachable
Heartbeat   age

[Start]
[Stop]
[Restart]
[Diagnose]

[EMERGENCY STOP]
```

Later screens may include:

- Home
- Activity
- PC Agent
- Permissions
- Diagnostics
- Settings

## 21. Emergency Stop

Emergency Stop must work locally and must not depend on Supabase.

It should:

1. block new command processing
2. cancel queued work where safe
3. disable automatic restart
4. stop the Agent
5. persist the locked state across reboot

Resume must require explicit local user action.

## 22. Update Strategy

Post-MVP, the Manager should own Agent update and rollback.

Expected flow:

```text
Download
  -> verify manifest / hashes
  -> stop Agent
  -> install staged version
  -> start Agent
  -> heartbeat / health check
  -> commit update
```

On health failure:

```text
rollback to previous version
```

Program files and persistent data must remain separated.

## 23. Security Scope for v1

v1 should prioritize simple, auditable protections:

- HTTPS/TLS
- high-entropy per-device token
- DPAPI / Credential Manager storage
- Tool Registry
- capability enforcement
- allowed-root enforcement
- sensitive-path rules
- command expiry
- operation ID deduplication
- local journal
- `shell: false`
- stdin disabled
- timeout enforcement
- process-tree containment
- Emergency Stop
- fail-closed behavior

The following are intentionally post-v1 unless testing proves they are needed earlier:

- Ed25519 command signing
- signed results
- signed approvals
- canonical JSON signing
- full taint tracking
- nonce/replay database beyond operation journal semantics

## 24. Repository Structure

Target repository structure:

```text
pc-agent/
  manager/        # .NET Manager
  agent/          # Node.js Agent
  gateway/        # Supabase Edge Functions
  plugin/         # ChatGPT Plugin / MCP definition
  protocol/       # shared schemas
  database/       # DB schema / migrations
  installer/      # Windows installer
  tests/
  docs/
```

Current OAuth login/consent pages may remain in the existing `site-min` repository; this repository is the Source of Truth for the PC Agent system itself.

## 25. Development Roadmap

### v0.1 — Connectivity MVP

- validate current OAuth Readonly V2 path end-to-end
- `gateway_probe`
- `relay_ping`
- `ping`
- `system_info`

### v0.2 — Agent Safety Foundation

- Tool Registry
- capability policy
- allowed roots
- sensitive paths
- operation ID
- command expiry
- journal foundation

All existing read-only tools should work through the new registry before write support is introduced.

### v0.3 — C# Manager / Supervisor

- start / stop / restart
- heartbeat
- process supervision
- crash recovery
- crash-loop detection
- tray
- diagnostics
- Emergency Stop

### v0.4 — Safe Write

- create directory
- write text file
- edit text file
- expected hash
- atomic write
- backup
- verification

### v0.5 — Development Runner

- structured `program + args[]`
- shell disabled
- stdin disabled
- timeout
- sanitized environment
- output limits
- process-tree termination
- subcommand policy

### v0.6 — Transactional Updater / Rollback

- check the latest stable GitHub Release
- download a versioned Windows bundle and checksum
- verify SHA-256 before extraction
- reject archive path traversal / oversized archives
- stage the new version beside the current version
- run bundle-check before switching
- stop the current Agent cleanly
- use a bootstrap process outside the normal Manager mutex
- run the candidate Manager in headless update-health-check mode
- require the candidate bundled Agent to become HEALTHY and connected
- launch the candidate Manager in background mode
- automatically restore the previous Manager and startup registration on failure
- publish release ZIP + SHA-256 assets from a version tag

### v0.7 — Bounded Observe -> Plan -> Act -> Verify Foundation

- cloud-side task records bound max actions, retries, total steps, and duration
- ChatGPT remains the planner; the gateway only enforces the execution budget
- each task step dispatches exactly one existing Agent tool
- observe and verify phases are read-only
- act phases use only existing locally governed write/development tools
- Agent Tool Registry and local approval remain the final authorization boundary
- task audit records omit full arguments and full results
- repeated identical failure fingerprints block the task after the second consecutive occurrence
- success requires a final successful verify step
- task metadata is carried in command request_metadata for traceability
- protocol version remains 1 because the Agent authorization envelope is unchanged

### v0.8 — Repository Repair Workflow

- treat non-zero development-command exit codes as failed Agent tool executions
- allow approved Git inspection during Observe
- restrict Act to existing safe-write tools
- allow approved Git inspection, npm test, and node --test during Verify
- retain explicit local approval for every Development Runner invocation
- persist SHA-256 result evidence rather than duplicating full output in task audit tables
- require final Verify evidence before task success
- validate the flow on a real repository: inspect -> edit -> test -> verify

### v0.8.2 — Legacy Worker Retirement

- register ping as a normal low-risk Agent Tool Registry operation
- route OAuth ping through agent_queued / agent_claimed
- remove the OAuth runtime dependency on the legacy queue worker
- stop and disable the old standalone kaito-device-agent worker only after v1 ping passes end-to-end
- verify device heartbeat remains on the current Agent version after legacy shutdown

### Later

- richer completion-evidence policies
- approvals and risk UX
- installer
- stronger cryptographic device identity if warranted

## 26. Current Prototype Rule

The school-PC prototype is a throwaway feasibility spike only.

It must not:

- register startup entries
- modify arbitrary files
- execute arbitrary commands
- install services
- alter production device credentials

The prototype exists only to test:

- .NET self-contained executable launch
- HTTPS access
- Supabase/gateway reachability
- Named Pipe support
- child process supervision
- heartbeat behavior
- school-PC policy restrictions

## 27. Decisions Requiring Future Review

Before production write access is enabled, review:

- exact allowed-root semantics
- exact sensitive-path list
- subcommand policies
- timeout defaults and maximums
- local journal retention
- confirmation rules
- DB lifecycle implementation
- multi-device behavior
- update trust model

## 28. Definition of Success for Initial Production Milestone

The first stable milestone is complete when:

```text
Windows login
  -> Manager starts
  -> Agent starts
  -> Agent becomes healthy
  -> ChatGPT authenticates through OAuth
  -> gateway_probe succeeds
  -> relay_ping succeeds
  -> ping succeeds
  -> system_info succeeds
```

No PowerShell interaction should be required for normal use.
