#!/usr/bin/env python3
"""检查家庭管家 Wiki 的入口、页面元数据与本地链接。"""

import re
from datetime import date, datetime
from pathlib import Path
from urllib.parse import unquote, urlsplit
from zoneinfo import ZoneInfo

try:
    import yaml
except ImportError:
    raise SystemExit("缺少 PyYAML，请参照家庭管家Wiki构建指南.md 安装。") from None


ROOT = Path(__file__).resolve().parents[1]
WIKI = ROOT / "wiki"
REPORT_DIR = WIKI / "维护" / "报告"
FRONTMATTER = re.compile(r"\A---[ \t]*\n(.*?)\n---[ \t]*(?:\n|\Z)", re.S)
MARKDOWN_LINK = re.compile(r"(?<!\\)\[(?!\[)[^\]\n]+\]\(\s*(?:<([^>\n]+)>|([^)\s]+))")
WIKILINK = re.compile(r"(?<!\\)\[\[([^|\]#\n]*)(?:[#|][^\]\n]*)?\]\]")
INACTIVE = re.compile(r"<!--.*?-->|^\s*(\x60{3,}|~{3,})[^\n]*\n.*?^\s*\1[ \t]*$|\x60[^\x60\n]+\x60", re.M | re.S)


def valid_date(value):
    try:
        return date.fromisoformat(str(value)).isoformat() == str(value)
    except ValueError:
        return False


def lint():
    issues = []
    home = Path("index.md")
    required = {home, Path("待办与维护.md"), Path("维护/模板.md"), Path("维护/log.md")}
    files = {
        path.relative_to(WIKI)
        for path in WIKI.rglob("*.md")
        if not any(part.startswith(".") for part in path.relative_to(WIKI).parts)
    }
    for relative in sorted(required - files):
        issues.append(f"缺少页面：{relative}")

    entries = {relative for relative in files if relative != home and relative.parts[0] != "维护"}
    home_links = set()
    for relative in sorted(files):
        path = WIKI / relative
        if not path.resolve().is_relative_to(WIKI):
            issues.append(f"{relative}：页面位于 Wiki 之外")
            continue
        try:
            text = path.read_text(encoding="utf-8-sig")
            front = FRONTMATTER.match(text)
            meta = yaml.safe_load(front[1]) if front else None
        except (OSError, UnicodeError, yaml.YAMLError):
            issues.append(f"{relative}：无法读取页面或解析 YAML")
            continue
        kind = meta.get("type") if isinstance(meta, dict) else None
        if not isinstance(kind, str) or not kind.strip() or not valid_date(meta.get("date")):
            issues.append(f"{relative}：需要有效的 type 和 YYYY-MM-DD 日期")
        if relative.parts[0] == "维护" and (
            not isinstance(meta, dict) or meta.get("graph-excluded") is not True
        ):
            issues.append(f"{relative}：维护页需要 graph-excluded: true")

        body = INACTIVE.sub("", text[front.end():] if front else text)
        for bracketed, plain in MARKDOWN_LINK.findall(body):
            try:
                link = urlsplit(bracketed or plain)
            except ValueError:
                issues.append(f"{relative}：存在无效的 Markdown 链接")
                continue
            if link.scheme or link.netloc or not link.path:
                continue
            target = (path.parent / unquote(link.path)).resolve()
            if not target.is_relative_to(ROOT) or not target.exists():
                issues.append(f"{relative}：本地链接缺失或越界：{link.path}")
            elif relative == home and target.is_relative_to(WIKI):
                home_links.add(target.relative_to(WIKI))

        for name in WIKILINK.findall(body):
            node = name.strip().removesuffix(".md")
            if not node:
                continue
            candidate = Path(node + ".md")
            if "/" in node:
                matches = {p for p in (candidate, relative.parent / candidate) if p in files}
            else:
                matches = {p for p in files if p.stem == node}
            if len(matches) != 1:
                issues.append(f"{relative}：Wiki 链接缺失或有重名：{name}")
            elif relative == home:
                home_links.update(matches)

    for entry in sorted(entries - home_links):
        issues.append(f"首页缺少入口链接：{entry}")

    today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    report = REPORT_DIR / f"lint-{today}.md"
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    lines = [
        "---", "type: lint-report", f"date: {today}", "graph-excluded: true", "---", "",
        "# 家庭管家 Wiki 检查", "", f"检查 {len(files)} 个页面，发现 {len(issues)} 条问题。", "",
        "检查项目包括首页入口、页面元数据和本地链接。",
    ]
    if issues:
        lines.extend(["", "## 待修复", "", *(f"- {issue}" for issue in issues)])
    report.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"检查 {len(files)} 个页面，发现 {len(issues)} 条问题。报告：{report.relative_to(ROOT)}")
    return int(bool(issues))


if __name__ == "__main__":
    raise SystemExit(lint())
