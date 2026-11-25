export const SKILL_MANIFEST_FILE_NAME = 'manifest.json'
export const SKILL_LIST_FILE_NAME = 'skill.list.json'
export const E2E_SCHEMA_FILE_NAME = 'e2e_schema.json'
export const PLAYWRIGHT_SCRIPT_FILE_NAME = 'test.spec.ts'
export const SKILL_DOCUMENT_FILE_NAME = 'SKILL.md'
export const SKILL_LOCK_FILE_NAME = '.authine-skill.lock'
/**
 * Skill 用户工作区目录名（v14，PRD 4.1）。
 *
 * 固定为 <skillRoot>/userWorkSpace/：持久化、按 Skill 隔离、不随任务生命周期清理；
 * 承载用户流程测试产生的测试产物（截图、基准图、差异图、导出文件等）。
 * 根目录本身不可删除、不可重命名（PRD 4.3）；与 temp/（生成临时区）、
 * test_report/（平台报告区）三者边界互斥（PRD 4.8）。
 */
export const USER_WORKSPACE_DIRECTORY_NAME = 'userWorkSpace'
/**
 * Skill 敏感数据文件名（v10，PRD 4.1）。
 *
 * 每个 Skill 恰好一份，保存该 Skill 全部敏感数据的真实值；
 * 创建 Skill 时默认写入，打开存量 Skill 时自动补建。
 */
export const SKILL_ENV_FILE_NAME = 'env.json'
/**
 * Agent 临时工作区目录名（v7 立约，v12-pre 重定义为「Agent 工作期间产生的全部中间内容」）。
 *
 * 装什么：**凡是 Agent 为完成任务而产生、对用户没有价值、只在任务期间供 Agent 自己
 * 负责到底的内容，全部放这里**——候选脚本、试运行文件、以及探查阶段截取的页面图片
 * （见 EXPLORATION_DIRECTORY_NAME，它位于本目录之下）。
 *
 * 生命周期：只在生成任务期间存在，任务终态（完成/失败/取消）整体删除；
 * 异常中断的遗留由下次任务启动前清理。因此凡放进来就**不要指望跨任务留存**——
 * 需要跨会话保留的内容应放到 baselines/ 这类正式产物目录。
 *
 * 对用户：不属于正式 Skill 产物，不展示在文件树中。
 */
export const TEMP_DIRECTORY_NAME = 'temp'
/**
 * 测试报告目录名（v11，PRD 7.2 P2）。
 *
 * 每次执行的报告保存在 `<skillRoot>/test_report/<runId>/` 下；
 * 该目录在文件树中正常展示（PRD P4），且不属于正式 Skill 产物——
 * Skill 导出/分享不包含该目录（PRD A7，见 packager.ts 的立约注释）。
 */
export const TEST_REPORT_DIRECTORY_NAME = 'test_report'
/** 测试报告 HTML 文件名（自包含单文件，PRD P6）。 */
export const TEST_REPORT_REPORT_FILE_NAME = 'report.html'
/**
 * 测试报告摘要文件名（v17，技术方案 §4.4）。
 *
 * 与 `report.html` **并列**放在 `test_report/<runId>/` 下，是该目录内第一个
 * 非报告类文件（R1）。存在的理由：HTML 是给人看的、无机器可读结构
 * （零脚本、无内嵌 JSON、无 `data-*`，统计是渲染后的文本），执行历史与两次对比
 * 无法从它可靠取数；而内存快照重启即失且每 Skill 只留 5 条。
 *
 * 与报告同生共死：删除走同一个 `deleteTestReportRun`（整目录）。
 */
export const TEST_REPORT_SUMMARY_FILE_NAME = 'summary.json'
/** 运行时间戳目录名规则：yyyyMMdd-HHmmss（本地时间，PRD P2）。 */
export const TEST_REPORT_RUN_DIR_PATTERN = /^\d{8}-\d{6}$/
/**
 * 页面探查产物目录名（v12-pre 新增，v12-pre 修订迁入 temp/）。
 *
 * Agent 生成阶段截取的页面截图保存在 `<skillRoot>/temp/exploration/<sessionId>/` 下。
 *
 * **为什么放在 temp/ 之内**：这些截图的作用是让用户在生成过程中看到「Agent 核对页面时
 * 究竟看到了什么」，用于判断其核对结论是否可信；截图文件本身对用户没有长期价值——
 * 用户真正要维护和查看的是 baselines/ 下的视觉基线。因此它属于「Agent 工作期间的中间内容」，
 * 与候选脚本同类，归入 temp/ 统一管理：不在文件树展示，任务终态随 temp/ 一并删除。
 *
 * 由此带来的两条结论（替代原有的「20 个会话上限 + 淘汰」机制）：
 *   - **不需要保留上限与淘汰**——整个 temp/ 在任务终态被删除，长期使用不会累积；
 *   - **不需要进导出包**——它在 temp/ 之内，而 temp/ 本就随包排除（见 packager.ts）。
 */
export const EXPLORATION_DIRECTORY_NAME = 'exploration'
/**
 * 单张探查截图的体积上限（原始字节）。
 *
 * 与 test-report-renderer 的内嵌上限、browser_screenshot 工具的回传上限同值（2MB）：
 * 三处口径一致，避免出现「工具认为能传、存储认为不能存」的错配。
 */
export const MAX_EXPLORATION_SCREENSHOT_BYTES = 2 * 1024 * 1024
/**
 * 视觉基线默认目录名（v12 引入，v14 语义收窄）。
 *
 * v14（B1）起默认基准目录为 `<skillRoot>/userWorkSpace/baselines/`——本常量
 * 不再表示 Skill 根目录下的 `baselines/`，而是 userWorkSpace 内的**默认基准
 * 子目录名**。历史 Skill 根目录下的 `baselines/` 不迁移、不作为默认根（D3）。
 * 仍是跨会话长期保留的比对基准，由用户主动维护，不做数量淘汰。
 */
export const VISUAL_BASELINE_DIRECTORY_NAME = 'baselines'
/**
 * 单张视觉基线的体积上限（原始字节）。
 *
 * 与探查截图、报告内嵌上限同口径（2MB），避免出现「捕获认为能存、比对认为不能用」的错配。
 */
export const MAX_VISUAL_BASELINE_BYTES = 2 * 1024 * 1024

export const MAX_SKILL_FILE_BYTES = 1024 * 1024
export const MAX_SKILL_TREE_DEPTH = 20
export const MAX_SKILL_TREE_NODES = 5000
export const MAX_RELATIVE_PATH_LENGTH = 2048

export const KNOWN_TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.txt',
  '.yaml',
  '.yml',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.less',
  '.xml',
  '.csv',
  '.toml',
  '.ini',
  '.sh',
  '.py',
  '.java',
  '.go',
  '.rs',
  '.vue',
])

export const KNOWN_BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.7z',
  '.rar',
  '.wasm',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp3',
  '.mp4',
  '.mov',
])
