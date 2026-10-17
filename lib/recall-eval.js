/**
 * dsh-wb-memory 召回评测模块（第三批，2026-10-17）。
 *
 * 定位（依据《第三批接口约定.md》）：
 *   - 纯离线评测：evaluateRecall(cases, ranker) 对「合成语料」逐案例调用传入的
 *     ranker（形状 = 现有 rankMemory(md, query, opts)），输出 JSON 可读的逐案例
 *     结果与汇总（命中 / 漏召回 / 禁选命中 / 空查询 / 排序级精度召回 / 耗时）。
 *   - 本模块不做任何 IO：不读文件、不写文件、不发请求；运行时需要的内置合成
 *     案例以常量 BUILTIN_RECALL_CASES 导出（供主线只读面板运行），测试用 fixture
 *     由该常量生成并保持逐字一致。
 *   - 评测级结果只反映「检索命中」，不当作模型回答质量，也不作自动准入标准。
 *   - 影子对照 shadowCompareCases 仅对同一案例比较「传入的两个 ranker」（即离线
 *     候选参数差异），不修改线上默认，也不自创生产算法。
 *   - candidateChars 是候选条目的字符量（标题+正文长度合计，有界于 top-k），
 *     不是实际注入字符数，不得冒称实际注入。
 *
 * 时间敏感口径：所有合成案例的 frontmatter 日期均为明示固定日期且距任何合理
 * 运行时点超过 90 天（entryBonus 的 30/90 天加成恒为 ×1.0），避免测试随运行
 * 时间腐化；不使用「近 30 天」的相对日期元数据。
 */

// ---------- 合成案例用的确定性生命周期标记（与 lib/memory-lifecycle.js 编码一致） ----------
const LIFECYCLE_AT = '2026-02-01T00:00:00.000Z'
const encMeta = (meta) => '<!-- wb-memory:' + Buffer.from(JSON.stringify(meta)).toString('base64url') + ' -->'
const MEM_OLD = 'mem_' + '1111aaaa2222bbbb3333cccc4444dddd' // 旧口径（被替代）
const MEM_NEW = 'mem_' + '9999eeee8888ffff777766665555aaaa' // 新口径（现行）
const MEM_RET = 'mem_' + 'abcdef0123456789abcdef0123456789' // 已撤回
const marker = (meta) => encMeta(meta)

const md = (lines) => lines.join('\n')

// 固定旧日期：明示固定日期，远离 30/90 天加成窗口，任何时点运行加成恒 ×1.0。
const OLD_DATE = '2026-01-10'

// ================= 内置合成案例（≥20 条，供测试 fixture 与主线只读面板共用） =================
// 字段：id / kind / desc / query / memoryMd / expectedTitles / forbiddenTitles /
//       expectEmpty / assert('strict' 全断言 | 'observe' 仅记录展示算法强弱) / rankerOpts(可选)
function buildBuiltinCases() {
  const cases = []

  // ---- 中文命中 ----
  cases.push({
    id: 'c01-zh-exact-term',
    kind: 'zh',
    desc: '中文精确术语命中，弱单字干扰条目应被弱词控制过滤',
    query: '打包工具用哪个',
    memoryMd: md([
      '# 项目长期记忆',
      '',
      '<!-- tags: 工具 / date: ' + OLD_DATE + ' -->',
      '## 打包工具选型',
      '乙行 用 esbuild 打包前端，速度比 webpack 快',
      '',
      '<!-- tags: 工具 / date: ' + OLD_DATE + ' -->',
      '## 数据库选型',
      '乙行 主库用 PostgreSQL，读写分离走从库',
      '',
    ]),
    expectedTitles: ['打包工具选型'],
    forbiddenTitles: ['数据库选型'],
    expectEmpty: false,
    assert: 'strict',
  })

  cases.push({
    id: 'c02-zh-bigram-phrase',
    kind: 'zh',
    desc: '中文连续片段（定投沪深300）命中，短线条目不误召回',
    query: '定投沪深300的计划',
    memoryMd: md([
      '# 项目长期记忆',
      '',
      '## 基金定投策略',
      '定投沪深300指数基金，每月一千元，长期持有',
      '',
      '## 股票交易记录',
      '乙行 只做短线，不碰基金',
      '',
    ]),
    expectedTitles: ['基金定投策略'],
    forbiddenTitles: [],
    expectEmpty: false,
    assert: 'strict',
  })

  cases.push({
    id: 'c18-zh-bigram-boundary',
    kind: 'zh',
    desc: '「上海会议」不误伤只含「会上」的条目（bigram 不按字禁的评审点）',
    query: '上海会议',
    memoryMd: md([
      '# 项目长期记忆',
      '',
      '## 上海出差记录',
      '乙行 去上海参加前端大会，顺便看展',
      '',
      '## 例会纪要',
      '乙行 会上讨论了版本发布节奏',
      '',
    ]),
    expectedTitles: ['上海出差记录'],
    forbiddenTitles: ['例会纪要'],
    expectEmpty: false,
    assert: 'strict',
  })

  cases.push({
    id: 'c23-zh-natural-query',
    kind: 'zh',
    desc: '自然中文问句（面板版本核验）命中标题词',
    query: '面板版本怎么核验',
    memoryMd: md([
      '# 项目长期记忆',
      '',
      '## 记忆面板版本核验',
      '乙行 0.12.1 部署后须重启宿主再刷新面板核验',
      '',
      '## 依赖治理记录',
      '乙行 卸载插件后要跑 pnpm install --lockfile-only',
      '',
    ]),
    expectedTitles: ['记忆面板版本核验'],
    forbiddenTitles: [],
    expectEmpty: false,
    assert: 'strict',
  })

  // ---- 英文 / 混排 ----
  cases.push({
    id: 'c03-en-error-code',
    kind: 'en',
    desc: '英文错误码 ENOENT 精确命中',
    query: 'ENOENT startup error',
    memoryMd: md([
      '# 项目长期记忆',
      '',
      '## 启动报错记录',
      '乙行 启动时报 ENOENT，检查路径',
      '',
      '## 依赖安装记录',
      '乙行 pnpm install 正常',
      '',
    ]),
    expectedTitles: ['启动报错记录'],
    forbiddenTitles: [],
    expectEmpty: false,
    assert: 'strict',
  })

  cases.push({
    id: 'c04-en-words',
    kind: 'en',
    desc: '普通英文词（webhook retry）命中，中文日志条目不误召回',
    query: 'webhook retry policy',
    memoryMd: md([
      '# 项目长期记忆',
      '',
      '## Webhook 重试策略',
      '乙行 webhook 失败后指数退避重试，最多 5 次',
      '',
      '## 日志清理策略',
      '乙行 日志保留 30 天后删除',
      '',
    ]),
    expectedTitles: ['Webhook 重试策略'],
    forbiddenTitles: [],
    expectEmpty: false,
    assert: 'strict',
  })

  cases.push({
    id: 'c05-mixed-zh-en',
    kind: 'mixed',
    desc: '中英混排查询同时用中文词与英文标识符命中',
    query: '部署 deploy pnpm',
    memoryMd: md([
      '# 项目长期记忆',
      '',
      '## 部署流程',
      '乙行 部署前先跑 pnpm build，再上传 dist',
      '',
      '## 回滚流程',
      '乙行 出问题就回滚到上一版本',
      '',
    ]),
    expectedTitles: ['部署流程'],
    forbiddenTitles: ['回滚流程'],
    expectEmpty: false,
    assert: 'strict',
  })

  cases.push({
    id: 'c22-en-case-folding',
    kind: 'en',
    desc: '小写 enoent 查询命中大写 ENOENT 正文，另一错误码条目靠弱单字不应入选',
    query: 'enoent 报错怎么处理',
    memoryMd: md([
      '# 项目长期记忆',
      '',
      '## 启动失败排查',
      '乙行 报 ENOENT 时先查路径拼写',
      '',
      '## 网络超时排查',
      '乙行 报 ETIMEDOUT 时先查代理',
      '',
    ]),
    expectedTitles: ['启动失败排查'],
    forbiddenTitles: ['网络超时排查'],
    expectEmpty: false,
    assert: 'strict',
  })

  cases.push({
    id: 'c24-en-underscore-code',
    kind: 'en',
    desc: '下划线错误码 err_module_not_found 整串命中',
    query: 'err_module_not_found 怎么解决',
    memoryMd: md([
      '# 项目长期记忆',
      '',
      '## Electron 启动报错',
      '乙行 偶发 err_module_not_found，重装依赖可解',
      '',
      '## 构建产物缺失',
      '乙行 dist 目录为空时先跑 build',
      '',
    ]),
    expectedTitles: ['Electron 启动报错'],
    forbiddenTitles: [],
    expectEmpty: false,
    assert: 'strict',
  })

  // ---- 无关查询（应空返回） ----
  cases.push({
    id: 'c06-irrelevant-zh',
    kind: 'irrelevant',
    desc: '与语料零词面重叠的中文查询应空返回',
    query: '红烧肉怎么做才好吃',
    memoryMd: md([
      '# 项目长期记忆',
      '',
      '## 打包工具选型',
      '乙行 用 esbuild 打包前端，速度比 webpack 快',
      '',
      '## 数据库选型',
      '乙行 主库用 PostgreSQL，读写分离走从库',
      '',
    ]),
    expectedTitles: [],
    forbiddenTitles: [],
    expectEmpty: true,
    assert: 'strict',
  })

  cases.push({
    id: 'c07-irrelevant-en',
    kind: 'irrelevant',
    desc: '与语料零词面重叠的英文查询应空返回',
    query: 'best pasta recipe tonight',
    memoryMd: md([
      '# 项目长期记忆',
      '',
      '## 打包工具选型',
      '乙行 用 esbuild 打包前端，速度比 webpack 快',
      '',
      '## 数据库选型',
      '乙行 主库用 PostgreSQL，读写分离走从库',
      '',
    ]),
    expectedTitles: [],
    forbiddenTitles: [],
    expectEmpty: true,
    assert: 'strict',
  })

  // ---- 弱词（单字退化路径） ----
  cases.push({
    id: 'c08-weak-single-char',
    kind: 'weak',
    desc: '单字查询退化为允许单字命中：唯一含该字的条目应可召回',
    query: '备',
    memoryMd: md([
      '# 项目长期记忆',
      '',
      '## 备份任务约定',
      '乙行 每天凌晨全量备份，保留 7 天',
      '',
      '## 前端构建记录',
      '乙行 用 vite 构建',
      '',
    ]),
    expectedTitles: ['备份任务约定'],
    forbiddenTitles: ['前端构建记录'],
    expectEmpty: false,
    assert: 'strict',
  })

  // ---- 空查询（应空返回） ----
  cases.push({
    id: 'c09-empty-query',
    kind: 'empty',
    desc: '空字符串查询应空返回',
    query: '',
    memoryMd: md(['# 项目长期记忆', '', '## 备份任务约定', '乙行 每天凌晨全量备份', '']),
    expectedTitles: [],
    forbiddenTitles: [],
    expectEmpty: true,
    assert: 'strict',
  })

  cases.push({
    id: 'c10-whitespace-query',
    kind: 'empty',
    desc: '纯空白查询应空返回',
    query: '   ',
    memoryMd: md(['# 项目长期记忆', '', '## 备份任务约定', '乙行 每天凌晨全量备份', '']),
    expectedTitles: [],
    forbiddenTitles: [],
    expectEmpty: true,
    assert: 'strict',
  })

  cases.push({
    id: 'c11-stopword-query',
    kind: 'empty',
    desc: '全停用词中文查询分词后为空，应空返回',
    query: '的那个了吗',
    memoryMd: md(['# 项目长期记忆', '', '## 备份任务约定', '乙行 每天凌晨全量备份，保留 7 天', '']),
    expectedTitles: [],
    forbiddenTitles: [],
    expectEmpty: true,
    assert: 'strict',
  })

  // ---- 重复标题 ----
  cases.push({
    id: 'c12-duplicate-titles',
    kind: 'duplicate',
    desc: '两条同名条目都命中关键词时，按多重集口径应各计一次命中',
    query: 'NODE_OPTIONS 怎么设置',
    memoryMd: md([
      '# 项目长期记忆',
      '',
      '## 环境变量约定',
      'NODE_OPTIONS 必须清空后再启动',
      '',
      '## 环境变量约定',
      'NODE_OPTIONS 保留原值即可',
      '',
    ]),
    expectedTitles: ['环境变量约定', '环境变量约定'],
    forbiddenTitles: [],
    expectEmpty: false,
    assert: 'strict',
  })

  // ---- 生命周期已退场 ----
  cases.push({
    id: 'c13-lifecycle-superseded',
    kind: 'lifecycle',
    desc: '数字更正后旧口径条目已 superseded：同词查询只应召回现行修订条目',
    query: '超产奖金基数 12000',
    memoryMd: md([
      '# 项目长期记忆',
      '',
      '## 超产奖金阈值（旧）',
      marker({ v: 1, id: MEM_OLD, state: 'superseded', by: MEM_NEW, events: [{ action: 'correct', at: LIFECYCLE_AT, reason: '数字更正：基数 8000 改为 12000', related: MEM_NEW }] }),
      '旧口径：超产奖金计算以 8000 为基数，按月结算',
      '',
      '## 超产奖金阈值（修订）',
      marker({ v: 1, id: MEM_NEW, state: 'current', from: MEM_OLD, events: [{ action: 'created', at: LIFECYCLE_AT, reason: '数字更正：基数 8000 改为 12000', related: MEM_OLD }] }),
      '新口径：超产奖金计算以 12000 为基数，按月结算',
      '',
    ]),
    expectedTitles: ['超产奖金阈值（修订）'],
    forbiddenTitles: ['超产奖金阈值（旧）'],
    expectEmpty: false,
    assert: 'strict',
  })

  cases.push({
    id: 'c14-lifecycle-retracted-only',
    kind: 'lifecycle',
    desc: '只有已撤回条目含查询词时应空返回（退场正文不当作当前事实）',
    query: '旧服务器 IP 是多少 192.168',
    memoryMd: md([
      '# 项目长期记忆',
      '',
      '## 旧服务器地址（已撤回）',
      marker({ v: 1, id: MEM_RET, state: 'retracted', events: [{ action: 'retract', at: LIFECYCLE_AT, reason: '服务器已下线' }] }),
      '旧服务部署在 192.168.1.50，端口 8080',
      '',
      '## 现行部署说明',
      '乙行 前端走 CDN，后端在云上',
      '',
    ]),
    expectedTitles: [],
    forbiddenTitles: ['旧服务器地址（已撤回）'],
    expectEmpty: true,
    assert: 'strict',
  })

  // ---- 数字纠正 / 数字精确性 ----
  cases.push({
    id: 'c15-numeric-low-idf',
    kind: 'numeric',
    desc: '「预算」在全部 6 条中出现的低区分词不产生无关召回，数字 12000 精确定位唯一条目',
    query: '预算上限 12000',
    memoryMd: md([
      '# 项目长期记忆',
      '',
      '## 预算口径 甲',
      '乙行 每月预算按人头摊销',
      '',
      '## 预算口径 乙',
      '乙行 每月预算按项目摊销',
      '',
      '## 预算口径 丙',
      '乙行 每月预算按季度摊销',
      '',
      '## 预算口径 丁',
      '乙行 每月预算按部门摊销',
      '',
      '## 字符预算上限',
      '乙行 注入字符预算上限是 12000',
      '',
      '## 预算口径 戊',
      '乙行 每月预算按区域摊销',
      '',
    ]),
    expectedTitles: ['字符预算上限'],
    forbiddenTitles: ['预算口径 甲', '预算口径 乙', '预算口径 丙', '预算口径 丁', '预算口径 戊'],
    expectEmpty: false,
    assert: 'strict',
  })

  cases.push({
    id: 'c16-numeric-exact',
    kind: 'numeric',
    desc: '仅数字不同（8080/9090）的两条：查 9090 应首选新端口条目',
    query: '端口 9090',
    memoryMd: md([
      '# 项目长期记忆',
      '',
      '## 旧端口记录',
      '乙行 服务端口 8080',
      '',
      '## 新端口记录',
      '乙行 服务端口 9090',
      '',
    ]),
    expectedTitles: ['新端口记录'],
    forbiddenTitles: [],
    expectEmpty: false,
    assert: 'strict',
  })

  // ---- 排序级 ----
  cases.push({
    id: 'c17-title-vs-body-order',
    kind: 'order',
    desc: '术语在标题的条目应排在仅在正文出现的条目之前',
    query: '熔断器',
    memoryMd: md([
      '# 项目长期记忆',
      '',
      '## 熔断器方案',
      '乙行 正文不提这个术语，只讲背景',
      '',
      '## 普通排障记录',
      '乙行 那次故障里顺带做了熔断器改造',
      '',
    ]),
    expectedTitles: ['熔断器方案', '普通排障记录'],
    forbiddenTitles: [],
    expectEmpty: false,
    assert: 'strict',
  })

  cases.push({
    id: 'c20-relratio-tail',
    kind: 'order',
    desc: '弱提及条目可能被 relRatio 尾部裁剪：观察当前算法特性（影子对照中用 relRatio=0 复核）',
    query: '灰度发布',
    memoryMd: md([
      '# 项目长期记忆',
      '',
      '## 灰度发布核心结论',
      '灰度发布 灰度发布 灰度发布，其余从略',
      '',
      '## 次要记录',
      '乙行 提过一次灰度发布，然后是别的内容',
      '',
      '## 无关条目',
      '乙行 完全别的话题',
      '',
    ]),
    expectedTitles: ['灰度发布核心结论'],
    forbiddenTitles: [],
    expectEmpty: false,
    assert: 'strict',
  })

  // ---- 不同项目参数相似 ----
  cases.push({
    id: 'c19-cross-project-similar',
    kind: 'cross-project',
    desc: '两个项目共用「阈值」等通用参数词：正确项目应排第一，通用词入侵记为观察项',
    query: '定投止盈阈值',
    memoryMd: md([
      '# 项目长期记忆',
      '',
      '## 理财定投参数',
      '每月定投 1000 元，止盈阈值 20%',
      '',
      '## 超产奖计算器参数',
      '未达阈值计 0；超产工时×小时加班费',
      '',
    ]),
    expectedTitles: ['理财定投参数'],
    forbiddenTitles: [],
    expectEmpty: false,
    assert: 'strict',
  })

  // ---- 规模语料（含耗时观测） ----
  const scaleMd = (() => {
    const rows = ['# 项目长期记忆', '']
    for (let i = 1; i <= 28; i++) {
      rows.push('## 常规事项 ' + i, '乙行 第 ' + i + ' 条常规开发事项，涉及文档整理与代码审阅', '')
    }
    rows.push('## Redis 集群约定', '乙行 Redis 集群按三主三从部署', '')
    rows.push('## Kafka 集群约定', '乙行 Kafka 集群报警发到值班群，副本数为 3', '')
    return rows.join('\n')
  })()

  cases.push({
    id: 'c21-scale-corpus',
    kind: 'scale',
    desc: '30 条规模语料：英文标识符 kafka 应压过只含通用词「集群」的条目排第一',
    query: 'kafka 集群报警',
    memoryMd: scaleMd,
    expectedTitles: ['Kafka 集群约定'],
    forbiddenTitles: [],
    expectEmpty: false,
    assert: 'strict',
  })

  // ---- observe 案例（只记录不断言：展示当前算法的强弱面，不要求排序完美） ----
  cases.push({
    id: 'o1-observe-generic-word-intrusion',
    kind: 'observe',
    desc: '观察：三个项目都用「阈值」：通用词会把相邻项目带进候选（弱项面），正确条目仍应排第一',
    query: '导出文件名阈值',
    memoryMd: md([
      '# 项目长期记忆',
      '',
      '## 报表导出规则',
      '乙行 导出文件名超过阈值时自动截断加序号',
      '',
      '## 超产奖计算器参数',
      '未达阈值计 0；超产工时×小时加班费',
      '',
      '## 告警规则',
      '乙行 错误数超过阈值就报警',
      '',
    ]),
    expectedTitles: ['报表导出规则'],
    forbiddenTitles: [],
    expectEmpty: false,
    assert: 'observe',
  })

  cases.push({
    id: 'o2-observe-weak-mention-tail',
    kind: 'observe',
    desc: '观察：弱提及条目在默认 relRatio=0.2 下的去留（与影子对照 relRatio=0 的差异）',
    query: '租用办公室',
    memoryMd: md([
      '# 项目长期记忆',
      '',
      '## 办公室租赁合同',
      '乙行 租用办公室三年，押二付一',
      '',
      '## 周报草稿',
      '乙行 本周整理了文件，提到要租用办公室的事，另外还修了打印机',
      '',
    ]),
    expectedTitles: ['办公室租赁合同'],
    forbiddenTitles: [],
    expectEmpty: false,
    assert: 'observe',
  })

  return cases
}

export const BUILTIN_RECALL_CASES = Object.freeze(buildBuiltinCases().map((c) => Object.freeze(c)))

// ================= 案例校验 =================
function validateCase(c) {
  if (!c || typeof c !== 'object') return '案例不是对象'
  if (typeof c.id !== 'string' || !c.id) return 'id 必须是非空字符串'
  if (typeof c.query !== 'string') return 'query 必须是字符串'
  if (typeof c.memoryMd !== 'string') return 'memoryMd 必须是字符串'
  if (!Array.isArray(c.expectedTitles) || c.expectedTitles.some((t) => typeof t !== 'string')) return 'expectedTitles 必须是字符串数组'
  if (!Array.isArray(c.forbiddenTitles) || c.forbiddenTitles.some((t) => typeof t !== 'string')) return 'forbiddenTitles 必须是字符串数组'
  if (typeof c.expectEmpty !== 'boolean') return 'expectEmpty 必须是布尔值'
  if (c.assert !== 'strict' && c.assert !== 'observe') return 'assert 必须是 strict 或 observe'
  if (!c.expectEmpty && c.expectedTitles.length === 0) return '非 expectEmpty 案例必须给出 expectedTitles'
  return null
}

// ================= 单案例执行与指标 =================
const round6 = (x) => Math.round(x * 1e6) / 1e6

// 从 ranker 返回行提取标题：兼容 rankMemory 的 { entry: { title } } 与审计行的 { title }。
function rowTitle(row) {
  if (!row || typeof row !== 'object') return null
  if (row.entry && typeof row.entry.title === 'string') return row.entry.title
  if (typeof row.title === 'string') return row.title
  return null
}

function runCase(c, ranker, baseOpts) {
  const opts = Object.assign({}, baseOpts, c.rankerOpts || {})
  const t0 = performance.now()
  let rows = null
  let error = null
  try {
    rows = ranker(c.memoryMd, c.query, opts)
  } catch (e) {
    error = e && e.message ? e.message : String(e)
  }
  const elapsedMs = round6(performance.now() - t0)
  const base = { id: c.id, kind: c.kind || null, assert: c.assert, queryChars: c.query.length, elapsedMs }
  if (error !== null) return Object.assign(base, { error, returned: [], hits: [], missed: [], forbiddenReturned: [], candidateChars: 0 })
  if (!Array.isArray(rows)) return Object.assign(base, { error: 'ranker 返回值不是数组', returned: [], hits: [], missed: [], forbiddenReturned: [], candidateChars: 0 })

  const returned = rows.map((r) => {
    const title = rowTitle(r)
    const bodyChars = r && r.entry && typeof r.entry.body === 'string' ? r.entry.body.length : null
    return {
      title,
      score: r && typeof r.score === 'number' ? round6(r.score) : null,
      rel: r && typeof r.rel === 'number' ? round6(r.rel) : null,
      bodyChars,
    }
  })
  const returnedTitles = returned.map((r) => r.title).filter((t) => typeof t === 'string')
  // candidateChars：候选条目标题+正文字符量（有界于 top-k）。只是候选字符量，
  // 不是实际注入字符数——实际注入还受预算、截断与组装影响，不得冒称。
  const candidateChars = returned.reduce((n, r) => n + (r.title ? r.title.length : 0) + (r.bodyChars || 0), 0)

  // 命中按多重集口径：同标题的每个期望实例各需一条返回来满足。
  const pool = returnedTitles.slice()
  const hits = []
  const missed = []
  const expectedRanks = {}
  let firstHitRank = null
  for (const t of c.expectedTitles) {
    const i = pool.indexOf(t)
    if (i >= 0) {
      hits.push(t)
      const rank = i + 1
      ;(expectedRanks[t] = expectedRanks[t] || []).push(rank)
      if (firstHitRank === null || rank < firstHitRank) firstHitRank = rank
      pool.splice(i, 1)
    } else {
      missed.push(t)
    }
  }
  const forbiddenSet = new Set(c.forbiddenTitles)
  const forbiddenReturned = returnedTitles.filter((t) => forbiddenSet.has(t))
  const expectedCount = c.expectedTitles.length
  const emptyOk = c.expectEmpty ? returnedTitles.length === 0 : null
  const precision = expectedCount > 0 ? (returnedTitles.length > 0 ? round6(hits.length / returnedTitles.length) : 0) : null
  const recall = expectedCount > 0 ? round6(hits.length / expectedCount) : null
  const mrr = expectedCount > 0 ? (firstHitRank ? round6(1 / firstHitRank) : 0) : null
  const expectedSet = new Set(c.expectedTitles)
  const top1Expected = expectedCount > 0 ? returnedTitles.length > 0 && expectedSet.has(returnedTitles[0]) : null

  const pass = c.assert === 'strict'
    ? missed.length === 0 && forbiddenReturned.length === 0 && (c.expectEmpty ? emptyOk === true : top1Expected === true)
    : null

  return Object.assign(base, {
    returned,
    returnedTitles,
    hits,
    missed,
    forbiddenReturned,
    expectedRanks,
    firstHitRank,
    precision,
    recall,
    mrr,
    top1Expected,
    emptyOk,
    candidateChars,
    pass,
  })
}

// ================= 汇总评测 =================
export function evaluateRecall(cases, ranker, opts = {}) {
  if (!Array.isArray(cases)) throw new TypeError('evaluateRecall: cases 必须是数组')
  if (typeof ranker !== 'function') throw new TypeError('evaluateRecall: ranker 必须是 (md, query, opts) => rankMemory 形状的函数')
  const baseOpts = opts.rankerOpts || {}
  const perCase = []
  let invalidCases = 0
  for (const c of cases) {
    const problem = validateCase(c)
    if (problem) {
      invalidCases++
      perCase.push({ id: c && typeof c.id === 'string' && c.id ? c.id : '(无id)', valid: false, problem })
      continue
    }
    perCase.push(runCase(c, ranker, baseOpts))
  }

  const ran = perCase.filter((p) => p.valid !== false)
  const errorRows = ran.filter((p) => p.error)
  const strictRows = ran.filter((p) => !p.error && p.assert === 'strict')
  const observeRows = ran.filter((p) => !p.error && p.assert === 'observe')
  const metricRows = ran.filter((p) => !p.error && (p.precision !== null || p.recall !== null))
  const avg = (xs) => (xs.length ? round6(xs.reduce((a, b) => a + b, 0) / xs.length) : null)
  const elapsed = ran.map((p) => p.elapsedMs).sort((a, b) => a - b)
  const median = elapsed.length ? round6(elapsed[Math.floor(elapsed.length / 2)]) : null

  const summary = {
    caseTotal: perCase.length,
    invalidCases,
    errorCases: errorRows.length,
    strictCases: strictRows.length,
    observeCases: observeRows.length,
    strictPassed: strictRows.filter((p) => p.pass === true).length,
    strictFailedIds: strictRows.filter((p) => p.pass !== true).map((p) => p.id),
    expectedTotal: metricRows.reduce((n, p) => n + p.hits.length + p.missed.length, 0),
    hitTotal: metricRows.reduce((n, p) => n + p.hits.length, 0),
    macroPrecision: avg(metricRows.map((p) => p.precision).filter((x) => x !== null)),
    macroRecall: avg(metricRows.map((p) => p.recall).filter((x) => x !== null)),
    macroMrr: avg(metricRows.map((p) => p.mrr).filter((x) => x !== null)),
    top1CorrectRate: metricRows.length ? round6(metricRows.filter((p) => p.top1Expected === true).length / metricRows.length) : null,
    forbiddenHitCases: ran.filter((p) => !p.error && p.forbiddenReturned && p.forbiddenReturned.length).map((p) => ({ id: p.id, titles: p.forbiddenReturned })),
    expectEmptyCases: ran.filter((p) => !p.error && p.emptyOk !== null).length,
    expectEmptyOk: ran.filter((p) => !p.error && p.emptyOk === true).length,
    elapsedMs: {
      total: round6(elapsed.reduce((a, b) => a + b, 0)),
      medianCase: median,
      maxCase: elapsed.length ? round6(elapsed[elapsed.length - 1]) : null,
      casesTimed: elapsed.length,
    },
  }

  return {
    kind: 'recall-eval',
    note: '合成语料离线评测；指标只反映检索命中与排序，不当作模型回答质量或自动准入标准；candidateChars 是候选字符量而非实际注入',
    perCase,
    summary,
  }
}

// ================= 影子对照（仅离线参数对比） =================
// 对同一案例分别调用两个传入的 ranker（典型用法：A=线上默认参数，B=离线候选参数），
// 报告两侧返回差异。纯离线：不落盘、不改线上默认、不据此自动切换算法。
export function shadowCompareCases(cases, rankerA, rankerB, opts = {}) {
  if (!Array.isArray(cases)) throw new TypeError('shadowCompareCases: cases 必须是数组')
  if (typeof rankerA !== 'function' || typeof rankerB !== 'function') throw new TypeError('shadowCompareCases: 两个 ranker 都必须是函数')
  const baseOpts = opts.rankerOpts || {}
  const perCase = []
  let invalidCases = 0
  for (const c of cases) {
    const problem = validateCase(c)
    if (problem) { invalidCases++; continue }
    const a = runCase(c, rankerA, baseOpts)
    const b = runCase(c, rankerB, baseOpts)
    const setA = new Set(a.returnedTitles || [])
    const setB = new Set(b.returnedTitles || [])
    perCase.push({
      id: c.id,
      a: { returnedTitles: a.returnedTitles, hits: a.hits, missed: a.missed, forbiddenReturned: a.forbiddenReturned, error: a.error || null },
      b: { returnedTitles: b.returnedTitles, hits: b.hits, missed: b.missed, forbiddenReturned: b.forbiddenReturned, error: b.error || null },
      onlyInA: (a.returnedTitles || []).filter((t) => !setB.has(t)),
      onlyInB: (b.returnedTitles || []).filter((t) => !setA.has(t)),
      top1Changed: (a.returnedTitles || [])[0] !== (b.returnedTitles || [])[0],
    })
  }
  return {
    kind: 'recall-eval-shadow',
    mode: 'offline-shadow',
    note: '仅离线对照同一案例上两个传入 ranker 的候选参数差异；不修改线上默认排序/阈值，也不代表生产效果',
    caseTotal: cases.length,
    invalidCases,
    perCase,
    summary: {
      cases: perCase.length,
      top1Changed: perCase.filter((p) => p.top1Changed).length,
      setChanged: perCase.filter((p) => p.onlyInA.length > 0 || p.onlyInB.length > 0).length,
      bExtraReturns: perCase.filter((p) => p.onlyInB.length > 0).length,
      bFewerReturns: perCase.filter((p) => p.onlyInA.length > 0).length,
    },
  }
}
