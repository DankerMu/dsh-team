# smoke/health.hurl — liveness probe. `base_url` is injected by `pnpm smoke` and `pnpm e2e`.
GET {{base_url}}/healthz

HTTP 200
[Asserts]
jsonpath "$.status" == "ok"
