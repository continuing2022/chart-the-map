# 远端 API POC

这是 `spec/cloud-api-contract.md` 的可执行实现，已接入腾讯云 COS、TokenHub 混元生图和可选 PostgreSQL 持久化，支持直接运行或构建容器。

## 当前生图接入：TokenHub

旧混元平台已于 2026-09-30 停服。本项目生产默认使用 TokenHub 的 Hy-Image-3.5-preview；下文旧混元接入记录仅供历史排查，不能用于当前上线。

1. 在 [TokenHub API Key 管理](https://console.cloud.tencent.com/tokenhub/apikey) 创建新平台 API Key。
2. 在 [在线推理－视觉模型](https://console.cloud.tencent.com/tokenhub/inference?regionId=1&serviceType=VISION) 开启 Hy-Image-3.5-preview 的后付费。
3. Render 设置 `AI_PROVIDER=tokenhub`、`TOKENHUB_API_KEY`，保存并部署。COS 密钥继续用于存储，不能代替新平台 API Key。
4. `/health` 应返回 `provider: "tokenhub"`、`aiConfigured: true`；这代表配置就绪，真实模型调用还需通过测试照片确认。未填 Key 时 API 仍能启动，返回 `aiConfigured: false`，生图任务显示缺少配置。

[官方 Hy 生图指南](https://cloud.tencent.com/document/product/1823/135745)规定新接口同步返回结果。后端使用现有后台任务等待请求，小程序继续轮询自有后端。参考照片以 Base64 发送，风格由提示词引导，生成面积为 1024×1024 档位、水印为“AI生成”，结果下载后保存回 COS。

生成超时默认为 5 分钟，可用 `TOKENHUB_GENERATION_TIMEOUT_MS` 调整；图片下载超时沿用 `HUNYUAN_REQUEST_TIMEOUT_MS`。请求不会自动重试。配置 PostgreSQL 后先持久化调用标记；服务重启遇到未完成的同步生成任务会提示中断，由用户决定是否再次生成，避免自动重复计费。新接口不支持用旧任务 ID 恢复查询。

诊断日志为 `tokenhub_failed`，仅记录失败阶段、状态码、错误码和请求 ID。预算台账仍使用估算成本，应按 TokenHub 实际价格配置 `STYLIZATION_COST_CNY` 并设置云端预算告警。营养分析和上传审核仍为 POC 实现。

## 本地运行

要求 Node.js 20 或更高版本：

```powershell
npm ci
npm start
```

默认监听 `0.0.0.0:3000`。访问 `GET http://localhost:3000/health` 应返回：

```json
{ "ok": true, "provider": "local-poc" }
```

配置 `DATABASE_URL` 后，服务启动时会自动执行 `server/db/migrations` 中尚未应用的 PostgreSQL 迁移，从数据库恢复餐食、图片元数据、任务和费用流水，并重新启动未完成的处理任务；健康检查会增加 `"database":"postgres","persistence":"postgres"`。Render Web Service 应使用同区域 PostgreSQL 的 Internal Database URL，并保持 `DATABASE_SSL=false`。也可以单独运行 `npm run db:migrate`。

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
- `AI_PROVIDER=tokenhub`（生产默认值）和 `TOKENHUB_API_KEY`
- `PUBLIC_BASE_URL=https://你的已备案API域名`
- `WECHAT_APP_ID` 和 `WECHAT_APP_SECRET`
- 分别随机生成的 `TOKEN_SECRET` 与 `ASSET_SIGNING_SECRET`
- `ASSET_STORAGE=cos`
- `COS_BUCKET`、`COS_REGION`、`COS_SECRET_ID`、`COS_SECRET_KEY` 和 `COS_KEY_PREFIX=private`

其余上传、时效、限流、成本和端口参数见根目录 `.env.example`。不要把任何真实值提交到仓库，也不要把微信 AppSecret、腾讯云 SecretId/SecretKey 或混元密钥放入 `config/runtime.js`。

服务在生产模式下会校验 HTTPS 公网地址、微信配置和两个至少 32 字符的签名密钥。TokenHub 缺少 API Key 时不会拖垮登录、存储等接口，而是返回未配置的健康状态和明确生图错误。只有不包含真实用户数据的隔离契约联调环境，才可以临时同时设置 `AI_PROVIDER=local` 和 `ALLOW_LOCAL_POC_PROVIDER=true`。

## 历史记录：旧混元接入（已停服）

1. 后端设置 `NODE_ENV=production`、`AI_PROVIDER=hunyuan`。若已有完整的 `COS_SECRET_ID` / `COS_SECRET_KEY`，无需新增密钥；独立密钥可使用成对的 `HUNYUAN_SECRET_ID` / `HUNYUAN_SECRET_KEY`。
2. 在腾讯云开通混元生图计费，并给对应子账号授予 `hunyuan:SubmitHunyuanImageJob` 和 `hunyuan:QueryHunyuanImageJob` 权限；COS 对象读写权限仍需保留。
3. 部署更新，配置 `DATABASE_URL` 时启动会自动执行新增迁移，保存混元任务 ID。访问 `/health` 应看到 `provider: "hunyuan"`，以及 `capabilities: { stylization: "hunyuan", nutrition: "local-poc", moderation: "local-poc" }`。
4. 在小程序上传一张测试餐食图，等待生成后确认风格图及 AI 水印，随后测试重试、换风格和删除。

三种风格由不同中文提示词引导，参考图通过 Base64 发送，单次仅生成一张。混元要求 Base64 小于 8MiB、图片每边小于 5000 像素；超出时任务会提示更换较小照片。默认每 3 秒查询一次，任务上限 10 分钟、单次 API/下载超时 30 秒，可通过 `HUNYUAN_*` 参数调整。

失败时不会复制原图伪装成功。权限、余额、限流和超时错误会返回可读提示，不会向客户端暴露 SDK 错误原文。结果只从腾讯 COS HTTPS 地址下载，限制大小并验证 JPEG/PNG 内容，然后保存到自有存储；供应商一小时有效的 URL 不会作为长期图片地址返回。

启用 PostgreSQL 后，已保存 ID 的任务会在重启后继续查询，不会重新提交。提交成功到任务 ID 落库之间仍存在短暂故障窗口，尚不保证跨实例的严格一次计费；当前仍应单实例运行。预算台账按配置估算成本累计，需按实际混元价格设置 `STYLIZATION_COST_CNY`，并在腾讯云保留账户预算告警。

容器构建示例：

```text
docker build -t meal-diary-api .
docker run --rm -p 3000:3000 --env-file <服务端私有环境文件> meal-diary-api
```

## 必须替换的生产边界

配置完整 COS 环境变量后，服务会自动使用私有 COS 保存原图和生成图，并为生成图签发短时下载地址；对象键按用户哈希隔离，删除餐食时会同步删除相关对象。未配置 COS 时仍使用仅供测试的内存存储。

混元 Provider 已替换真实风格化流程，但营养估算与上传内容安全仍复用 `providers/local-provider.js` 的模拟实现。未配置 `DATABASE_URL` 时业务状态仍在内存中，配置后会持久化到 PostgreSQL；限流和任务调度仍是单进程实现。

公网联调前必须完成：

1. 接入真实营养识别和腾讯云内容安全调用。
2. 配置 PostgreSQL，将限流状态迁移到共享缓存，部署持久任务队列和失败清理任务后再扩展多实例。
3. 使用工作负载角色或最小权限子账号，将全部长期凭证放入受管密钥服务。
4. 把 COS 下载域名加入微信 `downloadFile` 合法域名，并按契约清单完成开发者工具和真机验收。

自动化验证命令为 `npm test` 与 `npm run check`。
