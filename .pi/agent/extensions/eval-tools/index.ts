import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

type EvalCase = {
	name: string;
	requiredTool: string;
	tools: string[];
	prompt: string;
	expectedFailure?: FailureCategory;
	setup(cwd: string): Promise<void>;
	validate(cwd: string, text: string): Promise<Validation>;
};

type Validation = {
	ok: boolean;
	reason: string;
};

type ToolCall = {
	name: string;
	args: unknown;
};

type ToolResult = {
	name: string;
	isError: boolean;
	result: unknown;
};

type FailureCategory =
	| "none"
	| "no_tool_call"
	| "wrong_tool"
	| "extra_tool_call"
	| "invalid_args"
	| "tool_execution_error"
	| "task_validation_fail"
	| "timeout"
	| "process_error";

type RunResult = {
	case: string;
	trial: number;
	ok: boolean;
	strictOk: boolean;
	failureCategory: FailureCategory;
	validation: Validation;
	expectedTool: string;
	prompt: string;
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	toolCallCount: number;
	toolErrorCount: number;
	toolCalls: ToolCall[];
	toolResults: ToolResult[];
	finalText: string;
	stdout: string;
	stderr: string;
	cwd?: string;
	command: string[];
};

type CommandOptions = {
	trials: number;
	timeoutMs: number;
	cases: string[];
	concurrency: number;
	jsonPath?: string;
	htmlPath?: string;
	suitePath: string;
	keepFailures: boolean;
	preset?: string;
	overrides?: string[];
};

type EvalTarget = {
	provider: string;
	model: string;
	label: string;
};

type ActiveRun = {
	controller: AbortController;
	rows: RunResult[];
	startedAt: number;
	options: CommandOptions;
	targets: EvalTarget[];
	cases: EvalCase[];
	completed: number;
	total: number;
	current: string[];
	children: Set<{ kill(signal?: string): unknown }>;
	thinkingLevel: string;
	piVersion: string;
};

type Suite = {
	cases: Record<string, EvalCase>;
	defaults: Partial<CommandOptions>;
	presets: Record<string, Partial<CommandOptions>>;
	defaultCases: string[];
};

type RawSuite = {
	defaultCases?: string[];
	defaults?: Record<string, unknown>;
	presets?: Array<Record<string, unknown>>;
	cases?: RawCase[];
};

type RawCase = {
	name?: string;
	tool?: string;
	requiredTool?: string;
	tools?: string[];
	prompt?: string;
	expectedFailure?: FailureCategory;
	setup?: RawStep[];
	expect?: RawExpect[];
};

type RawStep = { file?: string; content?: string };
type RawExpect = {
	answerContains?: string;
	answerEquals?: string;
	file?: string;
	contains?: string;
	equals?: string;
	exists?: boolean;
};

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SUITE = join(EXTENSION_DIR, "native-tools.toml");

export default function evalToolsExtension(pi: ExtensionAPI) {
	pi.registerCommand("eval-tools", {
		description: "Run native tool-call evals on the current model",
		handler: async (args, ctx) => {
			await startEval(pi, ctx, args, undefined);
		},
	});

	pi.registerCommand("eval-tools-compare", {
		description: "Compare native tool-call evals across models",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const models = parts.filter((part) => !part.includes("="));
			const rest = parts.filter((part) => part.includes("=")).join(" ");
			if (models.length < 2) {
				ctx.ui.notify(
					"Usage: /eval-tools-compare provider/a provider/b trials=3",
					"error",
				);
				return;
			}
			const targets = models.map(targetFromSpec);
			await startEval(pi, ctx, rest, targets);
		},
	});
}

async function startEval(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string,
	targets: EvalTarget[] | undefined,
): Promise<void> {
	await ctx.waitForIdle();
	const current = ctx.model;
	if (!targets && !current) {
		ctx.ui.notify("No active model", "error");
		return;
	}
	let options: CommandOptions;
	let cases: EvalCase[];
	try {
		const parsed = parseOptions(args);
		const suite = await loadSuite(parsed.suitePath);
		options = applySuiteOptions(parsed, suite);
		cases = options.cases.map((name) => {
			const testCase = suite.cases[name];
			if (!testCase) throw new Error(`Unknown eval case: ${name}`);
			return testCase;
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Tool eval failed: ${message}`, "error");
		return;
	}
	const evalTargets = targets ?? [{
		provider: current!.provider,
		model: current!.id,
		label: `${current!.provider}/${current!.id}`,
	}];
	const total = evalTargets.length * cases.length * options.trials;
	const active: ActiveRun = {
		controller: new AbortController(),
		rows: [],
		startedAt: Date.now(),
		options,
		targets: evalTargets,
		cases,
		completed: 0,
		total,
		current: [],
		children: new Set(),
		thinkingLevel: pi.getThinkingLevel(),
		piVersion: await getPiVersion(),
	};
	ctx.ui.notify(`Running ${active.total} eval run(s).`, "info");
	if (!ctx.hasUI) {
		const report = await runEval(active, () => {});
		pi.sendMessage({
			customType: "eval-tools",
			content: report,
			display: true,
			details: { rows: active.rows },
		});
		return;
	}
	const report = await ctx.ui.custom<string | undefined>(
		(tui, theme, _kb, done) => {
			const component = new EvalToolsComponent(active, theme, done);
			void runEval(active, () => {
				component.invalidate();
				tui.requestRender();
			}).then((result) => {
				component.setReport(result);
				tui.requestRender();
				done(result);
			});
			return component;
		},
	);
	if (report) {
		pi.sendMessage({
			customType: "eval-tools",
			content: report,
			display: true,
			details: { rows: active.rows },
		});
	}
}

class EvalToolsComponent {
	private report: string | undefined;

	constructor(
		private active: ActiveRun,
		private theme: Theme,
		private done: (report: string | undefined) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.active.controller.abort();
			for (const child of this.active.children) child.kill("SIGTERM");
			return;
		}
		if (matchesKey(data, "return") && this.report) this.done(this.report);
	}

	render(_width: number): string[] {
		const lines = (this.report ?? formatProgress(this.active)).split("\n");
		return [
			this.theme.fg("accent", "Tool eval"),
			this.theme.fg("dim", "Press q or Esc to stop."),
			"",
			...lines,
		];
	}

	setReport(report: string): void {
		this.report = report;
	}

	invalidate(): void {}
	dispose(): void {}
}

async function runEval(
	active: ActiveRun,
	onUpdate: () => void,
): Promise<string> {
	try {
		const jobs = buildJobs(active);
		let next = 0;
		const workers = Array.from(
			{ length: active.options.concurrency },
			async () => {
				while (next < jobs.length && !shouldStop(active)) {
					const job = jobs[next++];
					const label = `${job.target.label} ${job.testCase.name} ` +
						`#${job.trial}`;
					active.current.push(label);
					onUpdate();
					try {
						active.rows.push(await runCase(
							job.testCase,
							job.trial,
							active.options,
							job.target,
							active.thinkingLevel,
							active,
						));
						active.completed++;
					} finally {
						active.current = active.current.filter((item) => item !== label);
						onUpdate();
					}
				}
			},
		);
		await Promise.all(workers);
		if (shouldStop(active)) throw new Error("Eval cancelled");
		return finishEval(active, false);
	} catch (error) {
		const stopped = shouldStop(active);
		if (!stopped) active.controller.abort();
		if (active.rows.length > 0) return finishEval(active, true);
		const message = error instanceof Error ? error.message : String(error);
		return stopped ? "Tool eval stopped." : `Tool eval failed: ${message}`;
	}
}

async function finishEval(
	active: ActiveRun,
	stopped: boolean,
): Promise<string> {
	const report = formatReport(active, stopped);
	if (active.options.jsonPath) await exportJson(active, stopped, report);
	if (active.options.htmlPath) await exportHtml(active, stopped, report);
	return report;
}

function buildJobs(active: ActiveRun) {
	return active.targets.flatMap((target) =>
		active.cases.flatMap((testCase) =>
			Array.from({ length: active.options.trials }, (_value, index) => ({
				target,
				testCase,
				trial: index + 1,
			}))
		)
	);
}

async function runCase(
	testCase: EvalCase,
	trial: number,
	options: CommandOptions,
	target: EvalTarget,
	thinkingLevel: string,
	active: ActiveRun,
): Promise<RunResult> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-tool-eval-"));
	let keep = false;
	try {
		await testCase.setup(cwd);
		const command = [
			"pi",
			"--mode",
			"json",
			"--no-session",
			"--no-context-files",
			"--no-skills",
			"--no-extensions",
			"--no-prompt-templates",
			"--no-themes",
			"--model",
			`${target.provider}/${target.model}`,
			"--thinking",
			thinkingLevel,
			"--tools",
			testCase.tools.join(","),
			testCase.prompt,
		];
		const started = Date.now();
		const result = await run(command, cwd, options.timeoutMs, active);
		if (shouldStop(active)) throw new Error("Eval cancelled");
		const events = parseEvents(result.stdout);
		const toolCalls = getToolCalls(events);
		const toolResults = getToolResults(events);
		const toolErrors = toolResults.filter((event) => event.isError);
		const finalText = getFinalText(events);
		const validation = await testCase.validate(cwd, finalText);
		const strictOk = strictToolUse(toolCalls, testCase);
		const category = failureCategory(
			result,
			validation,
			toolCalls,
			toolErrors,
			testCase,
		);
		const ok = testCase.expectedFailure ?
			category === testCase.expectedFailure && validation.ok :
			category === "none";
		keep = options.keepFailures && !ok;
		return {
			case: target.label === "" ? testCase.name :
				`${target.label}:${testCase.name}`,
			trial,
			ok,
			strictOk: ok && strictOk,
			failureCategory: category,
			validation,
			expectedTool: testCase.requiredTool,
			prompt: testCase.prompt,
			exitCode: result.code,
			timedOut: result.timedOut,
			durationMs: Date.now() - started,
			toolCallCount: toolCalls.length,
			toolErrorCount: toolErrors.length,
			toolCalls,
			toolResults,
			finalText,
			stdout: result.stdout,
			stderr: result.stderr.trim(),
			cwd: keep ? cwd : undefined,
			command,
		};
	} finally {
		if (!keep) await rm(cwd, { recursive: true, force: true });
	}
}

function parseOptions(args: string): CommandOptions {
	const options: CommandOptions = {
		trials: 1,
		timeoutMs: 120000,
		cases: [],
		concurrency: 1,
		suitePath: DEFAULT_SUITE,
		keepFailures: false,
		overrides: [],
	};
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts[0] && !parts[0].includes("=")) options.preset = parts.shift()!;
	for (const arg of parts) {
		if (arg.startsWith("trials=")) {
			options.trials = parsePositiveInt(arg.slice("trials=".length), arg);
			options.overrides!.push("trials");
		} else if (arg.startsWith("timeout=")) {
			options.timeoutMs = parsePositiveInt(arg.slice("timeout=".length), arg);
			options.overrides!.push("timeoutMs");
		} else if (arg.startsWith("cases=")) {
			options.cases = arg.slice("cases=".length).split(",").filter(Boolean);
			options.overrides!.push("cases");
		} else if (arg.startsWith("concurrency=")) {
			options.concurrency = parsePositiveInt(
				arg.slice("concurrency=".length),
				arg,
			);
			options.overrides!.push("concurrency");
		} else if (arg.startsWith("json=")) {
			options.jsonPath = arg.slice("json=".length);
		} else if (arg.startsWith("html=")) {
			options.htmlPath = arg.slice("html=".length);
		} else if (arg.startsWith("suite=")) {
			options.suitePath = arg.slice("suite=".length);
		} else if (arg === "keepFailures=true") {
			options.keepFailures = true;
		} else if (arg === "keepFailures=false") {
			options.keepFailures = false;
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	return options;
}

async function loadSuite(path: string): Promise<Suite> {
	const file = path.startsWith("/") ? path : resolve(process.cwd(), path);
	const raw = parseToml(await readFile(file, "utf8"));
	return compileSuite(raw);
}

function applySuiteOptions(options: CommandOptions, suite: Suite): CommandOptions {
	const merged = { ...options, ...suite.defaults };
	if (options.preset) {
		const preset = suite.presets[options.preset];
		if (!preset) throw new Error(`Unknown preset: ${options.preset}`);
		Object.assign(merged, preset, { preset: options.preset });
	}
	for (const key of options.overrides ?? []) {
		Object.assign(merged, { [key]: options[key as keyof CommandOptions] });
	}
	merged.jsonPath = options.jsonPath;
	merged.htmlPath = options.htmlPath;
	merged.suitePath = options.suitePath;
	merged.keepFailures = options.keepFailures;
	if (merged.cases.length === 0) merged.cases = suite.defaultCases;
	return merged;
}

function compileSuite(raw: RawSuite): Suite {
	const cases: Record<string, EvalCase> = {};
	for (const item of raw.cases ?? []) {
		if (!item.name) throw new Error("Eval case is missing name");
		const requiredTool = item.requiredTool ?? item.tool;
		if (!requiredTool) throw new Error(`${item.name} is missing tool`);
		if (!item.prompt) throw new Error(`${item.name} is missing prompt`);
		cases[item.name] = {
			name: item.name,
			requiredTool,
			tools: item.tools ?? [requiredTool],
			prompt: item.prompt,
			expectedFailure: item.expectedFailure,
			setup: (cwd) => runSetup(cwd, item.setup ?? []),
			validate: (cwd, text) => runExpect(cwd, text, item.expect ?? []),
		};
	}
	const presets: Record<string, Partial<CommandOptions>> = {};
	for (const preset of raw.presets ?? []) {
		const name = String(preset.name ?? "");
		if (!name) throw new Error("Preset is missing name");
		presets[name] = cleanOptions(preset);
	}
	return {
		cases,
		defaults: cleanOptions(raw.defaults ?? {}),
		presets,
		defaultCases: raw.defaultCases ?? Object.keys(cases),
	};
}

function cleanOptions(value: Record<string, unknown>): Partial<CommandOptions> {
	const options: Partial<CommandOptions> = {};
	if (typeof value.trials === "number") options.trials = value.trials;
	if (typeof value.timeoutMs === "number") options.timeoutMs = value.timeoutMs;
	if (typeof value.concurrency === "number") options.concurrency = value.concurrency;
	if (Array.isArray(value.cases)) options.cases = value.cases.map(String);
	return options;
}

async function runSetup(cwd: string, steps: RawStep[]): Promise<void> {
	for (const step of steps) {
		if (!step.file) throw new Error("setup step is missing file");
		await mkdir(dirname(join(cwd, step.file)), { recursive: true });
		await writeFile(join(cwd, step.file), step.content ?? "");
	}
}

async function runExpect(
	cwd: string,
	answer: string,
	expects: RawExpect[],
): Promise<Validation> {
	for (const expect of expects) {
		const result = await checkExpect(cwd, answer, expect);
		if (!result.ok) return result;
	}
	return { ok: true, reason: "ok" };
}

async function checkExpect(
	cwd: string,
	answer: string,
	expect: RawExpect,
): Promise<Validation> {
	if (expect.answerContains !== undefined) {
		const ok = answer.includes(expect.answerContains);
		return { ok, reason: ok ? "ok" : "final answer did not contain token" };
	}
	if (expect.answerEquals !== undefined) {
		const ok = answer.trim() === expect.answerEquals.trim();
		return { ok, reason: ok ? "ok" : "final answer mismatch" };
	}
	if (expect.file) return checkFileExpect(cwd, expect);
	throw new Error("expect step is missing matcher");
}

async function checkFileExpect(cwd: string, expect: RawExpect): Promise<Validation> {
	const path = join(cwd, expect.file!);
	if (expect.exists === true && !existsSync(path)) {
		return { ok: false, reason: `${expect.file} was not created` };
	}
	let text = "";
	try {
		text = await readFile(path, "utf8");
	} catch {
		return { ok: false, reason: `${expect.file} was not created` };
	}
	if (expect.contains !== undefined) {
		const ok = text.includes(expect.contains);
		return { ok, reason: ok ? "ok" : `${expect.file} content mismatch` };
	}
	if (expect.equals !== undefined) {
		const ok = text === expect.equals;
		return { ok, reason: ok ? "ok" : `${expect.file} content mismatch` };
	}
	return { ok: true, reason: "ok" };
}

function parseToml(text: string): RawSuite {
	const root: Record<string, unknown> = {};
	let section = root;
	let currentCase: Record<string, unknown> | undefined;
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index++) {
		let line = stripComment(lines[index]).trim();
		if (!line) continue;
		if (line === "[defaults]") {
			section = objectAt(root, "defaults");
			continue;
		}
		if (line === "[[presets]]") {
			section = pushObject(root, "presets");
			continue;
		}
		if (line === "[[cases]]") {
			currentCase = pushObject(root, "cases");
			section = currentCase;
			continue;
		}
		if (line === "[[cases.setup]]") {
			if (!currentCase) throw new Error("cases.setup before cases");
			section = pushObject(currentCase, "setup");
			continue;
		}
		if (line === "[[cases.expect]]") {
			if (!currentCase) throw new Error("cases.expect before cases");
			section = pushObject(currentCase, "expect");
			continue;
		}
		const equals = line.indexOf("=");
		if (equals === -1) throw new Error(`Invalid TOML line: ${line}`);
		const key = line.slice(0, equals).trim();
		let value = line.slice(equals + 1).trim();
		if (value === '"""') {
			const collected: string[] = [];
			while (++index < lines.length && lines[index].trim() !== '"""') {
				collected.push(lines[index]);
			}
			value = collected.join("\n") + "\n";
			section[key] = value;
		} else if (value.startsWith("[") && !value.endsWith("]")) {
			while (++index < lines.length) {
				line = stripComment(lines[index]).trim();
				value += line;
				if (line.endsWith("]")) break;
			}
			section[key] = parseTomlValue(value);
		} else {
			section[key] = parseTomlValue(value);
		}
	}
	return root as RawSuite;
}

function objectAt(root: Record<string, unknown>, key: string): Record<string, unknown> {
	root[key] ??= {};
	return root[key] as Record<string, unknown>;
}

function pushObject(root: Record<string, unknown>, key: string): Record<string, unknown> {
	const items = (root[key] ??= []) as Array<Record<string, unknown>>;
	const item: Record<string, unknown> = {};
	items.push(item);
	return item;
}

function stripComment(line: string): string {
	let quoted = false;
	for (let index = 0; index < line.length; index++) {
		const char = line[index];
		if (char === '"' && line[index - 1] !== "\\") quoted = !quoted;
		if (char === "#" && !quoted) return line.slice(0, index);
	}
	return line;
}

function parseTomlValue(value: string): unknown {
	if (value.startsWith('"') && value.endsWith('"')) {
		return JSON.parse(value);
	}
	if (value.startsWith("[") && value.endsWith("]")) {
		return JSON.parse(value.replace(/,\s*]/g, "]"));
	}
	if (value === "true") return true;
	if (value === "false") return false;
	const number = Number(value);
	if (Number.isFinite(number)) return number;
	return value;
}

function formatProgress(active: ActiveRun): string {
	const rows = active.rows;
	const failed = rows.filter((row) => !row.ok).length;
	const toolErrors = rows.reduce((sum, row) => sum + row.toolErrorCount, 0);
	const elapsedMs = Date.now() - active.startedAt;
	const etaMs = rows.length === 0 ? undefined :
		Math.round((elapsedMs / rows.length) * (active.total - rows.length));
	const lines = [
		`Tool eval ${active.targets.map((target) => target.label).join(", ")}`,
		`${bar(rows.length, active.total)} ${rows.length}/${active.total} ` +
		`${pct(rows.length, active.total)} ✓${rows.length - failed} ` +
		`✗${failed} tool-errors ${toolErrors}`,
		`elapsed ${duration(elapsedMs)} eta ${duration(etaMs)} ` +
		`concurrency ${active.options.concurrency}`,
		"Stop: q or Esc",
		"",
	];
	for (const name of active.cases.map((item) => item.name)) {
		const caseRows = rows.filter((row) =>
			row.case.endsWith(`:${name}`) || row.case === name
		);
		const pass = caseRows.filter((row) => row.ok).length;
		const fail = caseRows.length - pass;
		const avgMs = caseRows.length === 0 ? 0 : Math.round(
			caseRows.reduce((sum, row) => sum + row.durationMs, 0) / caseRows.length,
		);
		const expected = active.targets.length * active.options.trials;
		const activeMark = active.current.some((item) => item.includes(` ${name} #`));
		lines.push(
			`${activeMark ? "▶" : " "} ${name.padEnd(16)} ` +
			`${miniBar(caseRows.length, expected)} ${caseRows.length}/${expected} ` +
			`✓${pass} ✗${fail} avg ${duration(avgMs)}`,
		);
	}
	const last = rows.at(-1);
	if (active.current.length > 0) {
		lines.push("", `Now: ${active.current.join(", ")}`);
	}
	if (last) {
		lines.push(
			`Last: ${last.ok ? "✓" : "✗"} ${last.case} #${last.trial} ` +
			`${duration(last.durationMs)} ${last.failureCategory}`,
		);
	}
	return lines.join("\n");
}

function formatReport(active: ActiveRun, stopped: boolean): string {
	const rows = active.rows;
	const failed = rows.filter((row) => !row.ok).length;
	const strictFailed = rows.filter((row) => !row.strictOk).length;
	const toolErrorRuns = rows.filter((row) => row.toolErrorCount > 0).length;
	const toolCalls = rows.reduce((sum, row) => sum + row.toolCallCount, 0);
	const toolErrors = rows.reduce((sum, row) => sum + row.toolErrorCount, 0);
	const lines = [
		`${stopped ? "Partial " : ""}Tool eval`,
		`Targets: ${active.targets.map((target) => target.label).join(", ")}`,
		`Thinking: ${active.thinkingLevel}`,
		`Cases: ${active.options.cases.join(",")}`,
		`Trials: ${active.options.trials}`,
		`Timeout: ${active.options.timeoutMs}ms`,
		`Concurrency: ${active.options.concurrency}`,
		`Timestamp: ${new Date(active.startedAt).toISOString()}`,
		`Pi version: ${active.piVersion}`,
		`Runs: ${rows.length}/${active.total}`,
		`Pass rate: ${pct(rows.length - failed, rows.length)}`,
		`Strict tool-use pass rate: ${pct(rows.length - strictFailed, rows.length)}`,
		`Native tool-call failure rate: ${pct(toolErrorRuns, rows.length)}`,
		`Tool-call error rate: ${pct(toolErrors, toolCalls)}`,
		"",
		"By case:",
	];
	for (const name of [...new Set(rows.map((row) => row.case))]) {
		const caseRows = rows.filter((row) => row.case === name);
		const caseFailed = caseRows.filter((row) => !row.ok).length;
		const caseStrictFailed = caseRows.filter((row) => !row.strictOk).length;
		lines.push(
			`${name}: pass ${pct(caseRows.length - caseFailed, caseRows.length)}, ` +
			`strict ${pct(caseRows.length - caseStrictFailed, caseRows.length)}, ` +
			`avg ${duration(avgDuration(caseRows))}`,
		);
	}
	lines.push("", "Failure categories:");
	for (const [category, count] of categoryCounts(rows)) {
		lines.push(`${category}: ${count}`);
	}
	const failures = rows.filter((row) => !row.ok || !row.strictOk);
	if (failures.length > 0) {
		lines.push("", "Failures:");
		for (const row of failures.slice(0, 20)) lines.push(formatFailure(row));
		if (failures.length > 20) lines.push(`... ${failures.length - 20} more`);
	}
	if (active.options.jsonPath) {
		lines.push("", `JSON export: ${active.options.jsonPath}`);
	}
	if (active.options.htmlPath) {
		lines.push(`HTML export: ${active.options.htmlPath}`);
	}
	return lines.join("\n");
}

function formatFailure(row: RunResult): string {
	const calls = row.toolCalls.map((call) => call.name).join(",") || "none";
	const error = row.toolResults.find((result) => result.isError);
	const lines = [
		`${row.case} #${row.trial}: ${row.failureCategory}; ` +
		`expected=${row.expectedTool}; calls=${calls}; exit=${row.exitCode}`,
		`  validation: ${row.validation.reason}`,
	];
	if (row.toolCalls.length > 0) {
		lines.push(`  args: ${stringifyShort(row.toolCalls[0].args)}`);
	}
	if (error) lines.push(`  tool error: ${stringifyShort(error.result)}`);
	if (row.finalText) lines.push(`  final: ${truncate(row.finalText, 300)}`);
	if (row.stderr) lines.push(`  stderr: ${truncate(row.stderr, 300)}`);
	if (row.cwd) lines.push(`  cwd: ${row.cwd}`);
	return lines.join("\n");
}

async function exportJson(
	active: ActiveRun,
	stopped: boolean,
	report: string,
): Promise<void> {
	const file = resolve(process.cwd(), active.options.jsonPath!);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, JSON.stringify({
		stopped,
		report,
		startedAt: new Date(active.startedAt).toISOString(),
		targets: active.targets,
		thinkingLevel: active.thinkingLevel,
		piVersion: active.piVersion,
		options: active.options,
		rows: active.rows,
	}, null, 2));
}

async function exportHtml(
	active: ActiveRun,
	stopped: boolean,
	report: string,
): Promise<void> {
	const file = resolve(process.cwd(), active.options.htmlPath!);
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, renderHtml(active, stopped, report));
}

function renderHtml(active: ActiveRun, stopped: boolean, report: string): string {
	const rows = active.rows;
	const failed = rows.filter((row) => !row.ok).length;
	const strictFailed = rows.filter((row) => !row.strictOk).length;
	const title = `${stopped ? "Partial " : ""}Tool eval`;
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${html(title)}</title>
<style>
body{font-family:ui-sans-serif,system-ui,sans-serif;margin:32px;background:#111;color:#eee}
pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.card{background:#1b1b1b;border:1px solid #333;border-radius:10px;padding:16px;margin:12px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.metric{font-size:24px;font-weight:700}.muted{color:#aaa}.ok{color:#7ee787}.bad{color:#ff7b72}
table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border-bottom:1px solid #333;padding:8px;text-align:left;vertical-align:top}
details{border:1px solid #333;border-radius:8px;margin:8px 0;padding:8px;background:#181818}summary{cursor:pointer}
.block{white-space:pre-wrap;background:#0b0b0b;border:1px solid #333;border-radius:6px;padding:10px;overflow:auto}
.raw{display:none}body.show-raw .raw{display:block}body.show-raw .transcript{display:none}
button{background:#30363d;color:#eee;border:1px solid #555;border-radius:6px;padding:8px 10px;cursor:pointer}
</style>
<script>
function toggleRaw(){document.body.classList.toggle('show-raw')}
</script>
</head>
<body>
<h1>${html(title)}</h1>
<button onclick="toggleRaw()">Toggle readable transcript / raw stdout</button>
<div class="grid">
${metric("Runs", `${rows.length}/${active.total}`)}
${metric("Pass rate", pct(rows.length - failed, rows.length))}
${metric("Strict pass", pct(rows.length - strictFailed, rows.length))}
${metric("Duration", duration(Date.now() - active.startedAt))}
</div>
<div class="card"><pre>${html(report)}</pre></div>
${renderHtmlSummary(active)}
<h2>Failures</h2>
${rows.filter((row) => !row.ok || !row.strictOk).map(renderRow).join("\n") || "<p class=\"muted\">No failures</p>"}
<h2>All runs</h2>
${rows.map(renderRow).join("\n")}
</body>
</html>`;
}

function metric(label: string, value: string): string {
	return `<div class="card"><div class="muted">${html(label)}</div>` +
		`<div class="metric">${html(value)}</div></div>`;
}

function renderHtmlSummary(active: ActiveRun): string {
	const names = [...new Set(active.rows.map((row) => row.case))];
	return `<div class="card"><h2>By case</h2><table><thead><tr>` +
		`<th>Case</th><th>Runs</th><th>Pass</th><th>Strict</th><th>Avg</th>` +
		`</tr></thead><tbody>${names.map((name) => {
			const rows = active.rows.filter((row) => row.case === name);
			const failed = rows.filter((row) => !row.ok).length;
			const strictFailed = rows.filter((row) => !row.strictOk).length;
			return `<tr><td>${html(name)}</td><td>${rows.length}</td>` +
				`<td>${pct(rows.length - failed, rows.length)}</td>` +
				`<td>${pct(rows.length - strictFailed, rows.length)}</td>` +
				`<td>${duration(avgDuration(rows))}</td></tr>`;
		}).join("")}</tbody></table></div>`;
}

function renderRow(row: RunResult): string {
	const status = row.ok && row.strictOk ? "ok" : "bad";
	return `<details><summary><span class="${status}">` +
		`${row.ok && row.strictOk ? "✓" : "✗"}</span> ${html(row.case)} ` +
		`#${row.trial} ${html(row.failureCategory)} ${duration(row.durationMs)}` +
		`</summary><table><tbody>` +
		rowField("Expected tool", row.expectedTool) +
		rowField("Validation", row.validation.reason) +
		rowField("Exit", String(row.exitCode)) +
		rowField("Prompt", row.prompt) +
		`</tbody></table>` +
		section("Readable transcript", renderTranscript(row), "transcript") +
		section("Tool calls", JSON.stringify(row.toolCalls, null, 2)) +
		section("Tool results", JSON.stringify(row.toolResults, null, 2)) +
		section("Final text", row.finalText) +
		section("stderr", row.stderr) +
		section("Raw stdout", row.stdout, "raw") +
		`</details>`;
}

function rowField(label: string, value: string): string {
	return `<tr><th>${html(label)}</th><td>${html(value)}</td></tr>`;
}

function section(label: string, value: string, className = ""): string {
	if (!value) return "";
	return `<h4>${html(label)}</h4><pre class="block ${className}">` +
		`${html(value)}</pre>`;
}

function renderTranscript(row: RunResult): string {
	const events = parseEvents(row.stdout);
	const lines = [`User: ${row.prompt}`];
	for (const event of events) {
		if (event.type === "tool_execution_start") {
			lines.push(
				`Tool call: ${String(event.toolName)} ` +
				stringifyShort(event.args),
			);
		} else if (event.type === "tool_execution_end") {
			const prefix = event.isError ? "Tool error" : "Tool result";
			lines.push(`${prefix}: ${String(event.toolName)} ` +
				stringifyShort(event.result));
		}
	}
	if (row.finalText) lines.push(`Assistant: ${row.finalText}`);
	return lines.join("\n\n");
}

function html(value: string): string {
	return value.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function failureCategory(
	result: { code: number | null; timedOut: boolean },
	validation: Validation,
	toolCalls: ToolCall[],
	toolErrors: ToolResult[],
	testCase: EvalCase,
): FailureCategory {
	if (result.timedOut) return "timeout";
	if (result.code !== 0) return "process_error";
	if (toolCalls.length === 0) return "no_tool_call";
	if (toolCalls.some((call) => !testCase.tools.includes(call.name))) {
		return "wrong_tool";
	}
	if (!toolCalls.some((call) => call.name === testCase.requiredTool)) {
		return "no_tool_call";
	}
	if (toolErrors.some((item) => looksLikeInvalidArgs(item.result))) {
		return "invalid_args";
	}
	if (toolErrors.length > 0) return "tool_execution_error";
	if (!validation.ok) return "task_validation_fail";
	return "none";
}

function strictToolUse(toolCalls: ToolCall[], testCase: EvalCase): boolean {
	return toolCalls.some((call) => call.name === testCase.requiredTool) &&
		toolCalls.every((call) => testCase.tools.includes(call.name));
}

function parseEvents(stdout: string): Array<Record<string, unknown>> {
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
		try {
			return JSON.parse(line) as Record<string, unknown>;
		} catch {
			return { type: "invalid_json", line };
		}
	});
}

function getToolCalls(events: Array<Record<string, unknown>>): ToolCall[] {
	return events.filter((event) => event.type === "tool_execution_start").map(
		(event) => ({ name: String(event.toolName), args: event.args }),
	);
}

function getToolResults(events: Array<Record<string, unknown>>): ToolResult[] {
	return events.filter((event) => event.type === "tool_execution_end").map(
		(event) => ({
			name: String(event.toolName),
			isError: event.isError === true,
			result: event.result,
		}),
	);
}

function runDetached(
	command: string[],
	cwd: string,
	timeoutMs: number,
) {
	const controller = new AbortController();
	const active: ActiveRun = {
		controller,
		rows: [],
		startedAt: Date.now(),
		options: {
			trials: 1,
			timeoutMs,
			cases: [],
			concurrency: 1,
			suitePath: DEFAULT_SUITE,
			keepFailures: false,
		},
		targets: [],
		cases: [],
		completed: 0,
		total: 0,
		current: [],
		children: new Set(),
		thinkingLevel: "off",
		piVersion: "unknown",
	};
	return run(command, cwd, timeoutMs, active);
}

function run(
	command: string[],
	cwd: string,
	timeoutMs: number,
	active: ActiveRun,
) {
	return new Promise<{
		code: number | null;
		stdout: string;
		stderr: string;
		timedOut: boolean;
	}>((resolve) => {
		if (shouldStop(active)) {
			resolve({
				code: 130,
				stdout: "",
				stderr: "Eval cancelled",
				timedOut: false,
			});
			return;
		}
		const child = spawn(command[0], command.slice(1), {
			cwd,
			env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		active.children.add(child);
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const kill = () => {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2000).unref();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, timeoutMs);
		const stopPoll = setInterval(() => {
			if (shouldStop(active)) kill();
		}, 250);
		const onAbort = () => kill();
		active.controller.signal.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk) => stdout += chunk);
		child.stderr.on("data", (chunk) => stderr += chunk);
		child.on("error", (error) => {
			clearTimeout(timer);
			clearInterval(stopPoll);
			active.children.delete(child);
			active.controller.signal.removeEventListener("abort", onAbort);
			resolve({
				code: 1,
				stdout,
				stderr: `${stderr}\n${error.message}`,
				timedOut,
			});
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			clearInterval(stopPoll);
			active.children.delete(child);
			active.controller.signal.removeEventListener("abort", onAbort);
			resolve({ code, stdout, stderr, timedOut });
		});
	});
}

async function getPiVersion(): Promise<string> {
	const result = await runDetached(["pi", "--version"], process.cwd(), 5000);
	return result.stdout.trim() || result.stderr.trim() || "unknown";
}

function shouldStop(active: ActiveRun): boolean {
	return active.controller.signal.aborted;
}

function targetFromSpec(spec: string): EvalTarget {
	const slash = spec.indexOf("/");
	if (slash === -1) throw new Error(`Model must be provider/model: ${spec}`);
	return {
		provider: spec.slice(0, slash),
		model: spec.slice(slash + 1),
		label: spec,
	};
}

function getFinalText(events: Array<Record<string, unknown>>): string {
	const end = events.filter((event) => event.type === "message_end").at(-1);
	const message = end?.message as { content?: unknown } | undefined;
	return extractText(message?.content);
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => {
		if (typeof part === "string") return part;
		if (!part || typeof part !== "object") return "";
		const item = part as Record<string, unknown>;
		return item.text ?? item.content ?? item.delta ?? "";
	}).join("");
}

function parsePositiveInt(value: string, name: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 1) {
		throw new Error(`${name} must be >= 1`);
	}
	return parsed;
}

function pct(numerator: number, denominator: number): string {
	if (denominator === 0) return "0.0%";
	return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function avgDuration(rows: RunResult[]): number {
	if (rows.length === 0) return 0;
	return Math.round(
		rows.reduce((sum, row) => sum + row.durationMs, 0) / rows.length,
	);
}

function categoryCounts(rows: RunResult[]): Array<[string, number]> {
	const counts = new Map<string, number>();
	for (const row of rows) {
		counts.set(row.failureCategory, (counts.get(row.failureCategory) ?? 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function bar(done: number, total: number): string {
	const width = 24;
	const filled = total === 0 ? 0 : Math.round((done / total) * width);
	return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function miniBar(done: number, total: number): string {
	const width = 10;
	const filled = total === 0 ? 0 : Math.round((done / total) * width);
	return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function duration(ms: number | undefined): string {
	if (ms === undefined) return "--";
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${`${seconds % 60}`.padStart(2, "0")}s`;
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function stringifyShort(value: unknown): string {
	return truncate(
		typeof value === "string" ? value : JSON.stringify(value),
		300,
	);
}

function looksLikeInvalidArgs(value: unknown): boolean {
	const text = stringifyShort(value).toLowerCase();
	return ["argument", "args", "schema", "required", "invalid"].some(
		(word) => text.includes(word),
	);
}
