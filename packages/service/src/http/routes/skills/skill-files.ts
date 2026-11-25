import type { Hono } from 'hono'
import {
  createUserWorkspaceDirectory,
  createUserWorkspaceFile,
  deleteSkillEntry,
  listSkillFiles,
  readExplorationScreenshot,
  readSkillFile,
  readSkillImageFile,
  resolveSkill,
  writeSkillFile,
} from '@authine-e2e-agent/skill-manager'
import type {
  ICreateSkillDirectoryResponse,
  ICreateSkillFileResponse,
  IDeleteSkillFileResponse,
  IGetSkillFileResponse,
  IListSkillFilesResponse,
  IUpdateSkillFileResponse,
} from '@authine-e2e-agent/types'
import type { IAppEnv } from '../../app-types'
import { ApiError } from '../../../shared/errors/api-error'
import { parseJsonBody } from '../../request-validation'
import { requirePlatformConfig } from '../route-utils'
import {
  createUserWorkspaceDirectorySchema,
  createUserWorkspaceFileSchema,
  skillIdSchema,
  updateSkillFileSchema,
} from './validation'

const FILE_WRITE_BODY_LIMIT = 1024 * 1024 + 128 * 1024

export function registerSkillFileRoutes(routes: Hono<IAppEnv>): void {
  // —— 页面探查截图服务（v12-pre）——
  //
  // 与 test_report 的报告文件服务（D10 路径白名单）同构：
  // 会话目录名与文件名都走白名单正则，再做归一化后的前缀校验，最后只读该单文件。
  // 之所以需要它：截图字节不能进 SSE 事件通道（会经脱敏器替换 BINARY_KEY_PATTERN
  // 命中的字段，也会拖累事件总线与断线续传缓冲），因此改由客户端按 URL 单独拉取。
  //
  // 注意：图片本体位于 Skill 的 `temp/exploration/` 下，任务终态随 temp/ 删除，
  // 因此生成结束后本路由对该会话一律返回 404（客户端据此显示占位文案）。
  // 这是既定行为而非故障：探查截图的价值在于生成过程中判断 Agent 核对质量。
  routes.get('/:skillId/exploration/:sessionId/:fileName', async (context) => {
    const skillId = parseSkillId(context.req.param('skillId'))
    const sessionId = context.req.param('sessionId') ?? ''
    const fileName = context.req.param('fileName') ?? ''
    const { config } = await requirePlatformConfig()
    const resolvedSkill = await resolveSkill(
      { rootDir: config.projectDirectory },
      skillId,
    )

    // 路径校验与读取都在 skill-manager 内完成（白名单 + 归一化前缀校验）。
    const content = await readExplorationScreenshot({
      skillRoot: resolvedSkill.skillRoot,
      sessionId,
      fileName,
    })

    // 复制到独立的 ArrayBuffer 视图以满足 Hono 的 body 类型（避免 SharedArrayBuffer 联合）。
    const body = new Uint8Array(content.byteLength)
    body.set(content)

    return context.body(body, 200, {
      'Content-Type': 'image/png',
      'Content-Length': String(content.byteLength),
      // 只短缓存：截图位于 temp/ 之下，任务终态即被删除，长缓存会让客户端在文件
      // 消失后仍展示已失效的旧图；短缓存仅用于吸收同一次生成内的重复请求。
      'Cache-Control': 'private, max-age=60',
    })
  })

  // —— 图片预览字节服务（v13）——
  //
  // 为什么不能复用上面的 `/file?path=`：那条走的是**文本编辑器**读取路径，
  // 会在二进制扩展名、NUL 字节、UTF-8 解码三处拒绝图片（FILE_NOT_SUPPORTED）。
  // 图片必须按原始字节提供，因此单开一条只服务「可预览图片」的只读路由。
  //
  // 路径安全由 skill-manager 统一把关（逐段符号链接检测 + 归一化前缀校验 + 图片白名单），
  // 路由层只负责参数解析与响应头。
  routes.get('/:skillId/image', async (context) => {
    const skillId = parseSkillId(context.req.param('skillId'))
    const relativePath = context.req.query('path') ?? ''
    const { config } = await requirePlatformConfig()
    const image = await readSkillImageFile(
      { rootDir: config.projectDirectory },
      skillId,
      relativePath,
    )

    // 复制到独立的 ArrayBuffer 视图以满足 Hono 的 body 类型（避免 SharedArrayBuffer 联合）。
    const body = new Uint8Array(image.bytes.byteLength)
    body.set(image.bytes)

    return context.body(body, 200, {
      'Content-Type': image.mimeType,
      'Content-Length': String(image.bytes.byteLength),
      // 图片按路径寻址、内容可能被重新生成覆盖，因此不做长缓存；
      // no-cache 允许缓存但每次回源校验，兼顾重复打开与内容更新。
      'Cache-Control': 'private, no-cache',
    })
  })

  routes.get('/:skillId/files', async (context) => {
    const skillId = parseSkillId(context.req.param('skillId'))
    const { config } = await requirePlatformConfig()
    const tree = await listSkillFiles(
      { rootDir: config.projectDirectory },
      skillId,
    )
    const responseBody: IListSkillFilesResponse = { success: true, data: tree }
    return context.json(responseBody)
  })

  routes.get('/:skillId/file', async (context) => {
    const skillId = parseSkillId(context.req.param('skillId'))
    const relativePath = context.req.query('path') ?? ''
    const { config } = await requirePlatformConfig()
    const fileContent = await readSkillFile(
      { rootDir: config.projectDirectory },
      skillId,
      relativePath,
    )
    const responseBody: IGetSkillFileResponse = {
      success: true,
      data: fileContent,
    }
    return context.json(responseBody)
  })

  routes.put('/:skillId/file', async (context) => {
    const skillId = parseSkillId(context.req.param('skillId'))
    const input = await parseJsonBody(
      context,
      updateSkillFileSchema,
      FILE_WRITE_BODY_LIMIT,
    )
    const { config } = await requirePlatformConfig()
    const result = await writeSkillFile(
      { rootDir: config.projectDirectory },
      skillId,
      input,
    )
    const responseBody: IUpdateSkillFileResponse = {
      success: true,
      data: result,
    }
    return context.json(responseBody)
  })

  // —— userWorkSpace 内新建目录 / 文件（v14 D1/W14，文件树新建入口）——
  //
  // 与既有 `PUT /file` 的分工：POST 是**创建**（不覆盖、无需版本号），
  // PUT 是**更新**（版本冲突检测）。请求体只带 userWorkSpace 内相对路径，
  // 根由服务端拼接——用户不能在 userWorkSpace 外创建（B4）。
  // 路径安全（D2 归一化 + 逐段符号链接检查 + 白名单限制）在 skill-manager 统一把关。
  routes.post('/:skillId/directory', async (context) => {
    const skillId = parseSkillId(context.req.param('skillId'))
    const input = await parseJsonBody(
      context,
      createUserWorkspaceDirectorySchema,
      FILE_WRITE_BODY_LIMIT,
    )
    const { config } = await requirePlatformConfig()
    const result = await createUserWorkspaceDirectory(
      { rootDir: config.projectDirectory },
      skillId,
      input.path,
    )
    const responseBody: ICreateSkillDirectoryResponse = {
      success: true,
      data: result,
    }
    return context.json(responseBody, 201)
  })

  routes.post('/:skillId/file', async (context) => {
    const skillId = parseSkillId(context.req.param('skillId'))
    const input = await parseJsonBody(
      context,
      createUserWorkspaceFileSchema,
      FILE_WRITE_BODY_LIMIT,
    )
    const { config } = await requirePlatformConfig()
    const result = await createUserWorkspaceFile(
      { rootDir: config.projectDirectory },
      skillId,
      input.path,
      input.content,
    )
    const responseBody: ICreateSkillFileResponse = {
      success: true,
      data: result,
    }
    return context.json(responseBody, 201)
  })

  // —— 文件 / 目录删除（v13，文件树删除入口）——
  //
  // 路径走 query 而不是 body：DELETE 请求带 body 在部分客户端与代理上语义含糊，
  // 与同为只读寻址的 `/file`、`/image` 保持一致的写法。
  //
  // 删除面由 skill-manager 统一把关：路径安全（逐段符号链接检测 + 归一化前缀校验）
  // 与「创建期文件不可删」的保护清单都在那里，路由层不重复实现。
  routes.delete('/:skillId/file', async (context) => {
    const skillId = parseSkillId(context.req.param('skillId'))
    const relativePath = context.req.query('path') ?? ''
    const { config } = await requirePlatformConfig()
    const result = await deleteSkillEntry(
      { rootDir: config.projectDirectory },
      skillId,
      relativePath,
    )
    const responseBody: IDeleteSkillFileResponse = {
      success: true,
      data: result,
    }
    return context.json(responseBody)
  })
}

function parseSkillId(skillId: string): string {
  const result = skillIdSchema.safeParse(skillId)

  if (!result.success) {
    throw new ApiError({
      code: 'INVALID_SKILL_ID',
      status: 400,
      message: 'Skill ID 格式不正确。',
    })
  }

  return result.data
}
