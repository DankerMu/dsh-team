# 阶段 0 验证脚本

一次性验证用，不是平台代码的起点。`gateway.mjs` 里用户和端口是写死的。

```sh
docker build -t dsh-poc:0.2.0-rc.2 .
# 每个用户一个容器；shell 沙箱需要两项 security-opt
docker run -d --name dsh-a -e DMXAPI_KEY \
  --security-opt seccomp=unconfined --security-opt systempaths=unconfined \
  -p 127.0.0.1:13081:3080 -v dshpoc-home-a:/data/home -v dshpoc-work-a:/data/work \
  -v "$PWD/managed.patch.yml:/managed/patch.yml:ro" dsh-poc:0.2.0-rc.2 \
  sh -c 'exec dsh --profile web --patch /managed/patch.yml --no-open --trusted-host localhost:8080'
# dsh-b 同理，端口 13082
TOKEN_A=<dsh-a 日志里的 token> TOKEN_B=<dsh-b 的> node gateway.mjs
# 浏览器打开 http://localhost:8080/__login?u=a
```

`managed.patch.yml` 里的模型地址和 `DMXAPI_KEY` 是本次测试用的，密钥只从环境变量读取。

## Office 编辑流程

```sh
docker build -f Dockerfile.office -t dsh-poc-office:0.2.0-rc.2 .          # 预装 pnpm、两个插件、python-docx/openpyxl
docker build -f Dockerfile.office-patched -t dsh-poc-office:patched .     # 给 better-sidebar 0.24.1 打补丁
./up-office.sh                                                            # Document Server + 两个用户容器
TOKEN_A=... TOKEN_B=... node gateway.mjs
```

- `patch-better-sidebar.py`：从 `HOST_OWNED_EXTS` 去掉 docx/xlsx/pptx，否则 ONLYOFFICE 预览器拿不到这些文件。
- `managed.office.{a,b}.yml`：每用户一份覆盖层，`internalBaseUrl` 指向该用户容器。JWT 密钥是测试值。
- 字体从 `assets/fonts/` 只读挂进 Document Server。
- 打开 Office 文件前必须先有一个 Session。
