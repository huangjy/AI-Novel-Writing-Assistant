# Mermaid CLI 图表评审附件

技术方案或 E2E 阶段渲染前阅读。
CLI 生成 SVG/PNG/PDF，不直接生成 HTML。
本技能脚本调用 CLI、校验图片，将 SVG 与经过转义的源码打包成独立 HTML；
不改成手绘图，也不运行产品测试。标题、说明和图表自然语言使用中文。
纯 UI 例外只生成开发设计附件，不生成 `test-workflow` 的源码、HTML、图片或元数据；
下文两类附件与步骤三的要求，仅在相应图表适用时执行。

## 依赖与准备

需要 Python 3、Mermaid CLI（`mmdc`）、兼容 Node.js 和可用的 Puppeteer/Chromium。
检查 `mmdc --version` 或项目 `node_modules/.bin/mmdc`，记录使用版本。
不得在 `agents/openai.yaml` 中把 npm 依赖伪装成 MCP 工具依赖。

优先复用工具；缺少时解释前置条件并取得安装/网络许可。
优先项目或专用工具目录安装，不静默修改全局包或产品依赖。
获授权后可使用：

```sh
npm install --prefix <tool-directory> @mermaid-js/mermaid-cli@<chosen-version>
```

选择并记录实际版本。复用已有 Chrome 而非下载 Chromium 时，
通过 `--puppeteer-config` 传入 JSON：

```json
{"executablePath": "/path/to/installed/chrome"}
```

遵守浏览器启动权限，不禁用安全机制或沙箱来绕过权限问题。
渲染受阻时保留草稿并说明前置条件，不宣称成功。

## 附件合同

文件名用稳定 ASCII 小写短横线 feature 标识，例如 `local-import`；
使用 `--title` 指定中文展示名称。附件放在 spec 同目录：

```text
spec.md
local-import-dev-design.mmd
local-import-dev-design.html
local-import-dev-design.svg
local-import-dev-design.png
local-import-dev-design.render.json
local-import-test-workflow.mmd
local-import-test-workflow.html
local-import-test-workflow.svg
local-import-test-workflow.png
local-import-test-workflow.render.json
```

PNG 是可选内嵌预览；`.render.json` 保存源码/输出标识及文件归属。
spec 的可编辑 Mermaid 代码块与 `.mmd` 输入必须完全一致。
重复传递 `--source` 可将多图放在一个页面，并给图片编号。
可组合架构总览/时序图，或 E2E 主图/关键子流程，不为只出一张图而省略重要链路。

步骤二先渲染并展示开发设计页面，再请求确认；
步骤三先渲染并展示测试流程页面，再请求确认。
讨论改变图时同步更新附件。最终整理阶段嵌入链接/图片，
不把所有可视化评审延后到用户已经确认两阶段之后。

## 渲染命令

脚本相对技能安装目录定位，不假设位于项目目录：

```sh
python3 <skill-directory>/scripts/render_diagrams.py \
  --feature local-import --kind dev-design --title "本地资料导入" \
  --source <spec-directory>/local-import-dev-design.mmd \
  --output-dir <spec-directory> --png

python3 <skill-directory>/scripts/render_diagrams.py \
  --feature local-import --kind test-workflow --title "本地资料导入" \
  --source <spec-directory>/local-import-test-workflow.mmd \
  --output-dir <spec-directory> --png
```

仅需要 HTML 链接时省略 `--png`。
`--mmdc <executable-path>` 指定本地 CLI，`--puppeteer-config <json-path>` 指定浏览器配置。
脚本使用严格 Mermaid 设置和纯 SVG 文本标签，HTML 不依赖网络/CDN，
保留源码以便核查。规划图不引入远程字体、图标、图片或 link/click 指令。

脚本在发布前暂存全部渲染结果，拒绝结构为空的 SVG 及不完整/损坏 PNG。
生成并输出 `.render.json`，记录工具版本、源码指纹及各附件归属哈希。
已有目标必须与其自身记录一致；新名字冲突或用户已修改的生成文件不覆盖。
保留元数据。发布失败会恢复原附件，恢复也失败时报告并保留恢复副本。
这只是渲染证据，不是产品行为证明；结构校验不代替浏览器/视觉检查。
JSON 字段及文件标识维持原样，不翻译为另一套协议。

## 嵌入与检查

技术方案章节：

```markdown
[审阅架构设计](./local-import-dev-design.html)
![架构图预览](./local-import-dev-design.png)
```

E2E 章节：

```markdown
[审阅 E2E 测试流程](./local-import-test-workflow.html)
![E2E 流程预览](./local-import-test-workflow.png)
```

始终包含对应 HTML 链接。PNG 可选，但只能引用实际生成的图片。
多图可插入带编号图片或链接包含全部图的页面。
逐节点标准写在 spec 的邻近内容，不藏在图片里。

在可用浏览器/预览中打开页面，检查非空、中文文字可读、数据/调用方向、
分支标签、裁切及窄屏水平滚动，必要时截图。
核对相对链接和源码当前哈希。源码改变后只重渲染受影响页面/图片及更新链接，
不把过期图当成当前内容。

整个评审与交付期间，将 `.mmd`、HTML、元数据和引用图片与 spec 一起保存。
不能完成渲染或目视检查时，说明精确限制，只有用户明确接受限制后才称视觉评审义务完成；
不得静默降级为纯文本 spec。
