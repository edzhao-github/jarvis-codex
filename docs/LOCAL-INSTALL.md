# Local macOS installation

Jarvis reads `喵维斯设定.md` from the selected workspace when starting or resuming
a Codex thread and again when starting a voice session. If it is missing or empty,
Jarvis uses the built-in `src-tauri/src/personality.txt`. After editing the role,
restart the app to refresh its text runtime, or reconnect Voice to refresh the
voice prompt. For personal questions, Codex consults the relevant parts of
`用户档案.md` on demand. Voice delegates those questions to Codex. Map aliases
are resolved locally; no profile is attached to ordinary messages.

The installed app is `/Applications/Jarvis Codex.app`.

When updating the executable in the installed bundle, build it with
`npm exec -- tauri build --no-bundle`. The Tauri build embeds the frontend.
A plain `cargo build --release` still loads the development server, so it can
leave the installed app with a blank window. After signing and installing the
new executable, open the app and verify that the main interface renders.

Opening Jarvis from Applications or Launchpad shows its main window. Opening
it again restores a hidden or minimized window. The login agent passes
`--background` to start with only the wake listener active.

The installed app's `CFBundleExecutable` is `jarvis-launcher`, compiled from
`scripts/background-launcher.c`. The launcher forwards arguments to
`Contents/MacOS/jarvis-codex` and exports enabled system HTTP
and HTTPS proxy settings for the Codex child process; explicit proxy environment
variables take precedence. A full source build must retain this launcher or
implement equivalent proxy inheritance. Both executables and the app bundle
have local ad-hoc signatures.

The launcher also discovers Codex and sets `JARVIS_CODEX_BIN` when no explicit
override exists. This supports the nested
`Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex` location used by
newer ChatGPT releases, as well as the older locations. Rust discovery includes
the same nested app locations for future source builds. The installed launcher
was updated and its discovery, override handling, and Codex app-server initialize
handshake verified on 2026-10-01.

Build the compatibility launcher with:

```sh
clang -Wall -Wextra -Werror -framework CFNetwork -framework CoreFoundation \
  scripts/background-launcher.c -o /tmp/jarvis-launcher
```

The installed Swift wake helper has been rebuilt from this checkout. It
recovers stalled recognition and microphone sessions, finds its host when
launched without arguments, and waits for host launch completion before exiting.

Original app and intermediate helper backups are ZIP files under
`~/Library/Application Support/JarvisCodex/backups/`. Do not extract application
backups into indexed folders without a reason: Launchpad can surface the nested
helper instead of the installed version.

Validation performed: native launcher argument checks (normal, background,
wake, show, and conflicting arguments), helper compilation, app signature
verification, and the existing Node tests. These do not replace microphone
and window lifecycle testing on the Mac.
