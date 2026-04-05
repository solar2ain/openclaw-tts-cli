import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildCliSpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "tts-local-cli",
  name: "Local CLI TTS",
  description: "Use any command-line TTS tool as an OpenClaw speech provider",
  register(api) {
    api.registerSpeechProvider(buildCliSpeechProvider());
  },
});
