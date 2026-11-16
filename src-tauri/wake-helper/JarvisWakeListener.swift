import AppKit
import AVFoundation
import Foundation
import Speech

final class WakeListener {
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
    private var audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var hasWoken = false
    private var isStopping = false
    private var reportedRecognition = false
    private var generation = 0
    private var receivedAudio = false
    private let eventFile: URL?
    private let hostApp: URL?

    private let phrases = [
        "嗨jarvis",
        "嘿jarvis",
        "hijarvis",
        "heyjarvis",
        "嗨贾维斯",
        "嘿贾维斯",
        "猫维斯",
        "喵维斯",
        "猫维思",
        "喵维思",
        "嗨贾维思",
        "嘿贾维思",
        "嗨加维斯",
        "嘿加维斯",
    ]

    init() {
        if
            let index = CommandLine.arguments.firstIndex(of: "--event-file"),
            CommandLine.arguments.indices.contains(index + 1)
        {
            eventFile = URL(fileURLWithPath: CommandLine.arguments[index + 1])
        } else {
            eventFile = FileManager.default.temporaryDirectory
                .appendingPathComponent("jarvis-standalone-wake.jsonl")
        }
        if
            let index = CommandLine.arguments.firstIndex(of: "--host-app"),
            CommandLine.arguments.indices.contains(index + 1)
        {
            hostApp = URL(fileURLWithPath: CommandLine.arguments[index + 1])
        } else {
            // Launchpad can open the nested helper directly, without the
            // arguments normally supplied by the host's wake supervisor.
            var enclosing = Bundle.main.bundleURL.deletingLastPathComponent()
            var discoveredHost: URL?
            while enclosing.path != "/" {
                if enclosing.pathExtension == "app",
                   FileManager.default.isExecutableFile(atPath:
                    enclosing.appendingPathComponent("Contents/MacOS/jarvis-codex").path) {
                    discoveredHost = enclosing
                    break
                }
                enclosing.deleteLastPathComponent()
            }
            let installed = URL(fileURLWithPath: "/Applications/Jarvis Codex.app")
            hostApp = discoveredHost ?? (Bundle(url: installed)?.bundleIdentifier ==
                "com.bigguan.jarvis-codex" ? installed : nil)
        }
    }

    func run() {
        emit(["type": "boot", "bundle": Bundle.main.bundleURL.path])
        if CommandLine.arguments.contains("--check-host") {
            emit(["type": "host", "path": hostApp?.path ?? ""])
            exit(hostApp == nil ? 8 : 0)
        }
        if CommandLine.arguments.contains("--test-wake") {
            emit(["type": "wake", "phrase": "automated cold-launch test"])
            openHostApp()
            RunLoop.main.run()
            return
        }

        guard let recognizer, recognizer.isAvailable else {
            emit(["type": "error", "message": "speech recognizer unavailable"])
            exit(2)
        }

        let currentAuthorization = SFSpeechRecognizer.authorizationStatus()
        emit([
            "type": "authorization",
            "status": authorizationName(currentAuthorization),
        ])
        if currentAuthorization == .authorized {
            startRecognition()
            RunLoop.main.run()
            return
        }

        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self else { return }
                guard status == .authorized else {
                    self.emit([
                        "type": "authorization",
                        "status": self.authorizationName(status),
                    ])
                    exit(3)
                }
                self.emit(["type": "authorization", "status": "authorized"])
                self.startRecognition()
            }
        }

        RunLoop.main.run()
    }

    private func startRecognition() {
        generation += 1
        let sessionGeneration = generation
        isStopping = false
        reportedRecognition = false
        receivedAudio = false
        audioEngine = AVAudioEngine()
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            emit(["type": "error", "message": "microphone input unavailable"])
            exit(4)
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.contextualStrings = ["猫维斯", "嘿猫维斯", "喵维斯", "嘿喵维斯", "嗨贾维斯", "嘿贾维斯", "Hey Jarvis", "Hi Jarvis"]
        guard recognizer?.supportsOnDeviceRecognition == true else {
            emit(["type": "error", "message": "on-device speech recognition unavailable"])
            exit(7)
        }
        request.requiresOnDeviceRecognition = true
        if #available(macOS 13.0, *) {
            request.addsPunctuation = false
        }
        self.request = request

        input.removeTap(onBus: 0)
        var framesSinceReport: AVAudioFrameCount = 0
        var peak: Float = 0
        var firstBuffer = true
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            request.append(buffer)
            if firstBuffer {
                firstBuffer = false
                DispatchQueue.main.async {
                    guard let self, !self.isStopping, self.generation == sessionGeneration else { return }
                    self.receivedAudio = true
                    self.emit(["type": "ready"])
                }
            }
            if let samples = buffer.floatChannelData?[0] {
                for index in 0..<Int(buffer.frameLength) {
                    peak = max(peak, abs(samples[index]))
                }
            }
            framesSinceReport += buffer.frameLength
            if framesSinceReport >= AVAudioFrameCount(format.sampleRate * 5) {
                let level = peak
                framesSinceReport = 0
                peak = 0
                DispatchQueue.main.async {
                    guard let self, !self.isStopping, self.generation == sessionGeneration else { return }
                    self.emit(["type": "audio-level", "peak": String(format: "%.5f", level)])
                }
            }
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            emit(["type": "error", "message": "microphone start failed"])
            exit(5)
        }

        // WebRTC may still be releasing the input device after STOP. An
        // engine can report started without delivering any microphone buffers.
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self, !self.hasWoken, !self.isStopping,
                  self.generation == sessionGeneration, !self.receivedAudio else { return }
            self.restartRecognition(reason: "microphone delivered no audio")
        }
        // A live helper process does not imply a live recognition request.
        // Renew stalled requests as well as final ones, even with the host closed.
        DispatchQueue.main.asyncAfter(deadline: .now() + 50) { [weak self] in
            guard let self, !self.hasWoken, !self.isStopping,
                  self.generation == sessionGeneration else { return }
            self.restartRecognition(reason: "session refresh")
        }
        task = recognizer?.recognitionTask(with: request) { [weak self] result, error in
            guard let self, !self.hasWoken, !self.isStopping,
                  self.generation == sessionGeneration else { return }
            if let result {
                if !self.reportedRecognition {
                    self.reportedRecognition = true
                    self.emit(["type": "recognition", "status": "receiving results"])
                }
                let spoken = self.normalize(result.bestTranscription.formattedString)
                if self.phrases.contains(where: spoken.contains) {
                    self.hasWoken = true
                    self.emit([
                        "type": "wake",
                        "phrase": result.bestTranscription.formattedString,
                    ])
                    self.stop()
                    self.openHostApp()
                    return
                }
                if result.isFinal {
                    self.restartRecognition(reason: "recognition completed")
                    return
                }
            }
            if error != nil {
                self.restartRecognition(reason: "speech recognition interrupted")
            }
        }
    }

    private func restartRecognition(reason: String) {
        emit(["type": "restart", "reason": reason])
        stop()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self, !self.hasWoken else { return }
            self.startRecognition()
        }
    }

    private func stop() {
        isStopping = true
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        audioEngine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
    }

    private func openHostApp() {
        guard let hostApp else {
            emit(["type": "error", "message": "Jarvis Codex.app was not found"])
            exit(8)
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        configuration.arguments = ["--jarvis-wake"]
        NSWorkspace.shared.openApplication(
            at: hostApp,
            configuration: configuration
        ) { [weak self] application, error in
            guard let self else { return }
            if let error {
                self.emit([
                    "type": "error",
                    "message": "could not open Jarvis: \(error.localizedDescription)",
                ])
                // Keep listening after a failed launch rather than disappearing.
                self.hasWoken = false
                self.restartRecognition(reason: "host launch failed")
            } else if let application {
                self.emit(["type": "host-started", "pid": String(application.processIdentifier)])
                exit(0)
            }
        }
    }

    private func normalize(_ value: String) -> String {
        value
            .lowercased()
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: ",", with: "")
            .replacingOccurrences(of: "，", with: "")
            .replacingOccurrences(of: ".", with: "")
            .replacingOccurrences(of: "。", with: "")
            .replacingOccurrences(of: "！", with: "")
            .replacingOccurrences(of: "!", with: "")
    }

    private func authorizationName(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }

    private func emit(_ value: [String: String]) {
        guard
            let data = try? JSONSerialization.data(withJSONObject: value),
            let line = String(data: data, encoding: .utf8)
        else { return }
        if let eventFile {
            let data = Data((line + "\n").utf8)
            if let handle = try? FileHandle(forWritingTo: eventFile) {
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: data)
                try? handle.close()
            } else {
                try? data.write(to: eventFile, options: .atomic)
            }
        } else {
            print(line)
            fflush(stdout)
        }
    }
}

let listener = WakeListener()
listener.run()
