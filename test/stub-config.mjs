/** 把插件配置对象暴露给测试 */
export default async function makeConfig(name, config = {}, keep = {}, opts = {}) {
  Object.assign(config, keep)
  globalThis.__config = config
  return { config, configSave: async () => {}, configFile: `config/${name}.yaml` }
}
