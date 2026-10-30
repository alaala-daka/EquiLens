# 第二轮 C3 项目文档前端验证

2026-10-29。本记录汇总实现和定向检查；浏览器联验由独立执行者进行，结果由 Lead 汇总到独立浏览器记录。单元检查不替代浏览器、Word 往返或业务 AC 验收。

## 最终实现

项目工作区新增材料列表、授权上传 Sheet、解析状态和材料预览，接入项目 DOCX 打开、保存、冲突复制和指定版本下载。adapter 保留操作标识、来源与父版本，读取明确保存版本字节；拒绝旧项目迟到响应，复制内容响应丢失后重试保留原 operationId。

初始 viewer 不挂编辑引擎，可读取和下载指定保存版本；独立 canEdit 检查拒绝预检、保存和复制，服务端仍逐请求校验权限。viewer 身份本身不暂停读取请求。

已打开编辑器撤权后保留同一组件、引擎、正文、标题、备注和 dirty/registry 状态。外壳 inert 冻结交互，WordCanvas 同时调用 setDocumentMode("viewing") 和 setEditable(false, false)。已核对安装包 SuperDoc.d.ts 与打包源码；加载完成及序列化结束都不会恢复撤权后的编辑权限。

ProjectHost 刷新降权、移除当前项目、401 或网络错误不再重建工作区。key 仅为项目 ID；保留项目时即使 host 为 anonymous 也不进入匿名工作台。网络错误暂停请求，成功刷新可解除临时暂停，不写入永久撤权状态；引擎不自动恢复编辑或重开丢弃内容。真正切换前执行 registry.saveAll，失败留在原项目。恢复授权交互以独立浏览器记录为准。

## 官方来源与适配

实际读取 [官方 Blocks 及内嵌 dashboard-01/sidebar-07 源码](https://ui.shadcn.com/blocks) 和 [官方 Sheet demo 完整源码](https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/examples/sheet-demo.tsx)。工作台按既有契约保留文档/标准页签，不引入仪表盘图表；上传使用 Sheet/Header/Title 与已有表单组件。授权字段来自业务契约，省略示例说明段落符合仓库产品文案要求。权限修复未新增样式。

来源为审查修订阶段补读，不宣称初次 UI 实施前已检查。布局、响应式和真实交互应结合独立浏览器记录审查。

## 实际验证

- 路由策略和 documents-client 定向测试：15/15 通过，覆盖实际路由使用的匿名分支策略、刷新保留项目、保存失败保留选择以及 viewer 读写权限分离。
- adapter、engine-access、unsaved-registry 组合此前运行 20/20 通过。fake engine 验证只读模式、禁止编辑和同一内容对象保留；registry 验证保存失败保留登记。
- 最新 pnpm check：exit 0，ESLint、Next route typegen、TypeScript 全通过。

这些是纯状态、adapter、fake engine 和 registry 检查，非 React/浏览器挂载生命周期实测。本报告不宣称全量测试、构建、容器、真实 OBS/GaussDB 通过；独立浏览器联验正在汇总。

## 修复历史

已修复复制测试 fixture 缺 source、撤权卸载丢内容、仅 inert 未切引擎只读、host 刷新重建、401 退回匿名工作台和 viewer 读取过度阻断。早期 C2 类型错误及 fixture 错误不属于最新检查状态；早期“未修改 UI”只针对单次 adapter 检查，不能描述整个 C3 包，本报告已纠正。
