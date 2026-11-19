// Bundle launcher that inherits the system proxy.
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

int main(int argc, char **argv) {
    if (argc < 1) return 1;
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
    const char *runtime = "meowvis-desktop";
    size_t prefix = (size_t)(separator + 1 - path);
    if (prefix + strlen(runtime) + 1 > sizeof(path)) return 1;
    strcpy(path + prefix, runtime);

    argv[0] = path;
    execv(path, argv);
    perror("Could not start Meowvis");
    return 1;
}
