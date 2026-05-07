import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionInfo,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type KeybindingsManager,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

type SessionSelectItem = {
	value: string;
	label: string;
	description: string;
};

class SessionList implements Component {
	private filtered: SessionSelectItem[];
	private selectedIndex = 0;
	private query = "";

	constructor(
		private items: SessionSelectItem[],
		private maxVisible: number,
		private theme: Theme,
		private keybindings: KeybindingsManager,
		private done: (value: string | null) => void,
	) {
		this.filtered = items;
	}

	invalidate() {}

	render(width: number) {
		const innerWidth = Math.max(1, width - 4);
		const count = this.filtered.length;
		const index = count === 0 ? 0 : this.selectedIndex + 1;
		const page = Math.floor(this.selectedIndex / this.maxVisible) + 1;
		const pages = Math.max(1, Math.ceil(count / this.maxVisible));
		const start = Math.floor(this.selectedIndex / this.maxVisible) *
			this.maxVisible;
		const end = Math.min(start + this.maxVisible, count);
		const lines = [
			this.boxTop(width),
			this.boxLine(
				this.theme.fg("accent", this.theme.bold("Sessions")) +
					this.theme.fg("dim", ` (${index}/${count}) page ${page}/${pages}`),
				width,
			),
			this.boxLine(this.theme.fg("dim", `Search: ${this.query}`), width),
		];

		if (count === 0) {
			lines.push(this.boxLine(
				this.theme.fg("warning", "No matching sessions"),
				width,
			));
		} else {
			for (let i = start; i < end; i++) {
				const item = this.filtered[i];
				if (!item) continue;
				const prefix = i === this.selectedIndex ? "→ " : "  ";
				const title = truncateToWidth(item.label, Math.min(32, innerWidth), "");
				const descWidth = Math.max(0, innerWidth - visibleWidth(title) - 4);
				const desc = truncateToWidth(item.description, descWidth, "");
				const color: ThemeColor = i === this.selectedIndex ? "accent" : "text";
				lines.push(this.boxLine(
					this.theme.fg(color, prefix + title + "  " + desc),
					width,
				));
			}
		}

		for (let i = end - start; i < this.maxVisible; i++) {
			lines.push(this.boxLine("", width));
		}

		const help = "↑↓ navigate • type search • enter resume • esc";
		lines.push(this.boxLine(this.theme.fg("dim", help), width));
		lines.push(this.boxBottom(width));
		return lines;
	}

	handleInput(data: string) {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.move(-1);
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			this.move(1);
		} else if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.move(-this.maxVisible);
		} else if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.move(this.maxVisible);
		} else if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.done(this.filtered[this.selectedIndex]?.value ?? null);
		} else if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done(null);
		} else if (
			this.keybindings.matches(data, "tui.editor.deleteCharBackward")
		) {
			this.query = this.query.slice(0, -1);
			this.applyFilter();
		} else if (data.length === 1 && data >= " ") {
			this.query += data;
			this.applyFilter();
		}
	}

	private move(delta: number) {
		if (this.filtered.length === 0) return;
		this.selectedIndex = Math.max(
			0,
			Math.min(this.selectedIndex + delta, this.filtered.length - 1),
		);
	}

	private applyFilter() {
		const query = this.query.toLowerCase();
		this.filtered = this.items.filter((item) => {
			return [item.label, item.description, item.value]
				.join("\n")
				.toLowerCase()
				.includes(query);
		});
		this.selectedIndex = Math.min(this.selectedIndex, this.filtered.length - 1);
		this.selectedIndex = Math.max(0, this.selectedIndex);
	}

	private boxTop(width: number) {
		return this.theme.fg("accent", "╭" + "─".repeat(width - 2) + "╮");
	}

	private boxBottom(width: number) {
		return this.theme.fg("accent", "╰" + "─".repeat(width - 2) + "╯");
	}

	private boxLine(text: string, width: number) {
		const innerWidth = width - 4;
		const content = truncateToWidth(text, innerWidth, "");
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(content)));
		return this.theme.fg("accent", "│ ") + content + padding +
			this.theme.fg("accent", " │");
	}
}

function safeText(text: string) {
	return text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, " ")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, " ")
		.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export default function sessionManagerExtension(pi: ExtensionAPI) {
	async function getSessions(ctx: ExtensionCommandContext) {
		const sessions = await SessionManager.list(ctx.cwd);
		return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	}

	function formatDate(date: Date) {
		return date.toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
		});
	}

	function title(session: SessionInfo, currentPath?: string) {
		const prefix = session.path === currentPath ? "● " : "";
		const name = session.name || session.firstMessage || "(empty session)";
		return prefix + safeText(name);
	}

	function description(session: SessionInfo) {
		const parts = [
			formatDate(session.modified),
			`${session.messageCount} messages`,
		];
		if (session.parentSessionPath) parts.push("fork");
		return safeText(parts.join(" • "));
	}

	async function switchToSession(path: string, ctx: ExtensionCommandContext) {
		const currentPath = ctx.sessionManager.getSessionFile();
		if (path === currentPath) {
			ctx.ui.notify("Already in that session", "info");
			return;
		}

		await ctx.waitForIdle();
		const result = await ctx.switchSession(path, {
			withSession: async (ctx) => {
				ctx.ui.notify("Session resumed", "info");
			},
		});
		if (result.cancelled) ctx.ui.notify("Session switch cancelled", "info");
	}

	async function showSessionManager(ctx: ExtensionCommandContext) {
		const sessions = await getSessions(ctx);
		if (sessions.length === 0) {
			ctx.ui.notify("No sessions found for this project", "info");
			return;
		}

		const currentPath = ctx.sessionManager.getSessionFile();
		const items: SessionSelectItem[] = sessions.map((session) => ({
			value: session.path,
			label: title(session, currentPath),
			description: description(session),
		}));

		const selected = await ctx.ui.custom<string | null>(
			(_tui, theme, keybindings, done) => new SessionList(
				items,
				10,
				theme,
				keybindings,
				done,
			),
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "80%",
					minWidth: 90,
					maxHeight: "80%",
					margin: 2,
				},
			},
		);

		if (selected) await switchToSession(selected, ctx);
	}

	pi.registerCommand("sessions", {
		description: "List and resume project sessions",
		handler: async (args, ctx) => {
			const target = args.trim();
			if (target) {
				const sessions = await getSessions(ctx);
				const match = sessions.find((session) => session.path === target);
				if (!match) {
					ctx.ui.notify(`Session not found: ${target}`, "error");
					return;
				}
				await switchToSession(match.path, ctx);
				return;
			}

			if (!ctx.hasUI) {
				const sessions = await getSessions(ctx);
				ctx.ui.notify(
					sessions.map((s) => s.path).join("\n") || "No sessions",
					"info",
				);
				return;
			}

			await showSessionManager(ctx);
		},
	});
}
