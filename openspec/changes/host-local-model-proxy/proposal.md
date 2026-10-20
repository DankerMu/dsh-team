# Why

Issue #269 identifies a missing trusted-host configuration source: the restricted model driver intentionally drops ambient proxies, so the Docker/Buildx client cannot reliably use the host's existing loopback proxy. Add that source at the canonical Docker environment boundary without forwarding local credentials or broadening the model driver's environment.

# What Changes

- Define optional private host-local JSON configuration at `~/.config/dsh-team/docker-proxy.json`, with a closed uppercase proxy field set and literal-loopback transport restriction.
- Restricted invocation Docker clients read that source; ambient caller proxies are not their authority. Ordinary non-restricted verification preserves its current uppercase projection, including explicit empty values.
- Preserve general command/model-driver, browser and employee environment custody, private Docker configuration, local Engine constraints, one-shot admission and retirement.
- Add real-file/process transport and rejection evidence plus existing operator guidance. Actual Buildx/provider acceptance remains a separately authorized one-shot gate, not simulated success.

# Capabilities

## New Capabilities

None.

## Modified Capabilities

- `browser-runtime-verification`: distinguish ordinary caller proxy projection from restricted host-local selection and specify private configuration/transport custody.

# Impact

Canonical `scripts/docker-proxy-environment.mjs`, the trusted worker's Docker adapter, their existing verification consumers and targeted integration fixtures; operator guidance in AGENTS.md. No new dependency, host service, platform runtime setting, SSH field or systemd credential lifecycle.

# Triage

Issue type: feature
Fixture level: expanded
Upstream suggested level: absent (expanded: private config parser, shared script entry and credential custody)
Blast radius: trusted verification transport, secret exposure and independent cleanup availability
Selected risk packs: script entry; config; file IO/path safety; schema; secrets; ordering; input bounds; compatibility; error handling; packaging; documentation
Evidence floor: original-path RED/GREEN, real owned file/process/HTTP/CONNECT evidence, worker/driver custody and standalone archive smoke, canonical checks, four-seat review, exact-head trusted Docker/Compose, separately authorized single real-model/Buildx proof

# Decisions and authorization

The queue request authorizes reachable implementation. The issue's recommended separate host-local file is selected over new systemd-credential provisioning: fixed private JSON uses the existing host-owner trust boundary and adds no remote value transport. No real-model invocation, host proxy/service change or credential-file installation is authorized by this change. Human acceptance remains deferred and UNPASSED.
