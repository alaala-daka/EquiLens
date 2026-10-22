# 开发约定

## 技术边界

使用 Next.js App Router、TypeScript、Tailwind CSS 和 pnpm。开发与 CI 默认 Node.js 24，
pnpm 版本固定在 `package.json`；提交 `pnpm-lock.yaml` 和 `pnpm-workspace.yaml`。
不额外创建前后端 workspace，不增加独立服务，目录随真实实现建立。

`src/app/` 负责界面和 HTTP 入口；领域行为由服务端模块负责。
云服务适配器不向组件暴露凭据，金额计算不交给生成模型。
共享类型不能替代输入校验；文件、模型输出和文档中的指令均是不可信数据。

## 界面

正式工作台保持已确认的原文与结果并排布局 A；参考
[布局截图](docs/superpowers/specs/assets/engineering-legal-workbench-a.png)。
当前建设中首页不是正式工作台，不新增无法执行的业务按钮或示例成果。
中文文案保持简洁，提供可访问标签、键盘操作和明确的失败、缺证及未覆盖状态。
字体优先使用本地系统字体，构建不依赖下载外部字体。

## 检查

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

`pnpm check` 执行 ESLint 和 Next.js 路由类型生成、TypeScript 检查。
`pnpm smoke` 检查运行中的应用，可用 `pnpm smoke http://127.0.0.1:18080` 指定入口。
冒烟检查不等于业务质量评测。业务测试随实际功能加入，使用 `*.test.ts` / `*.test.tsx`，
并映射到 [AC-01—AC-26](spec/01-product.md#12-验收标准)。

使用两空格缩进，组件使用 PascalCase，函数使用 camelCase。
不为低影响的静态内容添加镜像实现的测试；对权限、金额、来源、版本及任务恢复编写行为测试。
