import path from "path";
import { mergeOptions, sendDataByChunk, SourceToImportId } from "../utils";
import { normalizePath, type PluginOption } from "vite";
import {
  DEP_SPY_START,
  DEP_SPY_SUB_START,
  DEP_SPY_VITE_BUILD,
} from "../../constant";
import { OutputBundle } from "rollup";
import { GetModuleInfo, PluginDepSpyConfig } from "../../type";
import { StaticGraph } from "../staticGraph";

export function vitePluginDepSpy(
  options: PluginDepSpyConfig = {},
): PluginOption {
  //只能通过ds命令运行;
  if (!process.env[DEP_SPY_START]) {
    return false;
  }
  // 避免子模块运行导致多次运行
  if (process.env[DEP_SPY_SUB_START]) {
    return false;
  }
  // 标记是由vite构建
  process.env[DEP_SPY_VITE_BUILD] = "true";
  // 源码路径和绝对路径的互相映射
  const sourceToImportIdMap = new SourceToImportId();
  // 合并环境配置和用户配置
  options = mergeOptions(options);

  return {
    name: "vite-plugin-dep-spy",
    enforce: "pre",
    configResolved(config) {
      if (process.env[DEP_SPY_SUB_START]) {
        return;
      }
      //  设置入口绝对地址，默认是index.html；支持数组
      const normalizeEntry = (e: string) =>
        normalizePath(path.isAbsolute(e) ? e : path.join(config.root, e));
      if (!options?.entry) {
        options.entry = normalizePath(path.join(config.root, "index.html"));
      }
      const entries = Array.isArray(options.entry)
        ? Array.from(new Set(options.entry.map(normalizeEntry)))
        : [normalizeEntry(options.entry)];
      options.entry = entries;

      // 合并到 rollupOptions.input（若用户未配置则填充；若已配置则合并去重）
      const input = (config.build?.rollupOptions as { input?: unknown })?.input;
      const toArray = (v: unknown): string[] => {
        if (!v) return [];
        if (typeof v === "string") return [v];
        if (Array.isArray(v)) return v as string[];
        if (typeof v === "object")
          return Object.values(v as Record<string, string>);
        return [];
      };
      const merged = Array.from(new Set([...entries, ...toArray(input)]));
      const _build = (config.build || ({} as unknown)) as {
        rollupOptions?: { input?: unknown };
      };
      const _rollupOptions = (_build.rollupOptions || ({} as unknown)) as {
        input?: unknown;
      };
      _rollupOptions.input = merged;
      _build.rollupOptions = _rollupOptions;
      // @ts-expect-error update resolved config for downstream plugins; vite doesn't type this as mutable
      config.build = _build;

      // 注入resolveId，保证第一个执行，不会被其他插件阶段
      /* 虽然vite不建议在这里调整插件，但是没有强行限制
         1. 只是收集引入和真实路径的关系，不会影响其他插件运行
         2. 避免被其他强行加入的插件提前拦截影响，比如：vite-plugin-uni
      **/
      /* @ts-expect-error ensure earliest resolve to record source-import map */
      config.plugins?.unshift({
        name: "vite-plugin-dep-spy-main-resolve",
        resolveId(id: string, importer: string) {
          // 调用下一个 resolveId 钩子获取输出
          return this.resolve(id, importer, {
            ...options,
            skipSelf: true,
          }).then((output: { id: string }) => {
            // 保存源码路径和绝对路径的关联
            if (output?.id) {
              sourceToImportIdMap.addRecord(id, importer, output?.id);
            }
            return output;
          });
        },
      });
    },
    async generateBundle(_, bundle) {
      // 避免子模块运行打包导致多次运行
      if (process.env[DEP_SPY_SUB_START]) {
        return;
      }
      // 收集模块的导出使用以及移除情况
      const importIdToExports = getImportIdToExports(bundle as OutputBundle);
      // 构造获取模块关键信息的函数
      const getModuleInfo: GetModuleInfo = (importId) => {
        // 当前文件的后缀
        const ext = path.extname(importId);
        // 导入信息
        const moduleInfo = this.getModuleInfo(importId);
        if (!moduleInfo) {
          throw new Error(`please check if ${importId} is correctly parsed`);
        }
        const importedIds = moduleInfo.importedIds;
        const dynamicallyImportedIds = moduleInfo.dynamicallyImportedIds;
        const exportedBindings = (
          moduleInfo as unknown as {
            exportedBindings?: Record<string, string[]>;
          }
        ).exportedBindings;
        // 导出信息
        const { removedExports = [], renderedExports = [] } =
          importIdToExports.get(importId) || {};
        // vue文件的特殊处理，跳过过程中的ts文件，相当于vue直接引入的依赖
        if (ext === ".vue") {
          return {
            importedIds: [...(filterVueImportedIds([...importedIds]) || [])],
            dynamicallyImportedIds: [...(dynamicallyImportedIds || [])],
            removedExports: [],
            renderedExports: ["default"],
          };
        }
        // 完善重导出文件的removedExports，renderedExports字段
        Object.keys(exportedBindings || {}).forEach((sourcePath) => {
          // 路径不为.则说明是重导出
          if (sourcePath !== ".") {
            // key为源码路径，需要转化为绝对路径
            const absolutePath = sourceToImportIdMap.getImportIdBySource(
              sourcePath,
              importId,
            );
            // 获取重导出模块的导出信息
            const {
              removedExports: _removedExports = [],
              renderedExports: _renderedExports = [],
            } = importIdToExports.get(absolutePath) || {};
            removedExports.push(..._removedExports);
            renderedExports.push(..._renderedExports);
          }
        });
        return {
          importedIds: [...(importedIds || [])],
          dynamicallyImportedIds: [...(dynamicallyImportedIds || [])],
          removedExports,
          renderedExports,
        };
      };
      // 生成依赖图
      const staticGraph = new StaticGraph(
        options,
        sourceToImportIdMap,
        getModuleInfo,
      );
      const graph = await staticGraph.generateGraph();
      // 分块发送数据给服务器
      await sendDataByChunk(Object.values(graph), "/collectBundle");
    },
  };
}

// 收集模块的导出使用以及移除情况
function getImportIdToExports(bundle: OutputBundle) {
  const importIdToExports = new Map<
    string,
    { removedExports: string[]; renderedExports: string[] }
  >();
  Object.values(bundle).forEach((dist) => {
    // 只处理代码块
    if (dist.type === "chunk") {
      // 改分块代码由哪些引入模块构成
      Object.entries(dist.modules || {}).forEach(([id, renderedModule]) => {
        importIdToExports.set(id, {
          removedExports: renderedModule?.removedExports || [],
          renderedExports: renderedModule?.renderedExports || [],
        });
      });
    }
  });
  return importIdToExports;
}

// 处理vite关于vue文件路径问题
// vue—> js + css
function filterVueImportedIds(importedIds: string[]) {
  return importedIds.filter((id) => {
    const pathInfo = parseVueRequestPath(id);
    if (pathInfo.query["type"] === "style") {
      return false;
    }
    return true;
  });
}
function parseVueRequestPath(filePath: string) {
  const [fullPath, queryString] = filePath.split("?");
  const result = {
    fullPath,
    fileName: fullPath.split("/").pop(),
    query: {},
  };

  if (queryString) {
    const params = new URLSearchParams(queryString);
    for (const [key, value] of params.entries()) {
      result.query[key] = value === "" ? true : value;
    }
  }
  return result;
}
