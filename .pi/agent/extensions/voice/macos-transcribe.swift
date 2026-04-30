import AVFoundation
import Foundation
import Speech

let args = CommandLine.arguments
let checkOnly = args.contains("--check")
let languageIndex = args.firstIndex(of: "--language")
let language = languageIndex.flatMap { index in
	index + 1 < args.count ? args[index + 1] : nil
} ?? "en-US"

let authSemaphore = DispatchSemaphore(value: 0)
var speechAllowed = false
SFSpeechRecognizer.requestAuthorization { status in
	speechAllowed = status == .authorized
	authSemaphore.signal()
}
authSemaphore.wait()

if !speechAllowed {
	FileHandle.standardError.write(Data("Speech recognition permission denied\n".utf8))
	exit(2)
}

let micSemaphore = DispatchSemaphore(value: 0)
var micAllowed = false
AVCaptureDevice.requestAccess(for: .audio) { allowed in
	micAllowed = allowed
	micSemaphore.signal()
}
micSemaphore.wait()

if !micAllowed {
	FileHandle.standardError.write(Data("Microphone permission denied\n".utf8))
	exit(5)
}

let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language))
if recognizer == nil || recognizer?.isAvailable != true {
	FileHandle.standardError.write(Data("Speech recognizer unavailable\n".utf8))
	exit(3)
}

if checkOnly {
	print("Microphone and speech recognition permissions OK")
	exit(0)
}

let engine = AVAudioEngine()
let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
if #available(macOS 13.0, *) {
	request.addsPunctuation = true
}

var latest = ""
var printed = false
let done = DispatchSemaphore(value: 0)

let task = recognizer!.recognitionTask(with: request) { result, error in
	if let result = result {
		latest = result.bestTranscription.formattedString
	}
	if error != nil || result?.isFinal == true {
		done.signal()
	}
}

let input = engine.inputNode
let format = input.outputFormat(forBus: 0)
input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
	request.append(buffer)
}

func finish() {
	if printed { return }
	printed = true
	input.removeTap(onBus: 0)
	engine.stop()
	request.endAudio()
	_ = done.wait(timeout: .now() + 2)
	task.cancel()
	print(latest)
	exit(0)
}

signal(SIGINT, SIG_IGN)
signal(SIGTERM, SIG_IGN)

let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigint.setEventHandler { finish() }
sigint.resume()

let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigterm.setEventHandler { finish() }
sigterm.resume()

do {
	try engine.start()
} catch {
	FileHandle.standardError.write(Data("Microphone unavailable: \(error.localizedDescription)\n".utf8))
	exit(4)
}

RunLoop.main.run()
