import { buildCliSpeechProvider } from "./speech-provider.js";

export default {
  id: "openclaw-tts-cli",
  name: "Local CLI TTS",
  description: "Use any command-line TTS tool as an OpenClaw speech provider",
  register(api: any) {
    api.registerSpeechProvider(buildCliSpeechProvider());
  },
};
