import {
	DynamicBorder,
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionInfo,
} from "@mariozechner/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	Text,
} from "@mariozechner/pi-tui";

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
		return prefix + (session.name || session.firstMessage || "(empty session)");
	}

	function description(session: SessionInfo) {
		const parts = [
			formatDate(session.modified),
			`${session.messageCount} messages`,
		];
		if (session.parentSessionPath) parts.push("fork");
		return parts.join(" • ");
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
		const items: SelectItem[] = sessions.map((session) => ({
			value: session.path,
			label: title(session, currentPath),
			description: description(session),
		}));

		const selected = await ctx.ui.custom<string | null>(
			(tui, theme, _keybindings, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(new Text(
					theme.fg("accent", theme.bold("Sessions")),
					1,
					0,
				));

				const list = new SelectList(items, Math.min(items.length, 15), {
					selectedPrefix: (s) => theme.fg("accent", s),
					selectedText: (s) => theme.fg("accent", s),
					description: (s) => theme.fg("muted", s),
					scrollInfo: (s) => theme.fg("dim", s),
					noMatch: (s) => theme.fg("warning", s),
				});
				list.onSelect = (item) => done(item.value);
				list.onCancel = () => done(null);
				container.addChild(list);

				container.addChild(new Text(
					theme.fg(
						"dim",
						"↑↓ navigate • type to search • enter resume • esc cancel",
					),
					1,
					0,
				));
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				return {
					render(width: number) {
						return container.render(width);
					},
					invalidate() {
						container.invalidate();
					},
					handleInput(data: string) {
						list.handleInput(data);
						tui.requestRender();
					},
				};
			},
			{ overlay: true, overlayOptions: { width: "80%", maxHeight: "80%" } },
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
