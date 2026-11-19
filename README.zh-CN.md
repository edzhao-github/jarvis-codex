# Meowvis / 喵维斯

macOS 机械猫桌面助手：千问负责实时语音，DeepSeek Harness 负责本地任务。支持本机唤醒、可打断对话、后台执行、开始提示、进度查询和停止任务。

## 本地构建

需要 macOS 13+、Xcode Command Line Tools、Rust 和 npm。

```sh
npm ci
npm install --prefix runtime/qwen-node --no-save node@24
npm run voice:prepare
npm run check
npm run build -- --bundles app
```

应用：`src-tauri/target/release/bundle/macos/Meowvis.app`。Node 和 Harness 随包提供，不依赖外部执行助手。首次启动在设置中填写工作目录、千问密钥和 DeepSeek 密钥。密钥保存到 macOS 钥匙串，下次启动自动读取，不写入项目文件。

- 麦克风：连接或结束语音。
- 红色停止：结束整次会话、停止任务并恢复唤醒监听。
- 设置中的“停止当前任务”：保留语音聊天，停止执行引擎。继续执行前需重新连接。
- 文字输入：加入当前语音会话；未连接时先连接。

模型：`qwen-audio-3.1-realtime-plus` / `deepseek-v4-flash`。支持的千问门户为实验中验证的 qianwen 接入点。执行使用 workspace-write，额外权限被拒绝；这不是文件读取隔离。已完成的文件操作不会因停止而回滚。

角色设定按当前工作目录的 Wiki/legacy 规则读取。记忆查询由模型选择总索引、单页、按章档案和关键词搜索工具。设置中的 Wiki 开关默认关闭；允许后，仅按需将相关页面或章节发给千问回答并引用来源，取消并保存会结束会话，已发送片段不可撤回。不会自动把整份档案附加到对话，也不会日常检索 Raw 或自动写入 Wiki。Raw 归档继续使用本机模块。应用内地图仍暂停。

独立语音测试页：`npm run voice:qwen`，访问 `http://127.0.0.1:1431`。桌面使用独立随机端口、会话令牌和来源检查，不依赖测试页。

本地构建未经 Apple 公证；第三方 Harness 为固定预览版，发布前需审查依赖和完成实际桌面语音验收。
