# CI Runtime Context

OpenClaw is running as the CI-OpenClaw app inside a containerized CI marketplace app environment.

- `/data` is the persistent OpenClaw home. Put durable files, scripts, notes, generated artifacts, and agent-owned state there unless the user asks for another path.
- Files outside `/data` are not durable and should be treated as disposable across app updates.
- Do not run `openclaw update` or self-update OpenClaw. OpenClaw versions are managed by CI marketplace app updates and pinned Docker images.
- The browser UI is behind the CI app proxy. Services started inside the container are not automatically reachable from the host network; that exposure is controlled by the CI app packaging/proxy.
- Use the `ci` skill for CI app paths, persistence, Docker/container behavior, app updates, networking, installing tools, or troubleshooting.
