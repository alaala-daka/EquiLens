# Third-party notices

## AI SDK and schema validation

- `ai@7.0.148` and `@ai-sdk/openai-compatible@3.0.75`: Apache-2.0,
  upstream https://github.com/vercel/ai . Full package license texts are retained in
  `licenses/ai-sdk-Apache-2.0.txt` and `licenses/ai-sdk-openai-compatible-Apache-2.0.txt`.
- `zod@4.6.7`: MIT, upstream https://github.com/colinhacks/zod . Full package notice
  is retained in `licenses/zod-MIT.txt`.

The packages are used without modification. The standalone build includes these notices and license files.

## SuperDoc

The browser Word editor uses unmodified `superdoc@1.47.2`, published by
Harbour Enterprises Inc., under AGPL-3.0. The complete license is retained in
`licenses/superdoc-AGPL-3.0.txt` and included in the standalone runtime.
Upstream source: https://github.com/superdoc/docx-editor
Exact published package: https://www.npmjs.com/package/superdoc/v/1.47.2

This integration does not use `@superdoc/docx-engine` or the v2 React wrapper.
EquiLens is licensed under AGPL-3.0-only; see `LICENSE`. Its corresponding source,
build scripts and locked dependency versions are published at
https://github.com/alaala-daka/EquiLens . The hosted `/source` link identifies the
deployment commit through `SOURCE_COMMIT`. Preserve this notice and the license
texts when redistributing the application.

## GaussDB driver

`gaussdb-node@0.2.2` is MIT licensed. Its full notice is retained in
`licenses/gaussdb-node-MIT.txt`. Upstream source:
https://github.com/huaweicloud-samples/database-gaussdb-node .

## DOCX package validation

- `fflate@0.8.3`: MIT, https://github.com/101arrowz/fflate
- `fast-xml-parser@5.11.2`: MIT, https://github.com/NaturalIntelligence/fast-xml-parser

Their package licenses are retained by pnpm; their full notice texts are included
in `licenses/` for standalone builds.

## shadcn/ui

UI components in `src/components/ui/`, the mobile hook, and the workbench's
component compositions originate from [shadcn/ui](https://github.com/shadcn-ui/ui).
Official sources and adaptation boundaries are recorded in `spec/02-workbench-ui.md`.

MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
