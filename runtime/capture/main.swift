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
      "inputDevices": processInputDevices(object).map(deviceName),
    ])
  }
  if let data = try? JSONSerialization.data(withJSONObject: rows, options: []) {
    print(String(data: data, encoding: .utf8) ?? "[]")
  } else {
    print("[]")
  }
}

// ── microphone device ───────────────────────────────────────────────────

/// The devices an audio client process uses for input.
func processInputDevices(_ object: AudioObjectID) -> [AudioDeviceID] {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioProcessPropertyDevices, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(object, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
  var devices = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
  guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &devices) == noErr else { return [] }
  return devices
}

/// Input devices of the meeting app's processes that hold the microphone right now.
func appInputDevices(_ bundleIds: [String]) -> [AudioDeviceID] {
  var devices: [AudioDeviceID] = []
  for object in processList() where propertyBool(object, kAudioProcessPropertyIsRunningInput) {
    let bid = propertyString(object, kAudioProcessPropertyBundleID) ?? ""
    guard bundleIds.contains(where: { bid == $0 || bid.hasPrefix($0) }) else { continue }
    for device in processInputDevices(object) where !devices.contains(device) { devices.append(device) }
  }
  return devices
}

func defaultInputDevice() -> AudioDeviceID? {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var device = AudioDeviceID(kAudioObjectUnknown)
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr,
        device != kAudioObjectUnknown else { return nil }
  return device
}

func deviceName(_ device: AudioDeviceID) -> String {
  return propertyString(device, kAudioObjectPropertyName) ?? "устройство \(device)"
}

/// The microphone to record: the one the meeting app is using, because the system
/// default may be a different, dead input (a MacBook's own microphone with the lid
/// closed). The system default only when the app's device cannot be read.
func pickInputDevice(appDevices: [AudioDeviceID], systemDefault: AudioDeviceID?) -> (device: AudioDeviceID, fromApp: Bool)? {
  if let device = appDevices.first(where: { $0 != kAudioObjectUnknown }) {
    return (device, true)
  }
  if let device = systemDefault {
    return (device, false)
  }
  return nil
}

/// Point the engine's input at a device. Must run before the input format is read.
func selectInputDevice(_ node: AVAudioInputNode, _ device: AudioDeviceID) -> OSStatus {
  guard let unit = node.audioUnit else { return kAudioUnitErr_Uninitialized }
  var id = device
  return AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
                              &id, UInt32(MemoryLayout<AudioDeviceID>.size))
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

/// A failed Core Audio step: which operation, and the OSStatus it returned.
struct CaptureFailure {
  let operation: String
  let status: OSStatus

  /// "AudioHardwareCreateAggregateDevice → 'nope' (1852797029)"
  var text: String { "\(operation) → \(describeStatus(status))" }
}

/// An OSStatus as its four-character code when printable, always with the number.
func describeStatus(_ status: OSStatus) -> String {
  let value = UInt32(bitPattern: status)
  let bytes = [UInt8(value >> 24 & 0xff), UInt8(value >> 16 & 0xff), UInt8(value >> 8 & 0xff), UInt8(value & 0xff)]
  if bytes.allSatisfy({ $0 >= 0x20 && $0 < 0x7f }), let code = String(bytes: bytes, encoding: .ascii) {
    return "'\(code)' (\(status))"
  }
  return "\(status)"
}

enum Step<T> {
  case ok(T)
  case failed(CaptureFailure)
}

/// Create the tap: the app's playing processes, or everything but this helper when none plays yet.
func createSystemTap(_ bundleIds: [String]) -> Step<(AudioObjectID, String)> {
  let ids = resolveTapObjects(bundleIds)
  let description: CATapDescription
  if !ids.isEmpty {
    description = CATapDescription(stereoMixdownOfProcesses: ids)
  } else {
    let selfObject = translatePidToProcessObject(getpid())
    description = CATapDescription(__stereoGlobalTapButExcludeProcesses: [NSNumber(value: selfObject)])
  }
  description.isPrivate = true
  var tapID = AudioObjectID(0)
  let status = AudioHardwareCreateProcessTap(description, &tapID)
  guard status == noErr else {
    return .failed(CaptureFailure(operation: "AudioHardwareCreateProcessTap", status: status))
  }
  guard let uid = tapUID(tapID) else {
    AudioHardwareDestroyProcessTap(tapID)
    return .failed(CaptureFailure(operation: "kAudioTapPropertyUID", status: kAudioHardwareUnknownPropertyError))
  }
  return .ok((tapID, uid))
}

func createAggregate(tapUID: String) -> Step<AudioObjectID> {
  // Apple "Capturing system audio with Core Audio taps": a private aggregate that
  // contains the tap, with sub-tap drift compensation. Tap auto-start is left out:
  // AudioDeviceStart starts the tap itself.
  let composition: [String: Any] = [
    kAudioAggregateDeviceNameKey: "meetings-capture-aggregate",
    kAudioAggregateDeviceUIDKey: UUID().uuidString,
    kAudioAggregateDeviceIsPrivateKey: 1,
    kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: tapUID, kAudioSubTapDriftCompensationKey: 1]],
  ]
  var aggID = AudioObjectID(0)
  let status = AudioHardwareCreateAggregateDevice(composition as CFDictionary, &aggID)
  guard status == noErr else {
    return .failed(CaptureFailure(operation: "AudioHardwareCreateAggregateDevice", status: status))
  }
  return .ok(aggID)
}

/// True when any process other than this helper is playing audio (the global fallback's "tapped output").
func anyOtherOutput() -> Bool {
  let selfPid = Int(getpid())
  for object in processList() where propertyBool(object, kAudioProcessPropertyIsRunningOutput) {
    if propertyInt(object, kAudioProcessPropertyPID) != selfPid { return true }
  }
  return false
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

  /// Zeros for a gap in the stream; they do not count towards the peak.
  func writeSilence(_ samples: Int) {
    lock.lock(); defer { lock.unlock() }
    guard let handle = handle, samples > 0 else { return }
    handle.write(Data(count: samples * 2))
    bytes += samples * 2
  }

  func close() {
    lock.lock(); defer { lock.unlock() }
    handle?.closeFile()
    handle = nil
  }
}

/// Clamp a summed sample to Int16.
func clampSample(_ value: Int32) -> Int16 {
  return Int16(max(-32768, min(32767, value)))
}

/// The per-sample clamped sum of two 16 kHz mono streams; the shorter is padded with zeros.
func mix(_ a: [Int16], _ b: [Int16]) -> [Int16] {
  let n = max(a.count, b.count)
  var out = [Int16](repeating: 0, count: n)
  for i in 0 ..< n {
    let av: Int32 = i < a.count ? Int32(a[i]) : 0
    let bv: Int32 = i < b.count ? Int32(b[i]) : 0
    out[i] = clampSample(av + bv)
  }
  return out
}

/// Places one stream's buffers on the recording's sample clock (16 kHz samples
/// since the recording started). A buffer that arrives close to where the stream
/// already is continues it; a buffer whose timestamp is later than that by more
/// than the tolerance leaves a gap, which the caller fills with zeros.
struct StreamClock {
  /// Callback timestamps jitter by a few milliseconds; below this the stream is contiguous.
  static let tolerance = SAMPLE_RATE / 10
  private(set) var position = 0

  /// The output index of a buffer of `count` samples stamped at `start`.
  mutating func place(start: Int, count: Int) -> Int {
    let index = start > position + StreamClock.tolerance ? start : position
    position = index + count
    return index
  }
}

/// Sums two streams on one sample clock and emits the mix in order. Output
/// advances to where both streams have reached, and never waits more than
/// `maxLag` samples for the slower one: a stream that is late, silent or absent
/// contributes zeros. Pure: the sink receives the samples.
final class TimelineMixer {
  static let maxLag = SAMPLE_RATE
  private var pending: [Int32] = []
  private var heads = [0, 0]
  private(set) var written = 0
  private let sink: ([Int16]) -> Void

  init(sink: @escaping ([Int16]) -> Void) {
    self.sink = sink
  }

  /// Samples held back, waiting for the other stream.
  var buffered: Int { pending.count }

  func add(stream: Int, index: Int, samples: [Int16]) {
    var first = 0
    var at = index
    if at < written {
      // Older than what was already emitted: that part is lost to the mix.
      first = min(samples.count, written - at)
      at = written
    }
    let offset = at - written
    let end = offset + samples.count - first
    if pending.count < end {
      pending.append(contentsOf: [Int32](repeating: 0, count: end - pending.count))
    }
    for i in first ..< samples.count {
      pending[offset + i - first] += Int32(samples[i])
    }
    heads[stream] = max(heads[stream], index + samples.count)
    flush(upTo: max(min(heads[0], heads[1]), max(heads[0], heads[1]) - TimelineMixer.maxLag))
  }

  /// Emit everything that is still held back.
  func finish() {
    flush(upTo: written + pending.count)
  }

  private func flush(upTo target: Int) {
    let count = min(target - written, pending.count)
    guard count > 0 else { return }
    sink(pending[0 ..< count].map(clampSample))
    pending.removeFirst(count)
    written += count
  }
}

/// mic.pcm, system.pcm and the mixed audio.pcm on one sample clock. Gaps in a
/// stream are written as zeros to its own file too, so a position in any of the
/// three files is the same moment of the recording.
final class RecordingStreams {
  static let mic = 0
  static let system = 1
  let writers: [PcmWriter]
  private let mixWriter: PcmWriter
  private var clocks = [StreamClock(), StreamClock()]
  private var filled = [0, 0]
  private var mixer: TimelineMixer!
  private let lock = NSLock()
  private var closed = false

  init(_ meetingDir: String) {
    writers = [PcmWriter(meetingDir + "/mic.pcm"), PcmWriter(meetingDir + "/system.pcm")]
    mixWriter = PcmWriter(meetingDir + "/audio.pcm")
    let out = mixWriter
    mixer = TimelineMixer { out.write($0) }
  }

  func append(_ stream: Int, start: Int, _ pcm: [Int16]) {
    lock.lock(); defer { lock.unlock() }
    guard !closed, !pcm.isEmpty else { return }
    let index = clocks[stream].place(start: max(0, start), count: pcm.count)
    if index > filled[stream] {
      writers[stream].writeSilence(index - filled[stream])
    }
    writers[stream].write(pcm)
    filled[stream] = index + pcm.count
    mixer.add(stream: stream, index: index, samples: pcm)
  }

  func finish() {
    lock.lock(); defer { lock.unlock() }
    closed = true
    mixer.finish()
    writers.forEach { $0.close() }
    mixWriter.close()
  }
}

/// Mach host time in seconds.
func hostSeconds(_ hostTime: UInt64) -> Double {
  var info = mach_timebase_info_data_t()
  mach_timebase_info(&info)
  return Double(hostTime) * Double(info.numer) / Double(info.denom) / 1_000_000_000
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
    // Copy buffer by buffer: one for interleaved input, one per channel otherwise.
    let target = UnsafeMutableAudioBufferListPointer(input.mutableAudioBufferList)
    for i in 0 ..< min(buffers.count, target.count) {
      guard let from = buffers[i].mData, let to = target[i].mData else { continue }
      memcpy(to, from, min(Int(buffers[i].mDataByteSize), Int(target[i].mDataByteSize)))
    }
    let ratio = outputFormat.sampleRate / inputFormat.sampleRate
    let outCapacity = AVAudioFrameCount(Double(input.frameLength) * ratio) + 1
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

/// How long the system path may take to start before it is reported as not started.
let SYSTEM_START_TIMEOUT_S = 10.0
/// A zero-only system stream is judged only after this much of it was delivered.
let SILENCE_JUDGE_SAMPLES = SAMPLE_RATE * 10

/// What the system-audio path has done so far.
struct SystemCaptureStatus {
  /// A Core Audio step failed: the path never delivered audio.
  var failure: CaptureFailure? = nil
  /// AudioDeviceStart returned success.
  var started = false
  /// AudioDeviceStart has not returned within the timeout (macOS is waiting for consent).
  var timedOut = false
  /// Samples the IO proc delivered.
  var samples = 0
  /// Loudest delivered sample.
  var peak = 0.0
  /// A tapped process was seen playing audio at some point during the recording.
  var tappedOutput = false
}

let ONLY_MICROPHONE = "записан только микрофон"
let SYSTEM_AUDIO_PERMISSION = "разрешите BB «Запись системного звука» в Системных настройках → Конфиденциальность и безопасность"

/// The system-audio issue to show for this status, or nil. `final` is the end
/// of the recording: until then a stream is not judged before it had time to start.
/// A usable microphone recording is never discarded: these are warnings.
func systemCaptureIssue(_ status: SystemCaptureStatus, final: Bool) -> String? {
  if let failure = status.failure {
    return "Системный звук не записан: \(failure.text); \(ONLY_MICROPHONE)"
  }
  if !status.started {
    guard status.timedOut || final else { return nil }
    return "Системный звук не записан: AudioDeviceStart не ответил за \(Int(SYSTEM_START_TIMEOUT_S)) с; \(SYSTEM_AUDIO_PERMISSION); \(ONLY_MICROPHONE)"
  }
  if status.samples == 0 {
    guard final else { return nil }
    return "Системный звук не записан: AudioDeviceStart прошёл, но захват не выдал данных; \(ONLY_MICROPHONE)"
  }
  if status.peak <= 0 && status.tappedOutput && (final || status.samples >= SILENCE_JUDGE_SAMPLES) {
    return "Системный звук пуст, хотя приложение воспроизводило звук: \(SYSTEM_AUDIO_PERMISSION); \(ONLY_MICROPHONE)"
  }
  return nil
}

let MICROPHONE_PERMISSION = "устройство отключено (например, закрыта крышка ноутбука) или BB не разрешён доступ к микрофону в Системных настройках → Конфиденциальность и безопасность"

/// The microphone issue, or nil. A live microphone always carries some noise, so
/// a stream of exact zeros means the device is dead or macOS is withholding it.
/// Judged like the system stream: not before it had time to deliver.
func microphoneIssue(device: String, samples: Int, peak: Double, final: Bool) -> String? {
  if samples == 0 {
    return final ? "Микрофон «\(device)» не записан: AVAudioEngine не выдал данных; \(MICROPHONE_PERMISSION)" : nil
  }
  if peak <= 0 && (final || samples >= SILENCE_JUDGE_SAMPLES) {
    return "Микрофон «\(device)» выдаёт тишину: \(MICROPHONE_PERMISSION)"
  }
  return nil
}

/// Self-test of the pure parts: mixing on one clock and the capture-issue rules.
func runSelfTest() -> Int32 {
  var ok = true
  func check(_ name: String, _ cond: Bool) {
    if !cond { ok = false }
    print("selftest \(name): \(cond ? "ok" : "FAIL")")
  }

  // mix: 1 s of constant 1000 plus 1 s of constant 2000 -> 16000 samples of 3000.
  let a = [Int16](repeating: 1000, count: 16_000)
  let b = [Int16](repeating: 2000, count: 16_000)
  let m = mix(a, b)
  check("mix-sum", m.count == 16_000 && m.allSatisfy { $0 == 3000 })
  // clamp: 30000 + 30000 -> 32767.
  let big = [Int16](repeating: 30_000, count: 100)
  check("mix-clamp", mix(big, big).allSatisfy { $0 == 32767 })

  // Feed a mixer 100 ms buffers the way the callbacks do; returns the output and the largest backlog.
  func run(_ feed: (TimelineMixer, inout StreamClock, inout StreamClock, Int) -> Void, ticks: Int) -> ([Int16], Int) {
    var out: [Int16] = []
    var backlog = 0
    let mixer = TimelineMixer { out.append(contentsOf: $0) }
    var mic = StreamClock()
    var sys = StreamClock()
    for tick in 0 ..< ticks {
      feed(mixer, &mic, &sys, tick)
      backlog = max(backlog, mixer.buffered)
    }
    mixer.finish()
    return (out, backlog)
  }
  let chunk = 1_600
  let micChunk = [Int16](repeating: 1000, count: chunk)
  let sysChunk = [Int16](repeating: 2000, count: chunk)

  // Microphone only for 3 s: 48000 samples equal to the microphone, never more than 1 s held back.
  let (micOnly, micOnlyBacklog) = run({ mixer, mic, _, tick in
    mixer.add(stream: 0, index: mic.place(start: tick * chunk, count: chunk), samples: micChunk)
  }, ticks: 30)
  check("timeline-mic-only", micOnly.count == 48_000 && micOnly.allSatisfy { $0 == 1000 })
  check("timeline-mic-only-backlog", micOnlyBacklog <= 16_000)

  // System stream starting 2 s late: its first sample lands at output index 32000.
  let (late, lateBacklog) = run({ mixer, mic, sys, tick in
    mixer.add(stream: 0, index: mic.place(start: tick * chunk, count: chunk), samples: micChunk)
    if tick >= 20 {
      mixer.add(stream: 1, index: sys.place(start: tick * chunk, count: chunk), samples: sysChunk)
    }
  }, ticks: 30)
  check("timeline-late-start", late.count == 48_000 && late[31_999] == 1000 && late[32_000] == 3000 && late[47_999] == 3000)
  check("timeline-late-start-backlog", lateBacklog <= 16_000)

  // A 0.5 s gap in the system stream (ticks 10-14): zeros there, total length unchanged.
  let (gap, gapBacklog) = run({ mixer, mic, sys, tick in
    mixer.add(stream: 0, index: mic.place(start: tick * chunk, count: chunk), samples: micChunk)
    if tick < 10 || tick >= 15 {
      mixer.add(stream: 1, index: sys.place(start: tick * chunk, count: chunk), samples: sysChunk)
    }
  }, ticks: 30)
  check("timeline-gap", gap.count == 48_000 && gap[15_999] == 3000 && gap[16_000 ..< 24_000].allSatisfy { $0 == 1000 } && gap[24_000] == 3000)
  check("timeline-gap-backlog", gapBacklog <= 16_000)

  // Timestamps that jitter by 5 ms do not open gaps.
  var jitter = StreamClock()
  let first = jitter.place(start: 0, count: chunk)
  let second = jitter.place(start: chunk + 80, count: chunk)
  check("clock-jitter", first == 0 && second == 1_600)
  var jump = StreamClock()
  _ = jump.place(start: 0, count: chunk)
  check("clock-gap", jump.place(start: 9_600, count: chunk) == 9_600)

  // Capture issue rules.
  let nope = CaptureFailure(operation: "AudioHardwareCreateAggregateDevice", status: 1_852_797_029)
  check("status-fourcc", describeStatus(1_852_797_029) == "'nope' (1852797029)")
  check("status-number", describeStatus(-50) == "-50")
  let failed = systemCaptureIssue(SystemCaptureStatus(failure: nope), final: false)
  check("issue-failure-names-operation", failed == "Системный звук не записан: AudioHardwareCreateAggregateDevice → 'nope' (1852797029); записан только микрофон")
  check("issue-starting-is-quiet", systemCaptureIssue(SystemCaptureStatus(), final: false) == nil)
  check("issue-start-timeout", systemCaptureIssue(SystemCaptureStatus(timedOut: true), final: false)?.contains("AudioDeviceStart не ответил за 10 с") == true)
  check("issue-never-started-at-end", systemCaptureIssue(SystemCaptureStatus(), final: true) != nil)
  check("issue-no-samples-at-end", systemCaptureIssue(SystemCaptureStatus(started: true), final: true)?.contains("захват не выдал данных") == true)
  check("issue-no-samples-early", systemCaptureIssue(SystemCaptureStatus(started: true), final: false) == nil)
  check("issue-zeros-with-output", systemCaptureIssue(SystemCaptureStatus(started: true, samples: 160_000, peak: 0, tappedOutput: true), final: false)?.contains("Системный звук пуст") == true)
  check("issue-zeros-too-early", systemCaptureIssue(SystemCaptureStatus(started: true, samples: 16_000, peak: 0, tappedOutput: true), final: false) == nil)
  check("issue-genuine-silence", systemCaptureIssue(SystemCaptureStatus(started: true, samples: 160_000, peak: 0, tappedOutput: false), final: true) == nil)
  check("issue-audible", systemCaptureIssue(SystemCaptureStatus(started: true, samples: 160_000, peak: 900, tappedOutput: true), final: true) == nil)

  // Microphone issue rules.
  check("mic-zeros", microphoneIssue(device: "MacBook Pro Microphone", samples: 160_000, peak: 0, final: false) == "Микрофон «MacBook Pro Microphone» выдаёт тишину: устройство отключено (например, закрыта крышка ноутбука) или BB не разрешён доступ к микрофону в Системных настройках → Конфиденциальность и безопасность")
  check("mic-zeros-too-early", microphoneIssue(device: "x", samples: 16_000, peak: 0, final: false) == nil)
  check("mic-no-samples-at-end", microphoneIssue(device: "x", samples: 0, peak: 0, final: true)?.contains("AVAudioEngine не выдал данных") == true)
  check("mic-audible", microphoneIssue(device: "x", samples: 160_000, peak: 40, final: true) == nil)

  // Microphone choice: the meeting app's device wins over the system default.
  let fromApp = pickInputDevice(appDevices: [91, 57], systemDefault: 57)
  check("mic-pick-app-device", fromApp?.device == 91 && fromApp?.fromApp == true)
  let fromDefault = pickInputDevice(appDevices: [], systemDefault: 57)
  check("mic-pick-default", fromDefault?.device == 57 && fromDefault?.fromApp == false)
  check("mic-pick-skips-unknown", pickInputDevice(appDevices: [0, 91], systemDefault: 57)?.device == 91)
  check("mic-pick-none", pickInputDevice(appDevices: [], systemDefault: nil) == nil)

  return ok ? 0 : 1
}

/// The system-audio path: tap, private aggregate device, IO proc. It starts on
/// its own thread because AudioDeviceStart can block for as long as macOS waits
/// for the System Audio Recording consent; the recording loop must keep running.
final class SystemCapture {
  private let lock = NSLock()
  private var status = SystemCaptureStatus()
  private var tapID: AudioObjectID? = nil
  private var aggregateID: AudioObjectID? = nil
  private var ioProcID: AudioDeviceIOProcID? = nil
  private var starting = false
  private let startedAt = Date()
  /// True when the tap covers all system audio because the app was not playing yet.
  private(set) var fallback = false

  var snapshot: SystemCaptureStatus {
    lock.lock(); defer { lock.unlock() }
    var copy = status
    copy.timedOut = starting && Date().timeIntervalSince(startedAt) >= SYSTEM_START_TIMEOUT_S
    return copy
  }

  func noteTappedOutput() {
    lock.lock(); defer { lock.unlock() }
    status.tappedOutput = true
  }

  private func fail(_ failure: CaptureFailure) {
    lock.lock(); defer { lock.unlock() }
    status.failure = failure
  }

  func start(bundleIds: [String], streams: RecordingStreams, clockStart: Double) {
    fallback = resolveTapObjects(bundleIds).isEmpty
    lock.lock(); starting = true; lock.unlock()
    Thread.detachNewThread { [self] in
      run(bundleIds: bundleIds, streams: streams, clockStart: clockStart)
      lock.lock(); starting = false; lock.unlock()
    }
  }

  private func run(bundleIds: [String], streams: RecordingStreams, clockStart: Double) {
    let tap: AudioObjectID
    let uid: String
    switch createSystemTap(bundleIds) {
    case let .ok((id, tapUid)): tap = id; uid = tapUid
    case let .failed(failure): fail(failure); return
    }
    lock.lock(); tapID = tap; lock.unlock()
    let aggregate: AudioObjectID
    switch createAggregate(tapUID: uid) {
    case let .ok(id): aggregate = id
    case let .failed(failure): fail(failure); return
    }
    lock.lock(); aggregateID = aggregate; lock.unlock()
    guard let converter = SystemTapConverter(asbd: tapFormat(tap)) else {
      fail(CaptureFailure(operation: "kAudioTapPropertyFormat", status: kAudioHardwareUnsupportedOperationError))
      return
    }
    var procID: AudioDeviceIOProcID? = nil
    let created = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregate, nil) { [self] _, input, inputTime, _, _ in
      let pcm = converter.toInt16(input)
      guard !pcm.isEmpty else { return }
      let start = Int((hostSeconds(inputTime.pointee.mHostTime) - clockStart) * Double(SAMPLE_RATE))
      streams.append(RecordingStreams.system, start: start, pcm)
      var loudest = 0.0
      for sample in pcm { loudest = max(loudest, abs(Double(sample))) }
      lock.lock()
      status.samples += pcm.count
      status.peak = max(status.peak, loudest)
      lock.unlock()
    }
    guard created == noErr, let proc = procID else {
      fail(CaptureFailure(operation: "AudioDeviceCreateIOProcIDWithBlock", status: created))
      return
    }
    lock.lock(); ioProcID = proc; lock.unlock()
    let begun = AudioDeviceStart(aggregate, proc)
    guard begun == noErr else {
      fail(CaptureFailure(operation: "AudioDeviceStart", status: begun))
      return
    }
    lock.lock(); status.started = true; lock.unlock()
  }

  /// Stop IO and remove the devices. While the start is still blocked inside
  /// Core Audio the objects are left alone: they are private to this process and
  /// go away when it exits.
  func stop() {
    lock.lock()
    let blocked = starting
    let (tap, aggregate, proc) = (tapID, aggregateID, ioProcID)
    lock.unlock()
    guard !blocked else { return }
    if let aggregate = aggregate, let proc = proc {
      AudioDeviceStop(aggregate, proc)
      AudioDeviceDestroyIOProcID(aggregate, proc)
    }
    if let aggregate = aggregate { AudioHardwareDestroyAggregateDevice(aggregate) }
    if let tap = tap { AudioHardwareDestroyProcessTap(tap) }
  }
}

func audioIssueObject(_ message: String, since: Int64) -> [String: Any] {
  return ["since": since, "attempts": 0, "lastAction": NSNull(), "message": message, "reason": "capture", "escalated": true]
}

func runRecord(_ meetingDir: String, _ bundleIds: [String]) {
  signal(SIGTERM, handleSignal)
  signal(SIGINT, handleSignal)

  let events = meetingDir + "/events.jsonl"
  let startedAt = nowMs()
  let clockStart = hostSeconds(mach_absolute_time())
  stateJson(meetingDir, "in_meeting", startedAt)
  appendEvent(events, ["t": startedAt, "level": "info", "msg": "local recording started"])

  let streams = RecordingStreams(meetingDir)
  let micWriter = streams.writers[RecordingStreams.mic]

  // ── microphone (AVAudioEngine, default input) ─────────────────────────
  let micEngine = AVAudioEngine()
  let micInput = micEngine.inputNode
  guard let chosen = pickInputDevice(appDevices: appInputDevices(bundleIds), systemDefault: defaultInputDevice()) else {
    writeFailedState(meetingDir, startedAt, "Микрофон не найден: в системе нет устройства ввода")
    exit(1)
  }
  let micName = deviceName(chosen.device)
  let selected = selectInputDevice(micInput, chosen.device)
  appendEvent(events, [
    "t": nowMs(), "level": selected == noErr ? "info" : "warn",
    "msg": selected == noErr
      ? "microphone: \(micName) (\(chosen.fromApp ? "the device the meeting app uses" : "system default input"))"
      : "microphone: could not select \(micName) (kAudioOutputUnitProperty_CurrentDevice → \(describeStatus(selected))); using the system default input",
  ])
  let micFormat = micInput.outputFormat(forBus: 0)
  guard micFormat.channelCount > 0 else {
    writeFailedState(meetingDir, startedAt, "Микрофон «\(micName)» не даёт входных каналов: запись невозможна")
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
  micInput.installTap(onBus: 0, bufferSize: 1024, format: micFormat) { buffer, when in
    let ratio = micOutFormat.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1
    guard let converted = AVAudioPCMBuffer(pcmFormat: micOutFormat, frameCapacity: capacity) else { return }
    var fed = false
    var error: NSError?
    micConverter.convert(to: converted, error: &error) { _, outStatus in
      outStatus.pointee = fed ? .noDataNow : .haveData
      fed = true
      return buffer
    }
    guard converted.frameLength > 0, let channel = converted.floatChannelData?[0] else { return }
    let samples = UnsafeBufferPointer(start: channel, count: Int(converted.frameLength))
    let pcm = samples.map { Int16(max(-1.0, min(1.0, Double($0))) * 32767.0) }
    let stamp = when.isHostTimeValid ? when.hostTime : mach_absolute_time()
    let start = Int((hostSeconds(stamp) - clockStart) * Double(SAMPLE_RATE))
    streams.append(RecordingStreams.mic, start: start, pcm)
  }
  micEngine.prepare()
  do {
    try micEngine.start()
  } catch {
    writeFailedState(meetingDir, startedAt, "Микрофон не запустился (AVAudioEngine.start: \(error.localizedDescription)): разрешите BB доступ в Системных настройках → Конфиденциальность и безопасность → Микрофон")
    exit(1)
  }

  // ── system audio, started off the main thread ─────────────────────────
  let system = SystemCapture()
  system.start(bundleIds: bundleIds, streams: streams, clockStart: clockStart)
  if system.fallback {
    appendEvent(events, ["t": nowMs(), "level": "warn", "msg": "the meeting app is not playing yet: recording all system audio for this meeting"])
  }

  var issue: String? = nil
  var issueSince: Int64 = 0
  /// Recompute the capture issue; log it and stamp it when it appears or changes.
  func refreshIssue(final: Bool) {
    let parts = [
      microphoneIssue(device: micName, samples: micWriter.bytes / 2, peak: micWriter.peak, final: final),
      systemCaptureIssue(system.snapshot, final: final),
    ].compactMap { $0 }
    let next = parts.isEmpty ? nil : parts.joined(separator: " ")
    if next != issue {
      issue = next
      issueSince = nowMs()
      if let message = next {
        appendEvent(events, ["t": issueSince, "level": "warn", "msg": message])
      } else {
        appendEvent(events, ["t": issueSince, "level": "info", "msg": "both streams are being recorded"])
      }
    }
  }
  func writeState(_ phase: String) {
    let status = system.snapshot
    stateJson(meetingDir, phase, startedAt, nil,
              audioSeconds: Double(micWriter.bytes) / 2.0 / Double(SAMPLE_RATE),
              audioBytes: micWriter.bytes + status.samples * 2,
              audioIssue: issue.map { audioIssueObject($0, since: issueSince) })
  }

  var lastBeat = Date()
  var appAppeared = false
  while !stopRequested {
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1))
    // The host writes stop.request to ask for a stop, as it does for the bot.
    if FileManager.default.fileExists(atPath: meetingDir + "/stop.request") {
      stopRequested = true
    }
    let now = Date()
    guard now.timeIntervalSince(lastBeat) >= 1.0 else { continue }
    lastBeat = now
    // Once a second: is the tapped audio playing? (All other apps when the tap is the fallback.)
    let appPlaying = !resolveTapObjects(bundleIds).isEmpty
    if appPlaying || (system.fallback && anyOtherOutput()) {
      system.noteTappedOutput()
    }
    if system.fallback && appPlaying && !appAppeared {
      appAppeared = true
      appendEvent(events, ["t": nowMs(), "level": "info", "msg": "the meeting app started playing; this recording keeps capturing all system audio"])
    }
    refreshIssue(final: false)
    writeState("in_meeting")
  }

  // Stop the system IO first, so nothing is written while the files close.
  system.stop()
  micInput.removeTap(onBus: 0)
  micEngine.stop()
  streams.finish()

  if !compressOgg(meetingDir) {
    appendEvent(events, ["t": nowMs(), "level": "warn", "msg": "audio.ogg was not produced (ffmpeg missing or failed); playback unavailable"])
  }

  let status = system.snapshot
  appendEvent(events, [
    "t": nowMs(), "level": "info", "msg": "local recording stopped",
    "data": ["micBytes": micWriter.bytes, "micPeak": micWriter.peak,
             "systemSamples": status.samples, "systemPeak": status.peak, "systemStarted": status.started],
  ])

  // Neither stream has sound: nothing usable was recorded.
  refreshIssue(final: true)
  let micAudible = micWriter.bytes > 0 && micWriter.peak > 0
  let systemAudible = status.samples > 0 && status.peak > 0
  if !micAudible && !systemAudible {
    writeFailedState(meetingDir, startedAt, issue ?? "Запись пуста: ни микрофон, ни системный звук не дали сигнала")
    exit(1)
  }

  // One audible stream is a usable recording; what is missing stays a visible warning.
  writeState("ended")
  // A start still blocked inside Core Audio must not keep the process alive.
  exit(0)
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
