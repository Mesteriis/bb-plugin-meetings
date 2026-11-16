// Local-recording capture helper (docs/dev/DESIGN.md §15). Compiled on the host
// during setup with swiftc. No bot joins the call: it records the microphone
// locally (and, when the process tap works, the system audio) into the meeting
// directory.
//
//   detect                     print one JSON array of audio client processes
//   record --meeting-dir <dir> record the microphone into the meeting dir
//
// state.json / events.jsonl follow the shapes in src/shared/runtime-files.ts.
// The microphone is written to mic.pcm and audio.pcm (s16le 16 kHz mono) so
// the transcriber can attribute it to the owner. System-audio capture through
// a Core Audio process tap is not wired in this build: it needs the System
// Audio Recording permission which this thread cannot exercise, so the helper
// records the microphone only and reports that limitation in events.jsonl.

import AVFoundation
import CoreAudio
import Darwin
import Foundation

let SAMPLE_RATE = 16_000

// ── process enumeration (detect) ────────────────────────────────────────

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
  var value: CFString?
  var size = UInt32(MemoryLayout<CFString?>.size)
  if AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) != noErr { return nil }
  return value as String?
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

// ── recording (record) ──────────────────────────────────────────────────

var stopRequested = false

func handleSignal(_ sig: Int32) {
  stopRequested = true
}

final class PcmWriter {
  private var handle: FileHandle?

  init(_ path: String) {
    FileManager.default.createFile(atPath: path, contents: nil)
    handle = try? FileHandle(forWritingTo: URL(fileURLWithPath: path))
  }

  func write(_ buffer: AVAudioPCMBuffer) {
    guard let handle = handle, let channel = buffer.floatChannelData?[0] else { return }
    let frames = Int(buffer.frameLength)
    let samples = UnsafeBufferPointer(start: channel, count: frames)
    var pcm = [Int16](repeating: 0, count: frames)
    for i in 0 ..< frames {
      let v = max(-1.0, min(1.0, Double(samples[i])))
      pcm[i] = Int16(v * 32767.0)
    }
    pcm.withUnsafeBytes { bytes in
      handle.write(Data(bytes))
    }
  }

  func close() { handle?.closeFile() }
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
    handle.write((line + "\n").data(using: .utf8)!)
    handle.closeFile()
  } else {
    try? (line + "\n").write(to: url, atomically: false, encoding: .utf8)
  }
}

func nowMs() -> Int64 {
  return Int64(Date().timeIntervalSince1970 * 1000)
}

func meetingId(_ dir: String) -> String {
  return (dir as NSString).lastPathComponent
}

func writeFailedState(_ dir: String, _ startedAt: Int64, _ message: String) {
  let ended = nowMs()
  writeJson(dir + "/state.json", [
    "version": 1,
    "meetingId": meetingId(dir),
    "pid": Int(getpid()),
    "phase": "failed",
    "detail": "recording_failed",
    "startedAt": startedAt,
    "joinedAt": startedAt,
    "recordingStartedAt": startedAt,
    "endedAt": ended,
    "endReason": "error",
    "error": ["code": "recording_failed", "message": message],
    "participants": ["count": NSNull(), "names": []],
    "activeSpeakers": [],
    "audio": ["seconds": 0, "bytes": 0],
    "updatedAt": ended,
  ])
  appendEvent(dir + "/events.jsonl", ["t": ended, "level": "error", "msg": message])
}

func runRecord(_ meetingDir: String) {
  signal(SIGTERM, handleSignal)
  signal(SIGINT, handleSignal)

  let startedAt = nowMs()
  writeJson(meetingDir + "/state.json", [
    "version": 1,
    "meetingId": meetingId(meetingDir),
    "pid": Int(getpid()),
    "phase": "in_meeting",
    "detail": "Recording locally",
    "startedAt": startedAt,
    "joinedAt": startedAt,
    "recordingStartedAt": startedAt,
    "endedAt": NSNull(),
    "endReason": NSNull(),
    "error": NSNull(),
    "participants": ["count": NSNull(), "names": []],
    "activeSpeakers": [],
    "audio": ["seconds": 0, "bytes": 0],
    "updatedAt": startedAt,
  ])
  appendEvent(meetingDir + "/events.jsonl", ["t": startedAt, "level": "info", "msg": "local recording started (microphone)"])

  let engine = AVAudioEngine()
  let input = engine.inputNode
  let inputFormat = input.outputFormat(forBus: 0)
  guard inputFormat.channelCount > 0 else {
    writeFailedState(meetingDir, startedAt, "Микрофон не найден: запись невозможна")
    exit(1)
  }
  guard let outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(SAMPLE_RATE), channels: 1, interleaved: false) else {
    writeFailedState(meetingDir, startedAt, "Не удалось создать формат записи")
    exit(1)
  }
  guard let converter = AVAudioConverter(from: inputFormat, to: outFormat) else {
    writeFailedState(meetingDir, startedAt, "Не удалось создать преобразователь аудио")
    exit(1)
  }

  let micWriter = PcmWriter(meetingDir + "/mic.pcm")
  let mixWriter = PcmWriter(meetingDir + "/audio.pcm")

  input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { buffer, _ in
    let ratio = outFormat.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio)
    guard let converted = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }
    var fed = false
    var error: NSError?
    converter.convert(to: converted, error: &error) { _, outStatus in
      outStatus.pointee = fed ? .noDataNow : .haveData
      fed = true
      return buffer
    }
    if converted.frameLength > 0 {
      micWriter.write(converted)
      mixWriter.write(converted)
    }
  }

  engine.prepare()
  do {
    try engine.start()
  } catch {
    writeFailedState(meetingDir, startedAt, "Микрофон: разрешите доступ приложению BB (Системные настройки → Конфиденциальность и безопасность → Микрофон)")
    exit(1)
  }

  while !stopRequested {
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.1))
  }

  engine.stop()
  input.removeTap(onBus: 0)
  micWriter.close()
  mixWriter.close()

  let endedAt = nowMs()
  writeJson(meetingDir + "/state.json", [
    "version": 1,
    "meetingId": meetingId(meetingDir),
    "pid": Int(getpid()),
    "phase": "ended",
    "detail": "Stopped",
    "startedAt": startedAt,
    "joinedAt": startedAt,
    "recordingStartedAt": startedAt,
    "endedAt": endedAt,
    "endReason": "stopped",
    "error": NSNull(),
    "participants": ["count": NSNull(), "names": []],
    "activeSpeakers": [],
    "audio": ["seconds": 0, "bytes": 0],
    "updatedAt": endedAt,
  ])
  appendEvent(meetingDir + "/events.jsonl", ["t": endedAt, "level": "info", "msg": "local recording stopped"])
}

// ── main ────────────────────────────────────────────────────────────────

let arguments = CommandLine.arguments
if arguments.count >= 2 && arguments[1] == "detect" {
  runDetect()
} else if arguments.count >= 2 && arguments[1] == "record" {
  var meetingDir = FileManager.default.currentDirectoryPath
  if let index = arguments.firstIndex(of: "--meeting-dir"), index + 1 < arguments.count {
    meetingDir = arguments[index + 1]
  }
  runRecord(meetingDir)
} else {
  FileHandle.standardError.write("usage: capture detect | record --meeting-dir <dir>\n".data(using: .utf8)!)
  exit(2)
}
