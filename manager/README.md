# Manager

The Manager will be a thin C#/.NET supervisor for the Node.js Agent.

Responsibilities:

- Start / Stop / Restart Agent
- heartbeat and health reporting
- crash-loop recovery
- tray/startup integration
- diagnostics
- local Emergency Stop
- update / rollback

The Manager must not implement capability, path, risk, or command authorization logic. Those remain in the Agent.
