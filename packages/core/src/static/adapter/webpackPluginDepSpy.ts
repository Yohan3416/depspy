import path from "path";
import { GetModuleInfo, ModuleInfo, PluginDepSpyConfig } from "../../type";
import { sendDataByChunk, SourceToImportId } from "../utils";
import { DEP_SPY_START, DEP_SPY_WEBPACK_BUILD } from "../../constant";
import { StaticGraph } from "../staticGraph";

export class webpackPluginDepSpy {
  private sourceToImportIdMap = new SourceToImportId();
  private importIdToModuleInfo = new Map<string, ModuleInfo>();
  constructor(private options: PluginDepSpyConfig = {}) {}
  apply(compiler) {
    //只能通过ds命令运行;
    if (!process.env[DEP_SPY_START]) {
      return false;
    }
    // 标记webpack构建
    process.env[DEP_SPY_WEBPACK_BUILD] = "true";

    compiler.hooks.beforeRun.tapPromise("EntryPathPlugin", async (compiler) => {
      // 入口路径标准化函数
      const normalizeEntry = (e: string) =>
        path.isAbsolute(e) ? e : path.resolve(compiler.context, e);

      // 如果用户没有提供entry，由webpack解析到的entry作为入口
      if (!this.options.entry) {
        const entry = compiler.options.entry;
        if (typeof entry === "string") {
          this.options.entry = normalizeEntry(entry);
        } else if (entry && typeof entry === "object") {
          // 处理多入口情况
          const entries: string[] = [];

          // 将入口对象转换为数组
          const toArray = (v: unknown): string[] => {
            if (!v) return [];
            if (typeof v === "string") return [v];
            if (Array.isArray(v)) return v as string[];
            if (typeof v === "object") {
              const obj = v as Record<string, unknown>;
              return Object.values(obj).flatMap((value) => {
                if (typeof value === "string") return [value];
                if (Array.isArray(value)) return value as string[];
                if (typeof value === "object" && value && "import" in value) {
                  return Array.isArray((value as { import: unknown }).import)
                    ? (value as { import: string[] }).import
                    : [];
                }
                return [];
              });
            }
            return [];
          };

          const entryArray = toArray(entry);
          entries.push(...entryArray.map(normalizeEntry));

          // 去重并设置入口
          this.options.entry = Array.isArray(this.options.entry)
            ? Array.from(new Set([...this.options.entry, ...entries]))
            : entries.length > 0
              ? entries
              : normalizeEntry("index.js");
        }
      } else {
        // 如果用户提供了entry，也需要标准化处理
        const normalizeUserEntry = (e: unknown): string[] => {
          if (typeof e === "string") return [normalizeEntry(e)];
          if (Array.isArray(e)) return e.map(normalizeEntry);
          return [];
        };

        const normalizedEntries = normalizeUserEntry(this.options.entry);
        this.options.entry = Array.from(new Set(normalizedEntries));
      }

      // 设置 node_modules 为 external，避免额外构建第三方依赖
      if (this.options.ignoreThirdParty) {
        const existingExternal = compiler.options.externals || [];
        const externalArray = Array.isArray(existingExternal)
          ? existingExternal
          : [existingExternal];

        const nodeModulesExternal = (
          context: string,
          request: string,
          callback: (err?: Error | null, result?: string) => void,
        ) => {
          const isNodeModules = request.includes("node_modules");
          const matchesExistingExternal = externalArray.some((ext: unknown) => {
            if (typeof ext === "function") {
              return ext(context, request, callback);
            } else if (typeof ext === "string") {
              return request.includes(ext);
            } else if (ext instanceof RegExp) {
              return ext.test(request);
            }
            return false;
          });

          if (isNodeModules || matchesExistingExternal) {
            return callback(null, `commonjs ${request}`);
          }
          return callback();
        };

        compiler.options.externals = nodeModulesExternal;
      }
    });
    compiler.hooks.compilation.tap("DependencyTreePlugin", (compilation) => {
      compilation.hooks.optimizeModules.tap(
        "DependencyTreePlugin",
        (modules) => {
          modules.forEach((module) => {
            const filePath = module.resource;
            if (!filePath) return;
            // 收集路径映射
            const { importedIds, dynamicallyImportedIds } =
              this.collectDependence(module, compilation);
            // 处理导出信息
            const { renderedExports, removedExports } = this.analyzeExports(
              module,
              compilation,
            );
            this.importIdToModuleInfo.set(filePath, {
              importedIds: [...new Set(importedIds)],
              dynamicallyImportedIds: [...new Set(dynamicallyImportedIds)],
              removedExports: removedExports,
              renderedExports: renderedExports,
            });
          });
        },
      );
    });
    // 输出处理
    compiler.hooks.done.tap("DependencyTreePlugin", async () => {
      // 构造获取模块关键信息的函数
      const getModuleInfo: GetModuleInfo = (importId) => {
        const {
          importedIds,
          dynamicallyImportedIds,
          removedExports,
          renderedExports,
        } = this.importIdToModuleInfo.get(importId) || {};
        return {
          importedIds: [...(importedIds || [])],
          dynamicallyImportedIds: [...(dynamicallyImportedIds || [])],
          removedExports,
          renderedExports,
        };
      };
      // 生成依赖图
      const staticGraph = new StaticGraph(
        this.options,
        this.sourceToImportIdMap,
        getModuleInfo,
      );
      const graph = await staticGraph.generateGraph();
      await sendDataByChunk(Object.values(graph), "/collectBundle");
    });
  }
  // 分析导出
  analyzeExports(module, compilation) {
    const renderedExports = [];
    const removedExports = [];
    let providedExports = [];
    // Webpack5 的导出信息存储方式
    if (compilation.moduleGraph?.getProvidedExports) {
      providedExports = compilation.moduleGraph.getProvidedExports(module);
    } else {
      // 兼容 Webpack4
      providedExports = module.buildMeta
        ? module.buildMeta.providedExports
        : [];
    }

    let usedExports = [];
    // Webpack5 的导出使用信息存储方式
    if (compilation.moduleGraph?.getUsedExports) {
      const _usedExports = compilation.moduleGraph.getUsedExports(module);
      if (_usedExports === true) {
        // 如果是 true，表示所有导出都被使用
        usedExports = [...providedExports];
      } else if (_usedExports === false) {
        // 如果是 false，表示没有导出被使用
        usedExports = [];
      } else if (_usedExports instanceof Set) {
        usedExports = [..._usedExports];
      }
    } else {
      // 兼容 Webpack4
      const _usedExports = module.usedExports || [];
      if (Array.isArray(_usedExports)) {
        // 如果是 true，表示所有导出都被使用
        usedExports = [..._usedExports];
      } else if (Array.isArray(providedExports)) {
        // 如果是 false，表示没有导出被使用
        usedExports = [...providedExports];
      }
    }

    if (Array.isArray(providedExports) && Array.isArray(usedExports)) {
      renderedExports.push(
        ...providedExports.filter((exp) => usedExports.includes(exp)),
      );
      removedExports.push(
        ...providedExports.filter((exp) => !usedExports.includes(exp)),
      );
    }

    return { renderedExports, removedExports };
  }
  // 收集路径映射
  collectDependence(module, compilation) {
    const importedIds = [];
    const dynamicallyImportedIds = [];
    // 遍历所有依赖收集映射关系
    module.dependencies.forEach((dep) => {
      // 处理静态导入映射
      const request = dep.request || dep.userRequest;
      const depModle = compilation.moduleGraph?.getModule
        ? compilation.moduleGraph.getModule(dep)
        : dep.module;
      if (request && depModle && depModle.resource) {
        importedIds.push(depModle.resource);
        this.sourceToImportIdMap.addRecord(
          request,
          module.resource,
          depModle.resource,
        );
      }
    });
    // 处理动态导入映射
    module.blocks.forEach((block) => {
      block.dependencies.forEach((dep) => {
        const request = dep.request || dep.userRequest;
        const depModle = compilation.moduleGraph?.getModule
          ? compilation.moduleGraph.getModule(dep)
          : dep.module;
        if (request && depModle && depModle.resource) {
          dynamicallyImportedIds.push(depModle.resource);
          this.sourceToImportIdMap.addRecord(
            request,
            module.resource,
            depModle.resource,
          );
        }
      });
    });
    return {
      importedIds,
      dynamicallyImportedIds,
    };
  }
}
