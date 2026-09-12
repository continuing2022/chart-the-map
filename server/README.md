# 远端 API POC

这是 `spec/cloud-api-contract.md` 的可执行参考实现，用来在真实腾讯云资源就绪前闭合小程序与后端之间的协议。它只使用 Node.js 内置模块，支持直接运行或构建容器。

## 本地运行

要求 Node.js 20 或更高版本：

```powershell
npm start
```

默认监听 `0.0.0.0:3000`。访问 `GET http://localhost:3000/health` 应返回：

```json
{ "ok": true, "provider": "local-poc" }
```

开发环境默认使用 `AUTH_MODE=dev`，把 `wx.login` code 的哈希当作隔离用户标识，只适合自动化和本地联调。服务不会自动读取 `.env` 文件；`.env.example` 只是部署平台环境变量的字段清单。

## 已实现的契约

- `POST /v1/auth/wechat`：15 分钟签名会话；生产 `wechat` 模式调用微信 `jscode2session`，AppSecret 只从服务端环境变量读取。
- `POST /v1/uploads`：限制请求体、MIME 和图片边长；仅接收 JPEG/PNG，移除 JPEG APP1/APP13 与 PNG 文本/EXIF 块，并调用 Provider 内容安全钩子。
- 餐食创建、查询和单任务重试：以客户端 ID 幂等，独立维护两类任务，异步完成前后均检查任务版本。
- 用户修正：校验备注、食物条目、份量枚举和营养数值；人工确认后的营养重试只写候选结果。
- 图片读取：完成结果返回短时 HMAC 签名地址，删除后旧地址立即失效。
- 删除、限流和预算：删除接口幂等；变更请求按用户限流；按配置成本累计，到达 `POC_BUDGET_CNY` 后返回 `POC_BUDGET_EXCEEDED`。

## 生产环境变量

部署时至少设置：

- `NODE_ENV=production`
- `AUTH_MODE=wechat`
- `ALLOW_LOCAL_POC_PROVIDER=false`
- `PUBLIC_BASE_URL=https://你的已备案API域名`
- `WECHAT_APP_ID` 和 `WECHAT_APP_SECRET`
- 分别随机生成的 `TOKEN_SECRET` 与 `ASSET_SIGNING_SECRET`

其余上传、时效、限流、成本和端口参数见根目录 `.env.example`。不要把任何真实值提交到仓库，也不要把微信 AppSecret、腾讯云 SecretId/SecretKey 或混元密钥放入 `config/runtime.js`。

服务在生产模式下会校验 HTTPS 公网地址、微信配置、两个至少 32 字符的密钥，并默认拒绝启动 `local-poc` Provider。只有不包含真实用户数据的隔离契约联调环境，才可以临时设置 `ALLOW_LOCAL_POC_PROVIDER=true`。

容器构建示例：

```text
docker build -t meal-diary-api .
docker run --rm -p 3000:3000 --env-file <服务端私有环境文件> meal-diary-api
```

## 必须替换的生产边界

`providers/local-provider.js` 会让内容安全直接通过、复制原始图片作为风格化结果，并返回固定营养估算；`app.js` 中的 Map 会把照片、任务、预算和餐食保存在单个进程内。这个组合不能承载真实用户数据，也无法在重启或多实例之间保持一致。

公网联调前必须完成：

1. 把照片资源层替换为当前用户私有前缀下的腾讯云 COS，并由后端签发短时读地址。
2. 把任务 Provider 替换为混元、营养识别和腾讯云内容安全调用；为晚到结果保留现有任务版本检查。
3. 把餐食、任务、幂等键、删除状态、预算台账和限流状态迁移到共享数据库/缓存；部署持久任务队列和失败清理任务。
4. 使用工作负载角色或最小权限子账号，将全部长期凭证放入受管密钥服务。
5. 配置 HTTPS、微信 request/uploadFile/downloadFile 合法域名，再按契约清单完成开发者工具和真机验收。

自动化验证命令为 `npm test` 与 `npm run check`。
