import { StaticTreeNode, StaticGraphNode } from "~/types";
import { SIDE_EFFECT_NAME } from "@dep-spy/core";
import { useStaticStore } from "@/contexts";

//通过完整的路径 rootPath + pathId + '-' + id 截取name
export const extractFileName = (path: string) => {
  // 匹配包含 index 的路径
  const indexRegex = /\/([^/]+)\/index\.([^/]+)(?:-\d+)?$/;
  // 匹配不包含 index 的路径
  const normalRegex = /\/([^/]+)(?:-\d+)?$/;

  if (path.includes("/index.")) {
    const match = path.match(indexRegex);
    if (match) {
      return `${match[1]}/index.${match[2]}`;
    }
  }
  const match = path.match(normalRegex);
  if (match) {
    return match[1];
  }
  return path;
};

export const traverseTree = (
  node: StaticTreeNode,
  callback: (node: StaticTreeNode) => void,
) => {
  callback(node);
  for (const child of Object.values(node.children)) {
    traverseTree(child, callback);
  }
};

export const getEntryIdFromTreeId = (treeId: string) => {
  const arr = treeId.split("-");
  arr.pop();
  return arr.join("-");
};

// 获取下一层子节点集合
export function getNextLevel(
  entryId: string,
  reverse: boolean,
): Map<string, { entryId: string; selectExports: Set<string> }> {
  const { staticGraph } = useStaticStore.getState();
  const renderChildren: Map<
    string,
    { entryId: string; selectExports: Set<string> }
  > = new Map();
  const graphNode = staticGraph.get(entryId);
  const selectExports = new Set(
    graphNode.renderedExports.concat(SIDE_EFFECT_NAME),
  );
  const treeNode: StaticTreeNode = {
    ...graphNode,
    id: `${entryId}-temp`,
    paths: [],
    children: [],
    collapsed: false,
  };

  if (reverse) {
    // 导入该文件的引入者数组，set去重
    new Set([...treeNode.importers, ...treeNode.dynamicImporters]).forEach(
      (childId) => {
        // 引入者导出的变动以及变动原因
        const child = staticGraph.get(childId);
        Object.entries(child.exportEffectedNamesToReasons).forEach(
          ([exportName, reasons]) => {
            // 如果引入者的导出变更和当前文件的变更相关，则添加到子节点进行展示
            reasons.importEffectedNames[entryId]?.forEach((importName) => {
              // 如果该文件选中的导出确实影响到了引入者的导出，则记录影响了引入者的哪些导出，并以此作为影响面向下传递
              if (selectExports.has(importName) || importName === "*") {
                const children = renderChildren.get(childId);
                // 已经添加，合并
                if (children) {
                  children.selectExports.add(exportName);
                  return;
                }
                // 未添加，新建
                renderChildren.set(childId, {
                  entryId: childId,
                  selectExports: new Set([exportName, SIDE_EFFECT_NAME]),
                });
              }
            });
          },
        );
      },
    );
  } else {
    // 1. 记录该文件选中的导出受到哪些导入以及对应导入的变量的影响，方便第二步过滤不需要展示的子节点
    const importIdToSelectExports = new Map<string, Set<string>>();
    selectExports.forEach((selectExport) => {
      // 选中的export变更的原因
      const reason = treeNode.exportEffectedNamesToReasons[selectExport];
      // 确保reason存在
      if (reason) {
        // 遍历影响该导出的所有导入，并进行合并
        Object.entries(reason.importEffectedNames).forEach(
          ([importId, importNames]) => {
            const childSelectExports = importIdToSelectExports.get(importId);
            // 已经添加，合并
            if (childSelectExports) {
              importIdToSelectExports.set(
                importId,
                new Set(Array.from(childSelectExports).concat(importNames)),
              );
              return;
            }
            // 未添加，新建
            importIdToSelectExports.set(importId, new Set(importNames));
          },
        );
      }
    });
    // 2. 该文件的导入文件数组，set去重
    new Set([
      ...treeNode.importedIds,
      ...treeNode.dynamicallyImportedIds,
    ]).forEach((childId) => {
      // 2.1 如果该文件受到了该导入的影响，则需要递归展示
      const childSelectExports = importIdToSelectExports.get(childId);
      if (childSelectExports) {
        renderChildren.set(childId, {
          entryId: childId,
          selectExports: childSelectExports,
        });
        return;
      }
      // 2.2 如果导入的文件有副作用变化，也需要展示
      const child = staticGraph.get(childId);
      if (child.isSideEffectChange) {
        renderChildren.set(childId, {
          entryId: childId,
          // SIDE_EFFECT_NAME代表选中中该节点的副作用
          selectExports: new Set([SIDE_EFFECT_NAME]),
        });
      }
    });
  }
  return renderChildren;
}

// 指定图的节点构建树，reverse 为 true 时，构建反向树
export function renderTreeByGraphId(
  entryId: string,
  // 是否反向构建（gitChange -> importChange）
  reverse: boolean = false,
  maxLevel: number = 3,
) {
  // 重置全局 idToCount
  globalIdToCount.clear();
  // 记录当前路径
  const paths = new Set<string>();
  const _buildTreeByGraphId = (
    // 传入根节点id
    entryId: string,
    // 图节点信息
    graph: Map<string, StaticGraphNode>,
    // 是否反向构建（gitChange -> importChange）
    reverse: boolean = false,
    currentLevel: number = 0,
  ) => {
    // 记录出现次数
    globalIdToCount.set(entryId, (globalIdToCount.get(entryId) || 0) + 1);
    // 图节点的原始信息
    const graphNode = graph.get(entryId);
    // 构建g6渲染的需要的树节点
    const treeNode: StaticTreeNode = {
      ...graphNode,
      id: `${entryId}-${globalIdToCount.get(entryId)}`,
      paths: Array.from(paths),
      children: [],
      collapsed: false,
    };
    if (currentLevel >= maxLevel - 1) {
      return {
        ...treeNode,
        // 叶子节点折叠
        collapsed: true,
      };
    }
    if (paths.has(entryId)) {
      // 退出当前path
      paths.delete(entryId);
      return treeNode;
    }
    // 记录当前path
    paths.add(entryId);
    // 获取下一层子节点集合
    const renderChildren = getNextLevel(entryId, reverse);
    // 递归构建
    renderChildren.forEach(({ entryId: childId }) => {
      treeNode.children.push(
        _buildTreeByGraphId(childId, graph, reverse, currentLevel + 1),
      );
    });
    // 退出当前path
    paths.delete(entryId);
    return treeNode;
  };
  const { staticGraph } = useStaticStore.getState();
  const staticTree = _buildTreeByGraphId(entryId, staticGraph, reverse);
  useStaticStore.setState((s) => ({
    staticRoot: staticTree,
    staticRootVersion: (s as any).staticRootVersion + 1,
  }));
}

// 全局 idToCount，避免重复节点 id
const globalIdToCount = new Map<string, number>();

export const renderNextLevel = (entryId: string, reverse: boolean = false) => {
  const { staticGraph, staticRoot } = useStaticStore.getState();
  if (!staticRoot) return;

  // 这里遍历也只会遍历当前展示的树节点，并不会完全去遍历整颗依赖树
  const findNodeById = (
    node: StaticTreeNode,
    targetId: string,
  ): StaticTreeNode | null => {
    if (node.id === targetId) return node;
    for (const child of node.children) {
      const found = findNodeById(child, targetId);
      if (found) return found;
    }
    return null;
  };

  const targetNode = findNodeById(staticRoot, entryId);
  if (!targetNode || targetNode.children.length > 0) return;

  // 获取下一层子节点集合
  const renderChildren = getNextLevel(getEntryIdFromTreeId(entryId), reverse);

  // 为每个子节点构造 treeNode 并添加到目标节点
  renderChildren.forEach(({ entryId: childId }) => {
    // 记录出现次数
    globalIdToCount.set(childId, (globalIdToCount.get(childId) || 0) + 1);

    const childGraphNode = staticGraph.get(childId);
    const childTreeNode: StaticTreeNode = {
      ...childGraphNode,
      id: `${childId}-${globalIdToCount.get(childId)}`,
      paths: [...targetNode.paths, entryId], // 从根节点到当前节点的完整路径
      children: [],
      collapsed: true,
    };

    targetNode.children.push(childTreeNode);
  });
  // 更新 store 中的 staticRoot 并递增版本号
  useStaticStore.setState((s) => ({
    staticRoot,
    staticRootVersion: s.staticRootVersion + 1,
  }));
};

// 处理后端发送的原始图节点数据
export const handleGraphNodes = (graphNodes: StaticGraphNode[]) => {
  const graph = new Map<string, StaticGraphNode>();
  const gitChangeSet = new Set<string>();
  const importChangeSet = new Set<string>();
  // 临时记录节点的importers和dynamicImporters
  const idToImporters = new Map<
    string,
    { importers?: Set<string>; dynamicImporters?: Set<string> }
  >();
  graphNodes.forEach((graphNode) => {
    const relativeId = graphNode.relativeId;
    // 1. 记录改节点为引用的importers
    graphNode.importedIds.forEach((childId) => {
      // 已有则添加
      if (idToImporters.has(childId)) {
        idToImporters.get(childId).importers.add(relativeId);
        return;
      }
      // 没有则新建
      idToImporters.set(childId, {
        importers: new Set([relativeId]),
        dynamicImporters: new Set(),
      });
    });
    // 2. 记录改节点为引用的dynamicImporters
    graphNode.dynamicallyImportedIds.forEach((childId) => {
      if (idToImporters.has(childId)) {
        idToImporters.get(childId).dynamicImporters.add(relativeId);
        return;
      }
      // 没有则新建
      idToImporters.set(childId, {
        dynamicImporters: new Set([relativeId]),
        importers: new Set(),
      });
    });
    // 3. 构建新的树节点
    const staticTreeNode = {
      ...graphNode,
      // 复用1，2步骤记录的引入者
      importers: idToImporters.get(relativeId)?.importers || new Set(),
      dynamicImporters:
        idToImporters.get(relativeId)?.dynamicImporters || new Set(),
    };
    // 记录节点信息
    idToImporters.set(graphNode.relativeId, staticTreeNode);
    graph.set(graphNode.relativeId, staticTreeNode);
    // 4. 记录变更文件
    if (graphNode.isGitChange) {
      gitChangeSet.add(graphNode.relativeId);
    }
    // 5. 记录导入变更文件
    if (graphNode.isImportChange) {
      importChangeSet.add(graphNode.relativeId);
    }
  });
  return {
    graph,
    gitChangeSet,
    importChangeSet,
  };
};
