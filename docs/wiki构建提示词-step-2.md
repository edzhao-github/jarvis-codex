> Codex 适配说明：本文件是待讨论的构建提示词，不代表现在执行。项目实施范围以 `docs/长期记忆系统实施计划.md` 为准，先完成阶段 A 的 Wiki 接入与读取验收，再另行推进长期记忆功能。
> 下文 `AGENTS.md` 指未来知识库目录内的 Wiki 行为规范，须继承项目根目录现有约定；不得覆盖根目录 `AGENTS.md` 或放宽用户档案的记录与隐私规则。

# 先放入 1 篇测试文章
cp ~/你的文章.md ~/knowledge-base/raw/articles/

# 告诉 Codex
你：ingest raw/articles/你的文章.md
# 仔细审查：摘要质量、概念提取是否准确、wikilinks 格式是否正确
# 若不满意，告诉 LLM：请更新 AGENTS.md，以后处理 [情况] 时要 [规范]
