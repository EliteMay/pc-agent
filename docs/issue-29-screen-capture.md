# Issue #29 - self-owned Notepad screen capture slice

## Status (2026-10-08)

- Implemented **on PR #31's feature branch**, not installed on the home PC or deployed to Supabase.
- Node Agent registers `capture_notepad` with `screen.capture`, medium risk and mandatory local Manager approval.
- Agent launches a **fixed** Windows System32 PowerShell process with a constant embedded helper. It never calls Desktop Commander or takes arbitrary PowerShell from ChatGPT.
- The helper identifies exactly one visible non-minimized `notepad.exe` main window, confirms its real process ID, and uses Windows `PrintWindow`. No desktop-wide screenshot fallback.
- It refuses capture if either `VALORANT` or `VALORANT-Win64-Shipping` is running, checked before and after rendering.
- The JPEG is capped at 960 x 720 pixels and 350,000 bytes, with bounded subprocess time/output and strict Agent result parsing.
- The OAuth gateway exposes `capture_notepad` as an image-capable MCP tool with no input parameters and local-approval metadata.
- Images are transported in the existing authenticated device queue. On successful retrieval, the OAuth gateway replaces the database result with a redaction marker **before** returning the image. The device-poll endpoint also redacts undelivered image results older than two minutes during later authenticated polls.

## Limitations / risks

1. The image can exist **temporarily as JSON in the Supabase command table**. It might remain longer if the gateway fails before acknowledging it and the Agent stops polling. Existing database backups may also retain data. The current design is **not a guaranteed zero-retention image channel**. Do not include passwords, credentials or other confidential text in the test Notepad window.
2. PrintWindow may render a blank or incomplete image for some modern Windows UI components; this has **not** been tested on the actual home PC. Do not silently fall back to desktop capture.
3. The first slice captures **only Notepad**, not arbitrary windows or the full desktop. This is deliberate to prevent accidental exfiltration while the control pathway is being established.
4. Agent/Manager v0.11 currently installed on the home PC does **not** have this feature. Repository code, Supabase Edge Functions and Private Plugin need versioned deployment and end-to-end validation.
5. In this ChatGPT conversation the custom Private Plugin's `ping` / `capture_notepad` tool is not available to execute. Do not claim #29 completion or use Desktop Commander as a substitute.
6. Capturing images repeatedly requires local approval each time. This is a deliberate privacy gate, not a promise of unattended screen surveillance.

## Validation

- Windows Agent CI: Node unit tests check tool registration, local-approval metadata, platform gating, fixed executable path, no shell, sanitized subprocess environment, result bounds, corrupt JPEG rejection, and normalized errors. Windows PowerShell helper syntax is parsed in CI.
- Gateway CI: `deno check` validates both OAuth Gateway and device Edge Function TypeScript.
- Manager CI: existing .NET build and regressions validate unrelated Manager behaviors.
- **Physical PC screenshot, real image rendering in ordinary ChatGPT, plugin ping, Game Safety during capture, and Desktop Commander-off end-to-end Notepad operation remain unverified.**

## Before deployment

1. Review PR #31 and CI. Avoid enabling a new remote screen tool on the installed PC until the change is reviewed.
2. Verify and deploy the exact current OAuth Gateway source on the same `kaito-pc-agent-oauth-readonly` function slug, preserving OAuth. Deploy the `pc-agent-device` cleanup alongside it.
3. Release and install the versioned Agent+Manager bundle. Ensure Manager starts in an **interactive Windows user session**, not a service session. Keep Game Safety and Emergency Stop enabled.
4. Reconnect or refresh the existing Private Plugin so that it advertises `capture_notepad`; do not create a separate third-party remote-control runtime.
5. With Desktop Commander stopped and VALORANT closed, open only one harmless Notepad window. Request `capture_notepad` through the own plugin, approve locally, and verify the image shows only that window.
6. Confirm the database command result is redacted after delivery; then implement mouse, keyboard, and scrolling under a separate security-checked change to complete all four gates of Issue #29.
