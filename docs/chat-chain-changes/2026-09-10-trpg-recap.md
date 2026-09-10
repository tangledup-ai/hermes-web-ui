---
date: 2026-09-10
feature: TRPG recap Hermes sessions
impact: Adds a recap source routed through the existing Hermes bridge and meetings MCP persistence.
pr: pending
---

# TRPG recap chat entry — 2026-09-10

Working tree change (no PR yet). TRPG creates a server-persisted Hermes session with source `trpg_recap`, then navigates to ChatView and sends a skill instruction. The source follows the normal Hermes bridge, remains visible in the session list and survives resume; it does not change the global chat runtime mode. The bundled meetings MCP category reads immutable transcript snapshots and saves evidence-validated recaps back to the meeting. No separate background chat runner is introduced.

Validation: TRPG client/server tests, MCP protocol/autoinjection tests, bridge readiness tests, browser TRPG flow and production build.
