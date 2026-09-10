# 第二阶段开发执行板

- Goal: 将第一阶段的本地演示骨架升级为可稳定使用、可验证、可平滑接入腾讯云真实服务的微信小程序核心版本。
- Success Criteria: 照片本地持久保存；替换和删除会清理派生数据；异步任务不会覆盖已删除、已替换或人工确认的记录；历史日期可补记；每日回顾可查看；云端服务具备明确且不泄露密钥的客户端边界；核心规则有自动化验证。
- Canonical Artifact: 微信小程序源码与 `services/meal-service.js` 服务边界
- Updated At: 2026-09-10 00:18
- Overall Status: review
- Next Action: 用户复核第三阶段体验；通过后开始 T05 真实云服务适配层。

## Task Index

| ID | Title | Priority | Status | Owner | Dependencies |
| --- | --- | --- | --- | --- | --- |
| T01 | 明确第二阶段服务边界与状态模型 | P0 | done | main | none |
| T02 | 实现照片持久化和替换/删除清理 | P0 | done | main | T01 |
| T03 | 实现安全的异步任务与人工确认保护 | P0 | done | main | T01 |
| T04 | 补齐历史补记和每日回顾闭环 | P1 | done | main | T02, T03 |
| T05 | 建立真实云服务适配层和配置说明 | P1 | todo | main | T01 |
| T06 | 自动化测试与微信开发者工具验收 | P0 | review | main | T02, T03, T04, T05 |

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
- Status: todo
- Owner: main
- Dependencies: T01
- Deliverable: 本地/远端模式适配层、无密钥客户端配置、接口契约和接入说明。
- Last Updated: 2026-09-09 22:33

### Execution Notes

- Files or surfaces: `services/`、配置样例、`README.md`、API 契约文档。
- Plan: 小程序仅配置 HTTPS API 基址；上传、创建记录、查询任务、修改确认数据和删除均通过后端鉴权。
- Risks: 真实域名、后端部署环境、微信 request 合法域名仍需用户在控制台配置。

### Progress Log

- 2026-09-09 22:33 任务已创建。

### Completion Evidence

- 待补充。

## Task T06: 自动化测试与微信开发者工具验收

- Context: 数据一致性是上线前高风险面，且部分文件系统/API 行为只能在微信运行时验证。
- Priority: P0
- Status: review
- Owner: main
- Dependencies: T02, T03, T04, T05
- Deliverable: 可本地运行的核心服务测试、静态检查，以及微信开发者工具手工验收清单。
- Last Updated: 2026-09-10 00:18

### Execution Notes

- Files or surfaces: `tests/`、`package.json` 或零依赖测试脚本、验收文档。
- Plan: 通过 wx 适配桩覆盖迁移、替换、删除、陈旧任务、重试和人工确认；最终在开发者工具验证图片和页面行为。
- Risks: 自动化测试不能替代真实设备上的相机、相册和文件生命周期验证。

### Progress Log

- 2026-09-09 22:33 任务已创建。
- 2026-09-10 00:18 Node 核心测试增至 9 项并全部通过；页面语法检查通过；开发者工具自动化 API 验证首页、日历、回顾页路由和真实图片上传。

### Completion Evidence

- `npm test` 9/9 通过；`npm run check` 通过；开发者工具真实图片上传、持久化状态、历史餐次渲染、昨日回顾汇总和首次自动打开通过。替换、删除和真实设备相机流程仍建议发布前人工复核。

## Global Progress Log

- 2026-09-09 22:33 第二阶段执行板已创建；当前不依赖用户提供密钥即可开始 T01-T03。
- 2026-09-09 22:43 第一批增量实现完成；7 项自动化测试与 JavaScript 语法检查通过，等待微信开发者工具手工验收。
- 2026-09-10 00:18 第三阶段历史补记与每日回顾完成；真实上传测试期间发现并修复日历循环变量渲染缺失、首页初次路由竞争两个运行时问题。

## Final Closure

- Delivered: 已交付照片持久化、受控清理、异步一致性、人工确认保护、历史补记和每日回顾闭环。
- Verified By: `npm test` 9/9 通过；`npm run check` 通过；微信开发者工具真实桌面图片上传与运行时页面状态通过。
- Remaining Follow-ups: T05 真实后端适配与域名配置；发布前复核真实设备相机、替换和删除流程。
