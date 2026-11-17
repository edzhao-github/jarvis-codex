fn main() {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some("--wiki-profile-section") {
        let (Some(section), None) = (args.next(), args.next()) else {
            eprintln!("用法：jarvis-codex --wiki-profile-section <章节标题或 --list>");
            std::process::exit(2);
        };
        match jarvis_codex_lib::lookup_profile_from_cli(&section) {
            Ok(output) => println!("{output}"),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    } else {
        jarvis_codex_lib::run();
    }
}
