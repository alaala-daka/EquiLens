# 工作台界面

数据库保存与会话隔离由[数据库规格](04-database-deployment.md)扩展；页面源码入口使用
[官方 Button asChild 链接示例](https://ui.shadcn.com/docs/components/radix/button#as-child)，保留 `link` 变体，不增加自定义样式。

## 信息架构与来源

顶层以“文档 / 规范库”两个页签组织，替代原来的四业务导航。点击文档后进入“编辑器 + 右侧 Agent 会话”工作区。
用户于 2026-10-22 确认此方向，替代旧布局 A；合同审查、材料核验、款项分析、文书撰写保留为业务能力，不再对应顶层页面。

使用官方 shadcn/ui Radix / Nova 中性色预设，以及官方
[Tabs](https://ui.shadcn.com/docs/components/tabs)、[Table](https://ui.shadcn.com/docs/components/table)、
[Empty](https://ui.shadcn.com/docs/components/empty)、[Textarea](https://ui.shadcn.com/docs/components/textarea)、
[Input Group](https://ui.shadcn.com/docs/components/input-group)、
[Resizable](https://ui.shadcn.com/docs/components/resizable)、
[Alert Dialog](https://ui.shadcn.com/docs/components/radix/alert-dialog)示例。
保留官方组件的结构、变体、间距和交互，不沿用旧 Sidebar Block 的演示导航。

## 文档与规范库

- `/` 默认显示文档页签。初始文档列表为空，不填充虚构项目、合同或模型结果。
- “新建文档”创建真正空白 DOCX 并进入编辑器；“导入 Word”校验后保存独立原件。
- 文档列表从服务端文档接口读取，点击标题打开已保存版本，不显示开发状态或本地草稿标记。
- 规范库显示空状态，本步不支持上传、编辑或发布规范，不把未经核对内容列为可用依据。
- 文档版本、来源、保存与导入边界由 Word 规格负责，不读取私有服务端资源。
- 返回列表前处理未保存更改；刷新后可打开成功保存的版本，不添加编辑器底部说明。

## 编辑器与 Agent 会话

Word 引擎、文件保存和 DOCX 往返行为由 [Word 文档编辑规格](03-word-editing.md) 负责。

- 桌面左侧为 Word 画布及引擎官方工具栏，右侧为当前文档的 Agent 会话区域，采用官方可调整面板。
- 标题与正文可编辑；应用外壳提供保存、导出及未保存更改对话框，不重做 Word Ribbon。
- 会话输入按文档独立保存，不混用其他文档的上下文。
- Agent 区域允许编辑待发送内容，但发送按钮禁用；无网络调用、模拟回复或虚假进度，不展示开发状态标签。
- 后续 Agent 接入必须遵守产品中的权限、事实、来源和版本契约；会话 UI 不授予任意工具执行或覆盖人工内容的权限。
- 窄屏将编辑器与会话区域纵向排列，保留键盘焦点、面板调整和可读的正文输入。

## 样式与验证

界面文案正式、严肃、简洁。删除“本地预览”“本地草稿”、编辑器底部保存说明和未完成功能描述。
保留文档名称、操作标签及“暂无文档”“暂无规范”“暂无会话”等简洁空状态，不添加虚构成功状态。

仅对全屏编辑区域的尺寸、边框衔接及窄屏排列做必要适配，保持官方中性色和组件样式。
系统字体替代远程下载字体；响应式检测使用 `useSyncExternalStore` 和 768px 断点。

验证两个页签、新建/导入/打开文档、标题/正文输入、保存与离开选择、文档隔离、Agent 禁止发送和窄屏布局。
执行代码、类型、构建、健康接口及静态资源检查。这些是本地界面验证，不计为业务 AC 通过。
当前不提供账号、GaussDB 持久化、规范发布、模型处理、业务复核或正式业务成果导出。
