## What you get

- A **Встречи** page in the sidebar: paste a Zoom, Google Meet, Telemost or Jitsi link, watch the bot's screen live, read the transcript as it grows, play the recording, rename speakers, search all meetings, and download md, txt, srt, vtt or json.
- `meetings_*` agent tools, so an agent can send the bot from a link, report whether it got in, and write a summary with decisions and action items when the meeting ends.
- A `bb meetings` command for the same work from a terminal, plus `doctor`, `setup` and `selftest`.
- **Local recording on macOS** (Apple silicon, macOS 14.4+): no bot joins. The plugin notices that Zoom, Teams, Telegram, FaceTime or a browser call started using the microphone and records it locally (mic, and system audio once its permission is granted), then transcribes with a local Whisper large-v3-turbo or GigaAM. Participants get no notice because no bot joins.
- Optional auto-join for every supported meeting in a Google, Outlook or Yandex calendar (secret ICS address).

## How it works

A bot runs Google Chrome on a virtual display and joins through its browser client, with no Zoom API keys. ffmpeg records what the bot hears, and GigaAM v3 transcribes it on your machine while the meeting runs. Speakers are named from Zoom's own signals (the active speaker, the highlighted tile, per-participant audio tracks) and from voice clustering.

Recording and the default speech recognition run on the recording host. Transcripts reach an AI provider when an agent reads them or API analysis is enabled, and reach a webhook recipient when you configure one. To keep transcripts local, disable automatic analysis, thread notifications and webhooks.

## Templates and agent integrations

Five built-in templates and editable custom rules produce structured summaries, tasks, risks, chapters, follow-up drafts and speech metrics. Applied rules are retained with each analysis. Ask grounded questions across meetings, connect external agents through MCP/REST, or receive HMAC-signed completion webhooks. The portable MCP stdio adapter uses your existing BB CLI access; HTTP clients also need access through BB's authentication boundary.

By default the requesting BB agent performs analysis. An optional OpenAI-compatible API can perform it directly; keys stay on the server. Outgoing screen sharing is blocked while the avatar camera and microphone continue working.

## Requirements

- **Bot mode**: Linux (x86-64 or arm64) with Google Chrome, Xvfb, PulseAudio and ffmpeg; `bb meetings setup` installs the rest.
- **Local recording**: macOS 14.4+ on Apple silicon, ffmpeg and Xcode command-line tools (for swiftc); `bb meetings setup` installs uv, the Python environment and the Whisper model (~1.6 GB). macOS asks for Microphone and System Audio Recording permission for the BB app.

Speech recognition: the `gigaam` plugin or another OpenAI-compatible server, or a local Whisper model on macOS. Russian only.
