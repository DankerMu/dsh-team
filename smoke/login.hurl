# HTML entry and local Vite script; rendered form belongs to pnpm test:ui.
GET {{base_url}}/_platform/login

HTTP 200
[Asserts]
header "Content-Type" contains "text/html"
body contains "<html lang=\"zh-CN\">"
body matches "<script[^>]+src=\"/_platform/assets/[^\"]+\\.js\""

GET {{base_url}}/_platform/api/no-such-route

HTTP 404
[Asserts]
jsonpath "$.statusCode" == 404
