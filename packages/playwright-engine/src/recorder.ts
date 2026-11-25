export interface IStartRecorderOptions {
  title: string
  url: string
}

export interface IRecorderResult {
  script: string
}

export async function startRecorder(
  options: IStartRecorderOptions,
): Promise<IRecorderResult> {
  return {
    script: `import { test } from '@playwright/test';\n\ntest('${options.title}', async ({ page }) => {\n  await page.goto('${options.url}');\n});\n`,
  }
}
