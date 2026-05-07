import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

const EXA_API_URL = "https://api.exa.ai";

const SearchParams = Type.Object({
	query: Type.String({ description: "Search query" }),
	type: Type.Optional(
		StringEnum(["auto", "neural", "keyword"] as const, {
			description: "Search mode. Use auto unless the user asks otherwise.",
		}),
	),
	numResults: Type.Optional(
		Type.Integer({
			description: "Number of results to return, from 1 to 20",
			minimum: 1,
			maximum: 20,
		}),
	),
	includeDomains: Type.Optional(
		Type.Array(Type.String(), {
			description: "Only return results from these domains",
		}),
	),
	excludeDomains: Type.Optional(
		Type.Array(Type.String(), {
			description: "Exclude results from these domains",
		}),
	),
	startPublishedDate: Type.Optional(
		Type.String({ description: "Earliest published date, YYYY-MM-DD" }),
	),
	endPublishedDate: Type.Optional(
		Type.String({ description: "Latest published date, YYYY-MM-DD" }),
	),
	includeText: Type.Optional(
		Type.Boolean({ description: "Include page text in the search response" }),
	),
	includeHighlights: Type.Optional(
		Type.Boolean({ description: "Include Exa highlights in results" }),
	),
});

const ContentsParams = Type.Object({
	ids: Type.Optional(
		Type.Array(Type.String(), {
			description: "Exa result IDs returned by exa_search",
		}),
	),
	urls: Type.Optional(
		Type.Array(Type.String(), {
			description: "URLs to retrieve content for",
		}),
	),
	includeText: Type.Optional(
		Type.Boolean({ description: "Include extracted page text" }),
	),
	includeHighlights: Type.Optional(
		Type.Boolean({ description: "Include Exa highlights" }),
	),
});

type SearchParamsType = Static<typeof SearchParams>;
type ContentsParamsType = Static<typeof ContentsParams>;

interface ExaDetails {
	endpoint: string;
	count: number;
	truncated?: boolean;
	fullOutputPath?: string;
}

function apiKey(): string {
	const key = process.env.EXA_API_KEY;
	if (!key) throw new Error("EXA_API_KEY is not set");
	return key;
}

async function exaRequest<T>(
	endpoint: string,
	body: unknown,
	signal?: AbortSignal,
): Promise<T> {
	const response = await fetch(`${EXA_API_URL}${endpoint}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": apiKey(),
		},
		body: JSON.stringify(body),
		signal,
	});

	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Exa ${response.status}: ${text || response.statusText}`);
	}

	return JSON.parse(text) as T;
}

function searchBody(params: SearchParamsType) {
	const contents: Record<string, unknown> = {};
	if (params.includeText) contents.text = true;
	if (params.includeHighlights) contents.highlights = true;

	return {
		query: params.query,
		type: params.type ?? "auto",
		numResults: params.numResults ?? 10,
		includeDomains: params.includeDomains,
		excludeDomains: params.excludeDomains,
		startPublishedDate: params.startPublishedDate,
		endPublishedDate: params.endPublishedDate,
		contents: Object.keys(contents).length > 0 ? contents : undefined,
	};
}

function contentsBody(params: ContentsParamsType) {
	if (!params.ids?.length && !params.urls?.length) {
		throw new Error("Provide at least one id or url");
	}

	const contents: Record<string, unknown> = {
		text: params.includeText ?? true,
	};
	if (params.includeHighlights) contents.highlights = true;

	return {
		ids: params.ids,
		urls: params.urls,
		contents,
	};
}

async function resultFor(
	endpoint: string,
	response: unknown,
): Promise<{ content: { type: "text"; text: string }[]; details: ExaDetails }> {
	const output = JSON.stringify(response, null, 2);
	const truncation = truncateHead(output, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});

	const details: ExaDetails = {
		endpoint,
		count: Array.isArray((response as { results?: unknown[] }).results)
			? (response as { results: unknown[] }).results.length
			: 0,
	};

	let text = truncation.content;
	if (truncation.truncated) {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-exa-"));
		const tempFile = join(tempDir, "output.json");
		await withFileMutationQueue(tempFile, async () => {
			await writeFile(tempFile, output, "utf8");
		});

		details.truncated = true;
		details.fullOutputPath = tempFile;
		text += `\n\n[Output truncated to ${truncation.outputLines} lines`;
		text += ` and ${formatSize(truncation.outputBytes)}.`;
		text += ` Full output saved to: ${tempFile}]`;
	}

	return {
		content: [{ type: "text", text }],
		details,
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "exa_search",
		label: "Exa Search",
		description:
			"Search the web with Exa. Requires EXA_API_KEY. " +
			`Output is truncated to ${DEFAULT_MAX_LINES} lines or ` +
			`${formatSize(DEFAULT_MAX_BYTES)}.`,
		promptSnippet: "Search the web with Exa semantic or keyword search",
		promptGuidelines: [
			"Use exa_search when current web results or semantic search help answer.",
		],
		parameters: SearchParams,
		async execute(_toolCallId, params, signal) {
			const response = await exaRequest("/search", searchBody(params), signal);
			return resultFor("/search", response);
		},
	});

	pi.registerTool({
		name: "exa_contents",
		label: "Exa Contents",
		description:
			"Fetch page contents from Exa result IDs or URLs. " +
			"Requires EXA_API_KEY.",
		promptSnippet: "Fetch extracted page contents for Exa IDs or URLs",
		promptGuidelines: [
			"Use exa_contents when exa_search result snippets are insufficient.",
		],
		parameters: ContentsParams,
		async execute(_toolCallId, params, signal) {
			const response = await exaRequest("/contents", contentsBody(params), signal);
			return resultFor("/contents", response);
		},
	});
}
