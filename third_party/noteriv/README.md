# Noteriv 参考说明

项目的技术栈、桌面界面、文件管理和编辑器参考了 Noteriv。阶段 1 实际移植并适配了以下源代码：

- `desktop/src/components/noteriv-markdown/`：编辑器主题、渲染器、注册机制及实时渲染逻辑的子集；根据本项目范围裁剪，并调整了只读状态的交互。
- `desktop/src/components/noteriv-formatting-toolbar.tsx`：格式工具栏，按当前功能及中文界面调整。
- `desktop/src/lib/replace-document.ts` 和 `desktop/src/lib/sanitize-html.ts`：文档替换与渲染 HTML 的安全处理。
- `desktop/src/components/markdown-editor.tsx` 和桌面样式：参考并适配 Noteriv 的 `Editor.tsx`、`SourceEditor.tsx` 及界面样式。
- `desktop/src/components/noteriv-markdown/rich-rendering.ts`：参考 Noteriv 的 `markdown/math.ts` 和 `markdown/mermaid.ts`，按本项目的光标交互和安全限制重做公式及图表渲染。
- `desktop/src/components/noteriv-markdown/wikilinks.ts`：参考其 Wiki 链接交互和补全实现，按本项目的歧义处理及文件规则调整。
- `desktop/src/components/knowledge-sidebar.tsx` 和 `desktop/src/lib/calendar.ts`：参考搜索、反向链接及日历的界面和日期处理，适配本地知识库与双主题。
- `desktop/src/components/workspace-tabs.tsx`：参考 `TitleBar.tsx` 的标签排列、激活与未保存标记、关闭按钮和中键关闭交互；编辑会话、自动保存和草稿保护按本项目实现。
- `desktop/src/components/quick-palette.tsx`、`image-viewer.tsx`：参考 `QuickOpen.tsx`、`CommandPalette.tsx`、`ImageViewer.tsx` 的筛选、键盘选择和图片显示比例；使用本项目共享适配器与编辑会话。图片粘贴/文件拖入、代码块复制也参考其编辑器交互，按本项目附件路径、上传限制和草稿保护实现，未引入其云同步模块。
- 阶段 4 入口收尾继续参考 `Sidebar.tsx` 的空状态新建入口和 `CommandPalette.tsx` 的操作名称/快捷键展示；Noto 在现有组件中统一三类文件入口、按文件的保存反馈和快捷键。草稿迟到操作隔离、重新读取及关闭保护沿本项目文件会话实现，没有采用参考项目的直接文件写入流程。
- `desktop/src/components/file-tree.tsx`、`resize-handle.tsx`、`settings-dialog.tsx` 和 `desktop/src/lib/workspace-state.ts`：参考 `Sidebar.tsx` 的目录折叠、行内改名与拖动调宽，`TitleBar.tsx` 的固定/排序/标签菜单，以及工作区状态、`SettingsModal.tsx` 和 `settings.ts` 的基础设置；重新接入本项目的安全路径调整、共享运行时和独立草稿流程。
- `desktop/src/components/outline-panel.tsx`、`desktop/src/lib/document-info.ts` 与底部统计：参考 `OutlinePanel.tsx` 和桌面状态栏的布局与定位交互；改用 Markdown 语法树识别 ATX/setext 标题和层级，适配本项目的多标签编辑器与阅读预览。
- `desktop/src/components/knowledge-graph-view.tsx` 和图谱样式：参考并适配 `GraphView.tsx` 的力布局、Canvas 绘制、相机与命中测试、缩放平移及拖动交互。笔记读取、链接解析、图谱数据、规模保护和标签/编辑生命周期改用本项目共享实现，两端不依赖其桌面文件 API。
- `desktop/src/components/task-board.tsx` 与看板样式：参考并适配 `BoardView.tsx` 的横向列布局、紧凑卡片、列内新增、约 4px Pointer 拖动阈值、浮层及落点提示；参考 `board-utils.ts` 的派生与移动纯函数思路。Noto 使用现有任务 Markdown、稳定 ID、原文补丁、统一完成状态和共享详情/保存队列，重做取消及生命周期保护，未采用其整篇序列化、临时随机卡片身份或自定义列格式。
- `desktop/src/lib/export-styles.ts`：参考并适配 `pdf-export.ts` / `publish.ts` 的单页结构和打印布局。导出管线、静态预览及命令入口参考其导出流程，改用 Noto 现有 remark/rehype、共享运行时和受控原生保存；保留中文文件名、图片/字体内嵌与草稿保护，未移植其正则 Markdown 转换、桌面注入 API 或固定延时重复打印路径。
- `desktop/src/components/knowledge-canvas.tsx`、`desktop/src/lib/canvas-document.ts` 与画布样式：参考并适配 `Canvas.tsx`、`canvas-utils.ts`、`canvas.css` 的 DOM 卡片/SVG 曲线、锚点、坐标/缩放/适应视图、卡片拖动/改尺寸、分组布局、便签外观、缩略图及画布笔迹。便签和笔迹使用带 Noto 扩展字段的文本节点，缩略图支持定位；按 JSON Canvas 1.0 文本/文件/分组子集重做严格解析、字段保留、有限历史、Pointer 取消、可见预览及多实例隔离。文件读取/保存、草稿、附件、路径迁移与资源缓存使用 Noto 共享会话和受控接口。未采用其直接读写/定时保存、非法 JSON 置空、绝对图片路径、`drawing` 专有节点类型或桌面注入对象，不宣称完整格式兼容。
- `desktop/src/lib/canvas-eraser.ts` 将画布笔迹转换为世界坐标，复用本项目白板的线段裁切实现；恢复画布节点的样式、未知字段与连接，并接入原有画布历史和保存会话。
- `desktop/src/components/drawing-whiteboard.tsx`、`desktop/src/lib/drawing-geometry.ts`、`drawing-document.ts`、`drawing-svg.ts` 与白板样式：参考并适配 `DrawingEditor.tsx`、`drawing-utils.ts` 的 Canvas 2D 绘制、工具排列、坐标/命中、形状与笔迹、SVG 派生。重接 Noto 的受控文件会话、版本/草稿、多标签及迁移；补严格自有格式、局部点坐标、真正历史、Pointer 取消、稳定多行输入、可访问操作及有界位图。局部擦除依据笔迹线段和橡皮扫过区域独立实现，保留片段元数据并合为一步撤销；可选专注模式不重建会话。未采用其组件自读自写、pop 式撤销或宽松格式兼容；SVG 改为安全基础矢量、动态笔宽/颜色/文字与完整边界，不宣称完整兼容其文件或 Excalidraw。
- Wiki 标题引用：参考 `wiki-link-utils.ts`、`toc-utils.ts`、`wikilink-completion.ts` 与 `page.tsx` 的文件优先、光标补全/待定位流程，扩展既有移植的 `noteriv-markdown/wikilinks.ts`。Noto 用 `wiki-target.ts`、`wiki-syntax.ts`、`heading-ids.ts`、`heading-index.ts` 重接统一 Unicode/重名/脚注 ID、明确来源、原会话/草稿门槛及代次取消；只读路径经共享 API，迁移只改文件跨度。未采用参考代码的 ASCII/正则标题定位、最后一个 `#` 猜标题、固定 3 秒超时、Electron/桌面注入对象或全局事件缓存。
- 搜索命中定位：`desktop/src/components/search-panel.tsx` 参考 `VaultSearch.tsx` 的 200 ms 防抖、紧凑文件/行/摘要、React mark 和键盘选择；参考 `commands_fs.rs/fs_search_in_files` 的分行/有界结果思路。匹配范围、共享快照、Unicode/换行映射、上下文重定位、阅读投影及临时装饰由 Noto 实现，接入既有会话和导航保护；未移植其平台注入 API、绝对路径遍历、仅返回行文本、首个小写下标高亮或选择后关闭弹层。
- 笔记与标题嵌入：参考 Noteriv `embed-utils.ts` 和编辑器嵌入的章节、只读卡片与来源入口；使用 Noto 的 Markdown AST、路径解析、共享运行时和会话/草稿保护重新实现，不移植 Electron API、全局缓存或正则截断。
- 工作区和笔记主界面美化：继续参考 `TitleBar.tsx`、`Sidebar.tsx`、`OutlinePanel.tsx` 与主题样式的紧凑布局；新增的工作区 SVG 图标为本项目绘制，编辑会话、文件操作与双端适配仍沿用 Noto 实现。
- 多主题和图形工作区：`desktop/src/lib/themes.ts` 参考 Noteriv `theme-utils.ts` 的 Catppuccin、Nord、GitHub Dark、Solarized Light 色表，并为对比度调整部分颜色；主题卡片、图谱配色/图例、画布及白板工具参考其 `ThemePicker.tsx`、`GraphView.tsx`、`Canvas.tsx`、`DrawingEditor.tsx`。Noto 保留自己的工作区、用户文件颜色和共享保存流程；未接入参考项目社区主题服务。
- `desktop/src/app/globals.css`：深色和浅色主题配色分别参考其 Catppuccin Mocha 与 Catppuccin Latte 内置主题。

随此保留其 [MIT 许可证和版权声明](LICENSE)；该文件不决定本项目自身的许可证。导出另使用锁定依赖 KaTeX 的 CSS 与 woff2 字体，构建脚本从安装包读取资源及完整 LICENSE，并将版权和许可文本放入每份导出 HTML 的样式注释中；这些不是 Noteriv 的字体资源。

参考基线见 [Noteriv 源码](https://github.com/thejacedev/Noteriv/tree/00b8a9593e99c47f5ead22f0a8e91852f66b1e6a)。
