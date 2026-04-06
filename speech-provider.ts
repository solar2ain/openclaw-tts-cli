import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// --- SDK dynamic imports with fallback for older OpenClaw versions ---

type LogFn = (msg: string, ...args: unknown[]) => void;

const log: { debug: LogFn; warn: LogFn; error: LogFn } = {
  debug: (...args) => console.log("[openclaw-tts-cli]", ...args),
  warn: (...args) => console.warn("[openclaw-tts-cli]", ...args),
  error: (...args) => console.error("[openclaw-tts-cli]", ...args),
};

let _sdkResolved = false;
let _ffmpegRunner: ((args: string[]) => Promise<void>) | undefined;
let _preferredTmpDir: (() => string) | undefined;

async function resolveSDK(): Promise<void> {
  if (_sdkResolved) return;
  _sdkResolved = true;
  try {
    const { createSubsystemLogger } = await import("openclaw/plugin-sdk/runtime-env");
    const sdkLog = createSubsystemLogger("openclaw-tts-cli");
    log.debug = sdkLog.debug;
    log.warn = sdkLog.warn;
    log.error = sdkLog.error;
  } catch {}
  try {
    const { runFfmpeg } = await import("openclaw/plugin-sdk/media-runtime");
    _ffmpegRunner = runFfmpeg;
  } catch {}
  try {
    const { resolvePreferredOpenClawTmpDir } = await import("openclaw/plugin-sdk/sandbox");
    _preferredTmpDir = resolvePreferredOpenClawTmpDir;
  } catch {}
}

async function ffmpegRunner(args: string[]): Promise<void> {
  await resolveSDK();
  if (_ffmpegRunner) return _ffmpegRunner(args);
  await execFileAsync("ffmpeg", args, { timeout: 60_000, maxBuffer: 50 * 1024 * 1024 });
}

function getTmpDir(): string {
  return _preferredTmpDir ? _preferredTmpDir() : os.tmpdir();
}

// --- Types (no runtime dependency) ---

type SpeechProviderConfig = Record<string, unknown>;

type SpeechProviderPlugin = {
  id: string;
  aliases?: string[];
  label: string;
  autoSelectOrder?: number;
  resolveConfig?: (ctx: any) => SpeechProviderConfig;
  isConfigured: (ctx: any) => boolean;
  synthesize: (req: any) => Promise<any>;
  synthesizeTelephony?: (req: any) => Promise<any>;
};

// --- Config helpers ---

const VALID_OUTPUT_FORMATS = ["mp3", "opus", "wav"] as const;
type OutputFormat = (typeof VALID_OUTPUT_FORMATS)[number];

type CliConfig = {
  command: string;
  args?: string[];
  outputFormat?: OutputFormat;
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
};

const DEFAULT_TIMEOUT_MS = 120_000;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined;
}

function asRecord(value: unknown): Record<string, string> | undefined {
  const obj = asObject(value);
  if (!obj) return undefined;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") result[k] = v;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeOutputFormat(value: unknown): OutputFormat {
  if (typeof value !== "string") return "mp3";
  const lower = value.toLowerCase().trim();
  if (VALID_OUTPUT_FORMATS.includes(lower as OutputFormat)) {
    return lower as OutputFormat;
  }
  return "mp3";
}

function resolvePluginEntryConfig(
  cfg: Record<string, unknown> | undefined,
): SpeechProviderConfig | undefined {
  const plugins = asObject(cfg?.plugins);
  const entries = asObject(plugins?.entries);
  const entry = asObject(entries?.["openclaw-tts-cli"]);
  return asObject(entry?.config) ?? undefined;
}

function resolveCliProviderConfig(
  rawConfig: Record<string, unknown>,
  cfg?: Record<string, unknown>,
): SpeechProviderConfig {
  const providers = asObject(rawConfig.providers);
  const fromProviders = asObject(providers?.cli) ?? asObject(providers?.["openclaw-tts-cli"]);
  if (fromProviders) return fromProviders;
  // Fallback: plugin config (plugins.entries.openclaw-tts-cli.config)
  return resolvePluginEntryConfig(cfg) ?? {};
}

function getConfig(cfg: SpeechProviderConfig): CliConfig | null {
  const command = typeof cfg.command === "string" ? cfg.command.trim() : "";
  if (!command) return null;
  return {
    command,
    args: asStringArray(cfg.args),
    outputFormat: normalizeOutputFormat(cfg.outputFormat),
    timeoutMs: typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS,
    cwd: typeof cfg.cwd === "string" ? cfg.cwd : undefined,
    env: asRecord(cfg.env),
  };
}

// --- Text / template helpers ---

function stripEmojis(text: string): string {
  return text
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function applyTemplate(str: string, ctx: Record<string, string | undefined>): string {
  // Support both {{Text}} (double-brace) and {text} (single-brace) placeholders
  return str
    .replace(/{{\s*(\w+)\s*}}/gi, (_match, key) => {
      const normalizedKey = key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
      return ctx[normalizedKey] ?? ctx[key] ?? "";
    })
    .replace(/(?<!\{)\{(\w+)\}(?!\})/gi, (_match, key) => {
      const normalizedKey = key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
      return ctx[normalizedKey] ?? ctx[key] ?? "";
    });
}

function parseCommand(cmdStr: string): { cmd: string; initialArgs: string[] } {
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";

  for (const char of cmdStr.trim()) {
    if (inQuote) {
      if (char === quoteChar) inQuote = false;
      else current += char;
    } else if (char === '"' || char === "'") {
      inQuote = true;
      quoteChar = char;
    } else if (char === " " || char === "\t") {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return { cmd: parts[0] || "", initialArgs: parts.slice(1) };
}

// --- Audio helpers ---

function findAudioFile(dir: string, baseName: string): string | null {
  const files = readdirSync(dir);
  const audioExts = [".wav", ".mp3", ".opus", ".ogg", ".m4a"];
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (audioExts.includes(ext) && (file.startsWith(baseName) || file.includes(baseName))) {
      return path.join(dir, file);
    }
  }
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (audioExts.includes(ext)) return path.join(dir, file);
  }
  return null;
}

function detectFormat(filePath: string): "mp3" | "opus" | "wav" | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".opus" || ext === ".ogg") return "opus";
  if (ext === ".wav") return "wav";
  if (ext === ".mp3" || ext === ".m4a") return "mp3";
  return null;
}

function getFileExt(format: string): string {
  if (format === "opus") return ".opus";
  if (format === "wav") return ".wav";
  return ".mp3";
}

// --- CLI runner ---

async function runCli(params: {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  text: string;
  outputDir: string;
  filePrefix: string;
  outputFormat?: OutputFormat;
}): Promise<{ buffer: Buffer; actualFormat: "mp3" | "opus" | "wav"; audioPath?: string }> {
  const cleanText = stripEmojis(params.text);
  if (!cleanText) throw new Error("CLI TTS: text is empty after removing emojis");

  const outputExt = getFileExt(params.outputFormat ?? "wav");
  const ctx: Record<string, string | undefined> = {
    Text: cleanText,
    OutputPath: path.join(params.outputDir, `${params.filePrefix}${outputExt}`),
    OutputDir: params.outputDir,
    OutputBase: params.filePrefix,
    Fileprefix: params.filePrefix,
  };

  const { cmd, initialArgs } = parseCommand(params.command);
  if (!cmd) throw new Error("CLI TTS: invalid command");

  const baseArgs = [...initialArgs, ...params.args];
  const args = baseArgs.map((a) => applyTemplate(a, ctx));

  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      setTimeout(() => proc.kill("SIGKILL"), 5000).unref();
    }, params.timeoutMs);

    const env = params.env ? { ...process.env, ...params.env } : process.env;
    const proc = spawn(cmd, args, { cwd: params.cwd, env, stdio: ["pipe", "pipe", "pipe"] });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on("data", (c) => stdoutChunks.push(c));
    proc.stderr.on("data", (c) => stderrChunks.push(c));

    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`CLI TTS failed: ${e.message}`));
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(new Error(`CLI TTS timed out after ${params.timeoutMs}ms`));
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        return reject(new Error(`CLI TTS exit ${code}: ${stderr}`));
      }

      const audioFile = findAudioFile(params.outputDir, params.filePrefix);
      if (audioFile) {
        if (!existsSync(audioFile)) {
          return reject(new Error(`CLI TTS: output file not found at ${audioFile}`));
        }
        const format = detectFormat(audioFile);
        if (!format) return reject(new Error(`CLI TTS: unknown format for ${audioFile}`));
        return resolve({
          buffer: readFileSync(audioFile),
          actualFormat: format,
          audioPath: audioFile,
        });
      }

      const stdout = Buffer.concat(stdoutChunks);
      if (stdout.length > 0) {
        return resolve({ buffer: stdout, actualFormat: "wav" });
      }
      reject(new Error("CLI TTS produced no output"));
    });

    if (!baseArgs.some((a) => /{{\s*text\s*}}/i.test(a) || /(?<!\{)\{text\}(?!\})/i.test(a))) {
      proc.stdin?.on("error", () => {});
      proc.stdin?.write(cleanText);
      proc.stdin?.end();
    }
  });
}

// --- Audio conversion ---

async function convertAudio(
  inputPath: string,
  outputDir: string,
  target: OutputFormat,
): Promise<Buffer> {
  const outputPath = path.join(outputDir, `converted${getFileExt(target)}`);
  const args = ["-y", "-i", inputPath];
  if (target === "opus") args.push("-c:a", "libopus", "-b:a", "64k", outputPath);
  else if (target === "wav") args.push("-c:a", "pcm_s16le", outputPath);
  else args.push("-c:a", "libmp3lame", "-b:a", "128k", outputPath);
  await ffmpegRunner(args);
  return readFileSync(outputPath);
}

async function convertToRawPcm(inputPath: string, outputDir: string): Promise<Buffer> {
  const outputPath = path.join(outputDir, "telephony.pcm");
  await ffmpegRunner([
    "-y", "-i", inputPath,
    "-c:a", "pcm_s16le", "-ar", "16000", "-ac", "1", "-f", "s16le",
    outputPath,
  ]);
  return readFileSync(outputPath);
}

// --- Provider ---

export function buildCliSpeechProvider(): SpeechProviderPlugin {
  return {
    id: "openclaw-tts-cli",
    aliases: ["cli"],
    label: "Local CLI",
    autoSelectOrder: 1000,

    resolveConfig(ctx): SpeechProviderConfig {
      return resolveCliProviderConfig(ctx.rawConfig, ctx.cfg);
    },

    isConfigured(ctx): boolean {
      const resolved = ctx.providerConfig && Object.keys(ctx.providerConfig).length > 0
        ? ctx.providerConfig
        : resolvePluginEntryConfig(ctx.cfg);
      return getConfig(resolved ?? {}) !== null;
    },

    async synthesize(req) {
      await resolveSDK();
      let providerConfig = req.providerConfig;
      if (!providerConfig || Object.keys(providerConfig).length === 0) {
        providerConfig = resolvePluginEntryConfig(req.cfg);
        log.debug("synthesize: using plugin entry config fallback");
      }
      const config = getConfig(providerConfig ?? {});
      if (!config) throw new Error("CLI TTS not configured");

      log.debug(`synthesize: text="${req.text.slice(0, 50)}…", format=${config.outputFormat}`);

      const tempDir = mkdtempSync(path.join(getTmpDir(), "openclaw-cli-tts-"));

      try {
        const result = await runCli({
          command: config.command,
          args: config.args ?? [],
          cwd: config.cwd,
          env: config.env,
          timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          text: req.text,
          outputDir: tempDir,
          filePrefix: "speech",
          outputFormat: config.outputFormat,
        });

        log.debug(`synthesize: format=${result.actualFormat}, size=${result.buffer.length}`);

        let buffer: Buffer;
        let format: OutputFormat;

        if (req.target === "voice-note") {
          if (result.actualFormat !== "opus") {
            const inputFile =
              result.audioPath ?? path.join(tempDir, `input${getFileExt(result.actualFormat)}`);
            if (!result.audioPath) writeFileSync(inputFile, result.buffer);
            buffer = await convertAudio(inputFile, tempDir, "opus");
            format = "opus";
          } else {
            buffer = result.buffer;
            format = "opus";
          }
        } else {
          const desired = config.outputFormat ?? "mp3";
          if (result.actualFormat !== desired) {
            const inputFile =
              result.audioPath ?? path.join(tempDir, `input${getFileExt(result.actualFormat)}`);
            if (!result.audioPath) writeFileSync(inputFile, result.buffer);
            buffer = await convertAudio(inputFile, tempDir, desired);
            format = desired;
          } else {
            buffer = result.buffer;
            format = result.actualFormat;
          }
        }

        const fileExtension = format === "opus" ? ".ogg" : `.${format}`;
        return {
          audioBuffer: buffer,
          outputFormat: format,
          fileExtension,
          voiceCompatible: req.target === "voice-note" && format === "opus",
        };
      } finally {
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    },

    async synthesizeTelephony(req) {
      let providerConfig = req.providerConfig;
      if (!providerConfig || Object.keys(providerConfig).length === 0) {
        providerConfig = resolvePluginEntryConfig(req.cfg);
      }
      const config = getConfig(providerConfig ?? {});
      if (!config) throw new Error("CLI TTS not configured");

      log.debug(`synthesizeTelephony: text=${req.text.slice(0, 50)}...`);

      await resolveSDK();
      const tempDir = mkdtempSync(path.join(getTmpDir(), "openclaw-cli-tts-"));

      try {
        const result = await runCli({
          command: config.command,
          args: config.args ?? [],
          cwd: config.cwd,
          env: config.env,
          timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          text: req.text,
          outputDir: tempDir,
          filePrefix: "telephony",
          outputFormat: config.outputFormat,
        });

        const inputFile =
          result.audioPath ?? path.join(tempDir, `input${getFileExt(result.actualFormat)}`);
        if (!result.audioPath) writeFileSync(inputFile, result.buffer);

        const pcmBuffer = await convertToRawPcm(inputFile, tempDir);

        return {
          audioBuffer: pcmBuffer,
          outputFormat: "pcm",
          sampleRate: 16000,
        };
      } finally {
        try {
          rmSync(tempDir, { recursive: true, force: true });
        } catch {}
      }
    },
  };
}
