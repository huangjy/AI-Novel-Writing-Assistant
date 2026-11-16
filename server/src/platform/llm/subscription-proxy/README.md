# 订阅内部传输

SDK 使用 `fetchFor(provider, model)` 发送 OpenAI-compatible 请求，不挂载 HTTP 推理路由，
也不监听独立端口。固定逻辑 origin 只由注入的 fetch 消费，不能作为实际 DNS 目标。

平台通过 `SubscriptionPort` 获取有效凭据、模型能力和绑定校验，不依赖授权业务模块内部实现。
`modules/authorization` 的组合入口提供端口实现。每次发送重新检查绑定和凭据代次；
账户失效通知同时取消队列与在途流，已发往上游的请求不承诺撤销计费。

账户队列跨 provider/模型共用单个许可。SDK/代理不增加生成重试；
合法 Retry-After 形成账户共享冷却，取消和流结束幂等释放许可。

使用 LangChain 的 SSE 解析器检查 Chat 的 DONE 或 Responses completed 终态，
SDK 继续负责正文、工具参数与 usage 的核心解析。截断和上游流错误不得冒充成功。
错误仅包含安全类别与消息，原始响应体、认证头和网络异常详情不得传播到日志/业务层。

调用用量仍由工厂已有装饰器记录，代理只补充 queue wait/transport/duration 诊断，
不重复写 invocation。终止性订阅错误必须穿透结构化重试/修复/备用厂商策略。
