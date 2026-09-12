# 本地采集网关（第一阶段）

本阶段实现了外部程序调用 Electron 的完整链路：提交任务、持久化排队、执行流程、查询状态、清洗结果及按实例归档。支持 `page-inspector@1.0.0` 和 `collection-workflow@1.0.0`。后者执行桌面保存的录制步骤、字段提取及翻页循环，使用 `parameters` 复用输入模板。配置方法见[录制与采集指南](collection-workflows.md)。任意 JS 脚本、页面网络响应采集和账号调度仍待实现。

## 启动

默认不开放 HTTP 端口。使用 PowerShell 设置环境变量后启动：

```powershell
$env:CLAWLER_GATEWAY_TOKEN = (node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")
$env:CLAWLER_GATEWAY_PORT = '17840'
pnpm dev
```

已有生产构建时可用 `pnpm start`。Token 必须是 32–256 个非空白 ASCII 字符，部署时应使用随机值，由调用方保存。未指定端口时使用 `17840`；`0` 可分配临时端口，实际地址输出到主进程日志，日志不输出 Token。只指定端口、弱 Token 或非法配置会令启动失败。

全部接口要求 `Authorization: Bearer <token>`，仅监听 `127.0.0.1`，拒绝带 `Origin` 的请求，不开放浏览器 CORS。此入口供同机后端程序调用。跨机器入口、TLS 和租户权限需后续接入，本轮未增加公网监听或云中继。

## 调用示例

在另一个 PowerShell 窗口先设置与服务端相同的 Token，再执行：

```powershell
$base = 'http://127.0.0.1:17840'
$headers = @{ Authorization = "Bearer $env:CLAWLER_GATEWAY_TOKEN" }
$instances = (Invoke-RestMethod "$base/v1/instances" -Headers $headers).instances
$submitHeaders = @{
  Authorization = $headers.Authorization
  'Idempotency-Key' = [guid]::NewGuid().ToString()
}
$body = @{
  instanceId = $instances[0].id
  targetUrl = 'clawler-demo://catalog/'
  cleaning = @{ trim = $true; deduplicate = $true }
} | ConvertTo-Json
$accepted = Invoke-RestMethod "$base/v1/jobs" -Method Post -Headers $submitHeaders -ContentType 'application/json' -Body $body
$jobId = $accepted.job.id
$deadline = (Get-Date).AddSeconds(60)
do {
  Start-Sleep -Milliseconds 500
  $job = (Invoke-RestMethod "$base/v1/jobs/$jobId" -Headers $headers).job
} while ($job.status -in @('queued', 'running') -and (Get-Date) -lt $deadline)
if ($job.status -eq 'succeeded') {
  Invoke-RestMethod "$base/v1/jobs/$jobId/result?format=json" -Headers $headers
  Invoke-WebRequest "$base/v1/jobs/$jobId/result?format=csv" -Headers $headers -OutFile './result.csv'
} else {
  $job | ConvertTo-Json -Depth 10
}
```

省略 `targetUrl` 时使用实例当前目标地址；传入时仅覆盖本次任务，不修改实例。支持 HTTP、HTTPS 和内置示例地址。提交时固定实例配置、Profile 和脚本版本。排队期间修改实例配置不会改写已接受任务，但禁用实例会阻止其后续执行。请求体不接受源码、任意文件路径或未声明字段。

## API

| 方法与路径 | 行为 |
| --- | --- |
| `GET /v1/health` | 服务状态、等待数、运行数、已存数量及容量；不可用时 503 |
| `GET /v1/instances` | 列出桌面中配置的实例 |
| `POST /v1/jobs` | JSON 提交 `{instanceId, targetUrl?, parameters?, cleaning?}`；新任务 202 |
| `GET /v1/jobs?offset=0&limit=50` | 按提交时间倒序分页，返回 `{jobs,total}`；limit 为 1–100 |
| `GET /v1/jobs/:id` | 返回 `{job}`，包含状态、配置快照和完成后的原始 Run |
| `POST /v1/jobs/:id/cancel` | 等待任务直接取消；运行任务持久化取消请求，再通知执行器 |
| `GET /v1/jobs/:id/result?format=json` | 成功任务的清洗结果；format 支持 json、csv、ndjson |

错误统一为 `{ "error": { "code": "..." } }`。主要错误：400 `INVALID_INPUT`、401 `UNAUTHORIZED`、403 `FORBIDDEN`、404 `NOT_FOUND`、409 `CONFLICT` / `RESULT_NOT_READY`、413 `PAYLOAD_TOO_LARGE`、415 `UNSUPPORTED_MEDIA_TYPE`、429 `QUEUE_FULL`、503 `STORAGE_FAILED` / `UNAVAILABLE`。请求体上限 64 KiB，只接受未压缩 JSON。

任务失败由 `job.status` 和 `job.errorCode` 表达，查询失败任务仍返回 200。状态为 `queued → running → succeeded | failed | cancelled`。取消是尽力中止，不能撤销已经发生的页面操作；运行任务取消后需继续轮询到终态。

`Idempotency-Key` 可选，长度为 1–128 个非空白 ASCII 字符。相同键和相同规范化请求返回原任务及 `replayed: true`（200），不同请求复用同一键返回 409。键在当前数据目录中全局唯一，重启仍有效。请求重试应保留原键，新业务任务应使用新键。幂等语义以已保存任务为准，不承诺外部网站操作“恰好一次”。

## 文件与恢复

```text
<Electron userData>/
  runtime/
    runtime.sqlite                       # 桌面配置、运行、步骤、网关任务及产物索引
    runtime.sqlite-wal / -shm             # 运行时可能存在的 SQLite 辅助文件
    instances/<instance UUID>/jobs/<job UUID>/
      job.json                           # 终态元数据、步骤及原始 Run
      result.json                        # 成功任务：嵌套结构
      result.csv                         # 成功任务：kind,text,url 表格
      result.ndjson                      # 成功任务：每行一个记录
```

可在「设置 → 存储位置」配置自定义目录，保存后在下一次启动时离线复制、校验并启用，原目录保留；也可通过 `CLAWLER_DATA_DIR` 显式覆盖（覆盖期间界面不能更改）。`userData` 与 `sessionData` 使用同一根目录，Profile 继续使用原有 `persist:profile-<UUID>` Session 分区。配置、SQLite、归档和浏览器文件一起迁移，详见[目录设置与恢复](storage-location.md)。网关任务产生上述文件归档；桌面手动运行与网关运行共用数据库 Run/Step 表。

数据库由独立工作线程串行访问，使用 WAL 与事务。202 表示任务已提交到数据库；结果文件先原子写入并同步，再将任务终态、Run/Step 和产物路径、大小、SHA-256 一起提交。磁盘失败会停止接受及调度新任务，健康接口报告不可用。文件与 SQLite 不构成跨资源事务，崩溃可能留下未被数据库引用的文件；API 以数据库终态为准。

首次升级会校验原 `workspace.json` 与 `runtime/gateway.json`，分别保存 `.pre-sqlite.backup.json` 原文备份，再以一个事务导入。迁移成功后不再读写旧 JSON；损坏数据库或未知版本会阻止启动，不会退回旧快照覆盖新数据。详见[事务运行库](runtime-storage.md)。

- 正常退出：中止正在执行的网关或桌面任务，等待终态保存并关闭数据库线程，保留未开始任务。
- 非正常退出：下次启动继续 `queued`；之前的 `running` 标记为 `failed / INTERRUPTED`，不自动重放可能产生副作用的浏览器操作。
- 同一数据目录由单个 Electron 应用实例持有，防止同时写入队列和 Session。

页面检查脚本的清洗默认去除标题、标题列表和链接文本的首尾空白，并对标题以及 `(链接文本, href)` 去重，不修改原始 Run。该脚本的 CSV 和 NDJSON 使用 `kind,text,url`。采集流程则在执行时裁剪字段空白并按完整记录去重；JSON 保留 `records` 和 `collection` 元数据，CSV 使用配置的字段名，NDJSON 每行一条采集记录。CSV 转义网页提供的公式前缀。

## 容量与后续工作

目前是可验证的单机网关基础，尚不是完整企业级平台：

- 浏览器并发为 1，HTTP 可并发提交，执行排队；桌面操作或录制占用执行器时网关等待。页面检查脚本超时 30 秒，采集流程总超时 120 秒。
- 默认最多 100 个等待/运行任务、1000 个历史任务；达到任一上限返回 429，不自动删除未完成任务、幂等键或 Profile。历史终态任务超出 1000 条或归档字节超过 2 GiB 时，从最旧终态任务开始清理（归档文件、产物索引与孤儿 Run 一并删除），清理失败时数据库不声称已删除。
- 状态已分表保存到 SQLite，但服务仍交换有界完整快照，内存队列尚未改为数据库分页调度。高吞吐、多租户和持续长期运行仍需增量命令与监控。
- 网关队列通过 HTTP 管理；桌面运行页仍显示最近 50 条实际 Run。
- 应用需持续运行，关闭即停止网关。尚无系统服务、托盘守护、自动启动或防休眠能力。
- 已有点击、普通文本输入、等待及翻页提取。尚未实现通用脚本沙盒、上传/下载/键盘等完整 RPA SDK、页面请求/响应捕获、账号池租约与轮换、Profile 代理、Webhook 重试和通用结果 Schema。
- Electron Session 隔离针对 Cookie/站点状态，不提供操作系统机器码隔离，也不保证任意网站都能无适配采集。

完整开发顺序以[研发与验收](engineering-plan.md)为准；存储底座还需文件完整性巡检、outbox 与长期运行验收。`GatewayExecutor` 边界可替换当前单执行器，HTTP 与结果归档无需直接依赖 Electron。

验证：`pnpm check`、`pnpm test:e2e`。新增测试覆盖幂等竞态、容量、取消、恢复、磁盘失败、导出及 HTTP 边界；Electron 测试实际采集内置网页、校验磁盘结果，并验证正常退出后的等待任务恢复。
