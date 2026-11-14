# JB Malware Engine — Windows Desktop and VPN Architecture

## Product scope

JB Malware Engine is a personal Windows 10/11 desktop application, not a commercial distribution target. There is no Android application in scope. The existing malware-analysis core remains reusable through the NPM workspace package `@jb/malware-engine`; the desktop application is a separate presentation and orchestration layer.

The first desktop experience will use a dark, compact cybersecurity interface. PowerShell remains an internal packaging/maintenance tool only; it is not the intended user interface.

## Repository strategy

For this milestone, keep the Windows desktop application and its architecture documentation in this repository under `apps/windows-desktop/` (planned). This avoids creating a second repository before the desktop shell has a stable boundary. Once the shell and package contract are validated, it can be extracted to `JB-Malware-Desktop` without moving or duplicating the malware core.

No Android repository or APK is planned.

## Layers

1. **Malware core — `packages/malware-engine`**: hashing, bounded static analysis, signatures, URL triage, download inspection, behavior correlation and explicit quarantine workflows. The Node.js API remains independent from Electron and reusable through NPM.
2. **Windows desktop shell — planned `apps/windows-desktop`**: Electron main process owns lifecycle, windows, IPC validation and local persistence. Renderer uses HTML/CSS/JavaScript. Preload exposes a narrow allowlisted API; `contextIsolation: true`, `nodeIntegration: false`, strict Content Security Policy, no remote renderer content. Renderer never receives unrestricted Node.js or filesystem access.
3. **Local persistence**: SQLite for scan history, user preferences and VPN state/audit events. Quarantine remains a protected local filesystem area managed by the core. No cloud database, telemetry, file uploads, Neon or R2 required for the personal MVP.
4. **VPN adapter — planned and independent**: use the established WireGuard protocol through a maintained Windows implementation; do not invent cryptography or a VPN protocol. A real VPN requires an endpoint/server and credentials. A local UI toggle alone does not anonymize traffic. Store endpoint configuration and secrets using Windows-protected storage; never commit keys or credentials.
5. **Network enforcement adapter — future privileged component**: the policy engine is pure JavaScript and does not change Windows networking. A separate Windows service/user-mode component may later enforce policy using supported Windows Filtering Platform APIs, narrowly scoped rules and explicit elevation. Do not install a driver, service, firewall rule, route, DNS override or network filter during this development phase.

## Kill Switch semantics

| Event | Policy decision | Expected behavior |
| --- | --- | --- |
| User requests VPN connection | `block_all` while connecting | No direct traffic while the tunnel is being established |
| Tunnel is confirmed | `vpn_only` | Traffic may use the confirmed VPN tunnel only |
| Tunnel unexpectedly drops | `block_all`, keep Kill Switch armed | Block direct fallback and request reconnection |
| User explicitly selects “Disconnect VPN and allow normal internet” | `direct_allowed`, disarm Kill Switch | Normal connection is permitted |
| Tunnel recovers after unexpected loss | `vpn_only` | Resume traffic only through the confirmed tunnel |
| App/process/Windows exits unexpectedly | Enforcement must remain fail-closed if already armed | Requires persistent OS-level enforcement; not implemented yet |

Closing the window is not equivalent to the explicit “Disconnect VPN and allow normal internet” command. The final UI should provide two distinct actions: **Disconnect and allow normal internet** and **Disconnect but keep internet blocked**. If the app crashes or Windows restarts, safe persistence must be handled by the future enforcement adapter; the current JavaScript policy model alone cannot guarantee this.

The state machine in `src/vpn-kill-switch-policy.js` expresses policy decisions only. It is not an active Kill Switch and does not block Windows traffic.

## Privacy and leak-resistance requirements

Before describing the VPN as leak-protected, validate public IPv4, IPv6, DNS, WebRTC behavior in supported browsers, route/interface changes, reconnect races, sleep/resume, Wi-Fi/Ethernet changes, app crash and Windows reboot. VPN endpoint exceptions must be limited to the configured endpoint; no broad direct-internet exception. Independent leak tests must show no direct fallback while the Kill Switch is armed.

Do not claim absolute “zero leaks” until these tests pass. A VPN endpoint/server is required; privacy cannot be achieved solely by the local malware scanner.

## Delivery phases

- **Phase 1 — current:** document architecture, define and test Kill Switch policy transitions, preserve existing malware core.
- **Phase 2:** create the Electron desktop shell and dark dashboard; wire only safe local core operations.
- **Phase 3:** add local SQLite history/preferences and explicit scan/quarantine UX.
- **Phase 4:** integrate a real WireGuard endpoint and Windows network enforcement adapter, with opt-in elevation and controlled failure tests.
- **Phase 5:** package a per-user Windows installer. No install or system networking changes without the user's explicit approval.

## Safety boundaries

Microsoft Defender stays enabled. No automatic quarantine based only on suspicious heuristics. No silent firewall/network changes. No service/driver installation or privileged operation without separate approval. No cloud telemetry or upload by default. Do not merge this feature branch or modify `main` without approval.
