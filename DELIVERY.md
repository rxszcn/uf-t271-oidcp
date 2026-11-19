# 交付说明：命中缓存的客户端元数据文档请求收敛构造开销（t271）

## 1. 背景与根因

`features.clientIdMetadataDocument` 打开后，`Client.find` 对每个携带
Client Identifier URL 的请求都会走到 `resolveClientByMetadataDocument`
（`lib/helpers/client_id_metadata_document.js`）。该路径原本只缓存了**拉取
到的文档属性**（`LRU` 里的 `properties`），命中缓存时仍调用 `createClient`
重新 `new provider.Client(properties, ctx, { cimd: true })`，即每请求重做：

1. `Client.Schema` 全量元数据校验（`#assign` / `required` / `enums` /
   `webUris` / `redirectUris` / `sectorIdentifier` 等十余步）；
2. `buildAsymmetricKeyStore` / `buildSymmetricKeyStore` 两个密钥库装配，
   包括逐键 `checkJWK`、`validateJWKS` 和对称密钥派生。

而出站文档拉取为 0（都在缓存里），静态注册客户端在 `staticClients` 里
带 `instanceof Client` 直接命中，不重建。于是压测火焰图集中在"元数据校验 +
密钥库装配"，成本随请求量线性放大，且与冷路径同量级 —— 这正是题面描述的
算力耗尽面。

此外，滚动升级并存期两条来源（静态注册与文档接入）共用同一命中路径；
灰度分流使同一客户端的命中请求分散到不同后端池，前端超时重发与"相邻请求
各自对命中所得客户端实例做局部加工"意味着：每个请求必须拿到**独立的客户端
实例**，请求内对实例的局部加工/回调不得跨请求可见。

## 2. 改动设计（自行决策部分）

### 2.1 构造一次、按请求实例化（`prepare` / `instantiate`）

在 `lib/models/client.js` 中给 `provider.Client` 增加两个静态方法：

- `Client.prepare(client)`：把一次**完整构造**的结果固化为一个不可变
  构造成果（`prepared`），包含：
  - 已校验的客户端属性快照（`snapshotConstructedAttributes`，含数组与
    `jwks.keys` 的浅拷贝）；
  - 非对称密钥库条目（`asymmetricKeys`）与对称密钥库条目
    （`symmetricKeys`）；
  - 已记忆化的 `sectorIdentifier`；
  - `clientIdMetadataDocument` 标记。
  `prepared` 会登记进 provider 局部的 `WeakSet`，未登记的普通对象被
  `instantiate` 拒绝（`TypeError`），避免误用。

- `Client.instantiate(prepared)`：构造一个**新的、每请求独立**的
  `Client` 实例，但**不重跑 schema 校验、不重装密钥库**：
  - 属性按容器做浅拷贝（数组、`jwks.keys` 复制），标量值共享；
  - 密钥库条目用 `createKeyCopier()` 逐键复制一次（保持 `jwks.keys[i]`
    与密钥库条目是同一对象这一构造期恒等性），但两个实例之间不共享
    可变的键对象；
  - 注入预先算好的 `sectorIdentifier`；恢复 `clientIdMetadataDocument`。

`Client` 构造函数新增内部入口 `{ prepared }`；对外构造路径（静态注册、
动态注册、`Client.validate`）完全不变。

`sectorIdentifier` 的缓存从 `#sectorIdentifier` 私有字段改为 provider 局部
的 `WeakMap`，因为 `instantiate` 不经过构造函数、私有字段无法在类外写入。
行为与原先一致（首次计算后记忆化）。

### 2.2 命中路径改为 `prepared` 缓存

`lib/helpers/client_id_metadata_document.js` 的缓存项由裸 `properties` 改为
`{ prepared }`：

- 命中缓存：`provider.Client.instantiate(entry.prepared)`，随后照旧按请求
  调用 `features.clientIdMetadataDocument.allowClient(ctx, client)`（每个
  请求仍然跑，批处理中每次都能拿到独立实例）；
- 缓存未命中：一次 `fetchMetadataDocument` → 一次完整 `prepareClient`
  （内部 `addClient` + `prepare`），此后所有命中请求共享这一份 `prepared`；
- **并发首发合并**：把"拉取 + 完整构造 + 写缓存"合并成一个 in-flight
  promise（`getPending`），并发首请求只做一次完整构造，各自
  `instantiate` 出独立实例；失败时清理 in-flight，后续请求可重试。

### 2.3 重建边界（何时必须重建）

- **文档内容更新**：缓存项按 LRU TTL 过期；重新拉取（`fetchMetadataDocument`）
  后**总是**重新 `prepareClient`，旧 `prepared` 随缓存项被替换/淘汰，
  不会复用旧注册数据的构造成果。测试用 timekeeper 固化：TTL 到期后
  `client_name` 从 `first` 变为 `refreshed`，且 `full.metadataDocument`
  从 1 增加到 2。
- **不同 provider**：缓存、`prepared` 集合与计数器都以 provider 为作用域
  （`WeakMap` / provider 局部的 `WeakSet`），互不串用。
- **不同 client_id**：缓存键仍为 `client_id`（URL），各自独立 `prepared`。
- **静态注册客户端**：仍由 `staticClients` 缓存 `instanceof Client` 的
  完整实例，行为不变；文档接入路径的优化不波及它。

### 2.4 静态客户端对照与出站拉取

- 静态客户端在 `Client.find` 中命中 `staticClients` 里的完整实例，不新建、
  不实例化，计数器 `full.static` 仅在一次惰性构造时 +1，之后恒为 1。
- 文档拉取计数只在真正发出 `fetchRequest` 时 +1；命中缓存不增加。

## 3. 可观测计数（用于验收读数）

新增 `lib/helpers/client_construction_counters.js`，以 `WeakMap` 按 provider
维护，无外部依赖、单调递增：

| 计数 | 含义 |
| --- | --- |
| `full.metadataDocument` | 文档接入路径上的**完整构造**次数（跑 schema + 密钥库装配） |
| `instances.metadataDocument` | 命中缓存时从 `prepared` **实例化**的次数 |
| `full.static` | 静态注册客户端的完整构造次数（对照组） |
| `documentFetches` | 出站元数据文档拉取次数 |

计数点：
- `lib/models/client.js`：构造函数 `cimd` 分支 → `recordClientConstruction`；
  `staticClients` 惰性构造 → `recordClientConstruction(provider, 'static')`；
  `instantiate` 构造路径 → `recordClientInstance`。
- `lib/helpers/client_id_metadata_document.js`：`fetchMetadataDocument` 首行
  → `recordMetadataDocumentFetch`。

## 4. 改动面（逐文件）

| 文件 | 改动 | 对应题面要求 |
| --- | --- | --- |
| `lib/helpers/client_construction_counters.js`（新增） | provider 作用域的构造/实例/拉取计数器及读取函数 | 验收读数口径、快照环境可复现、零外部依赖 |
| `lib/models/client.js` | 属性快照/拷贝、`createKeyCopier`、`sectorIdentifier` 改 `WeakMap`、`Client.prepare` / `Client.instantiate`、构造函数 `{ prepared }` 入口、静态构造与文档构造计数、静态路径计数 | 命中路径不再每请求重做校验与密钥库装配、按请求独立实例、静态行为不变 |
| `lib/helpers/client_id_metadata_document.js` | 缓存项改为 `{ prepared }`、`prepareClient`、`resolveCachedClient`/`instantiateClient`、in-flight 合并"拉取+构造+写缓存"、拉取计数 | 命中路径构造收敛、并发首发不重复完整构造、文档更新后不复用旧构造、出站拉取不增加 |
| `lib/helpers/defaults.js` | `features.clientIdMetadataDocument` 文档注释新增命中路径说明（供 `docs/README.md` 生成） | 文档同步 |
| `docs/README.md` | 同步生成的 `features.clientIdMetadataDocument` 说明段落 | 文档同步 |
| `test/client_id_metadata_document/client_id_metadata_document.test.js` | 新增 `cached hit path construction reuse` 用例组（4 条断言用例） | 在既有缓存行为测试文件内扩展三类断言、沿用同一框架、既有测试保持通过 |

## 5. 测试扩展（并入既有测试文件）

新用例组 `cached hit path construction reuse` 位于
`test/client_id_metadata_document/client_id_metadata_document.test.js`，沿用
该文件既有的 `node:test` + `bootstrap` + `mock` 框架与阻抗风格：

1. `serves a fixed batch of repeated requests without a full construction per request`
   —— 固定 10 次重复授权请求；断言 `documentFetches === 1`、
   `full.metadataDocument === 1`、`instances.metadataDocument === 10`，
   且 `full < BATCH`；同时断言 10 个实例互不相同、请求内局部加工
   （新增属性、`redirectUris.push`）不会泄漏到后续请求。
2. `rebuilds after the document is refetched instead of reusing the stale construction`
   —— TTL 到期后重新拉取；断言 `documentFetches === 2`、
   `full.metadataDocument === 2`、`instances.metadataDocument === 2`，
   内容为新文档值，证明不复用旧构造。
3. `shares one full construction between concurrent first requests`
   —— 并发两个首请求；断言 `documentFetches === 1`、
   `full.metadataDocument === 1`、`instances.metadataDocument === 2`，
   两个实例互不相同。
4. `leaves static client construction and outbound document fetches unchanged`
   —— 同形态静态客户端对照 10 次重复请求；断言 `full.static === 1`、
   `full.metadataDocument === 0`、`instances.metadataDocument === 0`、
   `documentFetches === 0`，且 10 次返回同一实例。

三类断言（构造计数 / 出站拉取计数 / 静态对照构造计数）均覆盖。

## 6. 验收读数

统一构造输入：同一客户端（`https://app.example.com/metadata`）固定批量
重复授权请求 `N = 200`，外加同形态静态客户端对照请求 `N = 200`。读数口径：
命中路径完整构造次数 `full.metadataDocument` 与出站文档拉取次数
`documentFetches`。快照测试环境内零外部依赖（`undici` MockAgent 拦截文档
拉取），可复现。

| 读数 | 优化前 | 优化后 |
| --- | --- | --- |
| 文档接入：`full.metadataDocument`（N=200 请求） | 200 | 1 |
| 文档接入：`instances.metadataDocument` | 0 | 200 |
| 文档接入：`documentFetches` | 1 | 1（不增加） |
| 静态对照：`full.static`（N=200 请求） | 1 | 1（不增加） |
| 静态对照：`documentFetches` | 0 | 0（不增加） |

完整构造次数由 200 降到 1（与请求数 200 相比显著下降，降幅 99.5%），
出站拉取次数与静态对照构造计数均未增加。

同一固定批量（N=2000）的命中路径耗时实测（Node 24.16.0，本机，三次取稳定
区间）：

| 版本 | 每请求耗时 |
| --- | --- |
| 优化前 | ≈48–49 µs |
| 优化后 | ≈5.4–6.0 µs |

命中路径 CPU 开销下降约 8–9 倍，且不再与请求数线性相关的构造部分同量级。

> 读数脚本为一次性探针（`lib/helpers/client_construction_counters.js` +
> `MockAgent`），验证后未纳入仓库；计数读取 API
> `clientConstructionCounters(provider)` 保留，供测试与运维指标复用。
> 优化前读数通过在 HEAD 基线 worktree 中注入同一计数器得到。

## 7. 验收命令

```bash
npm test
```

结果（最终读数）：`tests 3707`、`pass 3705`、`fail 0`、`cancelled 0`、
`skipped 2`、`todo 0`，`Suite passed`。

- 既有测试全部保持通过，未修改任何既有断言；
- `biome lint` 对改动文件无告警；
- 新增 4 条用例全部通过；
- `docs/update-configuration.js --check` 在本机 Windows 检出的 CRLF 基准上
  与 HEAD 同样报 `docs/README.md is not up to date`（该差异在本改动前即存在，
  见下节"已知环境差异"），本改动新增的说明段落已同步进 `docs/README.md`。

### 已知环境差异

`docs/update-configuration.js --check` 的失败是仓库基线问题，与本次改动无关：

- 在 pristine HEAD（`git stash -u` 后）执行同样报错；
- 原因为 Windows 检出下 `docs/README.md` / `docs/events.md` 的 CRLF 与生成器
  输出（LF）不一致，且生成器对部分 JS 片段会重排空行。

`npm test` 中的 `docs` 相关测试（`test/tools/type_contracts.test.js`、
`test/tools/configuration_documentation.test.js`）在统一为 LF 后通过。
