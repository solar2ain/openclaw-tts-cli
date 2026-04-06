# openclaw-tts-cli

Use any command-line TTS tool as an OpenClaw speech provider.

## Install

```bash
openclaw plugins install openclaw-tts-cli
```

## Configuration

There are two ways to configure this plugin, depending on your OpenClaw version.

### Option 1: `messages.tts.providers` (recommended, OpenClaw 2026.4+)

Add to your OpenClaw config:

```json
{
  "messages": {
    "tts": {
      "provider": "cli",
      "providers": {
        "cli": {
          "command": "/usr/local/bin/your-tts-tool",
          "args": ["--text", "{{Text}}", "--output", "{{OutputPath}}"],
          "outputFormat": "mp3",
          "timeoutMs": 120000,
          "cwd": "/tmp",
          "env": {
            "API_KEY": "your-key"
          }
        }
      }
    }
  }
}
```

### Option 2: Plugin config (compatible with all versions)

If your OpenClaw version does not support `messages.tts.providers`, configure
through the plugin entry instead:

```json
{
  "plugins": {
    "entries": {
      "openclaw-tts-cli": {
        "enabled": true,
        "config": {
          "command": "/usr/local/bin/your-tts-tool",
          "args": ["--text", "{text}", "--output", "{outputPath}"],
          "outputFormat": "mp3",
          "timeoutMs": 120000,
          "cwd": "/tmp",
          "env": {
            "API_KEY": "your-key"
          }
        }
      }
    }
  }
}
```

> **Priority:** `messages.tts.providers.cli` takes precedence over plugin config.
> If both are set, the plugin config is ignored.

## Template placeholders

| Placeholder                     | Description                          |
| ------------------------------- | ------------------------------------ |
| `{{Text}}` or `{text}`          | The text to synthesize (emoji-stripped) |
| `{{OutputPath}}` or `{outputPath}` | Full path for the output audio file |
| `{{OutputDir}}` or `{outputDir}`   | Directory for output files          |
| `{{OutputBase}}` or `{outputBase}` | Base filename prefix (no extension) |
| `{filePrefix}`                  | Alias for OutputBase                 |

Placeholders are case-insensitive. Double-brace style allows spaces: `{{ text }}` works too.

If no `{{Text}}` or `{text}` placeholder is present in args, the text is piped to the CLI via stdin.

## How it works

1. The plugin spawns your configured CLI command with template-substituted args.
2. It looks for an audio file in the output directory (wav, mp3, opus, ogg, m4a).
3. If no file is found, it reads stdout as audio data.
4. The audio is converted to the desired format using ffmpeg (via OpenClaw's SDK).
5. For telephony, audio is converted to raw 16kHz mono PCM.

## Requirements

- **ffmpeg** must be available (OpenClaw typically bundles or resolves it)
- **Node 22+**
- A TTS CLI tool of your choice (e.g., `piper`, `espeak`, `say`, `mlx-audio`, etc.)

## Examples

### macOS `say` command

```json
{
  "messages": {
    "tts": {
      "provider": "cli",
      "providers": {
        "cli": {
          "command": "say",
          "args": ["-o", "{{OutputPath}}", "{{Text}}"],
          "outputFormat": "wav"
        }
      }
    }
  }
}
```

### Piper TTS

```json
{
  "messages": {
    "tts": {
      "provider": "cli",
      "providers": {
        "cli": {
          "command": "piper",
          "args": ["--model", "/path/to/model.onnx", "--output_file", "{{OutputPath}}", "--text", "{{Text}}"],
          "outputFormat": "wav"
        }
      }
    }
  }
}
```

### MLX-Audio (Qwen3-TTS)

Uses Apple Silicon GPU acceleration via MLX for local neural TTS.

Plugin config style (compatible with all versions):

```json
{
  "plugins": {
    "entries": {
      "openclaw-tts-cli": {
        "enabled": true,
        "config": {
          "command": "python3 -m mlx_audio.tts.generate --model mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16 --voice serena --lang_code zh --audio_format wav",
          "args": ["--output_path", "{outputDir}", "--file_prefix", "{filePrefix}", "--text", "{text}"],
          "outputFormat": "opus"
        }
      }
    }
  }
}
```

Or with `messages.tts.providers` (OpenClaw 2026.4+):

```json
{
  "messages": {
    "tts": {
      "provider": "cli",
      "providers": {
        "cli": {
          "command": "python3 -m mlx_audio.tts.generate --model mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16 --voice serena --lang_code zh --audio_format wav",
          "args": ["--output_path", "{outputDir}", "--file_prefix", "{filePrefix}", "--text", "{text}"],
          "outputFormat": "opus"
        }
      }
    }
  }
}
```

## License

MIT
