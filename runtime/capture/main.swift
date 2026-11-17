// Local-recording capture helper (docs/dev/DESIGN.md §15). Compiled on the host
// during setup with swiftc. No bot joins the call: it records the microphone and
// the system audio (through a Core Audio process tap, macOS 14.2+) into the
// meeting directory.
//
//   detect                     print one JSON array of audio client processes
//   devices                    print one JSON array of input devices (name, isDefault)
//   events --from ms --to ms   print the system calendar's events in that window
//   record --meeting-dir <dir> [--bundle-ids id,id,...]  record mic + system audio
//
// Files: audio.pcm (s16le 16 kHz mono, mic + system mixed, what the transcriber
// reads), mic.pcm (mic only), system.pcm (system only), their Opus copies
// audio.ogg, mic.ogg and system.ogg written at the end, state.json / events.jsonl
// (bot shapes).

import AVFoundation
import CoreAudio
import Darwin
import EventKit
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
func createSystemTap(_ bundleIds: [String]) -> Step<(tap: AudioObjectID, uid: String, appScoped: Bool)> {
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
  return .ok((tapID, uid, !ids.isEmpty))
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

/// Append Int16 mono 16 kHz samples to a file.
final class PcmWriter {
  private var handle: FileHandle?
  private let lock = NSLock()

  init(_ path: String) {
    FileManager.default.createFile(atPath: path, contents: nil)
    handle = try? FileHandle(forWritingTo: URL(fileURLWithPath: path))
  }

  func write(_ pcm: [Int16]) {
    lock.lock(); defer { lock.unlock() }
    guard let handle = handle, !pcm.isEmpty else { return }
    pcm.withUnsafeBytes { handle.write(Data($0)) }
  }

  /// Zeros for a gap in the stream; they do not count towards the peak.
  func writeSilence(_ samples: Int) {
    lock.lock(); defer { lock.unlock() }
    guard let handle = handle, samples > 0 else { return }
    handle.write(Data(count: samples * 2))
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

  /// Where a buffer of `count` samples stamped at `start` goes, and how many of
  /// its leading samples to drop. A stream whose device clock runs fast gets ahead
  /// of its timestamps; once that lead exceeds the tolerance the excess is dropped,
  /// a few samples a buffer, so the lead never grows beyond the tolerance.
  mutating func place(start: Int, count: Int) -> (index: Int, skip: Int) {
    if start > position + StreamClock.tolerance {
      position = start + count
      return (start, 0)
    }
    let skip = min(count, max(0, position - start - StreamClock.tolerance))
    let index = position
    position += count - skip
    return (index, skip)
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

/// What one stream has put into the recording so far.
struct StreamStats {
  /// Samples accepted into the recording (padding excluded).
  var samples = 0
  /// Loudest accepted sample.
  var peak = 0
  /// Exact-zero samples at the end of the stream so far.
  var trailingZeros = 0
  /// When the last buffer was accepted.
  var lastBuffer: Date? = nil
}

/// mic.pcm, system.pcm and the mixed audio.pcm on one sample clock. Gaps in a
/// stream are written as zeros to its own file too, so a position in any of the
/// three files is the same moment of the recording. Nothing is accepted or
/// counted after finish(): the statistics describe what is in the files.
final class RecordingStreams {
  static let mic = 0
  static let system = 1
  private let writers: [PcmWriter]
  private let mixWriter: PcmWriter
  private var clocks = [StreamClock(), StreamClock()]
  private var filled = [0, 0]
  private var counters = [StreamStats(), StreamStats()]
  private var mixer: TimelineMixer!
  private let lock = NSLock()
  private var closed = false

  init(_ meetingDir: String) {
    writers = [PcmWriter(meetingDir + "/mic.pcm"), PcmWriter(meetingDir + "/system.pcm")]
    mixWriter = PcmWriter(meetingDir + "/audio.pcm")
    let out = mixWriter
    mixer = TimelineMixer { out.write($0) }
  }

  func stats(_ stream: Int) -> StreamStats {
    lock.lock(); defer { lock.unlock() }
    return counters[stream]
  }

  func append(_ stream: Int, start: Int, _ buffer: [Int16]) {
    lock.lock(); defer { lock.unlock() }
    guard !closed, !buffer.isEmpty else { return }
    let (index, skip) = clocks[stream].place(start: max(0, start), count: buffer.count)
    let pcm = skip == 0 ? buffer : Array(buffer[skip...])
    counters[stream].lastBuffer = Date()
    guard !pcm.isEmpty else { return }
    if index > filled[stream] {
      writers[stream].writeSilence(index - filled[stream])
    }
    writers[stream].write(pcm)
    filled[stream] = index + pcm.count
    mixer.add(stream: stream, index: index, samples: pcm)
    counters[stream].samples += pcm.count
    for sample in pcm {
      let magnitude = abs(Int(sample))
      if magnitude > counters[stream].peak { counters[stream].peak = magnitude }
      counters[stream].trailingZeros = sample == 0 ? counters[stream].trailingZeros + 1 : 0
    }
  }

  func finish() {
    lock.lock(); defer { lock.unlock() }
    guard !closed else { return }
    closed = true
    mixer.finish()
    writers.forEach { $0.close() }
    mixWriter.close()
  }
}

/// The host time of an IO buffer, or now when the device did not stamp it.
func bufferHostTime(_ stamp: UnsafePointer<AudioTimeStamp>) -> UInt64 {
  return stamp.pointee.mFlags.contains(.hostTimeValid) && stamp.pointee.mHostTime != 0 ? stamp.pointee.mHostTime : mach_absolute_time()
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

/// Converts a device or tap stream to 16 kHz mono Int16, honouring the
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
    for buffer in target {
      if let data = buffer.mData { memset(data, 0, Int(buffer.mDataByteSize)) }
    }
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
func compressOgg(_ meetingDir: String, _ name: String = "audio") -> Bool {
  let pcm = meetingDir + "/" + name + ".pcm"
  let ogg = meetingDir + "/" + name + ".ogg"
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
  var peak = 0
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

let MICROPHONE_PERMISSION = "проверьте, что звук на устройстве не выключен, оно подключено (у ноутбука не закрыта крышка) и BB разрешён доступ к микрофону в Системных настройках → Конфиденциальность и безопасность"
/// A microphone that worked and then delivers exact zeros for this long has gone silent.
let MICROPHONE_GONE_SAMPLES = SAMPLE_RATE * 300
/// No buffers for this long means the microphone has stopped.
let MICROPHONE_STALL_S = 10.0

/// What the microphone path has done so far.
struct MicrophoneStatus {
  var device: String
  /// Why it did not start, or nil.
  var failure: String? = nil
  var samples = 0
  var peak = 0
  /// Exact-zero samples at the end of the stream so far.
  var trailingZeros = 0
  /// Seconds since the last buffer, or since the recording started when there was none.
  var stalledSeconds = 0.0
}

/// The microphone issue, or nil. A microphone that has given nothing but exact
/// zeros for ten seconds is muted in hardware, dead, or withheld by macOS; which
/// of these cannot be told from the samples, and the message says so. One that
/// has carried sound is reported only after five minutes of exact zeros.
/// No buffers for ten seconds mean the device has gone. Looks at the end of the stream,
/// so a microphone that worked and then went away is reported.
func microphoneIssue(_ mic: MicrophoneStatus, final: Bool) -> String? {
  if let failure = mic.failure {
    return "Микрофон «\(mic.device)» не запустился: \(failure); \(MICROPHONE_PERMISSION)"
  }
  if mic.samples == 0 {
    guard final || mic.stalledSeconds >= MICROPHONE_STALL_S else { return nil }
    return "Микрофон «\(mic.device)» не записан: устройство не выдало данных; \(MICROPHONE_PERMISSION)"
  }
  if mic.stalledSeconds >= MICROPHONE_STALL_S {
    return "Микрофон «\(mic.device)» перестал выдавать звук \(Int(mic.stalledSeconds)) с назад: \(MICROPHONE_PERMISSION)"
  }
  // Some devices (conference bars with noise gating) deliver exact zeros between
  // phrases. Once the microphone has carried sound, only a long silence counts.
  let limit = mic.peak > 0 ? MICROPHONE_GONE_SAMPLES : SILENCE_JUDGE_SAMPLES
  if mic.trailingZeros >= limit || (final && mic.peak <= 0) {
    return "Микрофон «\(mic.device)» не даёт сигнала: \(MICROPHONE_PERMISSION)"
  }
  return nil
}

/// The format of a device's input (its first input stream), or nil.
func inputFormat(_ device: AudioDeviceID) -> AudioStreamBasicDescription? {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyStreamFormat, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
  var asbd = AudioStreamBasicDescription()
  var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
  guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &asbd) == noErr, asbd.mSampleRate > 0, asbd.mChannelsPerFrame > 0 else {
    return nil
  }
  return asbd
}

/// Every device that has an input stream.
func inputDevices() -> [AudioDeviceID] {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  let system = AudioObjectID(kAudioObjectSystemObject)
  guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
  var devices = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
  guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &devices) == noErr else { return [] }
  return devices.filter { inputFormat($0) != nil }
}

/// The input device with this name, or nil.
func inputDeviceNamed(_ name: String) -> AudioDeviceID? {
  return inputDevices().first { deviceName($0) == name }
}

/// `devices`: the microphones the owner can choose from in settings.
func runDevices() {
  let systemDefault = defaultInputDevice()
  let rows: [[String: Any]] = inputDevices().map { ["name": deviceName($0), "isDefault": $0 == systemDefault] }
  let data = (try? JSONSerialization.data(withJSONObject: rows, options: [])) ?? Data("[]".utf8)
  print(String(data: data, encoding: .utf8) ?? "[]")
}

/// When the microphone path must be started again: the device that should be
/// recorded is another one (chosen in settings, or the meeting app moved), the
/// device changed its format (AirPods switching profile), or buffers stopped
/// arriving (unplugged). `wanted` is nil when nothing names a device, as when
/// the app closes its input while muted: the current device is kept then.
/// Not while a start is under way, and not sooner than `retryS` after the last one.
func microphoneNeedsRestart(busy: Bool, sinceStartS: Double, current: AudioDeviceID?, wanted: AudioDeviceID?,
                            formatChanged: Bool, stalledS: Double, retryS: Double, stallS: Double = 3) -> Bool {
  guard !busy, sinceStartS >= retryS else { return false }
  if let wanted = wanted, wanted != current { return true }
  return formatChanged || stalledS >= stallS
}

/// Seconds to wait before the next restart after `failures` restarts in a row
/// that brought no audio: 5, 10, 20, 40, then 60.
func microphoneRetryDelay(failures: Int) -> Double {
  return min(60, 5 * pow(2, Double(max(0, failures))))
}

/// Two stream formats that the same converter can read.
func sameFormat(_ a: AudioStreamBasicDescription?, _ b: AudioStreamBasicDescription?) -> Bool {
  guard let a = a, let b = b else { return a == nil && b == nil }
  return a.mSampleRate == b.mSampleRate && a.mFormatID == b.mFormatID && a.mFormatFlags == b.mFormatFlags
    && a.mChannelsPerFrame == b.mChannelsPerFrame && a.mBitsPerChannel == b.mBitsPerChannel
    && a.mBytesPerFrame == b.mBytesPerFrame && a.mBytesPerPacket == b.mBytesPerPacket
}

/// The microphone path: an IO proc on the input device the meeting app uses,
/// the same mechanism as the system-audio path. It starts on its own thread
/// (a start can wait on the microphone consent) and starts again when the
/// device, its format or its buffers go away. A failure is kept as text for the
/// capture issue; it is never fatal on its own.
final class MicrophoneCapture {
  private let bundleIds: [String]
  private let forcedDevice: String?
  private let streams: RecordingStreams
  private let clockStart: Double
  private let events: String
  private let lock = NSLock()
  private var name = "не выбран"
  private var failure: String? = nil
  private var device: AudioDeviceID? = nil
  private var format: AudioStreamBasicDescription? = nil
  private var ioProcID: AudioDeviceIOProcID? = nil
  private var busy = false
  private var stopped = false
  private var missingLogged = false
  private var failures = 0
  private var samplesAtRestart = 0
  private var lastLabel = ""
  private var startedAt = Date()

  init(bundleIds: [String], forcedDevice: String?, streams: RecordingStreams, clockStart: Double, events: String) {
    self.bundleIds = bundleIds
    self.forcedDevice = forcedDevice
    self.streams = streams
    self.clockStart = clockStart
    self.events = events
  }

  /// (device name, why it did not start or nil)
  var state: (device: String, failure: String?) {
    lock.lock(); defer { lock.unlock() }
    return (name, failure)
  }

  /// The device something names: the one chosen in settings (--input-device) when
  /// it is connected, else the one the meeting app is using; nil when neither.
  private func namedDevice() -> (device: AudioDeviceID, origin: String)? {
    if let chosen = forcedDevice {
      if let device = inputDeviceNamed(chosen) {
        return (device, "chosen in settings")
      }
      // Unplugged or renamed: say so once, and record the app's microphone meanwhile.
      lock.lock()
      let first = !missingLogged
      missingLogged = true
      lock.unlock()
      if first {
        appendEvent(events, ["t": nowMs(), "level": "warn", "msg": "microphone: \(chosen), chosen in settings, is not connected; using the meeting app's"])
      }
    }
    if let device = appInputDevices(bundleIds).first(where: { $0 != kAudioObjectUnknown }) {
      return (device, "the device the meeting app uses")
    }
    return nil
  }

  /// The device to start on: the named one, else the system default input.
  private func wantedDevice() -> (device: AudioDeviceID, origin: String)? {
    return namedDevice() ?? defaultInputDevice().map { ($0, "system default input") }
  }

  func start() {
    lock.lock()
    guard !busy, !stopped else { lock.unlock(); return }
    busy = true
    startedAt = Date()
    lock.unlock()
    Thread.detachNewThread { [self] in
      teardown()
      begin()
      lock.lock()
      busy = false
      let late = stopped
      lock.unlock()
      if late { teardown() }
    }
  }

  /// Called once a second by the recording loop with the samples accepted so far.
  func tick(stalledSeconds: Double, samples: Int) {
    lock.lock()
    if samples > samplesAtRestart { failures = 0 }
    let (isBusy, current, built, since, retry) = (busy, device, format, Date().timeIntervalSince(startedAt), microphoneRetryDelay(failures: failures))
    lock.unlock()
    let formatChanged = built != nil && !sameFormat(current.flatMap(inputFormat), built)
    guard microphoneNeedsRestart(busy: isBusy, sinceStartS: since, current: current, wanted: namedDevice()?.device,
                                 formatChanged: formatChanged, stalledS: stalledSeconds, retryS: retry) else { return }
    lock.lock()
    let first = failures == 0
    failures += 1
    samplesAtRestart = samples
    lock.unlock()
    // One line when trouble begins; the retries that follow are silent.
    if first {
      appendEvent(events, ["t": nowMs(), "level": "warn", "msg": "microphone: the input changed or stopped; starting it again"])
    }
    start()
  }

  private func fail(_ label: String, _ text: String) {
    let line = "microphone: \(label) did not start: \(text)"
    lock.lock()
    name = label; failure = text
    let changed = line != lastLabel
    lastLabel = line
    lock.unlock()
    if changed { appendEvent(events, ["t": nowMs(), "level": "warn", "msg": line]) }
  }

  private func begin() {
    guard let (chosen, origin) = wantedDevice() else {
      fail("нет", "в системе нет устройства ввода")
      return
    }
    let label = deviceName(chosen)
    guard let asbd = inputFormat(chosen), let converter = SystemTapConverter(asbd: asbd) else {
      fail(label, "kAudioDevicePropertyStreamFormat: устройство не даёт входного формата")
      return
    }
    let streams = self.streams
    let clockStart = self.clockStart
    var procID: AudioDeviceIOProcID? = nil
    let created = AudioDeviceCreateIOProcIDWithBlock(&procID, chosen, nil) { _, input, inputTime, _, _ in
      let pcm = converter.toInt16(input)
      guard !pcm.isEmpty else { return }
      streams.append(RecordingStreams.mic, start: Int((hostSeconds(bufferHostTime(inputTime)) - clockStart) * Double(SAMPLE_RATE)), pcm)
    }
    guard created == noErr, let proc = procID else {
      fail(label, CaptureFailure(operation: "AudioDeviceCreateIOProcIDWithBlock", status: created).text)
      return
    }
    lock.lock(); device = chosen; ioProcID = proc; format = asbd; lock.unlock()
    let begun = AudioDeviceStart(chosen, proc)
    guard begun == noErr else {
      fail(label, CaptureFailure(operation: "AudioDeviceStart", status: begun).text)
      return
    }
    let line = "microphone: \(label) (\(origin)), \(Int(asbd.mSampleRate)) Hz, \(asbd.mChannelsPerFrame) ch"
    lock.lock()
    name = label; failure = nil
    let changed = line != lastLabel
    lastLabel = line
    lock.unlock()
    if changed { appendEvent(events, ["t": nowMs(), "level": "info", "msg": line]) }
  }

  private func teardown() {
    lock.lock()
    let (current, proc) = (device, ioProcID)
    device = nil; ioProcID = nil; format = nil
    lock.unlock()
    if let current = current, let proc = proc {
      AudioDeviceStop(current, proc)
      AudioDeviceDestroyIOProcID(current, proc)
    }
  }

  /// Stop IO. A start still blocked inside Core Audio undoes itself when it returns.
  func stop() {
    lock.lock()
    stopped = true
    let blocked = busy
    lock.unlock()
    if !blocked { teardown() }
  }
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
    mixer.add(stream: 0, index: mic.place(start: tick * chunk, count: chunk).index, samples: micChunk)
  }, ticks: 30)
  check("timeline-mic-only", micOnly.count == 48_000 && micOnly.allSatisfy { $0 == 1000 })
  check("timeline-mic-only-backlog", micOnlyBacklog <= 16_000)

  // System stream starting 2 s late: its first sample lands at output index 32000.
  let (late, lateBacklog) = run({ mixer, mic, sys, tick in
    mixer.add(stream: 0, index: mic.place(start: tick * chunk, count: chunk).index, samples: micChunk)
    if tick >= 20 {
      mixer.add(stream: 1, index: sys.place(start: tick * chunk, count: chunk).index, samples: sysChunk)
    }
  }, ticks: 30)
  check("timeline-late-start", late.count == 48_000 && late[31_999] == 1000 && late[32_000] == 3000 && late[47_999] == 3000)
  check("timeline-late-start-backlog", lateBacklog <= 16_000)

  // A 0.5 s gap in the system stream (ticks 10-14): zeros there, total length unchanged.
  let (gap, gapBacklog) = run({ mixer, mic, sys, tick in
    mixer.add(stream: 0, index: mic.place(start: tick * chunk, count: chunk).index, samples: micChunk)
    if tick < 10 || tick >= 15 {
      mixer.add(stream: 1, index: sys.place(start: tick * chunk, count: chunk).index, samples: sysChunk)
    }
  }, ticks: 30)
  check("timeline-gap", gap.count == 48_000 && gap[15_999] == 3000 && gap[16_000 ..< 24_000].allSatisfy { $0 == 1000 } && gap[24_000] == 3000)
  check("timeline-gap-backlog", gapBacklog <= 16_000)

  // Timestamps that jitter by 5 ms do not open gaps.
  var jitter = StreamClock()
  let first = jitter.place(start: 0, count: chunk).index
  let second = jitter.place(start: chunk + 80, count: chunk).index
  check("clock-jitter", first == 0 && second == 1_600)
  var jump = StreamClock()
  _ = jump.place(start: 0, count: chunk)
  check("clock-gap", jump.place(start: 9_600, count: chunk).index == 9_600)

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
  check("mic-zeros", microphoneIssue(MicrophoneStatus(device: "MacBook Pro Microphone", samples: 160_000, peak: 0, trailingZeros: 160_000), final: false) == "Микрофон «MacBook Pro Microphone» не даёт сигнала: проверьте, что звук на устройстве не выключен, оно подключено (у ноутбука не закрыта крышка) и BB разрешён доступ к микрофону в Системных настройках → Конфиденциальность и безопасность")
  check("mic-zeros-too-early", microphoneIssue(MicrophoneStatus(device: "x", samples: 16_000, peak: 0, trailingZeros: 16_000), final: false) == nil)
  check("mic-no-samples-at-end", microphoneIssue(MicrophoneStatus(device: "x"), final: true)?.contains("устройство не выдало данных") == true)
  check("mic-no-samples-after-10s", microphoneIssue(MicrophoneStatus(device: "x", stalledSeconds: 10), final: false)?.contains("устройство не выдало данных") == true)
  check("mic-audible", microphoneIssue(MicrophoneStatus(device: "x", samples: 160_000, peak: 40), final: true) == nil)
  check("mic-pause-after-sound-is-not-an-issue", microphoneIssue(MicrophoneStatus(device: "x", samples: 960_000, peak: 9000, trailingZeros: 160_000), final: false) == nil)
  check("mic-pause-at-the-end-is-not-an-issue", microphoneIssue(MicrophoneStatus(device: "x", samples: 960_000, peak: 9000, trailingZeros: 640_000), final: true) == nil)
  check("mic-went-silent-after-sound", microphoneIssue(MicrophoneStatus(device: "x", samples: 9_600_000, peak: 9000, trailingZeros: 4_800_000), final: false)?.contains("не даёт сигнала") == true)
  check("mic-stopped-after-sound", microphoneIssue(MicrophoneStatus(device: "AirPods", samples: 960_000, peak: 9000, stalledSeconds: 12), final: false)?.hasPrefix("Микрофон «AirPods» перестал выдавать звук 12 с назад: проверьте") == true)
  check("mic-start-failure", microphoneIssue(MicrophoneStatus(device: "x", failure: "AudioDeviceStart → -50"), final: false)?.hasPrefix("Микрофон «x» не запустился: AudioDeviceStart → -50") == true)

  // One hour of 100 ms buffers from a device whose clock is off: the stream stays
  // within the tolerance (plus one buffer) of where its timestamps say it is.
  func drift(_ samplesPerBuffer: Int) -> Int {
    var clock = StreamClock()
    for tick in 0 ..< 36_000 { _ = clock.place(start: tick * chunk, count: samplesPerBuffer) }
    return clock.position - 36_000 * chunk
  }
  let fast = drift(1_602)
  let slow = drift(1_598)
  check("clock-fast-device-bounded", fast >= 0 && fast <= 3_300)
  check("clock-slow-device-bounded", slow <= 0 && slow >= -3_300)
  var lead = StreamClock()
  _ = lead.place(start: 0, count: 4_800)
  let trimmed = lead.place(start: 1_600, count: 1_600)
  check("clock-lead-trimmed", trimmed.index == 4_800 && trimmed.skip == 1_600 && lead.position == 4_800)

  // Restarting the microphone: another named device, a format change or a stall; never while starting.
  check("mic-restart-steady", !microphoneNeedsRestart(busy: false, sinceStartS: 60, current: 91, wanted: 91, formatChanged: false, stalledS: 0.1, retryS: 5))
  check("mic-restart-other-device", microphoneNeedsRestart(busy: false, sinceStartS: 60, current: 91, wanted: 57, formatChanged: false, stalledS: 0.1, retryS: 5))
  check("mic-restart-keeps-device-when-none-named", !microphoneNeedsRestart(busy: false, sinceStartS: 60, current: 91, wanted: nil, formatChanged: false, stalledS: 0.1, retryS: 5))
  check("mic-restart-format", microphoneNeedsRestart(busy: false, sinceStartS: 60, current: 91, wanted: 91, formatChanged: true, stalledS: 0.1, retryS: 5))
  check("mic-restart-stalled", microphoneNeedsRestart(busy: false, sinceStartS: 60, current: 91, wanted: 91, formatChanged: false, stalledS: 3, retryS: 5))
  check("mic-restart-not-while-starting", !microphoneNeedsRestart(busy: true, sinceStartS: 60, current: nil, wanted: 57, formatChanged: false, stalledS: 30, retryS: 5))
  check("mic-restart-waits-for-retry", !microphoneNeedsRestart(busy: false, sinceStartS: 19, current: nil, wanted: 57, formatChanged: false, stalledS: 19, retryS: 20))
  check("mic-retry-backoff", [0, 1, 2, 3, 4, 9].map { microphoneRetryDelay(failures: $0) } == [5, 10, 20, 40, 60, 60])
  var pcm16 = AudioStreamBasicDescription(mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM, mFormatFlags: 12, mBytesPerPacket: 4,
                                          mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 2, mBitsPerChannel: 16, mReserved: 0)
  let before = pcm16
  check("format-same", sameFormat(before, pcm16))
  pcm16.mBitsPerChannel = 24
  pcm16.mBytesPerFrame = 6
  pcm16.mBytesPerPacket = 6
  check("format-sample-width-changed", !sameFormat(before, pcm16))

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
  private var cancelled = false
  private var appScoped: Bool? = nil
  private let startedAt = Date()
  private let streams: RecordingStreams

  init(streams: RecordingStreams) {
    self.streams = streams
  }

  /// The path's status; samples and peak are what the recording accepted.
  var snapshot: SystemCaptureStatus {
    let accepted = streams.stats(RecordingStreams.system)
    lock.lock(); defer { lock.unlock() }
    var copy = status
    copy.samples = accepted.samples
    copy.peak = accepted.peak
    copy.timedOut = starting && Date().timeIntervalSince(startedAt) >= SYSTEM_START_TIMEOUT_S
    return copy
  }

  /// True when the tap covers all system audio because the app was not playing; nil until the tap exists.
  var fallback: Bool? {
    lock.lock(); defer { lock.unlock() }
    return appScoped.map { !$0 }
  }

  func noteTappedOutput() {
    lock.lock(); defer { lock.unlock() }
    status.tappedOutput = true
  }

  private func fail(_ failure: CaptureFailure) {
    lock.lock(); defer { lock.unlock() }
    status.failure = failure
  }

  func start(bundleIds: [String], clockStart: Double) {
    lock.lock(); starting = true; lock.unlock()
    Thread.detachNewThread { [self] in
      run(bundleIds: bundleIds, clockStart: clockStart)
      lock.lock()
      starting = false
      let late = cancelled
      lock.unlock()
      // The recording was finalized while this start was blocked: undo it.
      if late { teardown() }
    }
  }

  private func run(bundleIds: [String], clockStart: Double) {
    let tap: AudioObjectID
    let uid: String
    switch createSystemTap(bundleIds) {
    case let .ok(created):
      tap = created.tap
      uid = created.uid
      lock.lock(); tapID = tap; appScoped = created.appScoped; lock.unlock()
    case let .failed(failure): fail(failure); return
    }
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
    let streams = self.streams
    var procID: AudioDeviceIOProcID? = nil
    let created = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregate, nil) { _, input, inputTime, _, _ in
      let pcm = converter.toInt16(input)
      guard !pcm.isEmpty else { return }
      let start = Int((hostSeconds(bufferHostTime(inputTime)) - clockStart) * Double(SAMPLE_RATE))
      streams.append(RecordingStreams.system, start: start, pcm)
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

  /// Stop IO and remove the devices. A start still blocked inside Core Audio is
  /// marked cancelled and undoes itself if it ever returns; the recording accepts
  /// nothing after RecordingStreams.finish() either way.
  func stop() {
    lock.lock()
    cancelled = true
    let blocked = starting
    lock.unlock()
    if !blocked { teardown() }
  }

  private func teardown() {
    lock.lock()
    let (tap, aggregate, proc) = (tapID, aggregateID, ioProcID)
    tapID = nil; aggregateID = nil; ioProcID = nil
    lock.unlock()
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

func runRecord(_ meetingDir: String, _ bundleIds: [String], inputDevice: String?) -> Never {
  signal(SIGTERM, handleSignal)
  signal(SIGINT, handleSignal)

  let events = meetingDir + "/events.jsonl"
  let startedAt = nowMs()
  let began = Date()
  let clockStart = hostSeconds(mach_absolute_time())
  stateJson(meetingDir, "in_meeting", startedAt)
  appendEvent(events, ["t": startedAt, "level": "info", "msg": "local recording started"])

  // Two independent paths: either one alone still makes a usable recording.
  let streams = RecordingStreams(meetingDir)
  let microphone = MicrophoneCapture(bundleIds: bundleIds, forcedDevice: inputDevice, streams: streams, clockStart: clockStart, events: events)
  microphone.start()
  let system = SystemCapture(streams: streams)
  system.start(bundleIds: bundleIds, clockStart: clockStart)

  func microphoneStatus() -> MicrophoneStatus {
    let accepted = streams.stats(RecordingStreams.mic)
    let (device, failure) = microphone.state
    return MicrophoneStatus(device: device, failure: failure, samples: accepted.samples, peak: accepted.peak,
                            trailingZeros: accepted.trailingZeros,
                            stalledSeconds: Date().timeIntervalSince(accepted.lastBuffer ?? began))
  }

  var issue: String? = nil
  var issueSince: Int64 = 0
  /// Recompute the capture issue; log it and stamp it when it appears or changes.
  func refreshIssue(final: Bool, microphone: MicrophoneStatus? = nil) {
    let parts = [microphoneIssue(microphone ?? microphoneStatus(), final: final), systemCaptureIssue(system.snapshot, final: final)].compactMap { $0 }
    let next = parts.isEmpty ? nil : parts.joined(separator: " ")
    guard next != issue else { return }
    issue = next
    issueSince = nowMs()
    if let message = next {
      appendEvent(events, ["t": issueSince, "level": "warn", "msg": message])
    } else {
      appendEvent(events, ["t": issueSince, "level": "info", "msg": "both streams are being recorded"])
    }
  }
  func writeState(_ phase: String) {
    let mic = streams.stats(RecordingStreams.mic)
    let sys = streams.stats(RecordingStreams.system)
    stateJson(meetingDir, phase, startedAt, nil,
              audioSeconds: Date().timeIntervalSince(began),
              audioBytes: (mic.samples + sys.samples) * 2,
              audioIssue: issue.map { audioIssueObject($0, since: issueSince) })
  }

  var lastBeat = Date()
  var fallbackLogged = false
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
    let fallback = system.fallback ?? false
    let appPlaying = !resolveTapObjects(bundleIds).isEmpty
    if fallback && !fallbackLogged {
      fallbackLogged = true
      appendEvent(events, ["t": nowMs(), "level": "warn", "msg": "the meeting app was not playing at start: recording all system audio for this meeting"])
    }
    if fallback ? anyOtherOutput() : appPlaying {
      system.noteTappedOutput()
    }
    if fallback && appPlaying && !appAppeared {
      appAppeared = true
      appendEvent(events, ["t": nowMs(), "level": "info", "msg": "the meeting app started playing; this recording keeps capturing all system audio"])
    }
    let micNow = microphoneStatus()
    microphone.tick(stalledSeconds: micNow.stalledSeconds, samples: micNow.samples)
    refreshIssue(final: false)
    writeState("in_meeting")
  }

  // The microphone as it was while recording: after the stop no buffers arrive, and
  // compressing a long recording takes longer than the stall limit.
  let microphoneAtStop = microphoneStatus()
  // Stop both paths, then close the files: nothing is accepted or counted after finish().
  system.stop()
  microphone.stop()
  streams.finish()

  if !compressOgg(meetingDir) {
    appendEvent(events, ["t": nowMs(), "level": "warn", "msg": "audio.ogg was not produced (ffmpeg missing or failed); playback unavailable"])
  }
  // The two streams stay as compressed copies: a later retranscription needs them
  // to tell the owner from the remote side once the raw PCM has been removed.
  for stream in ["mic", "system"] where !compressOgg(meetingDir, stream) {
    appendEvent(events, ["t": nowMs(), "level": "warn", "msg": "\(stream).ogg was not produced; a retranscription will not know the owner's pieces"])
  }

  let mic = streams.stats(RecordingStreams.mic)
  let sys = streams.stats(RecordingStreams.system)
  appendEvent(events, [
    "t": nowMs(), "level": "info", "msg": "local recording stopped",
    "data": ["micSamples": mic.samples, "micPeak": mic.peak, "systemSamples": sys.samples, "systemPeak": sys.peak,
             "systemStarted": system.snapshot.started],
  ])

  refreshIssue(final: true, microphone: microphoneAtStop)
  // Neither stream has sound: nothing usable was recorded.
  if mic.peak <= 0 && sys.peak <= 0 {
    writeFailedState(meetingDir, startedAt, issue ?? "Запись пуста: ни микрофон, ни системный звук не дали сигнала")
    _exit(1)
  }
  // One audible stream is a usable recording; what is missing stays a visible warning.
  writeState("ended")
  // _exit: a start still blocked inside Core Audio must not hold up the exit handlers.
  _exit(0)
}

// ── calendar (meeting titles) ───────────────────────────────────────────

/// Links found in an event's location, URL and notes: enough to tell which
/// meeting service the event is for, without handing the notes themselves over.
func eventLinks(_ event: EKEvent) -> [String] {
  let text = [event.location, event.url?.absoluteString, event.notes].compactMap { $0 }.joined(separator: " ")
  guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return [] }
  var links: [String] = []
  for match in detector.matches(in: text, options: [], range: NSRange(text.startIndex..., in: text)) {
    guard let url = match.url, url.scheme == "http" || url.scheme == "https", let host = url.host else { continue }
    // Host and path only: meeting passcodes live in the query.
    let link = host + url.path
    if !links.contains(link) { links.append(link) }
    if links.count == 20 { break }
  }
  return links
}

/// "Имя <почта>", or whichever of the two the calendar has. The address identifies
/// the person across meetings; the name is what a reader recognizes.
func attendeeLabel(_ participant: EKParticipant) -> String? {
  let address = participant.url.scheme == "mailto" ? String(participant.url.absoluteString.dropFirst("mailto:".count)) : nil
  let name = participant.name.flatMap { $0 == address || $0.isEmpty ? nil : $0 }
  switch (name, address) {
  case let (name?, address?): return "\(name) <\(address)>"
  case let (name?, nil): return name
  case let (nil, address?): return address
  default: return nil
  }
}

/// `events --from <ms> --to <ms>`: the system calendar's events in that window,
/// for naming a recording after the meeting it belongs to. Asks for calendar
/// access the first time; prints {"access": "granted"|"denied"|"timeout", "events": [...]}.
func runEvents(from: Double, to: Double) {
  let store = EKEventStore()
  let answered = DispatchSemaphore(value: 0)
  var granted = false
  store.requestFullAccessToEvents { ok, _ in
    granted = ok
    answered.signal()
  }
  var access = "granted"
  if answered.wait(timeout: .now() + 20) == .timedOut {
    access = "timeout"
  } else if !granted {
    access = "denied"
  }
  var rows: [[String: Any]] = []
  if access == "granted" {
    let predicate = store.predicateForEvents(withStart: Date(timeIntervalSince1970: from / 1000),
                                             end: Date(timeIntervalSince1970: to / 1000), calendars: nil)
    for event in store.events(matching: predicate) {
      rows.append([
        "title": event.title ?? "",
        "start": Int64(event.startDate.timeIntervalSince1970 * 1000),
        "end": Int64(event.endDate.timeIntervalSince1970 * 1000),
        "allDay": event.isAllDay,
        "declined": event.attendees?.contains { $0.isCurrentUser && $0.participantStatus == .declined } ?? false,
        "links": eventLinks(event),
        "attendees": (event.attendees ?? []).filter { !$0.isCurrentUser }.compactMap(attendeeLabel).prefix(50).map { $0 },
      ])
    }
  }
  let object: [String: Any] = ["access": access, "events": rows]
  let data = (try? JSONSerialization.data(withJSONObject: object, options: [])) ?? Data("{}".utf8)
  print(String(data: data, encoding: .utf8) ?? "{}")
}

// ── main ────────────────────────────────────────────────────────────────

let arguments = CommandLine.arguments
if arguments.count >= 2 && arguments[1] == "selftest" {
  exit(runSelfTest())
} else if arguments.count >= 2 && arguments[1] == "detect" {
  runDetect()
} else if arguments.count >= 2 && arguments[1] == "devices" {
  runDevices()
} else if arguments.count >= 2 && arguments[1] == "events" {
  func number(_ flag: String) -> Double? {
    guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
    return Double(arguments[index + 1])
  }
  guard let from = number("--from"), let to = number("--to"), to > from else {
    FileHandle.standardError.write(("usage: capture events --from <epoch ms> --to <epoch ms>" + NL).data(using: .utf8)!)
    exit(2)
  }
  runEvents(from: from, to: to)
} else if arguments.count >= 2 && arguments[1] == "record" {
  var meetingDir = FileManager.default.currentDirectoryPath
  var bundleIds: [String] = []
  if let index = arguments.firstIndex(of: "--meeting-dir"), index + 1 < arguments.count {
    meetingDir = arguments[index + 1]
  }
  if let index = arguments.firstIndex(of: "--bundle-ids"), index + 1 < arguments.count {
    bundleIds = arguments[index + 1].split(separator: ",").map { String($0) }
  }
  // The microphone chosen in settings; without it the meeting app's device is recorded.
  var inputDevice: String? = nil
  if let index = arguments.firstIndex(of: "--input-device"), index + 1 < arguments.count {
    inputDevice = arguments[index + 1]
  }
  runRecord(meetingDir, bundleIds, inputDevice: inputDevice)
} else {
  FileHandle.standardError.write(("usage: capture detect | devices | events --from ms --to ms | selftest | record --meeting-dir <dir> [--bundle-ids ids] [--input-device name]" + NL).data(using: .utf8)!)
  exit(2)
}
