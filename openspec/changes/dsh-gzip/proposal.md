## Why

#369. The owner found the first entry into the workbench slow (#350). Measured on the acceptance environment, the platform had the instance ready about 2.7 s after the start request. The rest was the browser downloading about 12.7 MB of uncompressed DSH JavaScript, 10.2 MB of it in one combined plugin script. The installed DSH 0.2.0-rc.2 web server has gzip built in but off by default (`@deepseek-ai/dsh-host-webserver/lib/index.js:103,140-147`), and the managed overlay's `webserver` row sets only `{ host: '0.0.0.0', port: 3080 }` (`platform/src/managed-config/generate.ts:139-142`). gzip at DSH's default level 1 brings the scripts to about 6.1 MB.

## What Changes

- The managed overlay's `webserver` row gains `compression: 'gzip'`; level and threshold stay at DSH's defaults (1 and 1024 bytes). No DSH source change (D1).
- No gateway change: it already forwards `Accept-Encoding` and returns `Content-Encoding`, stripping only hop-by-hop headers (`platform/src/gateway/http.ts:12-22`). DSH's own filter leaves `text/event-stream` and `Content-Range` responses uncompressed.
- Docker evidence through the real platform gateway: compressed large script with byte-identical decoded body, an uncompressed SSE stream that still delivers its first frame.
- AGENTS.md / DEPLOY.md overlay notes mention gzip.
- `design.md` is omitted (compact fixture).

## Triage

```text
Issue type: feature
Fixture level: compact
Upstream suggested level: absent (override: the production-config and legacy-compatibility triggers apply, but it is one DSH-owned option whose behaviour, filter and defaults are DSH's; no platform entrypoint, schema, auth or state changes)
Blast radius: every employee page load; a wrong option name or value fails DSH boot (schema-validated) and is caught by every Docker lane; a compression bug would corrupt or stall responses through the gateway
Selected risk packs: Config / project setup; Legacy compatibility / examples; Resource limits / large input / discovery; Documentation / migration notes
Evidence floor: generate.test.ts exact row; pnpm check; exact-head VPS pnpm test:docker + pnpm test:deploy with the gzip/SSE assertions
```
