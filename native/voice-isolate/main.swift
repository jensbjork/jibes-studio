// studio-voice-isolate: offline voice/background separation with macOS's built-in AUSoundIsolation audio unit
// (AudioToolbox effect aufx/vois/appl; macOS 13+, the "High Quality Voice" model on macOS 15+). Studio runs it to
// split a film's sound into the voice and everything else, locally and for free (src/main/voice-separation.ts).
//
//   studio-voice-isolate --probe
//       Prints {"ok":true,"hq":true,"latency":0.1325} (or {"ok":false,"error":"…"} and exits 1).
//   studio-voice-isolate <in.wav> <voice.wav> <background.wav> [--standard]
//       Writes both stems as 32-bit float WAV at the input's sample rate and channel count, exactly as long as the
//       input. The unit's latency is compensated (the first `latency` frames it renders are dropped, and as many
//       are rendered past the end), so the voice lines up with the input to the sample, and the background is
//       input − voice, so the two always sum back to the original. Prints "progress=0.42" lines on stdout.
//       --standard uses the standard "Voice" model even where the high quality one exists.
//
// Built by scripts/build-helpers.mjs (swiftc -O -target arm64-apple-macos13) into build/bin, and shipped in the
// app's Resources/bin by electron-builder.

import AVFoundation
import AudioToolbox
import Foundation

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

func say(_ line: String) {
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

/// The JSON object --probe prints, built by hand: the keys are fixed and the error text is escaped.
func probeJSON(ok: Bool, hq: Bool = false, latency: Double = 0, error: String? = nil) -> String {
    if let error = error {
        let escaped = error
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: " ")
        return "{\"ok\":false,\"error\":\"\(escaped)\"}"
    }
    return "{\"ok\":\(ok),\"hq\":\(hq),\"latency\":\(String(format: "%.6f", latency))}"
}

let isolationDescription = AudioComponentDescription(
    componentType: kAudioUnitType_Effect,
    componentSubType: kAudioUnitSubType_AUSoundIsolation,
    componentManufacturer: kAudioUnitManufacturer_Apple,
    componentFlags: 0,
    componentFlagsMask: 0)

/// Parameter 0 is WetDryMixPercent (-100…100; +100 = only the voice), parameter 1 SoundToIsolate, whose value
/// strings name the models ("High Quality Voice", "Voice"; macOS 13–14 have only "Voice").
struct Isolation {
    let engine: AVAudioEngine
    let player: AVAudioPlayerNode
    let effect: AVAudioUnitEffect
    let highQuality: Bool
}

func makeIsolation(format: AVAudioFormat, preferHighQuality: Bool) throws -> Isolation {
    var description = isolationDescription
    guard AudioComponentFindNext(nil, &description) != nil else {
        throw NSError(domain: "studio-voice-isolate", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "AUSoundIsolation is not available on this Mac"])
    }
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    let effect = AVAudioUnitEffect(audioComponentDescription: isolationDescription)
    engine.attach(player)
    engine.attach(effect)
    engine.connect(player, to: effect, format: format)
    engine.connect(effect, to: engine.mainMixerNode, format: format)
    try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: 4096)

    var highQuality = false
    if let tree = effect.auAudioUnit.parameterTree {
        if let model = tree.parameter(withAddress: 1) {
            let names = model.valueStrings ?? []
            if let hq = names.firstIndex(of: "High Quality Voice") {
                highQuality = preferHighQuality
                if preferHighQuality {
                    model.value = AUValue(hq)
                } else if let standard = names.firstIndex(of: "Voice") {
                    model.value = AUValue(standard)
                }
            }
        }
        // Only the voice comes out; the background is computed as input − voice.
        tree.parameter(withAddress: 0)?.value = 100
    }
    try engine.start()
    return Isolation(engine: engine, player: player, effect: effect, highQuality: highQuality)
}

func probe() -> Never {
    guard let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2) else {
        say(probeJSON(ok: false, error: "no audio format"))
        exit(1)
    }
    do {
        let isolation = try makeIsolation(format: format, preferHighQuality: true)
        let latency = isolation.effect.auAudioUnit.latency
        isolation.engine.stop()
        say(probeJSON(ok: true, hq: isolation.highQuality, latency: latency))
        exit(0)
    } catch {
        say(probeJSON(ok: false, error: error.localizedDescription))
        exit(1)
    }
}

func separate(input: URL, voiceURL: URL, backgroundURL: URL, preferHighQuality: Bool) throws {
    let inFile = try AVAudioFile(forReading: input)
    // A second reader of the same input, read in step with the rendered voice, gives the background.
    let original = try AVAudioFile(forReading: input)
    let format = inFile.processingFormat
    let channels = Int(format.channelCount)
    let isolation = try makeIsolation(format: format, preferHighQuality: preferHighQuality)
    let engine = isolation.engine
    isolation.player.scheduleFile(inFile, at: nil)
    isolation.player.play()

    let latencyFrames = AVAudioFramePosition((isolation.effect.auAudioUnit.latency * format.sampleRate).rounded())
    let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: format.sampleRate,
        AVNumberOfChannelsKey: format.channelCount,
        AVLinearPCMBitDepthKey: 32,
        AVLinearPCMIsFloatKey: true,
        AVLinearPCMIsNonInterleaved: false,
    ]
    let voiceFile = try AVAudioFile(forWriting: voiceURL, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
    let backgroundFile = try AVAudioFile(forWriting: backgroundURL, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)

    let capacity = engine.manualRenderingMaximumFrameCount
    guard let rendered = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: capacity),
          let voice = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity),
          let source = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity),
          let background = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
        throw NSError(domain: "studio-voice-isolate", code: 2, userInfo: [NSLocalizedDescriptionKey: "out of memory"])
    }

    let length = inFile.length
    let total = length + latencyFrames
    var renderedFrames: AVAudioFramePosition = 0
    var written: AVAudioFramePosition = 0
    var skip = latencyFrames
    var stalls = 0
    var lastReported = -1
    while renderedFrames < total {
        let frames = AVAudioFrameCount(min(AVAudioFramePosition(capacity), total - renderedFrames))
        let status = try engine.renderOffline(frames, to: rendered)
        switch status {
        case .success:
            stalls = 0
            let got = AVAudioFramePosition(rendered.frameLength)
            renderedFrames += got
            let drop = min(skip, got)
            skip -= drop
            let keep = min(got - drop, length - written)
            if keep <= 0 { continue }
            // The voice: the rendered frames after the latency.
            voice.frameLength = AVAudioFrameCount(keep)
            for c in 0..<channels {
                voice.floatChannelData![c].update(from: rendered.floatChannelData![c] + Int(drop), count: Int(keep))
            }
            // The background: the input at the same frames, minus the voice.
            source.frameLength = 0
            try original.read(into: source, frameCount: AVAudioFrameCount(keep))
            let have = Int(source.frameLength)
            background.frameLength = AVAudioFrameCount(keep)
            for c in 0..<channels {
                let s = source.floatChannelData![c]
                let v = voice.floatChannelData![c]
                let b = background.floatChannelData![c]
                for i in 0..<Int(keep) {
                    b[i] = (i < have ? s[i] : 0) - v[i]
                }
            }
            try voiceFile.write(from: voice)
            try backgroundFile.write(from: background)
            written += keep
            let percent = Int(Double(written) * 100 / Double(max(1, length)))
            if percent != lastReported {
                lastReported = percent
                say(String(format: "progress=%.2f", Double(percent) / 100))
            }
        case .insufficientDataFromInputNode, .cannotDoInCurrentContext:
            stalls += 1
            if stalls > 10_000 { throw NSError(domain: "studio-voice-isolate", code: 3, userInfo: [NSLocalizedDescriptionKey: "the audio unit stopped producing sound"]) }
            continue
        case .error:
            throw NSError(domain: "studio-voice-isolate", code: 4, userInfo: [NSLocalizedDescriptionKey: "render error"])
        @unknown default:
            throw NSError(domain: "studio-voice-isolate", code: 5, userInfo: [NSLocalizedDescriptionKey: "unknown render status"])
        }
    }
    engine.stop()
    if written != length {
        throw NSError(domain: "studio-voice-isolate", code: 6,
                      userInfo: [NSLocalizedDescriptionKey: "wrote \(written) of \(length) frames"])
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.contains("--probe") { probe() }
let preferHighQuality = !arguments.contains("--standard")
let paths = arguments.filter { !$0.hasPrefix("--") }
guard paths.count == 3 else {
    fail("usage: studio-voice-isolate <in.wav> <voice.wav> <background.wav> [--standard] | --probe")
}
do {
    try separate(input: URL(fileURLWithPath: paths[0]),
                 voiceURL: URL(fileURLWithPath: paths[1]),
                 backgroundURL: URL(fileURLWithPath: paths[2]),
                 preferHighQuality: preferHighQuality)
} catch {
    fail("studio-voice-isolate: \(error.localizedDescription)")
}
