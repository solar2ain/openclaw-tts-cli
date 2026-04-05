# openclaw-tts-cli

Use any command-line TTS tool as an OpenClaw speech provider.

## Install

```bash
openclaw plugins install openclaw-tts-cli
```

## Configuration

Add to your OpenClaw config (`openclaw.yaml`):

```yaml
messages:
  tts:
    provider: cli
    providers:
      cli:
        command: "/usr/local/bin/your-tts-tool"
        args:
          - "--text"
          - "{{Text}}"
          - "--output"
          - "{{OutputPath}}"
        outputFormat: mp3       # mp3 | opus | wav (default: mp3)
        timeoutMs: 120000       # default: 120000
        cwd: /tmp               # optional working directory
        env:                    # optional environment variables
          API_KEY: "your-key"
```

## Template placeholders

| Placeholder      | Description                              |
| ---------------- | ---------------------------------------- |
| `{{Text}}`       | The text to synthesize (emoji-stripped)   |
| `{{OutputPath}}` | Full path for the output audio file      |
| `{{OutputDir}}`  | Directory for output files               |
| `{{OutputBase}}`  | Base filename prefix (no extension)      |

Placeholders are case-insensitive and allow spaces: `{{ text }}` works too.

If no `{{Text}}` placeholder is present in args, the text is piped to the CLI via stdin.

## How it works

1. The plugin spawns your configured CLI command with template-substituted args.
2. It looks for an audio file in the output directory (wav, mp3, opus, ogg, m4a).
3. If no file is found, it reads stdout as audio data.
4. The audio is converted to the desired format using ffmpeg (via OpenClaw's SDK).
5. For telephony, audio is converted to raw 16kHz mono PCM.

## Requirements

- **ffmpeg** must be available (OpenClaw typically bundles or resolves it)
- **Node 22+**
- A TTS CLI tool of your choice (e.g., `piper`, `espeak`, `say`, etc.)

## Examples

### macOS `say` command

```yaml
messages:
  tts:
    provider: cli
    providers:
      cli:
        command: say
        args:
          - "-o"
          - "{{OutputPath}}"
          - "{{Text}}"
        outputFormat: wav
```

### Piper TTS

```yaml
messages:
  tts:
    provider: cli
    providers:
      cli:
        command: piper
        args:
          - "--model"
          - "/path/to/model.onnx"
          - "--output_file"
          - "{{OutputPath}}"
          - "--text"
          - "{{Text}}"
        outputFormat: wav
```

## License

MIT
