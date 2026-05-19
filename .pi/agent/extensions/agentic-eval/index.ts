import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { complete, type Message } from "@earendil-works/pi-ai";
import {
	BorderedLoader,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const MAX_DIFF_CHARS = 120000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_VERIFY_TIMEOUT_MS = 2 * 60 * 1000;

const SPEC_SYSTEM_PROMPT = `You write fair task specs for agentic model evals.

Given a single commit diff, produce a self-contained coding task spec for a
fresh agent that will start from the parent commit. The spec must describe the
intended product/code behavior, not the original implementation.

Rules:
- Do not mention the commit SHA, patch, diff, or original implementation.
- Do not copy exact code from the diff unless it is an externally visible API,
  CLI flag, string literal, schema, or user-facing contract.
- Avoid naming exact files unless that is needed to make the task fair.
- Include deterministic verification guidance when tests or commands are clear.
- Flag ambiguity or likely unfairness for the human reviewer.
- Keep it concise but sufficient for a competent coding agent.

Return markdown with these headings:
## Task
## Requirements
## Verification
## Fairness notes`;

const ATTEMPT_PROMPT_PREFIX = `You are a fresh coding agent running in a
sandbox checkout at the baseline before a hidden target commit.

Implement the task spec below. Do not inspect the hidden target commit, parent
directories, benchmark artifacts, or git history beyond the current HEAD. Use
normal repository context, code search, and tests. Make the required code
changes in this checkout, then give a concise summary.`;

type CommandOptions = {
	model?: string;
	out?: string;
	name?: string;
	verifier?: string;
	tools?: string;
	keepWorktree: boolean;
	attemptTimeoutMs: number;
	verifyTimeoutMs: number;
};

type ParsedCommand =
	| { action: "commit"; commit: string; options: CommandOptions }
	| { action: "run"; configPath: string; options: CommandOptions }
	| { action: "help" };

type Manifest = {
	version: 1;
	createdAt: string;
	repoRoot: string;
	targetCommit: string;
	parentCommit: string;
	specPath: string;
	verifierCommand?: string;
	model?: string;
	thinking: string;
	tools?: string;
	sourceDiffTruncated: boolean;
	trials: Trial[];
};

type Trial = {
	id: string;
	startedAt: string;
	finishedAt: string;
	model?: string;
	thinking: string;
	tools?: string;
	status: "passed" | "failed" | "unscored" | "agent_failed";
	agentExitCode: number | null;
	verifierCommand?: string;
	verifierExitCode?: number | null;
	verifierTimedOut?: boolean;
	worktreePath?: string;
	worktreeKept: boolean;
	artifacts: Record<string, string>;
};

type ProcessResult = {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
};

type SpecResult =
	| { ok: true; text: string }
	| { ok: false; error: string };

export default function agenticEvalExtension(pi: ExtensionAPI) {
	pi.registerCommand("agentic-eval", {
		description: "Evaluate an agent against a spec derived from a commit",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			let parsed: ParsedCommand;
			try {
				parsed = parseCommand(args);
			} catch (error) {
				showError(pi, ctx, errorMessage(error));
				return;
			}
			if (parsed.action === "help") {
				pi.sendMessage({
					customType: "agentic-eval",
					content: usage(),
					display: true,
				});
				return;
			}
			try {
				const report = parsed.action === "commit"
					? await prepareAndRun(pi, ctx, parsed.commit, parsed.options)
					: await rerun(pi, ctx, parsed.configPath, parsed.options);
				if (report) {
					pi.sendMessage({
						customType: "agentic-eval",
						content: report,
						display: true,
					});
				}
			} catch (error) {
				showError(pi, ctx, `Agentic eval failed: ${errorMessage(error)}`);
			}
		},
	});
}

async function prepareAndRun(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	commit: string,
	options: CommandOptions,
): Promise<string | undefined> {
	if (!ctx.hasUI) {
		throw new Error("commit setup requires interactive UI approval");
	}
	const repoRoot = await gitRoot(ctx.cwd);
	const targetCommit = await gitOne(
		repoRoot,
		["rev-parse", `${commit}^{commit}`],
	);
	const parentCommit = await singleParent(repoRoot, targetCommit);
	const diffResult = await git(repoRoot, [
		"show",
		"--format=fuller",
		"--stat",
		"--patch",
		"--find-renames",
		"--find-copies",
		"--no-ext-diff",
		targetCommit,
	]);
	if (diffResult.code !== 0) throw new Error(diffResult.stderr);
	const sourceDiffTruncated = diffResult.stdout.length > MAX_DIFF_CHARS;
	const diff = sourceDiffTruncated
		? diffResult.stdout.slice(0, MAX_DIFF_CHARS)
		: diffResult.stdout;
	const generated = await generateSpec(ctx, diff, sourceDiffTruncated);
	if (generated === undefined) return undefined;
	const edited = await ctx.ui.editor("Review agentic eval spec", generated);
	if (edited === undefined) return undefined;
	const approved = await ctx.ui.confirm(
		"Run eval?",
		"The edited spec will be shown to a fresh agent in an isolated checkout.",
	);
	if (!approved) return undefined;
	let verifier = options.verifier?.trim() || undefined;
	if (options.verifier === undefined) {
		verifier = await ctx.ui.input("Verifier command (optional)", "npm test");
		if (verifier === undefined) return undefined;
		verifier = verifier.trim() || undefined;
	}
	const evalDir = await createEvalDir(repoRoot, targetCommit, options);
	await mkdir(evalDir, { recursive: true });
	await writeFile(join(evalDir, "spec.md"), edited, "utf8");
	const manifest: Manifest = {
		version: 1,
		createdAt: new Date().toISOString(),
		repoRoot,
		targetCommit,
		parentCommit,
		specPath: "spec.md",
		verifierCommand: verifier,
		model: options.model ?? modelSpec(ctx),
		thinking: pi.getThinkingLevel(),
		tools: options.tools,
		sourceDiffTruncated,
		trials: [],
	};
	await saveManifest(evalDir, manifest);
	return runTrial(pi, ctx, evalDir, manifest, options);
}

async function rerun(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	configPath: string,
	options: CommandOptions,
): Promise<string> {
	const evalDir = await resolveEvalDir(ctx.cwd, configPath);
	const manifest = await loadManifest(evalDir);
	return runTrial(pi, ctx, evalDir, manifest, options);
}

async function generateSpec(
	ctx: ExtensionCommandContext,
	diff: string,
	truncated: boolean,
): Promise<string | undefined> {
	if (!ctx.model) throw new Error("No active model selected");
	const result = await ctx.ui.custom<SpecResult | undefined>(
		(tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, "Generating eval spec...");
			loader.onAbort = () => done(undefined);
			void generateSpecText(ctx, diff, truncated, loader.signal)
				.then((text) => done({ ok: true, text }))
				.catch((error) => {
					if (!loader.signal.aborted) {
						done({ ok: false, error: errorMessage(error) });
					}
				});
			return loader;
		},
	);
	if (result === undefined) return undefined;
	if (!result.ok) throw new Error(result.error);
	return result.text;
}

async function generateSpecText(
	ctx: ExtensionCommandContext,
	diff: string,
	truncated: boolean,
	signal: AbortSignal,
): Promise<string> {
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
	if (!auth.ok || !auth.apiKey) {
		throw new Error(
			auth.ok ? `No API key for ${ctx.model!.provider}` : auth.error,
		);
	}
	const note = truncated
		? "\n\nThe diff was truncated. Add a fairness note about this."
		: "";
	const userMessage: Message = {
		role: "user",
		content: [{ type: "text", text: `Commit diff:\n\n${diff}${note}` }],
		timestamp: Date.now(),
	};
	const response = await complete(
		ctx.model!,
		{ systemPrompt: SPEC_SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey: auth.apiKey, headers: auth.headers, signal },
	);
	if (response.stopReason === "aborted") throw new Error("cancelled");
	return response.content
		.filter((part): part is { type: "text"; text: string } =>
			part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

async function runTrial(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	evalDir: string,
	manifest: Manifest,
	options: CommandOptions,
): Promise<string> {
	const spec = await readFile(join(evalDir, manifest.specPath), "utf8");
	const trialId = await nextTrialId(evalDir);
	const trialDir = join(evalDir, "trials", trialId);
	await mkdir(trialDir, { recursive: true });
	const controller = new AbortController();
	const run = () => executeTrial(
		pi,
		evalDir,
		trialDir,
		trialId,
		manifest,
		spec,
		options,
		controller.signal,
	);
	let report: string;
	if (ctx.hasUI) {
		report = await ctx.ui.custom<string>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, `Running ${trialId}...`);
			loader.onAbort = () => controller.abort();
			void run().then(done).catch((error) => done(
				`Agentic eval failed: ${errorMessage(error)}`,
			));
			return loader;
		});
	} else {
		report = await run();
	}
	await saveManifest(evalDir, manifest);
	return report;
}

async function executeTrial(
	pi: ExtensionAPI,
	evalDir: string,
	trialDir: string,
	trialId: string,
	manifest: Manifest,
	spec: string,
	options: CommandOptions,
	signal: AbortSignal,
): Promise<string> {
	const worktreeParent = await mkdtemp(join(tmpdir(), "pi-agentic-eval-"));
	const worktree = join(worktreeParent, "worktree");
	const startedAt = new Date().toISOString();
	let worktreeKept = options.keepWorktree;
	const artifacts: Record<string, string> = {};
	let agentResult: ProcessResult | undefined;
	let verifyResult: ProcessResult | undefined;
	try {
		await createSandbox(
			manifest.repoRoot,
			manifest.parentCommit,
			worktree,
		);
		const prompt = `${ATTEMPT_PROMPT_PREFIX}\n\n## Task spec\n\n${spec}\n`;
		agentResult = await runPiAttempt(
			prompt,
			worktree,
			manifest,
			options,
			pi.getThinkingLevel(),
			signal,
		);
		artifacts.events = "events.jsonl";
		artifacts.stderr = "agent-stderr.txt";
		await writeFile(join(trialDir, artifacts.events), agentResult.stdout);
		await writeFile(join(trialDir, artifacts.stderr), agentResult.stderr);
		await git(worktree, ["add", "-N", "--", "."]);
		const status = await git(worktree, ["status", "--short"]);
		const diff = await git(worktree, ["diff", "--binary", "--", "."]);
		artifacts.status = "status.txt";
		artifacts.diff = "attempt.patch";
		await writeFile(join(trialDir, artifacts.status), status.stdout);
		await writeFile(join(trialDir, artifacts.diff), diff.stdout);
		await git(worktree, ["reset", "-q"]);
		const finalText = finalAssistantText(agentResult.stdout);
		if (finalText) {
			artifacts.final = "final.txt";
			await writeFile(join(trialDir, artifacts.final), finalText);
		}
		const verifierCommand = effectiveVerifier(manifest, options);
		if (agentResult.code === 0 && verifierCommand) {
			verifyResult = await runShell(
				verifierCommand,
				worktree,
				options.verifyTimeoutMs,
				signal,
			);
			artifacts.verifier = "verifier.txt";
			await writeFile(
				join(trialDir, artifacts.verifier),
				formatVerifierOutput(verifierCommand, verifyResult),
			);
		}
		const trial = makeTrial(
			trialId,
			startedAt,
			manifest,
			options,
			agentResult,
			verifyResult,
			verifierCommand,
			worktree,
			worktreeKept,
			artifacts,
		);
		manifest.trials.push(trial);
		const report = formatReport(evalDir, manifest, trial);
		artifacts.summary = "summary.md";
		await writeFile(join(trialDir, artifacts.summary), report);
		return report;
	} finally {
		if (!worktreeKept) {
			await rm(worktreeParent, { recursive: true, force: true });
		} else if (!existsSync(worktree)) {
			worktreeKept = false;
		}
	}
}

function makeTrial(
	trialId: string,
	startedAt: string,
	manifest: Manifest,
	options: CommandOptions,
	agentResult: ProcessResult,
	verifyResult: ProcessResult | undefined,
	verifierCommand: string | undefined,
	worktree: string,
	worktreeKept: boolean,
	artifacts: Record<string, string>,
): Trial {
	const status = score(agentResult, verifyResult, verifierCommand);
	return {
		id: trialId,
		startedAt,
		finishedAt: new Date().toISOString(),
		model: options.model ?? manifest.model,
		thinking: manifest.thinking,
		tools: options.tools ?? manifest.tools,
		status,
		agentExitCode: agentResult.code,
		verifierCommand,
		verifierExitCode: verifyResult?.code,
		verifierTimedOut: verifyResult?.timedOut,
		worktreePath: worktreeKept ? worktree : undefined,
		worktreeKept,
		artifacts,
	};
}

function score(
	agentResult: ProcessResult,
	verifyResult: ProcessResult | undefined,
	verifier: string | undefined,
): Trial["status"] {
	if (agentResult.code !== 0 || agentResult.timedOut) return "agent_failed";
	if (!verifier) return "unscored";
	return verifyResult?.code === 0 && !verifyResult.timedOut
		? "passed"
		: "failed";
}

function effectiveVerifier(
	manifest: Manifest,
	options: CommandOptions,
): string | undefined {
	if (options.verifier !== undefined) {
		return options.verifier.trim() || undefined;
	}
	return manifest.verifierCommand?.trim() || undefined;
}

async function runPiAttempt(
	prompt: string,
	cwd: string,
	manifest: Manifest,
	options: CommandOptions,
	currentThinking: string,
	signal: AbortSignal,
): Promise<ProcessResult> {
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--thinking",
		manifest.thinking || currentThinking,
	];
	const model = options.model ?? manifest.model;
	if (model) args.push("--model", model);
	const tools = options.tools ?? manifest.tools;
	if (tools) args.push("--tools", tools);
	args.push(prompt);
	const invocation = getPiInvocation(args);
	return runProcess(
		invocation.command,
		invocation.args,
		cwd,
		options.attemptTimeoutMs,
		signal,
	);
}

async function runShell(
	command: string,
	cwd: string,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<ProcessResult> {
	return runProcess("/bin/sh", ["-lc", command], cwd, timeoutMs, signal);
}

function runProcess(
	command: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ProcessResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd,
			env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const kill = () => {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2000).unref();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, timeoutMs);
		const onAbort = () => kill();
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk) => stdout += chunk);
		child.stderr.on("data", (chunk) => stderr += chunk);
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({
				code: 1,
				stdout,
				stderr: `${stderr}\n${error.message}`,
				timedOut,
			});
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ code, stdout, stderr, timedOut });
		});
	});
}

async function gitRoot(cwd: string): Promise<string> {
	return gitOne(cwd, ["rev-parse", "--show-toplevel"]);
}

async function gitOne(cwd: string, args: string[]): Promise<string> {
	const result = await git(cwd, args);
	if (result.code !== 0) throw new Error(result.stderr.trim() || "git failed");
	return result.stdout.trim();
}

async function git(
	cwd: string,
	args: string[],
	timeoutMs = 30000,
): Promise<ProcessResult> {
	return runProcess("git", args, cwd, timeoutMs);
}

async function createSandbox(
	repoRoot: string,
	parentCommit: string,
	worktree: string,
): Promise<void> {
	const archivePath = join(dirname(worktree), "baseline.tar");
	await mkdir(worktree, { recursive: true });
	try {
		const archive = await git(
			repoRoot,
			["archive", "--format=tar", `--output=${archivePath}`, parentCommit],
			120000,
		);
		if (archive.code !== 0) throw new Error(archive.stderr);
		const extract = await runProcess(
			"tar",
			["-xf", archivePath, "-C", worktree],
			dirname(worktree),
			120000,
		);
		if (extract.code !== 0) throw new Error(extract.stderr);
	} finally {
		await rm(archivePath, { force: true });
	}
	const init = await git(worktree, ["init", "-q"]);
	if (init.code !== 0) throw new Error(init.stderr);
	const add = await git(worktree, ["add", "-A"]);
	if (add.code !== 0) throw new Error(add.stderr);
	const commit = await git(worktree, [
		"-c",
		"user.name=pi agentic eval",
		"-c",
		"user.email=pi-agentic-eval@example.invalid",
		"commit",
		"--allow-empty",
		"--no-gpg-sign",
		"-qm",
		"baseline",
	]);
	if (commit.code !== 0) throw new Error(commit.stderr);
}

async function singleParent(
	repoRoot: string,
	targetCommit: string,
): Promise<string> {
	const line = await gitOne(
		repoRoot,
		["rev-list", "--parents", "-n", "1", targetCommit],
	);
	const parts = line.split(/\s+/);
	if (parts.length !== 2) {
		throw new Error("Only non-merge commits are supported");
	}
	return parts[1];
}

async function createEvalDir(
	repoRoot: string,
	targetCommit: string,
	options: CommandOptions,
): Promise<string> {
	if (options.out) return resolve(repoRoot, options.out);
	const repoName = safeName(basename(repoRoot) || "repo");
	const hash = createHash("sha1").update(repoRoot).digest("hex").slice(0, 8);
	const shortCommit = targetCommit.slice(0, 12);
	const stamp = new Date().toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/, "Z")
		.replace("T", "-");
	const suffix = options.name ? `-${safeName(options.name)}` : "";
	return join(
		homedir(),
		".pi",
		"agent",
		"agentic-evals",
		`${repoName}-${hash}`,
		`${stamp}-${shortCommit}${suffix}`,
	);
}

async function resolveEvalDir(
	cwd: string,
	configPath: string,
): Promise<string> {
	const full = resolve(cwd, configPath);
	if (existsSync(join(full, "eval.json"))) return full;
	if (basename(full) === "eval.json") return dirname(full);
	throw new Error(`Config not found: ${configPath}`);
}

async function loadManifest(evalDir: string): Promise<Manifest> {
	const manifest = JSON.parse(
		await readFile(join(evalDir, "eval.json"), "utf8"),
	) as Manifest;
	if (manifest.version !== 1) throw new Error("Unsupported eval manifest");
	return manifest;
}

async function saveManifest(
	evalDir: string,
	manifest: Manifest,
): Promise<void> {
	await writeFile(
		join(evalDir, "eval.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
}

async function nextTrialId(evalDir: string): Promise<string> {
	const trialsDir = join(evalDir, "trials");
	let max = 0;
	try {
		const entries = await readdir(trialsDir);
		for (const entry of entries) {
			const match = entry.match(/^trial-(\d+)$/);
			if (match) max = Math.max(max, Number.parseInt(match[1], 10));
		}
	} catch {
		return "trial-001";
	}
	return `trial-${String(max + 1).padStart(3, "0")}`;
}

function finalAssistantText(stdout: string): string {
	const events = stdout.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line) as Record<string, unknown>;
			} catch {
				return undefined;
			}
		})
		.filter((event): event is Record<string, unknown> => event !== undefined);
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event.type !== "message_end") continue;
		const message = event.message as { role?: string; content?: unknown };
		if (message?.role === "assistant") return extractText(message.content).trim();
	}
	return "";
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => {
		if (typeof part === "string") return part;
		if (!part || typeof part !== "object") return "";
		const item = part as Record<string, unknown>;
		const value = item.text ?? item.content ?? item.delta ?? "";
		return typeof value === "string" ? value : "";
	}).join("");
}

function formatVerifierOutput(command: string, result: ProcessResult): string {
	return [
		`$ ${command}`,
		`exit: ${result.code}`,
		`timed out: ${result.timedOut}`,
		"",
		"--- stdout ---",
		result.stdout,
		"--- stderr ---",
		result.stderr,
	].join("\n");
}

function formatReport(
	evalDir: string,
	manifest: Manifest,
	trial: Trial,
): string {
	const lines = [
		"# Agentic eval result",
		"",
		`Status: ${trial.status}`,
		`Trial: ${trial.id}`,
		`Model: ${trial.model ?? "default"}`,
		`Thinking: ${trial.thinking}`,
		`Verifier: ${trial.verifierCommand ?? "none"}`,
		`Eval dir: ${evalDir}`,
		`Config: ${join(evalDir, "eval.json")}`,
		`Spec: ${join(evalDir, manifest.specPath)}`,
		`Artifacts: ${join(evalDir, "trials", trial.id)}`,
		"",
		`Agent exit: ${trial.agentExitCode}`,
	];
	if (trial.verifierCommand) {
		lines.push(`Verifier exit: ${trial.verifierExitCode}`);
		lines.push(`Verifier timed out: ${trial.verifierTimedOut ?? false}`);
	}
	if (trial.worktreePath) lines.push(`Checkout: ${trial.worktreePath}`);
	if (manifest.sourceDiffTruncated) {
		lines.push("", "Warning: source diff was truncated during spec generation.");
	}
	return lines.join("\n");
}

function modelSpec(ctx: ExtensionCommandContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function showError(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	message: string,
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, "error");
		return;
	}
	pi.sendMessage({
		customType: "agentic-eval",
		content: message,
		display: true,
	});
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

function parseCommand(args: string): ParsedCommand {
	const tokens = tokenize(args);
	if (tokens.length === 0 || tokens[0] === "help" || tokens[0] === "--help") {
		return { action: "help" };
	}
	const first = tokens.shift()!;
	if (first === "run") {
		const configPath = tokens.shift();
		if (!configPath) throw new Error("Usage: /agentic-eval run <eval.json>");
		return { action: "run", configPath, options: parseOptions(tokens) };
	}
	if (first === "commit") {
		const commit = tokens.shift();
		if (!commit) throw new Error("Usage: /agentic-eval commit <sha>");
		return { action: "commit", commit, options: parseOptions(tokens) };
	}
	return { action: "commit", commit: first, options: parseOptions(tokens) };
}

function parseOptions(tokens: string[]): CommandOptions {
	const options: CommandOptions = {
		keepWorktree: false,
		attemptTimeoutMs: DEFAULT_ATTEMPT_TIMEOUT_MS,
		verifyTimeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
	};
	for (const token of tokens) {
		const index = token.indexOf("=");
		if (index === -1) throw new Error(`Expected key=value option: ${token}`);
		const key = token.slice(0, index);
		const value = token.slice(index + 1);
		if (key === "model") options.model = value;
		else if (key === "out") options.out = value;
		else if (key === "name") options.name = value;
		else if (key === "verify" || key === "verifier") options.verifier = value;
		else if (key === "tools") options.tools = value;
		else if (key === "keep" || key === "keepWorktree") {
			options.keepWorktree = parseBoolean(value, key);
		} else if (key === "timeout") {
			options.attemptTimeoutMs = parseDuration(value, key);
		} else if (key === "verifyTimeout") {
			options.verifyTimeoutMs = parseDuration(value, key);
		} else {
			throw new Error(`Unknown option: ${key}`);
		}
	}
	return options;
}

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: string | undefined;
	let escaped = false;
	for (const char of input.trim()) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === "\"" || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (quote) throw new Error("Unclosed quote in command arguments");
	if (escaped) current += "\\";
	if (current) tokens.push(current);
	return tokens;
}

function parseBoolean(value: string, key: string): boolean {
	if (["true", "1", "yes", "on"].includes(value)) return true;
	if (["false", "0", "no", "off"].includes(value)) return false;
	throw new Error(`${key} must be true or false`);
}

function parseDuration(value: string, key: string): number {
	const match = value.match(/^(\d+)(ms|s|m)?$/);
	if (!match) throw new Error(`${key} must be a duration like 120s or 5m`);
	const amount = Number.parseInt(match[1], 10);
	const unit = match[2] ?? "ms";
	if (unit === "ms") return amount;
	if (unit === "s") return amount * 1000;
	return amount * 60 * 1000;
}

function safeName(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "eval";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function usage(): string {
	return [
		"Usage:",
		"/agentic-eval commit <sha> [key=value...]",
		"/agentic-eval run <eval.json|eval-dir> [key=value...]",
		"",
		"Options:",
		"model=provider/model",
		"verify=\"npm test\"",
		"tools=read,bash,edit,write,grep,find,ls",
		"timeout=15m",
		"verifyTimeout=2m",
		"keepWorktree=true",
		"out=/path/to/eval-dir",
	].join("\n");
}
