# Design

## Context

The platform stores an external Document Server address verbatim and never probes it. The instance's `dsh-sidebar-onlyoffice@0.2.0` reaches the address only through the same-origin `/sidebar/onlyoffice/ds/` proxy inside the instance.

- **Refused upstream:** the proxy answers `api.js` with an immediate 502, the script `error` event fires, and the plugin shows `loadFailed` + `errApi` (`src/client/OnlyOfficeView.tsx:55-87, :190-196`; `src/dsProxy.ts:357-374`).
- **Blackholed address:** the 20 s client timeout fires instead, and its rejection stays cached until the page is reloaded.

## Decisions

- **Separate requirement**, not a scenario under "Office 不可用时的退路": that requirement promises a read-only preview with the plugin disabled, which never holds in external mode.
- **Refused loopback address** `http://127.0.0.1:9`: the office-profile lane's `REWRITTEN_URL`, kept with its in-instance no-listener precondition.
  - It behaves the same on every host.
  - Only the instance dials it, so no traffic leaves the host.
  - Its 502 path does not cache the rejection.

  The timeout path is documented from the source and is not observed.

- **Shared state.** The scenario changes the deployment-wide Office setting inside the shared stack lane.
  - It runs last among the Office scenarios: after `officeIdleScenario` and before the spawn check.
  - It starts from the idle-stopped instance.
  - It restores bundled mode on every path, using the `officeIdleScenario` restore pattern, and then proves the bundled Document Server is reachable again.
- **Console scoping.** The one expected 502 is accepted only as an exact console/response pair on the `api.js` URL. The global rules for zero errors, failed requests and external requests stay unchanged.
- **Not promised:**
  - wrong JWT, incompatible version, and errors inside the editor iframe of a reachable Document Server;
  - a licensed server's connection limit, which belongs to that server and its operator.

## Risks

- **Observed UI may differ from the source reading.** The rule is to stop and revise the spec, never to loosen the assertion.
- **A failed restore would poison later lanes.** Restoration failures fail the lane and are aggregated, not swallowed.
