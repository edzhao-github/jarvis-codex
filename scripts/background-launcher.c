// Compatibility launcher for the installed v0.2.0 binary. Source builds use
// the same background-by-default behavior directly in src-tauri/src/lib.rs.
#include <mach-o/dyld.h>
#include <CFNetwork/CFNetwork.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void inherit_proxy(CFDictionaryRef settings, CFStringRef enabledKey,
                         CFStringRef hostKey, CFStringRef portKey,
                         const char *upper, const char *lower) {
    // Explicit process settings take precedence over the system configuration.
    if (getenv(upper) || getenv(lower) || getenv("ALL_PROXY") || getenv("all_proxy")) return;
    CFNumberRef enabled = CFDictionaryGetValue(settings, enabledKey);
    CFNumberRef portValue = CFDictionaryGetValue(settings, portKey);
    CFStringRef hostValue = CFDictionaryGetValue(settings, hostKey);
    if (!enabled || CFGetTypeID(enabled) != CFNumberGetTypeID() ||
        !portValue || CFGetTypeID(portValue) != CFNumberGetTypeID() ||
        !hostValue || CFGetTypeID(hostValue) != CFStringGetTypeID()) return;
    int active = 0, port = 0;
    if (!CFNumberGetValue(enabled, kCFNumberIntType, &active) || !active ||
        !CFNumberGetValue(portValue, kCFNumberIntType, &port) || port < 1 || port > 65535) return;
    char host[1024], proxy[1100];
    if (!CFStringGetCString(hostValue, host, sizeof(host), kCFStringEncodingUTF8) ||
        !host[0] || strpbrk(host, "/@ \t\r\n")) return;
    snprintf(proxy, sizeof(proxy), strchr(host, ':') ? "http://[%s]:%d" : "http://%s:%d", host, port);
    setenv(upper, proxy, 0);
    setenv(lower, proxy, 0);
}

static void discover_codex(void) {
    // Preserve explicit configuration; Finder launches do not inherit shell PATH.
    if (getenv("JARVIS_CODEX_BIN")) return;
    const char *candidates[] = {
        "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
        "/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        "/Applications/Codex.app/Contents/Resources/codex",
        "/opt/homebrew/bin/codex",
        "/usr/local/bin/codex",
    };
    for (size_t i = 0; i < sizeof(candidates) / sizeof(candidates[0]); ++i) {
        if (access(candidates[i], X_OK) == 0) {
            setenv("JARVIS_CODEX_BIN", candidates[i], 0);
            return;
        }
    }
}

int main(int argc, char **argv) {
    discover_codex();
    CFDictionaryRef proxies = CFNetworkCopySystemProxySettings();
    if (proxies) {
        inherit_proxy(proxies, kCFNetworkProxiesHTTPEnable, kCFNetworkProxiesHTTPProxy,
                      kCFNetworkProxiesHTTPPort, "HTTP_PROXY", "http_proxy");
        inherit_proxy(proxies, kCFNetworkProxiesHTTPSEnable, kCFNetworkProxiesHTTPSProxy,
                      kCFNetworkProxiesHTTPSPort, "HTTPS_PROXY", "https_proxy");
        CFRelease(proxies);
    }
    char path[PATH_MAX];
    uint32_t size = sizeof(path);
    if (_NSGetExecutablePath(path, &size) != 0) return 1;
    char *separator = strrchr(path, '/');
    if (!separator) return 1;
    const char *runtime = "jarvis-codex";
    size_t prefix = (size_t)(separator + 1 - path);
    if (prefix + strlen(runtime) + 1 > sizeof(path)) return 1;
    strcpy(path + prefix, runtime);

    int foreground = 0, background = 0;
    for (int i = 1; i < argc; ++i) {
        foreground |= strcmp(argv[i], "--jarvis-wake") == 0 || strcmp(argv[i], "--show") == 0;
        background |= strcmp(argv[i], "--background") == 0;
    }
    char **args = calloc((size_t)argc + 2, sizeof(char *));
    if (!args) return 1;
    int count = 0;
    args[count++] = path;
    for (int i = 1; i < argc; ++i) {
        if (foreground && strcmp(argv[i], "--background") == 0) continue;
        args[count++] = argv[i];
    }
    if (!foreground && !background) args[count++] = "--background";
    execv(path, args);
    perror("Could not start Jarvis Codex");
    free(args);
    return 1;
}
