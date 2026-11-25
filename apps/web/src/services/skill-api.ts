import type {
  ICreateSkillDirectoryRequest,
  ICreateSkillDirectoryResponse,
  ICreateSkillFileRequest,
  ICreateSkillFileResponse,
  ICreateSkillRequest,
  ICreateSkillResponse,
  IDeleteSkillFileResponse,
  IDeleteSkillResponse,
  IGetSkillFileResponse,
  IGetSkillResponse,
  IListSkillFilesResponse,
  IListSkillsResponse,
  IUpdateSkillFileRequest,
  IUpdateSkillFileResponse,
} from '@authine-e2e-agent/types'
import { requestJson } from './http-client'

export function fetchSkills(
  signal?: AbortSignal,
): Promise<IListSkillsResponse> {
  return requestJson({ path: '/api/skills', signal })
}

export function createSkill(
  payload: ICreateSkillRequest,
): Promise<ICreateSkillResponse> {
  return requestJson({ path: '/api/skills', method: 'POST', body: payload })
}

export function deleteSkill(skillId: string): Promise<IDeleteSkillResponse> {
  return requestJson({
    path: `/api/skills/${encodeURIComponent(skillId)}`,
    method: 'DELETE',
  })
}

export function fetchSkill(
  skillId: string,
  signal?: AbortSignal,
): Promise<IGetSkillResponse> {
  return requestJson({
    path: `/api/skills/${encodeURIComponent(skillId)}`,
    signal,
  })
}

export function fetchSkillFiles(
  skillId: string,
  signal?: AbortSignal,
): Promise<IListSkillFilesResponse> {
  return requestJson({
    path: `/api/skills/${encodeURIComponent(skillId)}/files`,
    signal,
  })
}

export function fetchSkillFile(
  skillId: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<IGetSkillFileResponse> {
  return requestJson({
    path: `/api/skills/${encodeURIComponent(skillId)}/file?path=${encodeURIComponent(relativePath)}`,
    signal,
  })
}

export function updateSkillFile(
  skillId: string,
  payload: IUpdateSkillFileRequest,
  signal?: AbortSignal,
): Promise<IUpdateSkillFileResponse> {
  return requestJson({
    path: `/api/skills/${encodeURIComponent(skillId)}/file`,
    method: 'PUT',
    body: payload,
    signal,
  })
}

/**
 * 删除 Skill 内的文件或目录（v13）。
 *
 * 目录会被服务端递归删除。创建 Skill 时生成的文件（`manifest.json`、
 * `e2e_schema.json`、`env.json`）受保护，服务端会以 `FILE_READ_ONLY` 拒绝。
 *
 * @param skillId 目标 Skill ID。
 * @param relativePath 待删除内容在 Skill 内的相对路径。
 * @returns 删除结果（含被删路径与类型）。
 * @throws ApiClientError 失败时抛出（只读文件 403、路径非法 400、不存在 404）。
 */
export function deleteSkillFile(
  skillId: string,
  relativePath: string,
): Promise<IDeleteSkillFileResponse> {
  return requestJson({
    path: `/api/skills/${encodeURIComponent(skillId)}/file?path=${encodeURIComponent(relativePath)}`,
    method: 'DELETE',
  })
}

/**
 * 构造 Skill 内图片的字节地址（v13 图片预览）。
 *
 * 只返回地址而不拉取：图片由 `<img src>` 直接消费，交给浏览器做
 * 缓存、懒加载与解码，比在 JS 里取 blob 再转 url 更省内存。
 *
 * @param skillId 目标 Skill ID。
 * @param relativePath 图片在 Skill 内的相对路径。
 * @returns 同源的图片字节地址。
 * @throws 不抛出异常。
 */
export function buildSkillImageUrl(
  skillId: string,
  relativePath: string,
): string {
  return `/api/skills/${encodeURIComponent(skillId)}/image?path=${encodeURIComponent(relativePath)}`
}

/**
 * 在 userWorkSpace 内新建子目录（v14 D1/W14，创建语义：不覆盖已有目录）。
 *
 * @param skillId 目标 Skill ID。
 * @param path userWorkSpace 内相对路径（不含 userWorkSpace 前缀）。
 * @returns 创建结果（含 Skill 内完整相对路径）。
 * @throws ApiClientError 路径非法（400）、已存在（409）、越界或符号链接占用（400）时抛出。
 */
export function createUserWorkspaceDirectory(
  skillId: string,
  path: string,
): Promise<ICreateSkillDirectoryResponse> {
  return requestJson({
    path: `/api/skills/${encodeURIComponent(skillId)}/directory`,
    method: 'POST',
    body: { path },
  })
}

/**
 * 在 userWorkSpace 内新建文本文件（v14 D1/W14，创建语义：不覆盖已有文件）。
 *
 * @param skillId 目标 Skill ID。
 * @param path userWorkSpace 内相对路径。
 * @param content 文件初始内容（通常为空字符串，R10）。
 * @returns 创建结果（含完整相对路径、版本与大小）。
 * @throws ApiClientError 路径非法（400）、已存在（409）、二进制扩展名（422）、
 *   超限（413）时抛出。
 */
export function createUserWorkspaceFile(
  skillId: string,
  path: string,
  content: string,
): Promise<ICreateSkillFileResponse> {
  return requestJson({
    path: `/api/skills/${encodeURIComponent(skillId)}/file`,
    method: 'POST',
    body: { path, content },
  })
}
