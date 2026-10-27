## Why

#369 and #370. The owner found the first entry into the workbench slow (#350). Measured on the acceptance environment, the platform had the instance ready about 2.7 s after the start request. The rest was the browser downloading about 12.7 MB of uncompressed DSH JavaScript, 10.2 MB of it in one combined plugin script. The installed DSH 0.2.0-rc.2 web server has gzip built in but off by default (`@deepseek-ai/dsh-host-webserver/lib/index.js:103,140-147`), and the managed overlay's `webserver` row sets only `{ host: '0.0.0.0', port: 3080 }` (`platform/src/managed-config/generate.ts:139-142`). gzip at DSH's default level 1 brings the scripts to about 6.1 MB.

The same investigation found that DSH sends no `Cache-Control`, `ETag` or `Last-Modified` for its Vite-hashed `/assets/` files, so every entry re-downloads about 1.5 MB (`index-*.js`, `vendor-*.js` and two stylesheets; a second entry still got 200 with full bodies). DSH has no option for this. The owner chose to have the platform gateway add a long-lived cache header for those hashed files (#370).

## What Changes

- The managed overlay's `webserver` row gains `compression: 'gzip'`; level and threshold stay at DSH's defaults (1 and 1024 bytes). No DSH source change (D1).
- No gateway change: it already forwards `Accept-Encoding` and returns `Content-Encoding`, stripping only hop-by-hop headers (`platform/src/gateway/http.ts:12-22`). DSH's own filter leaves `text/event-stream` and `Content-Range` responses uncompressed.
- Docker evidence through the real platform gateway: compressed large script with byte-identical decoded body, an uncompressed SSE stream that still delivers its first frame.
- **Gateway (#370).** `forwardHttp` adds `Cache-Control: private, max-age=31536000, immutable` to a forwarded response only when the method is GET or HEAD, the request has no query string, the path is a Vite-hashed DSH asset (`/assets/[<lowercase dir>/]<name>-<8 base64url chars>.(js|css|woff2|woff|ttf)`), the upstream status is 200 and the upstream sent no `Cache-Control`. Everything else is forwarded exactly as before. `private` because these responses sit behind the platform session.
- Docker evidence through the real platform gateway for both behaviours.
- AGENTS.md / DEPLOY.md mention gzip and the asset cache header.

## Triage

```text
Issue type: feature
Fixture level: expanded
Upstream suggested level: absent (the gateway is a shared entrypoint for every employee request; production overlay config also changes)
Blast radius: every employee page load; a wrong overlay value fails DSH boot (schema-validated) and every Docker lane; a compression bug would corrupt or stall responses; an over-broad cache predicate would pin a non-immutable response in browsers for a year
Selected risk packs: Config / project setup; Legacy compatibility / examples; Resource limits / large input / discovery; Error handling / rollback / partial outputs; Documentation / migration notes
Evidence floor: generate.test.ts exact row; http.test.ts cache predicate matrix; pnpm check; exact-head VPS pnpm test:docker + pnpm test:deploy with the gzip/SSE assertions
```
