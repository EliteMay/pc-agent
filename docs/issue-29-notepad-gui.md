# Goal #29: Notepad GUI input (v0.11.3 candidate)

## Scope

- `notepad_gui` is an **in-process tool of the self-owned Windows Agent**.
- Allowed actions: `open`, `click`, `type`, `scroll`, `save`.
- Every command is classified **high risk** and requires a new physical approval in the local Manager.
- No Desktop Commander, external automation provider, executable injection or arbitrary commands are part of the production pathway.
- If a protected game is running, the helper refuses operation. Agent Manager Game Safety additionally pauses the Agent.
- The helper searches for exactly one visible, non-minimized `notepad.exe` window, verifies process identity, foreground focus, and bounds. Mouse coordinates are **client-area-relative**, not desktop-relative.
- `open` only launches `notepad.exe` for an existing regular `.txt` file under a configured allowed root, max 1 MiB; symlink resolution and sensitive-path checks occur in the Agent before launch. Open refuses if a visible Notepad window already exists.
- `click`: `{ "action":"click","x":120,"y":160 }`, within actual client rectangle.
- `type`: `{ "action":"type","text":"Hello" }`, maximum 500 UTF-16 units; Unicode keyboard input only.
- `scroll`: `{ "action":"scroll","direction":"down","steps":2 }`, 1–3 wheel steps.
- `save`: `{ "action":"save" }`. Sends Ctrl+S only; does **not** dismiss an unexpected Save As or overwrite dialog.
- An operation returning `dispatched:true` expressly returns `verified:false`. Read back the screen and saved file to verify.

## Validation gates

1. GitHub Agent CI Windows: Node tests validate input schema, unknown fields, platform gating, sanitized fixed PowerShell runner, path restrictions, malformed result rejection. Windows PowerShell parse and isolated C# compilation checks run.
2. GitHub Gateway CI: Deno type-check the exposed OAuth MCP tool and queue validator. Manager Windows CI: build, regressions, archive verification.
3. Install v0.11.3 using the existing verified Manager upgrade path. Confirm Agent heartbeat version and Game Safety.
4. With only a **harmless test document**, verify the native Agent code on the home PC. No passwords or sensitive documents during screenshot tests.
5. Verify OAuth Plugin exposes `notepad_gui`; initiate a request **through that Plugin**, approve on the local Manager and observe a new `capture_notepad` response in ChatGPT.
6. Stop Desktop Commander entirely. Repeat open → click → type → save → capture → read_text_file solely via the own plugin, Gateway and Agent. **Do not close Issue #29 until all four original exit criteria are evidenced.**

## Known limitations

- Modern Notepad windows may have custom UI; Win32 SendInput may not reach the intended editing control if focus is wrong. Fail closed and inspect a new screenshot, do not silently target desktop or arbitrary windows.
- A user can switch focus while a command is in flight. GUI input is never a fully atomic operation; Notepad is checked before sending each keyboard event, and target changes abort further input. Even an aborted command might have applied a partial operation, so verification is essential.
- Screenshots temporarily exist in the existing Supabase command queue. Delivery redaction and poll-time cleanup are best-effort; database backups or outages can retain data.
- The Plugin E2E gate is blocked if this ordinary ChatGPT conversation does not expose the owned Private Plugin tool; do not replace it with Desktop Commander and declare success.
