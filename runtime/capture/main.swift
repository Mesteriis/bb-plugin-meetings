// Local-recording capture helper (docs/dev/DESIGN.md §15). Compiled on the host
// during setup with swiftc. No bot joins the call: it records the microphone and
// the system audio (through a Core Audio process tap, macOS 14.2+) into the
// meeting directory.
//
//   detect                     print one JSON array of audio client processes
//   record --meeting-dir <dir> [--bundle-ids id,id,...]  record mic + system audio
//
// Files: audio.pcm (s16le 16 kHz mono, mic + system mixed, what the transcriber
// reads), mic.pcm (mic only), system.pcm (system only), state.json / events.jsonl
// (bot shapes).

import AVFoundation
import CoreAudio
import Darwin
import Foundation

let SAMPLE_RATE = 16_000
let NL = String(Character(UnicodeScalar(10)!))

// ── process enumeration (detect + tap resolution) ───────────────────────

func processList() -> [AudioObjectID] {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyProcessObjectList,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var dataSize: UInt32 = 0
  let system = AudioObjectID(kAudioObjectSystemObject)
  guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &dataSize) == noErr, dataSize > 0 else {
    return []
  }
  let count = Int(dataSize) / MemoryLayout<AudioObjectID>.size
  var objects = [AudioObjectID](repeating: 0, count: count)
  let status = AudioObjectGetPropertyData(system, &address, 0, nil, &dataSize, &objects)
  guard status == noErr else { return [] }
  return objects
}

func propertyInt(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> Int {
  var address = AudioObjectPropertyAddress(
    mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value: pid_t = 0
  var size = UInt32(MemoryLayout<pid_t>.size)
  if AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) != noErr { return 0 }
  return Int(value)
}

func propertyBool(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> Bool {
  var address = AudioObjectPropertyAddress(
    mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  if AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) != noErr { return false }
  return value != 0
}

func propertyString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
  var address = AudioObjectPropertyAddress(
    mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  if AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) != noErr { return nil }
  return value?.takeRetainedValue() as String?
}

func runDetect() {
  var rows: [[String: Any]] = []
  for object in processList() {
    rows.append([
      "pid": propertyInt(object, kAudioProcessPropertyPID),
      "bundleId": propertyString(object, kAudioProcessPropertyBundleID) ?? "",
      "input": propertyBool(object, kAudioProcessPropertyIsRunningInput),
      "output": propertyBool(object, kAudioProcessPropertyIsRunningOutput),
    ])
  }
  if let data = try? JSONSerialization.data(withJSONObject: rows, options: []) {
    print(String(data: data, encoding: .utf8) ?? "[]")
  } else {
    print("[]")
  }
}

// ── tap + aggregate device (system audio) ───────────────────────────────

func translatePidToProcessObject(_ pid: pid_t) -> AudioObjectID {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var object = AudioObjectID(kAudioObjectUnknown)
  var pidValue = pid
  var size = UInt32(MemoryLayout<AudioObjectID>.size)
  _ = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address,
                                 UInt32(MemoryLayout<pid_t>.size), &pidValue, &size, &object)
  return object
}

func tapUID(_ tapID: AudioObjectID) -> String? {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioTapPropertyUID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  if AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &value) == noErr, let v = value {
    return v.takeRetainedValue() as String
  }
  return nil
}

func tapFormat(_ tapID: AudioObjectID) -> AudioStreamBasicDescription {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var asbd = AudioStreamBasicDescription()
  var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
  if AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &asbd) != noErr {
    asbd = AudioStreamBasicDescription()
  }
  return asbd
}

/// Process objects that output audio and match one of the given bundle ids (exact or helper prefix).
func resolveTapObjects(_ bundleIds: [String]) -> [AudioObjectID] {
  var objects: [AudioObjectID] = []
  for object in processList() {
    guard propertyBool(object, kAudioProcessPropertyIsRunningOutput) else { continue }
    let bid = propertyString(object, kAudioProcessPropertyBundleID) ?? ""
    if bundleIds.contains(where: { bid == $0 || bid.hasPrefix($0) }) {
      objects.append(object)
    }
  }
  return objects
}

/// Create the tap. Returns (tapID, uid) or nil on failure.
func createSystemTap(_ bundleIds: [String]) -> (AudioObjectID, String)? {
  let ids = resolveTapObjects(bundleIds)
  let description: CATapDescription
  if !ids.isEmpty {
    description = CATapDescription(stereoMixdownOfProcesses: ids)
  } else {
    // Fall back to a global tap that excludes this helper's own process object.
    let selfObject = translatePidToProcessObject(getpid())
    description = CATapDescription(__stereoGlobalTapButExcludeProcesses: [NSNumber(value: selfObject)])
  }
  description.isPrivate = true
  var tapID = AudioObjectID(0)
  let status = AudioHardwareCreateProcessTap(description, &tapID)
  guard status == noErr else {
    fputs("createSystemTap: AudioHardwareCreateProcessTap status 0x\(String(status, radix: 16)) ids=\(ids.count)\n", stderr)
    return nil
  }
  guard let uid = tapUID(tapID) else {
    fputs("createSystemTap: tap UID unreadable\n", stderr)
    return nil
  }
  return (tapID, uid)
}

func createAggregate(tapUID: String) -> AudioObjectID? {
  // Apple "Capturing system audio with Core Audio taps": a private aggregate
  // containing the tap, with tap auto-start and sub-tap drift compensation.
  // tap auto-start (tapautostart) is deliberately omitted: it would block
  // AudioDeviceStart until a tapped process plays, and the global fallback taps
  // everything. The private tap with drift compensation is enough.
  let composition: [String: Any] = [
    "name": "meetings-capture-aggregate",
    "uid": UUID().uuidString,
    "private": 1,
    "taps": [["uid": tapUID, "drift": 1]],
  ]
  var aggID = AudioObjectID(0)
  let status = AudioHardwareCreateAggregateDevice(composition as CFDictionary, &aggID)
  return status == noErr ? aggID : nil
}

// ── recording ───────────────────────────────────────────────────────────

var stopRequested = false

func handleSignal(_ sig: Int32) {
  stopRequested = true
}

/// Append Int16 mono 16 kHz samples to a file, tracking byte count and peak amplitude.
final class PcmWriter {
  private var handle: FileHandle?
  private(set) var bytes: Int = 0
  private(set) var peak: Double = 0
  private let lock = NSLock()

  init(_ path: String) {
    FileManager.default.createFile(atPath: path, contents: nil)
    handle = try? FileHandle(forWritingTo: URL(fileURLWithPath: path))
  }

  func write(_ pcm: [Int16]) {
    lock.lock(); defer { lock.unlock() }
    guard let handle = handle, !pcm.isEmpty else { return }
    for sample in pcm {
      let magnitude = abs(Double(sample))
      if magnitude > peak { peak = magnitude }
    }
    pcm.withUnsafeBytes { buffer in
      handle.write(Data(buffer))
    }
    bytes += pcm.count * 2
  }

  func close() {
    lock.lock(); defer { lock.unlock() }
    handle?.closeFile()
    handle = nil
  }
}

/// The per-sample clamped sum of two 16 kHz mono streams; the shorter is padded with zeros.
func mix(_ a: [Int16], _ b: [Int16]) -> [Int16] {
  let n = max(a.count, b.count)
  var out = [Int16](repeating: 0, count: n)
  for i in 0 ..< n {
    let av = i < a.count ? Int(a[i]) : 0
    let bv = i < b.count ? Int(b[i]) : 0
    out[i] = Int16(max(-32768, min(32767, av + bv)))
  }
  return out
}

/// Mixes mic + system on one 16 kHz sample clock: the shorter stream is padded with zeros,
/// so a gap in one stream yields that stream's zeros, never a shorter file.
final class Mixer {
  private var handle: FileHandle?
  private var mic: [Int16] = []
  private var sys: [Int16] = []
  private let lock = NSLock()

  init(_ path: String) {
    FileManager.default.createFile(atPath: path, contents: nil)
    handle = try? FileHandle(forWritingTo: URL(fileURLWithPath: path))
  }

  func appendMic(_ pcm: [Int16]) {
    lock.lock(); defer { lock.unlock() }
    mic += pcm
    drain()
  }

  func appendSys(_ pcm: [Int16]) {
    lock.lock(); defer { lock.unlock() }
    sys += pcm
    drain()
  }

  private func drain() {
    let n = min(mic.count, sys.count)
    guard n > 0, let handle = handle else { return }
    let mixed = mix(Array(mic[0 ..< n]), Array(sys[0 ..< n]))
    mixed.withUnsafeBytes { handle.write(Data($0)) }
    mic.removeFirst(n)
    sys.removeFirst(n)
  }

  func finish() {
    lock.lock(); defer { lock.unlock() }
    guard let handle = handle else { return }
    let mixed = mix(mic, sys)
    mixed.withUnsafeBytes { handle.write(Data($0)) }
    mic.removeAll()
    sys.removeAll()
    handle.closeFile()
  }
}

func writeJson(_ path: String, _ object: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: object, options: []) {
    try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
  }
}

func appendEvent(_ path: String, _ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
  let line = String(data: data, encoding: .utf8) ?? ""
  let url = URL(fileURLWithPath: path)
  if let handle = try? FileHandle(forWritingTo: url) {
    handle.seekToEndOfFile()
    handle.write((line + NL).data(using: .utf8)!)
    handle.closeFile()
  } else {
    try? (line + NL).write(to: url, atomically: false, encoding: .utf8)
  }
}

func nowMs() -> Int64 {
  return Int64(Date().timeIntervalSince1970 * 1000)
}

func meetingId(_ dir: String) -> String {
  return (dir as NSString).lastPathComponent
}

func stateJson(_ dir: String, _ phase: String, _ startedAt: Int64, _ errorMessage: String? = nil, audioSeconds: Double = 0, audioBytes: Int = 0, audioIssue: [String: Any]? = nil) {
  var endedAt: Any = NSNull()
  var endReason: Any = NSNull()
  var error: Any = NSNull()
  if phase == "ended" {
    endedAt = nowMs()
    endReason = "stopped"
  } else if phase == "failed" {
    endedAt = nowMs()
    endReason = "error"
    error = ["code": "recording_failed", "message": errorMessage ?? "recording failed"]
  }
  var object: [String: Any] = [
    "version": 1,
    "meetingId": meetingId(dir),
    "pid": Int(getpid()),
    "phase": phase,
    "detail": phase == "in_meeting" ? "Recording locally" : phase,
    "startedAt": startedAt,
    "joinedAt": startedAt,
    "recordingStartedAt": startedAt,
    "endedAt": endedAt,
    "endReason": endReason,
    "error": error,
    "participants": ["count": NSNull(), "names": []],
    "activeSpeakers": [],
    "audio": ["seconds": audioSeconds, "bytes": audioBytes],
    "updatedAt": nowMs(),
  ]
  if let issue = audioIssue { object["audioIssue"] = issue }
  writeJson(dir + "/state.json", object)
}

func writeFailedState(_ dir: String, _ startedAt: Int64, _ message: String) {
  stateJson(dir, "failed", startedAt, message)
  appendEvent(dir + "/events.jsonl", ["t": nowMs(), "level": "error", "msg": message])
}

/// Converts the tap's native stream to 16 kHz mono Int16, honouring the
/// AudioStreamBasicDescription (channel layout, interleaving) and resampling with
/// AVAudioConverter instead of nearest-sample decimation.
final class SystemTapConverter {
  private let converter: AVAudioConverter
  private let inputFormat: AVAudioFormat
  private let outputFormat: AVAudioFormat

  init?(asbd: AudioStreamBasicDescription) {
    var s = asbd
    guard let inFmt = AVAudioFormat(streamDescription: &s) else { return nil }
    guard let outFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(SAMPLE_RATE), channels: 1, interleaved: false) else { return nil }
    guard let conv = AVAudioConverter(from: inFmt, to: outFmt) else { return nil }
    inputFormat = inFmt
    outputFormat = outFmt
    converter = conv
  }

  func toInt16(_ data: UnsafePointer<AudioBufferList>) -> [Int16] {
    let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: data))
    guard let first = buffers.first else { return [] }
    let bytesPerFrame = Int(inputFormat.streamDescription.pointee.mBytesPerFrame)
    guard bytesPerFrame > 0 else { return [] }
    let frameLength = Int(first.mDataByteSize) / bytesPerFrame
    guard frameLength > 0, let input = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: AVAudioFrameCount(frameLength)) else { return [] }
    input.frameLength = AVAudioFrameCount(frameLength)
    for i in 0 ..< buffers.count {
      let src = buffers[i]
      guard let mData = src.mData else { continue }
      let count = Int(src.mDataByteSize) / MemoryLayout<Float32>.size
      let source = UnsafeBufferPointer(start: mData.assumingMemoryBound(to: Float32.self), count: count)
      if let dest = input.floatChannelData?[i] {
        for j in 0 ..< count { dest[j] = source[j] }
      } else if let dest = input.int16ChannelData?[i] {
        for j in 0 ..< count { dest[j] = Int16(source[j] * 32767.0) }
      }
    }
    let ratio = outputFormat.sampleRate / inputFormat.sampleRate
    let outCapacity = AVAudioFrameCount(Double(input.frameLength) * ratio)
    guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: outCapacity) else { return [] }
    var fed = false
    var error: NSError?
    converter.convert(to: output, error: &error) { _, outStatus in
      outStatus.pointee = fed ? .noDataNow : .haveData
      fed = true
      return input
    }
    guard output.frameLength > 0, let channel = output.floatChannelData?[0] else { return [] }
    return Array(UnsafeBufferPointer(start: channel, count: Int(output.frameLength))).map { Int16(max(-1.0, min(1.0, Double($0))) * 32767.0) }
  }
}

/// Resample Float32 mono at srcRate to Int16 mono 16 kHz (nearest sample).
func resampleMono(_ src: [Float], srcRate: Double) -> [Int16] {
  guard !src.isEmpty else { return [] }
  let ratio = srcRate / Double(SAMPLE_RATE)
  var out: [Int16] = []
  out.reserveCapacity(Int(Double(src.count) / ratio) + 1)
  var position = 0.0
  while Int(position) < src.count {
    let v = src[Int(position)]
    let clamped = max(-1.0, min(1.0, Double(v)))
    out.append(Int16(clamped * 32767.0))
    position += ratio
  }
  return out
}

/// Extract downmixed mono Float32 from an AudioBufferList.
func monoFloat(_ data: UnsafePointer<AudioBufferList>) -> [Float] {
  let list = data.pointee
  guard list.mNumberBuffers > 0 else { return [] }
  let bufferCount = Int(list.mNumberBuffers)
  let buffersPtr = withUnsafePointer(to: list.mBuffers) { UnsafeRawPointer($0).assumingMemoryBound(to: AudioBuffer.self) }
  var channelsData: [[Float]] = []
  for i in 0 ..< bufferCount {
    let ab = buffersPtr[i]
    guard let mData = ab.mData else { continue }
    let count = Int(ab.mDataByteSize) / MemoryLayout<Float>.size
    let samples = UnsafeBufferPointer(start: mData.assumingMemoryBound(to: Float.self), count: count)
    channelsData.append(Array(samples))
  }
  guard let first = channelsData.first else { return [] }
  let count = first.count
  var result: [Float] = []
  result.reserveCapacity(count)
  for j in 0 ..< count {
    var sum: Float = 0
    var n = 0
    for c in channelsData where j < c.count { sum += c[j]; n += 1 }
    result.append(n > 0 ? sum / Float(n) : 0)
  }
  return result
}

/// Compress audio.pcm (s16le 16 kHz mono) to audio.ogg (Opus 48 kHz mono), like bot mode.
func compressOgg(_ meetingDir: String) -> Bool {
  let pcm = meetingDir + "/audio.pcm"
  let ogg = meetingDir + "/audio.ogg"
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
  process.arguments = [
    "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "s16le", "-ar", "16000", "-ac", "1", "-i", pcm,
    "-ar", "48000", "-ac", "1", "-c:a", "libopus", "-b:a", "32k", "-application", "voip", "-f", "ogg", ogg,
  ]
  process.standardOutput = FileHandle.nullDevice
  process.standardError = FileHandle.nullDevice
  do {
    try process.run()
    process.waitUntilExit()
  } catch {
    return false
  }
  return process.terminationStatus == 0
}

/// True when the system stream was expected but recorded nothing but zeros (DESIGN §15).
func systemStreamIsSilent(peak: Double, bytes: Int, started: Bool) -> Bool {
  return started && bytes > 0 && peak <= 0
}

/// The system-audio issue for a finished recording, or nil (DESIGN §15, decision B5).
/// - not started, or started but no bytes: a capture issue (operation failed).
/// - started with only zeros: a permission hint only when a tapped process really played;
///   otherwise it is genuine silence and there is no issue.
func systemCaptureIssue(bytes: Int, peak: Double, started: Bool, hadTappedOutput: Bool) -> String? {
  if !started {
    return "системный звук не записан: не удалось запустить захват"
  }
  if bytes == 0 {
    return "системный звук не записан: захват не выдал данных"
  }
  if peak <= 0 {
    return hadTappedOutput ? "системный звук пуст, хотя приложение воспроизводило звук (проверьте разрешение «Запись системного звука»)" : nil
  }
  return nil
}

/// Self-test: the mix on one sample clock and the zero-detection predicates.
func runSelfTest() -> Int32 {
  var ok = true
  func check(_ name: String, _ cond: Bool) {
    if !cond { ok = false }
    print("selftest \(name): \(cond ? "ok" : "FAIL")" + NL)
  }

  // mix: 1 s of constant 1000 plus 1 s of constant 2000 -> 16000 samples of 3000.
  let a = [Int16](repeating: 1000, count: 16_000)
  let b = [Int16](repeating: 2000, count: 16_000)
  let m = mix(a, b)
  check("mix-sum", m.count == 16_000 && m.allSatisfy { $0 == 3000 })

  // clamp: 30000 + 30000 -> 32767.
  let big = [Int16](repeating: 30_000, count: 100)
  check("mix-clamp", mix(big, big).allSatisfy { $0 == 32767 })

  // a 0.5 s gap in one stream gives that stream's zeros, not a shorter file.
  let half = [Int16](repeating: 1000, count: 8_000)
  let gapped = mix(a, half)
  check("mix-gap", gapped.count == 16_000 && gapped[0 ..< 8_000].allSatisfy { $0 == 2000 } && gapped[8_000...].allSatisfy { $0 == 1000 })

  // zero-detection.
  check("zero-all-zero", systemStreamIsSilent(peak: 0, bytes: 32_000, started: true))
  check("zero-nonzero", !systemStreamIsSilent(peak: 100, bytes: 32_000, started: true))
  check("zero-not-started", !systemStreamIsSilent(peak: 0, bytes: 32_000, started: false))

  // issue: never started, no bytes, silent-with-output, genuine silence.
  check("issue-not-started", systemCaptureIssue(bytes: 0, peak: 0, started: false, hadTappedOutput: false) != nil)
  check("issue-no-bytes", systemCaptureIssue(bytes: 0, peak: 0, started: true, hadTappedOutput: false) != nil)
  check("issue-silent-with-output", systemCaptureIssue(bytes: 32_000, peak: 0, started: true, hadTappedOutput: true) != nil)
  check("issue-genuine-silence", systemCaptureIssue(bytes: 32_000, peak: 0, started: true, hadTappedOutput: false) == nil)

  return ok ? 0 : 1
}

func runRecord(_ meetingDir: String, _ bundleIds: [String]) {
  signal(SIGTERM, handleSignal)
  signal(SIGINT, handleSignal)

  let startedAt = nowMs()
  stateJson(meetingDir, "in_meeting", startedAt)
  appendEvent(meetingDir + "/events.jsonl", ["t": startedAt, "level": "info", "msg": "local recording started"])

  let micWriter = PcmWriter(meetingDir + "/mic.pcm")
  let sysWriter = PcmWriter(meetingDir + "/system.pcm")
  let mixer = Mixer(meetingDir + "/audio.pcm")

  // ── microphone (AVAudioEngine, default input) ─────────────────────────
  let micEngine = AVAudioEngine()
  let micInput = micEngine.inputNode
  let micFormat = micInput.outputFormat(forBus: 0)
  guard micFormat.channelCount > 0 else {
    writeFailedState(meetingDir, startedAt, "Микрофон не найден: запись невозможна")
    exit(1)
  }
  guard let micOutFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(SAMPLE_RATE), channels: 1, interleaved: false) else {
    writeFailedState(meetingDir, startedAt, "Не удалось создать формат записи микрофона")
    exit(1)
  }
  guard let micConverter = AVAudioConverter(from: micFormat, to: micOutFormat) else {
    writeFailedState(meetingDir, startedAt, "Не удалось создать преобразователь микрофона")
    exit(1)
  }
  micInput.installTap(onBus: 0, bufferSize: 1024, format: micFormat) { buffer, _ in
    let ratio = micOutFormat.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio)
    guard let converted = AVAudioPCMBuffer(pcmFormat: micOutFormat, frameCapacity: capacity) else { return }
    var fed = false
    var error: NSError?
    micConverter.convert(to: converted, error: &error) { _, outStatus in
      outStatus.pointee = fed ? .noDataNow : .haveData
      fed = true
      return buffer
    }
    if converted.frameLength > 0, let channel = converted.floatChannelData?[0] {
      let samples = Array(UnsafeBufferPointer(start: channel, count: Int(converted.frameLength)))
      let pcm = samples.map { Int16(max(-1.0, min(1.0, Double($0))) * 32767.0) }
      micWriter.write(pcm)
      mixer.appendMic(pcm)
    }
  }
  micEngine.prepare()
  do {
    try micEngine.start()
  } catch {
    writeFailedState(meetingDir, startedAt, "Микрофон: разрешите доступ приложению BB (Системные настройки → Конфиденциальность и безопасность → Микрофон)")
    exit(1)
  }

  // ── system audio (process tap + private aggregate device + IO proc) ────
  var systemStarted = false
  var systemTapID: AudioObjectID? = nil
  var systemAggID: AudioObjectID? = nil
  var systemIOProcID: AudioDeviceIOProcID? = nil
  let hadTappedOutput = !resolveTapObjects(bundleIds).isEmpty
  if let (tapID, uid) = createSystemTap(bundleIds), let aggID = createAggregate(tapUID: uid) {
    systemTapID = tapID
    systemAggID = aggID
    let asbd = tapFormat(tapID)
    let sysConverter = SystemTapConverter(asbd: asbd)
    var ioProcID: AudioDeviceIOProcID? = nil
    let status = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggID, nil) { _now, inInputData, _inInputTime, _outOutputData, _inOutputTime in
      guard let conv = sysConverter else { return }
      let pcm = conv.toInt16(inInputData)
      sysWriter.write(pcm)
      mixer.appendSys(pcm)
    }
    if status == noErr {
      systemIOProcID = ioProcID
      let startStatus = AudioDeviceStart(aggID, ioProcID)
      systemStarted = (startStatus == noErr)
      if !systemStarted {
        appendEvent(meetingDir + "/events.jsonl", ["t": nowMs(), "level": "warn", "msg": "system audio tap did not start (permission denied or unavailable)"])
      }
    } else {
      appendEvent(meetingDir + "/events.jsonl", ["t": nowMs(), "level": "warn", "msg": "could not register the system audio IO proc"])
    }
  } else {
    appendEvent(meetingDir + "/events.jsonl", ["t": nowMs(), "level": "warn", "msg": "system audio tap could not be created (System Audio Recording permission)"])
  }

  var lastBeat = Date()
  while !stopRequested {
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1))
    let now = Date()
    if now.timeIntervalSince(lastBeat) >= 1.0 {
      lastBeat = now
      stateJson(meetingDir, "in_meeting", startedAt, nil,
                audioSeconds: Double(micWriter.bytes) / 2.0 / Double(SAMPLE_RATE),
                audioBytes: micWriter.bytes + sysWriter.bytes)
    }
    // The host writes stop.request to ask us to stop (the same signal the bot polls).
    if FileManager.default.fileExists(atPath: meetingDir + "/stop.request") {
      stopRequested = true
    }
  }

  // Stop the system IO first so no writer is written while it is being closed.
  if let aggID = systemAggID, let ioProcID = systemIOProcID {
    AudioDeviceStop(aggID, ioProcID)
    AudioDeviceDestroyIOProcID(aggID, ioProcID)
  }
  if let aggID = systemAggID {
    AudioHardwareDestroyAggregateDevice(aggID)
  }
  if let tapID = systemTapID {
    AudioHardwareDestroyProcessTap(tapID)
  }

  micEngine.stop()
  micInput.removeTap(onBus: 0)
  micWriter.close()
  sysWriter.close()
  mixer.finish()

  // ── compressed copy for playback (audio.ogg, Opus) ─────────────────────
  if !compressOgg(meetingDir) {
    appendEvent(meetingDir + "/events.jsonl", ["t": nowMs(), "level": "warn", "msg": "audio.ogg was not produced (ffmpeg missing or failed); playback unavailable"])
  }

  // ── finish (DESIGN §15, decision B5): a usable microphone recording is never thrown away. ──
  let micPeak = micWriter.peak
  let sysPeak = sysWriter.peak
  let audioSeconds = Double(micWriter.bytes) / 2.0 / Double(SAMPLE_RATE)
  let audioBytes = micWriter.bytes + sysWriter.bytes
  appendEvent(meetingDir + "/events.jsonl", [
    "t": nowMs(), "level": "info", "msg": "local recording stopped",
    "data": ["micBytes": micWriter.bytes, "systemBytes": sysWriter.bytes,
             "micPeak": micPeak, "systemPeak": sysPeak, "systemStarted": systemStarted],
  ])

  // Microphone empty or all-zero: a genuine recording failure, not a capture issue.
  if micWriter.bytes == 0 || micPeak <= 0 {
    writeFailedState(meetingDir, startedAt, "Микрофон пуст: запись невозможна (проверьте разрешение «Микрофон» для приложения BB)")
    exit(1)
  }

  // System audio failed or is silent while a tapped process played: keep the recording,
  // but surface a visible audioIssue (reason capture) naming the operation.
  if let issue = systemCaptureIssue(bytes: sysWriter.bytes, peak: sysPeak, started: systemStarted, hadTappedOutput: hadTappedOutput) {
    appendEvent(meetingDir + "/events.jsonl", ["t": nowMs(), "level": "warn", "msg": issue])
    stateJson(meetingDir, "ended", startedAt, nil, audioSeconds: audioSeconds, audioBytes: audioBytes,
              audioIssue: ["since": nowMs(), "attempts": 0, "lastAction": NSNull(), "message": issue, "reason": "capture"])
    return
  }

  stateJson(meetingDir, "ended", startedAt, nil, audioSeconds: audioSeconds, audioBytes: audioBytes)
}

// ── main ────────────────────────────────────────────────────────────────

let arguments = CommandLine.arguments
if arguments.count >= 2 && arguments[1] == "selftest" {
  exit(runSelfTest())
} else if arguments.count >= 2 && arguments[1] == "detect" {
  runDetect()
} else if arguments.count >= 2 && arguments[1] == "record" {
  var meetingDir = FileManager.default.currentDirectoryPath
  var bundleIds: [String] = []
  if let index = arguments.firstIndex(of: "--meeting-dir"), index + 1 < arguments.count {
    meetingDir = arguments[index + 1]
  }
  if let index = arguments.firstIndex(of: "--bundle-ids"), index + 1 < arguments.count {
    bundleIds = arguments[index + 1].split(separator: ",").map { String($0) }
  }
  runRecord(meetingDir, bundleIds)
} else {
  FileHandle.standardError.write(("usage: capture detect | record --meeting-dir <dir> [--bundle-ids ids]" + NL).data(using: .utf8)!)
  exit(2)
}
