# DuckDuckGo search plugin (image-baked)

This directory is a **build-time placeholder**. The real
`@openclaw/duckduckgo-plugin` package is unpacked here during `docker build`
(see `Dockerfile`), pinned to the same version as the global `openclaw@`
install.

Do not commit the npm package contents. Reconcile loads this path via
`ensureOpenClawPlugin` and sets `tools.web.search.provider` to `duckduckgo`
so appliance installs get free web search without the onboarding search wizard
(`--skip-search`).
