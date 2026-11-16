# Local macOS installation

Personality is embedded from `src-tauri/src/personality.txt` in thread start and
resume instructions. It defines 喵维斯 as a confident mechanical cat with candid,
reasoned disagreement, concise discussion of tradeoffs, and truthful tool-result
reporting. Restart the app after rebuilding to refresh an existing runtime.

The installed app is `/Applications/Jarvis Codex.app`.

Normal launch should run in the background. `--jarvis-wake` and `--show`
are foreground entry points. This behavior is implemented in the Rust source.

The installed app has been rebuilt from this checkout with the mechanical-cat
asset, updated wake helper, and background-by-default Rust startup. Its
`CFBundleExecutable` is `jarvis-launcher`, compiled from
`scripts/background-launcher.c`. The launcher executes
`Contents/MacOS/jarvis-codex` with `--background` on normal launches and
preserves foreground wake launches. The launcher also exports enabled system HTTP
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
