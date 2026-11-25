/**
 * 自定义 Node ESM loader：支持以 `import x from "./xxx.md?raw"` 方式导入 markdown。
 *
 * 背景：源码中通过 `?raw` 导入 markdown（见 src/env.d.ts），该语法只有打包器
 * （tsup / Vite）认识。直接 `node`/`tsx` 运行源码会报
 * `ERR_UNKNOWN_FILE_EXTENSION: ".md"`。
 *
 * 本文件被 `--import` 时先自注册为 ESM loader（见文件底部 register 调用），
 * 把 `.md` / `.md?raw` 导入解析为「默认导出原始文本」的模块，等价于打包器的
 * text loader 行为。从而让 tsx 能直接运行任意源码文件，配合 VSCode 打断点调试。
 *
 * 用法：
 *   node --import tsx --import ./scripts/md-raw-loader.mjs <目标.ts>
 * 或通过 .vscode/launch.json 的 debug 配置触发（见仓库根目录）。
 */
import { register } from "node:module";
import { readFile } from "node:fs/promises";

/**
 * 拦截 `load`：把 `.md` 文件转成导出纯文本的模块。
 *
 * @param url - 被加载模块的 URL（可能带 `?raw` 查询串）
 * @param context - 加载上下文（本实现未使用）
 * @param nextLoad - 链中下一个 load hook，非 `.md` 时透传
 * @returns `.md` 文件返回导出原始文本的 module；其余返回 nextLoad 结果
 * @throws 无（文件读取失败时由底层 fs 异常上抛）
 */
export async function load(url, context, nextLoad) {
  if (url.split("?")[0].endsWith(".md")) {
    const source = await readFile(new URL(url).pathname, "utf8");
    // 用 JSON.stringify 保证文本中的引号、换行等被正确转义
    return {
      format: "module",
      source: `export default ${JSON.stringify(source)};`,
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}

// 被 `--import` 加载时自注册为 loader（相对于本文件所在目录解析）
register(new URL("./md-raw-loader.mjs", import.meta.url));
