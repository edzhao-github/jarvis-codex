# 家庭管家 Wiki 构建指南

这份文档是家庭管家知识库的构建和验收依据。知识库根目录为项目内的「记忆」。日常从 [Wiki 首页](wiki/index.md) 进入，维护约定见 [AGENTS.md](AGENTS.md)。

## 1. 建立目录和入口

~~~text
记忆/
├── raw/                 原件，先直接放在这里
├── wiki/
│   ├── index.md         首页
│   ├── 家庭日常/        家庭习惯、常用安排、办事流程
│   ├── 物品与设备/      收纳位置、设备说明、维修和耗材
│   ├── 健康/            授权保存的健康记录和跟进事项
│   ├── 工作/            项目、会议结论和常用工作流程
│   ├── 学习/            学习目标、资料笔记、练习与复盘
│   ├── 管家记忆/        已确认的偏好、提醒方式和长期约定
│   ├── 待办与维护.md    待办、定期维护和完成记录
│   └── 维护/
│       ├── 模板.md
│       ├── log.md
│       └── 报告/
└── scripts/             检查和本地搜索命令
~~~

在每个主题目录建立一张 index.md，写清该主题记录什么，并留一个「条目」小节。首页链接到六张主题入口和总待办。定期维护写在总待办，来源和细节链接到对应主题。需要链接多处时保留一份正文。例如，换滤芯的记录放在「物品与设备」，下一次更换日期出现在总待办。

每张 Markdown 页面用 YAML frontmatter 写 type 和 date，日期格式为 YYYY-MM-DD。首页可用 wiki-index，主题入口用 topic-index，事项页用 tasks，普通记录用 note。模板、维护日志和报告分别使用 template、system-log 和相应的报告类型，并添加 graph-excluded: true。新记录从 [通用模板](wiki/维护/模板.md) 复制，按需填写。要补建目录，可以从「记忆」运行：

~~~sh
mkdir -p raw wiki/{家庭日常,物品与设备,健康,工作,学习,管家记忆,维护/报告}
~~~

在 Obsidian 中可以把「记忆」打开为库，便于一起浏览 Wiki 和原件。也可以单独打开「记忆/wiki」聚焦知识页面。图谱过滤框可用 `-[graph-excluded:true]`。单独的 Wiki 库已配置该过滤。

## 2. 手工记录和引用

1. 把用户提供的原件保存到 raw/，保持原件内容。需要更多分类时按材料数量拆分。
2. 从首页进入主题，把经过核对的记录写到相关页面，附原件相对链接或用户确认日期。Wiki 文件名可直接使用中文。引用有重名的页面时使用相对路径。
3. 用户明确确认的长期约定写进「管家记忆」。健康、工作等主题已有完整记录时，保留主题原页，在管家记忆中链接该页。
4. 有时间要求的跟进项加入总待办。修改和删除时同步检查主题链接及本地索引。

raw/、wiki/、本机 QMD 索引、Obsidian 设置和未来的记忆系统运行数据都排除在 Git 之外，由本机保存。

## 3. 配置本地检索与检查

在「记忆」下运行。QMD 需要 Node.js 22 或更新版本，检查脚本需要 Python 3.10 或更新版本以及 PyYAML。已有 PyYAML 时可以直接运行检查。

~~~sh
python3 -m venv .qmd/python
.qmd/python/bin/python -m pip install PyYAML
npm install --prefix .qmd @tobilu/qmd@2.8.3
scripts/qmd collection add wiki --name meowvis-wiki --mask '{家庭日常,物品与设备,健康,工作,学习,管家记忆}/**/*.md,待办与维护.md'
~~~

若已有同名集合且路径规则是旧版，先用 scripts/qmd collection show meowvis-wiki 核对，再用 collection remove 后重新添加。该命令清除本地索引条目，Wiki 页面保存在原目录。集合覆盖六个主题和总待办。

~~~sh
python3 scripts/lint.py
scripts/qmd update
scripts/qmd status
scripts/qmd search "关键词" -c meowvis-wiki
~~~

在虚拟环境安装 PyYAML 时，用 .qmd/python/bin/python 执行检查。报告位于 wiki/维护/报告，覆盖入口、元数据和本地链接。有问题时返回 1。QMD 的索引留在本机，当前以关键词检索为主。

## 4. 预留长期记忆系统

以后启用长期记忆功能时，可在「记忆系统」下按需新增这些目录。

| 目录 | 保存内容 |
| --- | --- |
| candidates/ | 等待用户确认的候选 |
| impressions/ | 管家推断出的待确认印象 |
| metadata/ | 来源映射、处理进度和删除状态 |
| audit/ | 确认、纠正、删除等事件与时间 |

原始依据沿用 raw/。确认后的长期记忆写入 Wiki 的「管家记忆」，接受用户后续纠正。当前工作范围是手工整理的本地 Wiki。对话采集、自动提炼和跨会话自动召回尚未启用。

## 5. 验收

- 首页能到达六个主题和总待办。各主题目录有入口页。
- 维护文件集中在 wiki/维护。旧 Step 1 的验收和检查报告保存在「报告」下。
- lint 能检查缺失入口、错误元数据和断链。初始结构应通过检查。
- qmd 初始索引为七页。加入测试笔记并刷新后能检索，删除测试笔记并刷新后不再命中。
