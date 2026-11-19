fn main() {
    let mut args = std::env::args().skip(1);
    let operation = args.next();
    if operation.as_deref() == Some("--store-api-keys") {
        use std::io::{self, Read};
        let mut input = String::new();
        let result = io::stdin()
            .take(16384)
            .read_to_string(&mut input)
            .map_err(|_| "无法读取密钥输入".to_owned())
            .and_then(|_| serde_json::from_str(&input).map_err(|_| "密钥输入格式无效".to_owned()))
            .and_then(meowvis_lib::credentials::save);
        match result {
            Ok(()) => println!("密钥已保存到 macOS 钥匙串"),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return;
    }
    let lookup = match operation.as_deref() {
        Some("--wiki-profile-section") => meowvis_lib::lookup_profile_from_cli,
        Some("--wiki-read") => meowvis_lib::read_wiki_from_cli,
        Some("--wiki-search") => meowvis_lib::search_wiki_from_cli,
        _ => {
            meowvis_lib::run();
            return;
        }
    };
    let (Some(query), None) = (args.next(), args.next()) else {
        eprintln!("用法：meowvis-desktop --wiki-profile-section <章节标题或 --list> 或 --wiki-read <相对页面路径> 或 --wiki-search <查询>");
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
