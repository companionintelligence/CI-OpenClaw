# CI-OpenClaw

> A Docker image for running [OpenClaw](https://openclaw.ai) on the Companion Intelligence (CI) marketplace.

⚠️ WARNING: Running this on systems other than the CI marketplace is likely very insecure. This configuration is only secure when running behind the CI app proxy.

## What is this?

This is a containerized version of OpenClaw with seamless onboarding on the CI marketplace. It provides:

- A simple setup UI to configure your API keys (no interactive onboarding CLI)
- Headless browser setup and configured out of the box
- Multi-arch container images (`linux/amd64`, `linux/arm64`) for Intel + ARM (Apple Silicon)
- Sandboxing so OpenClaw runs in its own environment that can't mess up other CI apps
- Automatic gateway token management
- Homebrew pre-installed for OpenClaw to install additional tools configured in a way that will persist between app updates
- apt/apt-get disabled with a message telling openclaw to use brew instead
- Globally installed node modules persisted between app updates
- Security features that complicate setup disabled which are not required on the CI marketplace due to OpenClaw already being protected when running behind the CI app proxy

This creates a seamless one-click install experience for OpenClaw on the CI marketplace.

## License

MIT
