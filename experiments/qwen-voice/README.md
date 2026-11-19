# Qwen voice spike

Run `npm run voice:qwen`, then open http://127.0.0.1:1431.
Use your own region, Workspace ID, API key, enabled model and matching voice.
Defaults follow the official Qwen-Audio 3.1 example; availability must be verified
against your account. There is no automatic region/model fallback.

The key is entered into a password field and forwarded only to the loopback bridge
and the selected Alibaba endpoint, held in memory, never persisted. Conversation
text stays on the page and is not logged to disk. Microphone audio is sent to the
selected provider after explicit Connect. Close/End stops capture and disconnects;
connections have a 30-minute maximum. Only one connection is allowed at a time.
No user profile, Wiki, production personality or 开发助手 history is loaded.

This is a WebSocket PCM baseline, not a production WebRTC/AOQ implementation.
Input is 16 kHz PCM16, output 24 kHz PCM16; an AudioWorklet captures input with
browser echo cancellation/noise suppression. Use headphones for the initial test,
then separately test speakers. Capture resampling uses nearest samples when the
browser cannot honor 16 kHz and is not a production antialiasing resampler.

Compare voice responsiveness, sentence pauses, corrections, mixed languages and
20-minute stability against the existing app. The displayed latency starts at
receipt of the server speech-stopped event and ends at scheduled local playback;
it excludes preceding VAD/network time and is not end-to-end latency.

Ask to test waiting for 2, 10 or 30 seconds with any label. `delay_probe` only waits
and returns that label. The probe itself cannot execute real tasks; the separately enabled Harness tools can. Try another subject/label to
check generality. Ending the call cancels all pending timers. Interrupt only stops
speech; it does not cancel an outstanding probe. Check whether late probe results
interrupt ongoing conversation during live acceptance; no behavioral guarantee is
made before provider testing. No automatic retries that could duplicate tasks.

Official protocol: https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides

Validation: JavaScript syntax and existing repository tests. Live authentication,
model access, audio quality and tool-event compatibility require account settings
and a microphone test. Do not interpret offline checks as voice acceptance.

Qianwen AI Platform uses the fixed endpoint `wss://maas.qianwenaiapi.com/api-ws/v1/realtime`; choose Qianwen, no Workspace ID required. Bailian regional endpoints remain separate. Verified against https://platform.qianwenai.com/docs/api-reference/qwen-audio-realtime/websocket-access on 2026-11-19.

Tool completion scheduling: results wait outside user speech, pending user response, active model responses and local audio playback. An 800 ms quiet gap yields to new speech. Results batch into one notification reply. Playback state travels over the bridge; disconnect discards pending notifications. Tests cover speech, text, overlapping responses, playback and shutdown. Actual provider turn semantics still need live retesting.


## DeepSeek Harness execution

Pinned official SDK: `@deepseek-ai/dsh-sdk-client@0.2.2-rc.5`.
Needs Node >=24.9. The launcher uses current Node when compatible, otherwise
`runtime/qwen-node/node_modules/.bin/node`. Prepare it with
`npm install --prefix runtime/qwen-node --no-save node@24` if needed.
Enter the separate DeepSeek API key to enable `execute_task`, `task_status`, and
`stop_task`. The key is held in memory and passed only to the Harness subprocess.
The Qwen key is not inherited by Harness. Task prompts and results pass between
the two providers; do not include private Wiki/profile data in test prompts.

Writes use the default workspace-write sandbox under
`runtime/qwen-harness/workspace`; the runtime home and durable session records
are in `runtime/qwen-harness/home` (ignored by Git). This is not a read-isolation
guarantee. Approval requests are denied; native questions are dismissed with a
visible notice. No automatic retry. One task at a time, one Harness session per
voice connection. Pending work returns a busy result rather than duplicating it.
The stop button closes the runtime, not just playback. Ending the call also closes
it. Reconnect after stopping to start a fresh execution session. Completed effects
are not rolled back. Shutdown failure is reported, not claimed as success.

Verified on 2026-11-19: real DeepSeek task created harness-smoke.txt and read it
back; host independently verified its contents. Voice-triggered execution still
requires user speech acceptance. Existing tests plus runner lifecycle tests cover
single-flight dispatch, cancellation-result suppression, missing credentials and
permission denial. The upstream preview dependency tree introduces npm audit
findings; this branch is an experiment, not a production release.
