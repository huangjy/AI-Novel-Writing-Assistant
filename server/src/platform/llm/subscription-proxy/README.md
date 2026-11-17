# 订阅内部传输

SDK 使用 `fetchFor(provider, model)` 发送 OpenAI-compatible 请求，不挂载 HTTP 推理路由，
也不监听独立端口。固定逻辑 origin 只由注入的 fetch 消费，不能作为实际 DNS 目标。

`createCopilotRequestHeaders()` 统一维护 Copilot 兼容客户端身份，包括编辑器/插件版本、
集成标识、User-Agent 和 API 版本。授权适配器与推理传输必须共用，不能只在模型目录补头：
有效 Bearer token 不代表缺少这些协议头的请求会被 Copilot 接受。它们是上游协议合同，
不是本产品版本；升级兼容身份时需同时验证目录、Chat 和 Responses，每次发送生成独立请求标识。
GitHub OAuth/REST 请求显式使用 `github` 目标的 `2022-11-28` 版本，
Copilot 模型目录和推理使用 `copilot` 目标的 `2025-10-01` 版本。
不得把 Copilot 版本头直接复用于 GitHub `/user`，否则设备码已获批准也无法保存账户。

Copilot Responses 在物理发送前省略通用 SDK 带入的 `temperature`，不按模型名称猜测兼容性。
此适配不改变 Chat 参数、模型、输出预算、工具或结构化输出合同，也不通过收到 400 后重放请求来探测。

平台通过 `SubscriptionPort` 获取有效凭据、模型能力和绑定校验，不依赖授权业务模块内部实现。
`modules/authorization` 的组合入口提供端口实现。每次发送重新检查绑定和凭据代次；
账户失效通知同时取消队列与在途流，已发往上游的请求不承诺撤销计费。

账户队列跨 provider/模型共用单个许可。SDK/代理不增加生成重试；
合法 Retry-After 形成账户共享冷却，取消和流结束幂等释放许可。

使用 LangChain 的 SSE 解析器检查 Chat 的 DONE 或 Responses completed 终态，
SDK 继续负责正文、工具参数与 usage 的核心解析。截断和上游流错误不得冒充成功。
Responses 的 `incomplete_details.reason=max_output_tokens` 映射为独立的
`COPILOT_OUTPUT_LIMIT_REACHED`，与网络截断区分；安全日志只保留终态类型、允许的原因枚举、
实际输出 Token 数和本次额度。错误不能触发代理重放或隐式换模型。
错误仅包含安全类别与消息，原始响应体、认证头和网络异常详情不得传播到日志/业务层。

调用用量仍由工厂已有装饰器记录，代理只补充 queue wait/transport/duration 诊断，
不重复写 invocation。终止性订阅错误必须穿透结构化重试/修复/备用厂商策略。
