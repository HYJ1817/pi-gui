# P25 Provider Authentication Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the independent frontend task and review; implement the SDK and flow controller in this session. Track each step below.

**Goal:** Expose Pi native authentication safely without reproducing OAuth or leaking credentials.

**Architecture:** User-level controller owns flow identity and single-flight; a private worker uses the proven Pi public SDK. Provider configuration and model RPC responses expose only safe projections. Authentication refresh requests a safe chat-runtime reload and reads Pi state again.

**Tech Stack:** Native Node HTTP, worker_threads, ES modules, existing Electron URL bridge; no added dependencies.

### 1. Credential exits and native SDK

- [x] Add tests/provider-auth.cjs. First prove a fixture key currently leaks through createProviders GET; then test SDK discovery, unknown, OAuth/API/environment metadata, secret omission and HTTPS validation.
- [x] Add server/provider-auth-sdk.js using a worker with stdout/stderr consumed privately and dynamic public SDK import, never internal token APIs. Check exported ModelRuntime methods rather than semver. Only canonical interaction events and descriptor fields leave the worker.
- [x] Harden server/providers.js GET and config/model-fetch writes. Preserve existing disk keys when an environment-reference field is absent; reject new raw keys. Strip model headers and credential fields in SSE model responses.
- [x] Run node tests/provider-auth.cjs and npm run test:models; record red/green evidence.

### 2. Auth flow and runtime synchronization

- [x] Add server/provider-auth.js and route /api/provider-auth before provider configuration routes. GET returns capability/providers/flow/sync. POST login/logout/respond/cancel/sync accepts only providerId, authType, flowId, promptId, value.
- [x] Test single-flight, duplicate/late replies, prompt abort, cancel, timeout, failure, logout readback, workspace changes, same-package Pi restart, changed-package cancellation, secret errors and deferred synchronization.
- [x] Integrate server.js lifecycle. Keep flow independent of cwd; mark model synchronization pending after terminal operations; use existing busy predicates to defer reload, preserve the active session and confirm readiness before synced.
- [x] Run focused suite. No real credentials or real OAuth tests.

### 3. Provider / Authentication UI

- [x] Add public/provider-auth.js with independent request/flow revisions and generic state rendering. All backend requests go through public/api.js; safe browser opening reuses desktop openWebUrl with additional HTTPS validation.
- [x] Extend public/providers.js to show discovered Pi providers, actual auth methods/status/sources and actions, alongside custom models.json configuration. Remove raw key input and presets; retain environment references and custom model discovery.
- [x] Extend tests/smoke.cjs with offline auth endpoints and real behavior assertions. Add auth scenes to visual-harness/cdp-shot at 700, 900, 1200 and 1536 widths.
- [x] Run npm run test:ui and fresh screenshot harness; inspect actual screenshots.

### 4. Review, documentation and delivery

- [x] Add docs/provider-auth.md and update architecture/security/testing/README. Explain Pi 1.0.0 openai vs legacy openai-codex, local evidence limits, CLI fallback, no API Key renderer input and deferred model refresh.
- [x] Review requirements then code quality, fix findings. Run npm test, test:ui and Windows build:app -- --rebuild; packaged auth adapter fixture must work.
- [x] Commit rollback boundaries with Chinese UTF-8 commit files; no version bump, tag, release or push. Report requested 12 evidence items and each acceptance criterion honestly.
