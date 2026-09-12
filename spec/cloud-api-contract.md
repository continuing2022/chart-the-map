# 食光日记远端服务契约 v1

## 目标与边界

小程序只连接项目自有的 HTTPS API，不直接持有腾讯云 `SecretId`、`SecretKey`、COS 长期凭证或混元密钥。后端负责微信身份校验、私有 COS 对象、混元任务、营养分析、内容安全、费用限制与数据删除。

客户端默认仍使用 `mock` 模式。只有后端完成部署、域名加入微信小程序合法域名并完成本契约验收后，才把 `config/runtime.js` 的 `serviceMode` 改为 `remote`，同时填写公开的 `apiBaseUrl`。

## 通用约定

- 基址必须为 HTTPS，不含末尾 `/`，例如 `https://meal-api.example.com`。
- JSON 请求和响应使用 UTF-8；时间戳使用 Unix 毫秒。
- 除登录外，所有接口要求 `Authorization: Bearer <短期会话>`。
- `clientRecordId` 与 `clientTaskId` 是客户端生成的幂等键。后端对相同键重复提交必须返回原资源，不能重复计费或重复创建任务。
- 任务状态只使用 `queued`、`processing`、`completed`、`failed`；失败对象至少包含可安全展示的 `message`。
- 删除接口必须幂等：资源已经删除时仍返回 `204`。
- 原图和风格图始终存入私有 COS；API 不返回永久公开 URL。
- 风格图 `imageUrl` 是短时签名读地址，同时必须返回 `imageExpiresAt`。`GET /v1/meals/:id` 在地址临近过期时返回续签地址。
- 自有 API 域名需要加入微信公众平台的 request/uploadFile 合法域名；签名图所用 COS 自定义域名需要加入 downloadFile 合法域名。

## 1. 微信登录换短期会话

`POST /v1/auth/wechat`

```json
{
  "code": "wx.login 返回的一次性 code"
}
```

```json
{
  "session": {
    "accessToken": "短期、不透明令牌",
    "expiresAt": 1789125600000
  }
}
```

后端使用自己的微信 AppSecret 校验 `code`，令牌只授权当前用户的数据。客户端只缓存短期访问令牌，不接收腾讯云凭证或长期刷新令牌。

## 2. 上传原始照片

`POST /v1/uploads`，`multipart/form-data`

- 文件字段：`file`
- 文本字段：`clientRecordId`、`dateKey`、`slotKey`

```json
{
  "asset": {
    "id": "asset_original_123"
  }
}
```

后端应限制 MIME 类型、文件大小和像素尺寸，移除 EXIF/GPS，完成内容安全检查后写入当前用户的私有 COS 前缀。失败或超时产生的未绑定上传应由短生命周期规则清理。

## 3. 创建餐食与处理任务

`POST /v1/meals`

```json
{
  "clientRecordId": "meal-lunch-...",
  "dateKey": "2026-09-11",
  "slotKey": "lunch",
  "style": "插画",
  "originalAssetId": "asset_original_123",
  "tasks": {
    "stylization": { "clientTaskId": "stylization-..." },
    "nutrition": { "clientTaskId": "nutrition-..." }
  }
}
```

返回 `201`，或对相同 `clientRecordId` 返回等价的已有资源：

```json
{
  "meal": {
    "id": "meal_remote_123",
    "status": "processing",
    "tasks": {
      "stylization": {
        "id": "task_style_123",
        "clientTaskId": "stylization-...",
        "status": "processing"
      },
      "nutrition": {
        "id": "task_nutrition_123",
        "clientTaskId": "nutrition-...",
        "status": "processing"
      }
    }
  }
}
```

## 4. 查询餐食与任务

`GET /v1/meals/:mealId`

返回与创建接口相同的完整 `meal` 快照。完成结果示例：

```json
{
  "meal": {
    "id": "meal_remote_123",
    "status": "completed",
    "tasks": {
      "stylization": {
        "id": "task_style_123",
        "clientTaskId": "stylization-...",
        "status": "completed",
        "completedAt": 1789125300000,
        "result": {
          "assetId": "asset_stylized_123",
          "imageUrl": "https://private-cos.example.com/...?signature=...",
          "imageExpiresAt": 1789128900000
        }
      },
      "nutrition": {
        "id": "task_nutrition_123",
        "clientTaskId": "nutrition-...",
        "status": "completed",
        "completedAt": 1789125290000,
        "result": {
          "nutrition": {
            "items": [
              { "name": "米饭", "portion": "标准", "group": "grain" }
            ],
            "calories": 320,
            "protein": 7,
            "fat": 2,
            "carbs": 68
          }
        }
      }
    }
  }
}
```

客户端只在 `clientTaskId` 仍匹配当前本地任务时合并结果；照片已替换、记录已删除或任务已重试时，旧结果会被丢弃。

## 5. 重试单个任务

`POST /v1/meals/:mealId/tasks/:taskType`

`taskType` 只允许 `stylization` 或 `nutrition`。请求包含新的 `clientTaskId`；风格化重试同时包含 `style`。响应返回完整 `meal` 快照。

```json
{
  "clientTaskId": "nutrition-new-..."
}
```

人工确认后的营养重试结果仍作为候选结果返回，不能在后端自动覆盖已确认数据。

## 6. 同步用户修正

- `PATCH /v1/meals/:mealId`：同步 `{ "note": "..." }`。
- `PUT /v1/meals/:mealId/nutrition`：同步 `{ "nutrition": {...}, "manuallyConfirmed": true }`。

后端必须校验份量枚举、数值范围、文本长度和资源归属。客户端本地即时保存；远端同步失败会保留错误状态，生产发布前应结合网络恢复策略完成真机验收。

## 7. 删除

- `DELETE /v1/meals/:mealId`：删除餐食、原图、风格图、营养数据及未完成任务；返回 `204`。
- `DELETE /v1/uploads/:assetId`：删除尚未绑定餐食的上传；返回 `204`。

客户端先删除本地记录，再把远端删除写入持久队列。网络失败时队列保留，并在后续页面激活和任务刷新时重试。后端必须把已删除记录设为不可回写，并清理晚到的供应商结果。

## 腾讯云实现要求

- 使用独立子账号或工作负载角色，COS 权限限制到应用 Bucket 和用户隔离前缀。
- Bucket 保持私有读写，原图与风格图不通过永久公开 URL 暴露。
- 混元与 COS 长期凭证只存在于后端环境变量或受管密钥服务。
- 服务端对上传、生成、轮询和重试设置用户级限流、幂等键、每日成本上限和审计日志；日志不得记录图片内容、签名 URL、登录 code 或令牌。
- 替换和删除时取消可取消的供应商任务；不可取消的任务完成后立即丢弃结果并删除临时对象。

## 接入验收

- [ ] 微信登录失败、令牌过期和 401 自动重试符合预期。
- [ ] 上传只到自有 API，客户端代码和请求中没有腾讯云长期密钥。
- [ ] 两类任务可独立成功、失败和重试，旧 `clientTaskId` 结果不能回写。
- [ ] 人工确认不会被营养重试覆盖。
- [ ] 短时风格图 URL 可在临近过期时续签。
- [ ] request、uploadFile 与 downloadFile 合法域名均已配置且真机可访问。
- [ ] 替换、删除、离线后恢复均不会留下可访问的孤立对象。
- [ ] 达到 100 元 POC 预算即停止生成，并返回可解释的限额错误。

## 仓库内参考实现状态

`server/` 已实现用于契约联调的零第三方依赖 Node.js POC，自动化覆盖短期会话与用户隔离、multipart 上传、幂等创建、两类任务完成与陈旧结果拒绝、人工确认保护、签名图片读取、预算闸门和幂等删除。它的 `local-poc` Provider 将状态和照片保存在单个进程内，以复制原始图片和确定性营养数据模拟供应商结果。

该实现不是生产腾讯云适配器，不能据此勾选私有 COS、混元、内容安全、共享持久化、公网合法域名或真机验收项。生产部署必须按 [`server/README.md`](../server/README.md) 替换 Provider/存储，并完成上面的全部接入验收。
