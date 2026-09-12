# 第二阶段开发执行板

- Goal: 将第一阶段的本地演示骨架升级为可稳定使用、可验证、可平滑接入腾讯云真实服务的微信小程序核心版本。
- Success Criteria: 照片本地持久保存；替换和删除会清理派生数据；异步任务不会覆盖已删除、已替换或人工确认的记录；历史日期可补记；每日回顾可查看；云端服务具备明确且不泄露密钥的客户端边界；核心规则有自动化验证。
- Canonical Artifact: 微信小程序源码与 `services/meal-service.js` 服务边界
- Updated At: 2026-09-12 21:05
- Overall Status: blocked
- Next Action: 确认 T08 的公网部署目标、正式小程序 AppID 和三个合法域名；随后接入私有 COS/混元 Provider 并执行真机远端验收。

## Task Index

| ID | Title | Priority | Status | Owner | Dependencies |
| --- | --- | --- | --- | --- | --- |
| T01 | 明确第二阶段服务边界与状态模型 | P0 | done | main | none |
| T02 | 实现照片持久化和替换/删除清理 | P0 | done | main | T01 |
| T03 | 实现安全的异步任务与人工确认保护 | P0 | done | main | T01 |
| T04 | 补齐历史补记和每日回顾闭环 | P1 | done | main | T02, T03 |
| T05 | 建立真实云服务适配层和配置说明 | P1 | done | main | T01 |
| T06 | 自动化测试与微信开发者工具验收 | P0 | done | main | T02, T03, T04, T05 |
| T07 | 实现可部署的最小远端 API | P0 | done | main | T05 |
| T08 | 公网部署与真机远端验收 | P0 | blocked | main | T06, T07 |

## Shared Context

- Constraints: 原生微信小程序；真实照片保持私密；长期云密钥不得进入小程序、聊天或仓库；保留用户对 `project.config.json` 和 `project.private.config.json` 的本地改动；当前 POC 预算上限 100 元。
- Inputs: `CONTEXT.md`、`.wayfinder/meal-diary-mvp-map.md`、既有本地 MVP、腾讯云 POC 已就绪决议。
- Global Risks: 微信临时图片路径会失效；旧异步任务可能回写到已替换记录；人工确认可能被重试结果覆盖；真实后端地址和部署方式尚未接入。
- Verification Standard: Node 自动化测试覆盖状态迁移和一致性规则；微信开发者工具完成拍照、替换、删除、重试、历史补记与回顾的手工验收。

## Task T01: 明确第二阶段服务边界与状态模型

- Context: 第一阶段将存储、异步模拟和业务规则集中在单一服务中，但尚无版本迁移、任务标识或云端适配边界。
- Priority: P0
- Status: done
- Owner: main
- Dependencies: none
- Deliverable: 版本化状态模型、明确的记录/任务状态与可替换服务接口。
- Last Updated: 2026-09-09 22:43

### Execution Notes

- Files or surfaces: `services/meal-service.js`、新增服务模块与测试辅助代码。
- Plan: 将存储模式升级为 v2；为风格化与营养任务分别记录任务标识和起始时间；隔离本地模拟和远端调用入口。
- Risks: 必须兼容已经保存在开发者工具中的 v1 演示数据。

### Progress Log

- 2026-09-09 22:33 任务已创建并开始梳理现有状态模型。
- 2026-09-09 22:43 已完成 v1 到 v2 的兼容迁移、独立处理任务模型和统一结果合并入口。

### Completion Evidence

- `npm test` 中的迁移、陈旧任务与替换/删除防回写测试通过。

## Task T02: 实现照片持久化和替换/删除清理

- Context: `wx.chooseImage` 返回临时路径，当前记录可能在重启或系统清理后丢图，替换/删除也没有清理本地保存文件。
- Priority: P0
- Status: done
- Owner: main
- Dependencies: T01
- Deliverable: 新照片通过 `wx.saveFile` 持久化；替换或删除后安全清理不再引用的本地文件。
- Last Updated: 2026-09-10 00:18

### Execution Notes

- Files or surfaces: `services/image-storage.js`、`pages/home/index.js`、`services/meal-service.js`。
- Plan: 文件操作封装为 Promise；先保存新文件再原子替换记录；清理失败不破坏记录主流程但会留下可观测提示。
- Risks: 只能删除由小程序保存的本地文件，不能误删相册原图或临时文件。

### Progress Log

- 2026-09-09 22:33 任务已创建。
- 2026-09-09 22:43 已接入 `wx.saveFile` 持久化和受控的 `wx.removeSavedFile` 清理；详情页新增替换照片入口。
- 2026-09-10 00:03 已通过开发者工具真实文件选择器上传桌面 `饭.png`（553,491 字节），保存路径从临时地址转换为小程序持久文件地址且记录标记为受管文件。

### Completion Evidence

- 文件存储单元测试通过；开发者工具真实相册选择、`wx.saveFile` 和持久文件展示通过。

## Task T03: 实现安全的异步任务与人工确认保护

- Context: 当前共用 `createdAt` 判定两个任务，重试会互相影响，且营养重试会清空用户确认结果。
- Priority: P0
- Status: done
- Owner: main
- Dependencies: T01
- Deliverable: 独立任务标识、失败/重试状态、陈旧任务防回写，以及人工确认营养不被自动结果覆盖。
- Last Updated: 2026-09-09 22:43

### Execution Notes

- Files or surfaces: `services/meal-service.js`、`pages/detail/index.js`、相关页面状态。
- Plan: 每类任务维护 `taskId/startedAt/status/error`；完成时校验记录和任务标识；营养重试保留已确认结果并把新结果作为候选或明确要求用户确认覆盖。
- Risks: 本地模拟必须与未来服务端回调遵循同一套合并规则。

### Progress Log

- 2026-09-09 22:33 任务已创建。
- 2026-09-09 22:43 已实现独立任务标识、失败状态、陈旧结果防回写、候选营养分析和确定性份量重算。

### Completion Evidence

- 任务重试、删除/替换防回写、人工确认保护与份量重算测试通过。

## Task T04: 补齐历史补记和每日回顾闭环

- Context: 路线图要求历史日期补记和次日首次打开的每日回顾，当前日历只能查看已有记录，首页回顾只是跳转提示。
- Priority: P1
- Status: done
- Owner: main
- Dependencies: T02, T03
- Deliverable: 可选择历史日期的日视图/补记入口，以及可关闭且每天只自动出现一次的前日回顾。
- Last Updated: 2026-09-10 00:18

### Execution Notes

- Files or surfaces: `pages/calendar/*`、新增回顾或日视图页面、`app.json`、日期工具。
- Plan: 优先复用四个餐次卡位组件结构；回顾基于已有记录和已确认数据生成。
- Risks: 不把回顾做成连续打卡或健康评分。

### Progress Log

- 2026-09-09 22:33 任务已创建。
- 2026-09-10 00:18 已完成历史日期选择、空餐次补记、已记录日期快捷入口、独立每日回顾、昨日首次自动展示及当天防重复展示。

### Completion Evidence

- 自动化测试覆盖每日回顾汇总与自动展示状态；开发者工具用真实图片完成 9 月 9 日午餐历史补记，页面状态确认 1 餐、620 kcal 汇总正确。

## Task T05: 建立真实云服务适配层和配置说明

- Context: 真实 COS 与混元只能由自有后端持有长期密钥，小程序需要稳定的 API 契约、短时授权和轮询/回调模型。
- Priority: P1
- Status: done
- Owner: main
- Dependencies: T01
- Deliverable: 本地/远端模式适配层、无密钥客户端配置、接口契约和接入说明。
- Last Updated: 2026-09-11 19:38

### Execution Notes

- Files or surfaces: `services/`、配置样例、`README.md`、API 契约文档。
- Plan: 小程序仅配置 HTTPS API 基址；上传、创建记录、查询任务、修改确认数据和删除均通过后端鉴权。
- Risks: 真实域名、后端部署环境、微信 request 合法域名仍需用户在控制台配置。

### Progress Log

- 2026-09-09 22:33 任务已创建。
- 2026-09-11 19:26 五个 UI 页面完成视觉重构并提交；开始设计和实现可保留本地模拟默认行为的远端服务适配层。
- 2026-09-11 19:38 已完成 mock/remote 运行模式、微信短期会话、受鉴权上传、任务轮询/重试、签名图续签、用户修正同步与持久删除队列；补齐远端 API v1 契约。

### Completion Evidence

- `npm test` 共 17 项通过，其中 8 项覆盖远端 HTTPS、短期会话、401 换新、上传、结果合并、远端/本地隔离、陈旧任务拒绝与删除重试。
- `npm run check` 与 `git diff --check` 通过；小程序默认仍保持 `mock` 模式，不包含任何云端长期密钥。

## Task T06: 自动化测试与微信开发者工具验收

- Context: 数据一致性是上线前高风险面，且部分文件系统/API 行为只能在微信运行时验证。
- Priority: P0
- Status: done
- Owner: main
- Dependencies: T02, T03, T04, T05
- Deliverable: 可本地运行的核心服务测试、静态检查，以及微信开发者工具手工验收清单。
- Last Updated: 2026-09-12 21:05

### Execution Notes

- Files or surfaces: `tests/`、`package.json` 或零依赖测试脚本、验收文档。
- Plan: 通过 wx 适配桩覆盖迁移、替换、删除、陈旧任务、重试和人工确认；最终在开发者工具验证图片和页面行为。
- Risks: 自动化测试不能替代真实设备上的相机、相册和文件生命周期验证。

### Progress Log

- 2026-09-09 22:33 任务已创建。
- 2026-09-10 00:18 Node 核心测试增至 9 项并全部通过；页面语法检查通过；开发者工具自动化 API 验证首页、日历、回顾页路由和真实图片上传。
- 2026-09-12 21:05 重新执行客户端、远端适配层和真实 HTTP/multipart 服务端契约测试；23 项全部通过，语法检查与差异检查通过，任务收口。

### Completion Evidence

- `npm test` 23/23 通过；`npm run check` 与 `git diff --check` 通过；开发者工具真实图片上传、持久化状态、历史餐次渲染、昨日回顾汇总和首次自动打开通过。真实设备相机、远端替换/删除与离线恢复并入 T08 发布前验收。

## Global Progress Log

- 2026-09-09 22:33 第二阶段执行板已创建；当前不依赖用户提供密钥即可开始 T01-T03。
- 2026-09-09 22:43 第一批增量实现完成；7 项自动化测试与 JavaScript 语法检查通过，等待微信开发者工具手工验收。
- 2026-09-10 00:18 第三阶段历史补记与每日回顾完成；真实上传测试期间发现并修复日历循环变量渲染缺失、首页初次路由竞争两个运行时问题。
- 2026-09-11 19:26 进入 T05；约束为客户端仅保存公开 API 基址，微信登录态换取短期会话，所有腾讯云长期密钥继续只保留在服务端。
- 2026-09-11 19:38 T05 完成并进入联调评审；下一阻塞面是按 v1 契约部署后端、配置微信合法域名并完成真机远端流程验收。
- 2026-09-11 20:02 开始 T07；采用零第三方依赖、单实例可运行的 POC API 先闭合 v1 契约，真实腾讯云 Provider 与公网部署由 T08 接续。
- 2026-09-12 21:00 T07 完成；服务入口冒烟、23 项自动化测试、静态检查与差异空白检查通过，T08 等待公网与腾讯云资源信息。
- 2026-09-12 21:05 T06 在复跑 23 项测试和静态检查后由 review 收口为 done；当前唯一未完成任务为 T08。

## Task T07: 实现可部署的最小远端 API

- Context: 客户端远端适配和 API v1 契约已经完成，但仓库内尚无可启动的服务端，无法执行端到端联调。
- Priority: P0
- Status: done
- Owner: main
- Dependencies: T05
- Deliverable: 可通过环境变量配置并直接启动的最小 Node.js API、受限上传与短期会话、幂等餐食/任务状态机、签名图片读取、用户修正、删除和契约集成测试。
- Last Updated: 2026-09-12 21:00

### Execution Notes

- Files or surfaces: `server/`、`tests/server-api.test.js`、`package.json`、`README.md`、`spec/cloud-api-contract.md`。
- Plan: 不引入第三方依赖；本地 Provider 用于自动化联调，微信 code2session 和腾讯云真实资源通过明确适配边界与环境变量接入。
- Risks: 单实例内存状态和本地文件只适合 POC；私有 COS、混元、内容安全、共享持久化与生产级限流必须在 T08 部署环境中替换和复核。

### Progress Log

- 2026-09-11 20:02 已确认客户端 17 项测试及静态检查通过，开始实现服务端契约。
- 2026-09-12 21:00 已实现短期会话、受限 multipart 上传、元数据移除、用户隔离、幂等餐食/任务、人工确认保护、短时签名图、限流、预算闸门与幂等删除；补齐容器和部署说明。

### Completion Evidence

- `npm test` 共 23 项通过，其中 6 项通过真实 HTTP/multipart 覆盖服务端契约；`npm run check` 与 `git diff --check` 通过。
- `npm start` 成功监听 3000 端口，`GET /health` 返回 `{"ok":true,"provider":"local-poc"}`。

## Task T08: 公网部署与真机远端验收

- Context: 微信小程序远端模式要求已备案 HTTPS API、微信合法域名、真实 AppID/AppSecret，以及服务端腾讯云资源和凭证。
- Priority: P0
- Status: blocked
- Owner: main
- Dependencies: T06, T07
- Deliverable: 部署真实后端、配置 request/uploadFile/downloadFile 合法域名，并完成真机登录、上传、任务、重试、替换、删除和离线恢复验收。
- Last Updated: 2026-09-12 21:00

### Execution Notes

- Files or surfaces: 部署平台、微信公众平台、腾讯云 COS/混元/内容安全、`config/runtime.js`。
- Plan: T07 通过后根据用户可用的域名与云资源选择部署目标；所有长期密钥只写入服务端受管环境变量。
- Risks: 当前仓库上下文未提供公网域名、正式小程序 AppID 或云端运行环境，不能提前宣称真机远端验收完成。

### Progress Log

- 2026-09-11 20:02 已登记为 T07 后续任务。
- 2026-09-12 21:00 POC 契约前置已完成；当前缺少公网部署目标/域名、正式小程序 AppID 和腾讯云 COS/混元运行资源，无法安全完成真实 Provider 与真机合法域名验收。

### Completion Evidence

- 待补充。

## Final Closure

- Delivered: 已交付照片持久化、受控清理、异步一致性、人工确认保护、历史补记、每日回顾、可切换客户端适配层、API v1 契约，以及可执行的零依赖远端 API POC 与容器入口。
- Verified By: `npm test` 23/23 通过；`npm run check`、`git diff --check`、服务启动与健康检查通过；此前微信开发者工具真实桌面图片上传与本地模式运行时页面状态通过。
- Remaining Follow-ups: 用私有 COS、混元、内容安全、共享存储和持久任务队列替换本地 POC Provider；部署公网 HTTPS、配置微信合法域名，并完成远端模式、真实设备相机、替换、删除和离线恢复验收。
