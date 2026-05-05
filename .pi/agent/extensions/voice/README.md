# Voice extension

Adds voice dictation for the pi input editor.

## Usage

Press `ctrl+shift+v` to start recording, then press it again to stop and insert
the transcript. You can also run:

```text
/voice
```

Useful commands:

- `/voice-check`: checks native macOS microphone and speech permissions.
- `/voice-permissions`: opens the relevant macOS privacy settings.
- `/voice-backend native|openai`: chooses the transcription backend.
- `/voice-insert-mode replace|append|prepend`: controls transcript insertion.
- `/voice-language en-US`: sets the native macOS recognizer locale.
- `/voice-config`: shows the config path and current settings.

Configuration is stored at `~/.pi/agent/voice.json`.

## Backends

`native` uses macOS Speech and AVFoundation. It is the default backend and
requires macOS microphone and speech-recognition permissions. The Swift helper
is compiled automatically with `swiftc` the first time it is used.

`openai` records audio with `sox`'s `rec` command and sends the temporary WAV to
an OpenAI-compatible `/audio/transcriptions` endpoint. Install sox with
`brew install sox` and set the configured API key environment variable, which
defaults to `OPENAI_API_KEY`.

## How it works

The extension registers a shortcut plus several slash commands. Starting
recording spawns either the native Swift helper or `rec`, and updates pi's
status area. Stopping recording sends SIGINT to the child process, collects or
submits the audio transcript, removes temporary files, and writes the transcript
into the editor according to the configured insert mode.
