import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	spawn,
	spawnSync,
	type ChildProcessWithoutNullStreams,
} from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type Backend = "native" | "openai";
type InsertMode = "replace" | "append" | "prepend";

type VoiceConfig = {
	backend: Backend;
	language: string;
	shortcut: string;
	insertMode: InsertMode;
	openai: {
		baseUrl: string;
		apiKeyEnv: string;
		model: string;
	};
};

type Recording = {
	backend: Backend;
	child: ChildProcessWithoutNullStreams;
	file?: string;
	output: string;
	error: string;
};

const configPath = join(homedir(), ".pi", "agent", "voice.json");
const helperPath = join(__dirname, "macos-transcribe.swift");
const helperBinaryPath = join(__dirname, "macos-transcribe");

const defaultConfig: VoiceConfig = {
	backend: "native",
	language: "en-US",
	shortcut: "ctrl+shift+v",
	insertMode: "replace",
	openai: {
		baseUrl: "https://api.openai.com/v1",
		apiKeyEnv: "OPENAI_API_KEY",
		model: "whisper-1",
	},
};

let recording: Recording | undefined;

export default function (pi: ExtensionAPI) {
	const config = loadConfig();

	pi.registerShortcut(config.shortcut || "ctrl+shift+v", {
		description: "Toggle voice dictation",
		handler: async (ctx) => {
			await toggleVoice(ctx);
		},
	});

	pi.registerCommand("voice", {
		description: "Toggle voice dictation",
		handler: async (_args, ctx) => {
			await toggleVoice(ctx);
		},
	});

	pi.registerCommand("voice-backend", {
		description: "Set voice backend: native or openai",
		handler: async (args, ctx) => {
			const backend = args.trim();
			if (backend !== "native" && backend !== "openai") {
				ctx.ui.notify("Usage: /voice-backend native|openai", "warning");
				return;
			}
			const next = { ...loadConfig(), backend };
			saveConfig(next);
			ctx.ui.notify("Voice backend saved. Run /reload to update shortcut.", "info");
		},
	});

	pi.registerCommand("voice-insert-mode", {
		description: "Set voice insert mode: replace, append, or prepend",
		handler: async (args, ctx) => {
			const insertMode = args.trim();
			if (
				insertMode !== "replace" &&
				insertMode !== "append" &&
				insertMode !== "prepend"
			) {
				ctx.ui.notify(
					"Usage: /voice-insert-mode replace|append|prepend",
					"warning",
				);
				return;
			}
			const next = { ...loadConfig(), insertMode };
			saveConfig(next);
			ctx.ui.notify("Voice insert mode saved.", "info");
		},
	});

	pi.registerCommand("voice-language", {
		description: "Set native voice language, e.g. en-US",
		handler: async (args, ctx) => {
			const language = args.trim();
			if (!language) {
				ctx.ui.notify("Usage: /voice-language en-US", "warning");
				return;
			}
			const next = { ...loadConfig(), language };
			saveConfig(next);
			ctx.ui.notify("Voice language saved.", "info");
		},
	});

	pi.registerCommand("voice-permissions", {
		description: "Open macOS microphone and speech recognition settings",
		handler: async (_args, ctx) => {
			spawn("open", [
				"x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
			]);
			spawn("open", [
				"x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition",
			]);
			ctx.ui.notify(
				"Enable your terminal app for Microphone and Speech Recognition.",
				"info",
			);
		},
	});

	pi.registerCommand("voice-check", {
		description: "Check native macOS voice permissions",
		handler: async (_args, ctx) => {
			const config = loadConfig();
			try {
				const output = await runHelperCheck(config.language);
				ctx.ui.notify(output || "Voice permissions OK", "success");
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});

	pi.registerCommand("voice-config", {
		description: "Show voice dictation config path and current settings",
		handler: async (_args, ctx) => {
			const current = loadConfig();
			ctx.ui.notify(
				`${configPath}\n${JSON.stringify(current, null, 2)}`,
				"info",
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("voice", undefined);
	});

	pi.on("session_shutdown", async () => {
		if (recording) await stopChild(recording.child);
		recording = undefined;
	});
}

async function toggleVoice(ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	if (recording) {
		await stopRecording(ctx);
	} else {
		await startRecording(ctx);
	}
}

async function startRecording(ctx: ExtensionContext) {
	const config = loadConfig();
	try {
		const next =
			config.backend === "native"
				? startNativeRecording(config)
				: startOpenAIRecording();
		recording = next;
		await ensureStarted(next);
		ctx.ui.setStatus("voice", ctx.ui.theme.fg("warning", "🎙 recording"));
		ctx.ui.notify("Recording. Press voice shortcut again to stop.", "info");
	} catch (error) {
		recording = undefined;
		ctx.ui.setStatus("voice", undefined);
		ctx.ui.notify(errorMessage(error), "error");
	}
}

async function stopRecording(ctx: ExtensionContext) {
	const current = recording;
	if (!current) return;
	recording = undefined;
	ctx.ui.setStatus("voice", ctx.ui.theme.fg("accent", "transcribing"));
	try {
		await stopChild(current.child);
		const transcript =
			current.backend === "native"
				? current.output.trim()
				: await transcribeOpenAI(current.file!);
		await cleanup(current.file);
		ctx.ui.setStatus("voice", undefined);
		if (!transcript) {
			ctx.ui.notify("No speech detected.", "warning");
			return;
		}
		insertTranscript(ctx, transcript);
		ctx.ui.notify("Transcript inserted.", "success");
	} catch (error) {
		await cleanup(current.file);
		ctx.ui.setStatus("voice", undefined);
		ctx.ui.notify(errorMessage(error), "error");
	}
}

async function runHelperCheck(language: string): Promise<string> {
	ensureNativeHelperBuilt();
	const child = spawn(helperBinaryPath, ["--check", "--language", language], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	let error = "";
	child.stdout.on("data", (data) => (output += data.toString()));
	child.stderr.on("data", (data) => (error += data.toString()));
	const code = await new Promise<number | null>((resolve) => {
		child.once("exit", resolve);
	});
	if (code !== 0) throw new Error(error.trim() || `Check exited with ${code}`);
	return output.trim();
}

function startNativeRecording(config: VoiceConfig): Recording {
	ensureNativeHelperBuilt();
	const child = spawn(helperBinaryPath, ["--language", config.language], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const rec = { backend: "native" as const, child, output: "", error: "" };
	child.stdout.on("data", (data) => (rec.output += data.toString()));
	child.stderr.on("data", (data) => (rec.error += data.toString()));
	return rec;
}

function ensureNativeHelperBuilt() {
	if (existsSync(helperBinaryPath)) return;
	const result = spawnSync("swiftc", [
		helperPath,
		"-o",
		helperBinaryPath,
		"-framework",
		"Speech",
		"-framework",
		"AVFoundation",
	]);
	if (result.status !== 0) {
		throw new Error(result.stderr.toString() || "Failed to build native helper");
	}
}

function startOpenAIRecording(): Recording {
	if (!commandExists("rec")) {
		throw new Error("OpenAI voice backend requires sox: brew install sox");
	}
	const file = join(tmpdir(), `pi-voice-${Date.now()}.wav`);
	const child = spawn("rec", ["-q", "-b", "16", "-c", "1", "-r", "16000", file], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const rec = { backend: "openai" as const, child, file, output: "", error: "" };
	child.stdout.on("data", (data) => (rec.output += data.toString()));
	child.stderr.on("data", (data) => (rec.error += data.toString()));
	child.on("error", () => {});
	return rec;
}

async function transcribeOpenAI(file: string): Promise<string> {
	const config = loadConfig();
	const key = process.env[config.openai.apiKeyEnv];
	if (!key) throw new Error(`Missing ${config.openai.apiKeyEnv}`);
	const audio = await readFile(file);
	const form = new FormData();
	form.append("model", config.openai.model);
	form.append("file", new Blob([audio], { type: "audio/wav" }), "audio.wav");
	const baseUrl = config.openai.baseUrl.replace(/\/$/, "");
	const response = await fetch(`${baseUrl}/audio/transcriptions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${key}` },
		body: form,
	});
	if (!response.ok) throw new Error(await response.text());
	const body = (await response.json()) as { text?: string };
	return body.text?.trim() ?? "";
}

async function ensureStarted(rec: Recording): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 500));
	if (rec.child.exitCode === null) return;
	throw new Error(rec.error.trim() || `Recorder exited with ${rec.child.exitCode}`);
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null) return;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolve();
		}, 4000);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
		child.kill("SIGINT");
	});
}

function insertTranscript(ctx: ExtensionContext, transcript: string) {
	const config = loadConfig();
	const current = ctx.ui.getEditorText();
	if (config.insertMode === "append") {
		ctx.ui.setEditorText(joinText(current, transcript));
	} else if (config.insertMode === "prepend") {
		ctx.ui.setEditorText(joinText(transcript, current));
	} else {
		ctx.ui.setEditorText(transcript);
	}
}

function joinText(left: string, right: string) {
	if (!left.trim()) return right;
	if (!right.trim()) return left;
	return `${left.trimEnd()} ${right.trimStart()}`;
}

function loadConfig(): VoiceConfig {
	try {
		if (!existsSync(configPath)) {
			saveConfig(defaultConfig);
			return defaultConfig;
		}
		return mergeConfig(JSON.parse(readFileSync(configPath, "utf8")));
	} catch {
		return defaultConfig;
	}
}

function saveConfig(config: VoiceConfig) {
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function mergeConfig(value: Partial<VoiceConfig>): VoiceConfig {
	return {
		...defaultConfig,
		...value,
		openai: { ...defaultConfig.openai, ...value.openai },
	};
}

async function cleanup(file?: string) {
	if (!file) return;
	await unlink(file).catch(() => undefined);
}

function commandExists(command: string) {
	return spawnSync("which", [command]).status === 0;
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}
