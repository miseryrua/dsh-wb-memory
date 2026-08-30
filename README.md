# dsh-wb-memory

把 WorkBuddy 的文件化记忆机制带入 DeepSeek Harness（DSH）。纯 Markdown 文件记忆，无向量库、无外部依赖。

> 版本：引擎 v7.5 / 面板 v5（package 0.8.2）。v7.5 变更：config.json BOM 容错（E1）、compact 目标字符数自适应（E2）、画像候选机制、注入块纪律层重写、digest 头尾截取、`GET /wb-memory/status`；v5 面板：状态指标条、总闸+三子开关、影响范围显示、提示分层、分组卡片、检索/治理解除隐藏、新建文件、busy 反馈。

## 术语表（全插件统一）

| 术语 | 配置/代码 | 含义 |
| --- | --- | --- |
| **流水** | digest / autoDigest | 每轮对话自动追加的简短记录（做了什么 → 结论） |
| **提炼** | distill / autoDistill | 历史日志 → MEMORY.md 条目（LLM 分类抽取） |
| **整理** | compact（含于 autoDistill 巡逻） | MEMORY.md 超阈值时 LLM 压缩 |
| **治理** | gc / gcEnabled | TTL 归档 + 近重复检测 + 回收站/归档超期清理 |
| **画像** | USER.md | 全局用户画像（**只读**，由候选机制统一并入） |

## 记忆存储布局

记忆的真值源是**各 dsh 工作区自己的 `.workbuddy/memory/` 目录**（根目录由 `DSH_WORKSPACE_ROOT` 环境变量覆盖，默认 `D:\datas\Deepseek Harness`）：

```
<工作区>/.workbuddy/memory/
├── MEMORY.md          # 长期记忆（条目式，## 标题 分段，可带 frontmatter 注释行）
├── YYYY-MM-DD.md      # 每日日志（人工收尾记录 + 自动流水）
├── archive/           # TTL 归档的过期日志 + MEMORY.md 容量备份（超期真删）
└── .trash/<ts>/       # 面板删除文件的回收站（rename 而非 unlink，可回滚，超期真删）

插件目录（~/.dsh/plugins-dev/dsh-wb-memory/）
├── USER.md            # 全局用户画像（跨工作区，只读；旧版备份 USER.md.bak）
├── USER-CANDIDATES.md # 画像候选（Agent 按行追加，巡检自动评估并入；处理留痕 USER-CANDIDATES.log）
├── config.json        # 配置（面板可改，热生效）
└── distilled.json     # 幂等标记（工作区+日期 → 已提炼；__compact__ / __usermd__ 特殊键）
```

## 分层注入（省 token）

`systemPrompt` 注入块（同步构建）：

- **L0 全局画像**：插件目录 `USER.md`，预算 `profileMaxChars`
- **L1 摘要层**：当前工作区 MEMORY.md 的条目标题+首行，预算 `summaryMaxChars`（无当前 query 时）
- **L2 相关条目**：按当前用户消息关键词召回 top-K（`relevantTopK`），每条预算 `entryMaxChars`
- **L3 今日日志**：保尾截断注入（最新记录在文件尾部，预算 `logMaxChars`）
- **记忆纪律**：注入块末尾的路标规则（何时读/何时写/写到哪/不写什么/冲突消解/四段式坑条目/画像只读）

工作区解析：会话 cwd 位于 `<root>/<工作区>/` 下则自动匹配；否则用面板手动选择的 `activeProject`。

## 自动化机制

- **自动流水（auto-digest）**：订阅 `session/event`，每轮成功完成的对话追加一条 `HH:MM【自动】用户要求 → 结论` 到当日日志。助手侧**头尾各取**截断（结论常在尾部，纯头部截取会丢失）；去重、每日上限 `digestMaxPerDay`、仅主会话。
- **自动提炼（auto-distill）**：每小时巡检（配置热生效），把**昨天及更早**的日志经 LLM 提炼为带 frontmatter 的条目追加进 MEMORY.md；按（工作区, 日期）幂等，失败自动重试；兼扫 `archive/`。提炼 prompt 含记入标准三分类 + **「坑」条目四段式**（现象 → 根因 → 绕过办法 → 影响边界）+ **可信边界标注**要求。
- **自动整理（auto-compact）**：MEMORY.md 超 `memoryCharThreshold` 时先备份到 archive/ 再由 LLM 整理压缩。护栏：必须变短、压回阈值内、条目数不少于一半；每天每工作区至多尝试一次。**目标字符数自适应（v7.5）**：按上次 compact 的实测超幅（after/target）反推本次目标（`threshold/超幅×0.95`，限幅 [0.3, 0.8]×threshold），首次兜底 0.8×——实测 glm-5.3 恒超目标 27%~47%（见下），固定系数与护栏之间没有余量会拒收死循环。整理路由可独立配置 `compactProvider`/`compactModel`/`compactMaxTokens`（默认 8000；缺省跟随提炼配置；显式配置时自动压低思考档）。
- **画像候选（v7.5）**：Agent 会话不直接改 USER.md，跨项目通用的新发现按行追加到 `USER-CANDIDATES.md`；巡检发现非空时调提炼路由评估并入（旧画像先备份 .bak；护栏：非空、≤6000 字符、不得缩水到旧版 30% 以下；失败每天重试一次），处理后候选清空、留痕 `USER-CANDIDATES.log`。
- **幂等护栏（v7.3）**：提炼落盘前用双指标相似度（max(Jaccard, 重叠率) ≥ `dupThreshold`）比对新旧条目，高度相似的直接丢弃。所有 JSON 读取（config / distilled）均 BOM 容错（PowerShell 5.1 `Set-Content -Encoding UTF8` 必写 BOM，Node JSON.parse 不接受）——v7.5 把启动引导路径也纳入 BOM 容错，带 BOM 的合法 config 不再被静默重置为默认值。

**模型选型实测备注（2026-08-30，写入运维记录）**：compact 是「恒超 target」的重灾区——deepseek-v4-flash 连续 3 天无视「条目数 ≥ 半数」约束被拒收；glm-5.3 尊重条目数但输出恒超目标 27%~47%（target 6400→实际 9380、8000→10180、9600→12745）。教训：压缩类任务配指令遵循强的模型 + 依赖自适应 target，不要跟阈值玩军备竞赛。

## 治理（面板「治理」按钮 / POST /wb-memory/gc）

TTL 日志归档（`logRetentionDays`）、容量检测（`memoryCharThreshold`）、近重复检测（`dupThreshold`，Jaccard+重叠率双指标，只报告不合并）、回收站清理（`trashRetentionDays`）、归档清理（`archiveRetentionDays`）。`gcEnabled=false` 时跳过。

## HTTP 路由（webServer，exact）

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/wb-memory/config` | GET/POST | 读/改配置（POST 需同源；字段白名单含 enabled/autoDigest/autoDistill/gcEnabled/路由/compactMaxTokens/activeProject） |
| `/wb-memory/status` | GET | 运行状态（记忆占用/条目数/今日流水/待提炼/上次整理/回收站/归档计数；`?workspace=` 可选；纯只读，供面板状态条轮询） |
| `/wb-memory/workspaces` | GET | 工作区列表 |
| `/wb-memory/files` | GET | 激活工作区记忆文件列表（含 size） |
| `/wb-memory/file` | GET/POST/DELETE | 读/写/回收单个文件（basename 防穿越） |
| `/wb-memory/search` | GET | 关键词检索召回（`?q=&workspace=`） |
| `/wb-memory/gc` | POST | 手动治理（**不要用作轮询**：会执行归档与真删） |
| `/wb-memory/distill` | GET | 触发全工作区巡检：提炼 + 整理 + 画像候选评估（`?wait=1` 同步等结果） |
| `/wb-memory/models` | GET | 可用 LLM 路由（模型下拉） |
| `/wb-memory/debug-cwd` | GET | 调试：最近会话 cwd 与工作区解析 |

Agent 侧推荐用法：注入块里已含摘要与纪律，需要细节时用文件工具直读 MEMORY.md，或 `GET /wb-memory/search?q=关键词&workspace=工作区名` 召回 top-K；跨项目通用新发现按行追加到插件目录 USER-CANDIDATES.md。

## 配置项（config.json）

注入预算：`profileMaxChars`/`summaryMaxChars`/`logMaxChars`/`entryMaxChars`/`relevantTopK`；
治理：`gcEnabled`/`logRetentionDays`/`memoryCharThreshold`/`dupThreshold`/`trashRetentionDays`/`archiveRetentionDays`；
流水：`autoDigest`/`digestMaxPerDay`/`digestUserChars`/`digestAssistantChars`；
提炼/整理：`autoDistill`/`distillProvider`/`distillModel`/`compactProvider`（可选）/`compactModel`（可选）/`compactMaxTokens`（默认 8000，思考型模型需给足——正文本身约需 5k token）/`distillMaxInputChars`/`distillMaxTokens`/`distillTimeoutMs`/`distillIntervalMs`/`distillStartDelayMs`。

缺字段自动以默认值合并补齐；坏 JSON（含带 BOM 的合法 JSON 之外的损坏情况）备份为 `config.json.bak` 后重建；**带 BOM 的合法 JSON 正常加载，不再触发重置**（v7.5）。

## 开发

```bash
node --check lib/index.js        # 语法检查
node --check lib/client.js       # 语法检查
node lib/index.js                # 应报 cordis ctx 错误（说明模块可独立加载）
node test/smoke.mjs              # 纯函数冒烟测试（42 项：retrieve/governance/BOM/自适应target/头尾截取）
```
