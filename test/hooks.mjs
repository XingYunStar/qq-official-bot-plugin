/** 测试用：把插件的 TRSS 配置/配置读取重定向到桩文件 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith("lib/plugins/config.js"))
    return { url: new URL("./stub-config.mjs", import.meta.url).href, shortCircuit: true }
  if (specifier.endsWith("lib/config/config.js"))
    return { url: new URL("./stub-main-config.mjs", import.meta.url).href, shortCircuit: true }
  return nextResolve(specifier, context)
}
