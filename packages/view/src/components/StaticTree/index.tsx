import { useEffect, useRef } from "react";
import * as G6 from "@antv/g6";
import { useStaticStore, useStore } from "@/contexts";
import { textOverflow } from "../../utils/textOverflow";
import { shallow } from "zustand/shallow";
import { State, COLOR } from "./constant";
import {
  extractFileName,
  getNextLevel,
  getEntryIdFromTreeId,
  renderNextLevel,
} from "@/pages/StaticAnalyzePage/utils";

export default function StaticTree() {
  const {
    staticRoot,
    staticRootVersion,
    setHighlightedNodeId,
    highlightedNodeId,
    activeTab,
  } = useStaticStore(
    (state) => ({
      staticRoot: state.staticRoot,
      staticRootVersion: state.staticRootVersion,
      setStaticRoot: state.setStaticRoot,
      highlightedNodeId: state.highlightedNodeId,
      setHighlightedNodeId: state.setHighlightedNodeId,
      activeTab: state.activeTab,
    }),
    shallow,
  );
  const { theme } = useStore(
    (state) => ({
      theme: state.theme,
    }),
    shallow,
  );
  const graphRef = useRef<G6.TreeGraph>();
  const lastMatrixRef = useRef<number[] | null>(null);
  const highlightedNodeIdRef = useRef(highlightedNodeId);
  const containerRef = useRef<HTMLDivElement>();

  useEffect(() => {
    if (!graphRef.current) return;
    const prevMatrix =
      lastMatrixRef.current ||
      graphRef.current.getGroup().getMatrix()?.slice?.();

    G6RegisterNode();
    // 生成新的nodeStateStyles配置
    const newNodeStateStyles = {
      highlight: {
        stroke: theme === "dark" ? COLOR.DARK.HIGHLIGHT : COLOR.LIGHT.HIGHLIGHT,
        lineWidth: 2,
      },
      gitChanged: {
        stroke: theme === "dark" ? COLOR.DARK.GIT : COLOR.LIGHT.GIT,
        lineWidth: 2,
      },
      importChanged: {
        stroke: theme === "dark" ? COLOR.DARK.IMPORT : COLOR.LIGHT.IMPORT,
        lineWidth: 2,
      },
    };

    // 批量绘制：更新样式 + changeData 强制重绘 + 恢复矩阵
    graphRef.current.setAutoPaint(false);
    graphRef.current.set("nodeStateStyles", newNodeStateStyles);
    // 重新应用状态，确保状态色也更新
    graphRef.current.getNodes().forEach((node) => {
      const states = node.getStates();
      states.forEach((state) => {
        graphRef.current.setItemState(node, state, false);
        graphRef.current.setItemState(node, state, true);
      });
    });
    // 使用 changeData 以更新自定义节点/边的颜色
    graphRef.current.changeData(staticRoot);

    // 恢复视图矩阵，保持位置与缩放
    if (prevMatrix) graphRef.current.getGroup().setMatrix(prevMatrix);
    graphRef.current.setAutoPaint(true);
    graphRef.current.paint();
  }, [theme]);

  //注册自定节点和边
  function G6RegisterNode() {
    // 注册module节点
    G6.registerNode(
      "tree-node",
      {
        drawShape: function drawShape(cfg, group) {
          const rect = group.addShape("rect", {
            attrs: {
              x: 0,
              y: 0,
              width: 100,
              height: 20,
              fill: "transparent", // 添加透明填充色确保点击区域覆盖整个矩形
              stroke: theme === "dark" ? COLOR.DARK.SIMPLE : COLOR.LIGHT.SIMPLE,
              radius: 5,
            },
            // must be assigned in G6 3.3 and later versions. it can be any string you want, but should be unique in a custom item type
            name: "rect-shape",
          });
          const content = textOverflow(
            extractFileName(cfg.relativeId as string),
            100,
          );
          const text = group.addShape("text", {
            attrs: {
              text: content,
              fill: theme === "dark" ? "#ffffffd9" : "#000000e0",
            },
            // must be assigned in G6 3.3 and later versions. it can be any string you want, but should be unique in a custom item type
            name: "text-shape",
          });
          const tbox = text.getBBox();
          const rbox = rect.getBBox();
          // const hasChildren =
          //   Array.isArray(cfg.children) && cfg.children.length > 0;
          const id = getEntryIdFromTreeId(cfg.id as string);
          const hasChildren = getNextLevel(id, activeTab === "git").size > 0;
          text.attr({
            x: (rbox.width - tbox.width) / 2,
            y: (rbox.height + tbox.height) / 2,
          });
          if (hasChildren) {
            group.addShape("marker", {
              attrs: {
                x: rbox.width + 8,
                y: 0,
                r: 6,
                symbol: cfg.collapsed ? G6.Marker.expand : G6.Marker.collapse,
                stroke:
                  theme === "dark" ? COLOR.DARK.SIMPLE : COLOR.LIGHT.SIMPLE,
                lineWidth: 1,
              },
              // must be assigned in G6 3.3 and later versions. it can be any string you want, but should be unique in a custom item type
              name: "collapse-icon",
            });
          }
          return rect;
        },
        update: (cfg, item) => {
          const group = item.getContainer();
          const icon = group.find((e) => e.get("name") === "collapse-icon");
          icon?.attr(
            "symbol",
            cfg.collapsed ? G6.Marker.expand : G6.Marker.collapse,
          );
        },
      },
      "single-node",
    );
    // 注册线节点
    G6.registerEdge("custom-polyline", {
      draw(cfg, group) {
        const startPoint = cfg.startPoint;
        const endPoint = cfg.endPoint;

        let strokeColor =
          theme === "dark" ? COLOR.DARK.SIMPLE : COLOR.LIGHT.SIMPLE;
        const edge = group.get("item");
        if (edge.hasState(State.HIGHLIGHTE)) {
          strokeColor =
            theme === "dark" ? COLOR.DARK.HIGHLIGHT : COLOR.LIGHT.HIGHLIGHT;
        } else if (edge.hasState(State.GIT)) {
          strokeColor = theme === "dark" ? COLOR.DARK.GIT : COLOR.LIGHT.GIT;
        } else if (edge.hasState(State.IMPORT)) {
          strokeColor =
            theme === "dark" ? COLOR.DARK.IMPORT : COLOR.LIGHT.IMPORT;
        }
        const shape = group.addShape("path", {
          attrs: {
            stroke: strokeColor,
            path: [
              ["M", startPoint.x, startPoint.y],
              ["L", endPoint.x / 3 + (2 / 3) * startPoint.x, startPoint.y], // 三分之一处
              ["L", endPoint.x / 3 + (2 / 3) * startPoint.x, endPoint.y], // 三分之二处
              ["L", endPoint.x, endPoint.y],
            ],
            endArrow: true,
          },
          // 在 G6 3.3 及之后的版本中，必须指定 name，可以是任意字符串，但需要在同一个自定义元素类型中保持唯一性
          name: "custom-polyline-path",
        });
        return shape;
      },
    });
    // 注册循环线节点
    G6.registerEdge("circle-line", {
      draw(cfg, group) {
        const { startPoint, endPoint } = cfg;

        let strokeColor = "red";
        const edge = group.get("item");
        if (edge.hasState(State.HIGHLIGHTE)) {
          strokeColor =
            theme === "dark" ? COLOR.DARK.HIGHLIGHT : COLOR.LIGHT.HIGHLIGHT;
        } else if (edge.hasState(State.GIT)) {
          strokeColor = theme === "dark" ? COLOR.DARK.GIT : COLOR.LIGHT.GIT;
        } else if (edge.hasState(State.IMPORT)) {
          strokeColor =
            theme === "dark" ? COLOR.DARK.IMPORT : COLOR.LIGHT.IMPORT;
        }
        const shape = group.addShape("line", {
          attrs: {
            x1: startPoint.x,
            y1: startPoint.y,
            x2: endPoint.x,
            y2: endPoint.y,
            stroke: strokeColor,
            lineWidth: 2, // 线宽
            // endArrow: true,
          },
          name: "circle-line-path",
        });
        return shape;
      },
    });
  }

  useEffect(() => {
    //清除所有item的高亮状态
    highlightedNodeIdRef.current = highlightedNodeId;
    if (!highlightedNodeId || !graphRef.current) return;
    const nodes = graphRef.current.getNodes();
    const edges = graphRef.current.getEdges();
    nodes.forEach((node) => {
      graphRef.current.setItemState(node, State.HIGHLIGHTE, false);
      graphRef.current.refreshItem(node);
    });
    edges.forEach((edge) => {
      graphRef.current.setItemState(edge, State.HIGHLIGHTE, false);
      graphRef.current.refreshItem(edge);
    });
    //高亮节点
    const node = graphRef.current.findById(highlightedNodeId);
    const relatedEdges = (node as G6.Node).getEdges();
    if (node) {
      graphRef.current.setItemState(node, State.HIGHLIGHTE, true);
      graphRef.current.refreshItem(node);
      relatedEdges.forEach((edge) => {
        graphRef.current.setItemState(edge, State.HIGHLIGHTE, true);
        graphRef.current.refreshItem(edge);
      });
    }
  }, [highlightedNodeId]);

  useEffect(() => {
    if (!staticRoot || !containerRef.current) return;
    // hover
    const tooltip = new G6.Tooltip({
      offsetX: 10,
      offsetY: 20,
      getContent(e) {
        const model = e.item._cfg.model;
        const outDiv = document.createElement("div");
        outDiv.style.width = "fit-content";
        outDiv.innerHTML = model.relativeId as string;
        return outDiv;
      },
      itemTypes: ["node"],
    });

    //注册自定节点和边
    G6RegisterNode();

    const width = containerRef.current.scrollWidth;
    const height = containerRef.current.scrollHeight || 500;
    const graph = new G6.TreeGraph({
      container: "container",
      width,
      height,
      // fitView: true,
      animate: false,
      modes: {
        default: ["drag-canvas", "zoom-canvas"],
      },
      nodeStateStyles: {
        highlight: {
          stroke:
            theme === "dark" ? COLOR.DARK.HIGHLIGHT : COLOR.LIGHT.HIGHLIGHT,
          lineWidth: 2,
        },
        gitChanged: {
          stroke: theme === "dark" ? COLOR.DARK.GIT : COLOR.LIGHT.GIT,
          lineWidth: 2,
        },
        importChanged: {
          stroke: theme === "dark" ? COLOR.DARK.IMPORT : COLOR.LIGHT.IMPORT,
          lineWidth: 2,
        },
      },
      defaultNode: {
        type: "tree-node",
        anchorPoints: [
          [0, 0.5],
          [1, 0.5],
        ],
      },
      defaultEdge: {
        type: "custom-polyline",
      },
      layout: {
        type: "compactBox",
        direction: "LR",
        getId: function getId(d) {
          return d.id;
        },
        getVGap: function getVGap() {
          return 0;
        },
        getHGap: function getHGap() {
          return 80;
        },
      },
      fitViewPadding: [50, 450, 50, 50],
      plugins: [tooltip],
    });

    graphRef.current = graph;
    graph.data(staticRoot);
    graph.render();
    // 若已有历史矩阵，则优先恢复；否则首次居中
    if (lastMatrixRef.current) {
      graph.getGroup().setMatrix(lastMatrixRef.current);
    } else {
      // graph.fitView();
      graph.translate(graph.getWidth() / 2, graph.getHeight() / 2);
      lastMatrixRef.current = graph.getGroup().getMatrix()?.slice?.() || null;
    }
    graph.paint();

    // 监听视口相关事件，实时记录矩阵
    const saveMatrix = () => {
      const m = graph.getGroup().getMatrix();
      if (m) lastMatrixRef.current = m.slice();
    };
    graph.on("viewportchange", saveMatrix as unknown as () => void);
    graph.on("afterzoom", saveMatrix as unknown as () => void);
    graph.on("dragend", saveMatrix as unknown as () => void);

    //注册事件 --> 折叠与展开 高亮节点
    graph.on("node:click", (e) => {
      if (e.target.cfg.name === "collapse-icon") {
        clearHighlight();
        const prevMatrix =
          lastMatrixRef.current || graph.getGroup().getMatrix()?.slice?.();
        const item = e.item as G6.Node;
        const data = item.get("model") as { id: string; collapsed?: boolean };
        const collapsed = !data.collapsed;
        // 展开前拉取下一层
        if (!collapsed) {
          const reverse = activeTab === "git";
          renderNextLevel(data.id as string, reverse);
        }
        graph.setAutoPaint(false);
        graph.updateItem(item, { collapsed });
        (item.get("model") as { collapsed?: boolean }).collapsed = collapsed;
        graph.layout();
        if (prevMatrix) graph.getGroup().setMatrix(prevMatrix);
        // 更新缓存矩阵
        const m = graph.getGroup().getMatrix();
        if (m) lastMatrixRef.current = m.slice();
        graph.setAutoPaint(true);
        graph.paint();
        return;
      } else {
        e.stopPropagation();
        clearHighlight();
        setHighlightedNodeId(e.item._cfg.id);
      }
    });
    return () => {
      graph.destroy();
      graphRef.current = null;
    };
  }, [staticRootVersion]);

  const clearHighlight = () => {
    setHighlightedNodeId("");
  };

  return (
    <div
      id="container"
      ref={containerRef}
      className="w-full h-screen overflow-hidden"
    ></div>
  );
}
