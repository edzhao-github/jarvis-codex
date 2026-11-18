fn main() {
    let mut args = std::env::args().skip(1);
    let operation = args.next();
    let lookup = match operation.as_deref() {
        Some("--wiki-profile-section") => jarvis_codex_lib::lookup_profile_from_cli,
        Some("--wiki-read") => jarvis_codex_lib::read_wiki_from_cli,
        Some("--wiki-search") => jarvis_codex_lib::search_wiki_from_cli,
        _ => {
            jarvis_codex_lib::run();
            return;
        }
    };
    let (Some(query), None) = (args.next(), args.next()) else {
        eprintln!("用法：jarvis-codex --wiki-profile-section <章节标题或 --list> 或 --wiki-read <相对页面路径> 或 --wiki-search <查询>");
        std::process::exit(2);
    };
    match lookup(&query) {
        Ok(output) => println!("{output}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
