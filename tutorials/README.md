# 从一次调用开始

先让程序收到一个回答，再让它记住上一轮、执行文件任务，最后接入浏览器。这里的课程按这个顺序组织；示例已经写好，你可以先运行，再沿章节拆解关键代码。

- [Python SDK](python-sdk/README.zh.md)：固定 `0.1.5rc1`，六个练习从高层调用走到裸 JSON-RPC。重点是 runtime 生命周期、会话复用和结果判断。
- [FastAPI 101](fastapi-101/README.md)：把 Python 调用放进一个长期运行的服务，用页面观察已提交消息、工具轨迹和多会话行为。
- [TypeScript SDK](typescript-sdk/README.md)：固定 npm `0.1.7-rc.2`，通过四个例子学习 profile 启动、会话复用和底层通知关联。

做完后，可以进入[完整项目](../projects/README.md)补齐业务状态与恢复。某个事件或失败行为让你疑惑时，先找对应 [Lab](../labs/README.md)做小实验，再去[机制章](../how-dsh-works/README.md)追源码。
