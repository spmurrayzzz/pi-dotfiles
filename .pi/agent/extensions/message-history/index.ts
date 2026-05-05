import {
	CustomEditor,
	SessionManager,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import type {
	EditorTheme,
	KeybindingsManager,
	TUI,
} from "@mariozechner/pi-tui";

function messageText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;

	const text = content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n")
		.trim();

	return text || undefined;
}

class HistoryEditor extends CustomEditor {
	private historyIndex = -1;
	private draft = "";

	constructor(
		tui: TUI,
		theme: EditorTheme,
		private keybindings: KeybindingsManager,
		private getHistory: () => string[],
	) {
		super(tui, theme, keybindings);
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.editor.cursorUp")) {
			const current = this.getText();
			const history = this.getHistory();
			if (history.length === 0) return;

			if (this.historyIndex === -1) {
				const index = history.indexOf(current);
				if (index >= 0) {
					this.historyIndex = Math.min(index + 1, history.length - 1);
				} else if (current === "") {
					this.draft = current;
					this.historyIndex = 0;
				} else {
					super.handleInput(data);
					return;
				}
			} else if (this.historyIndex < history.length - 1) {
				this.historyIndex++;
			}

			this.setText(history[this.historyIndex] ?? this.draft);
			return;
		}

		if (this.keybindings.matches(data, "tui.editor.cursorDown")) {
			const current = this.getText();
			const history = this.getHistory();
			if (history.length === 0) return;

			if (this.historyIndex === -1) {
				const index = history.indexOf(current);
				if (index < 0) {
					super.handleInput(data);
					return;
				}
				this.historyIndex = index;
			}

			if (this.historyIndex > 0) {
				this.historyIndex--;
				this.setText(history[this.historyIndex] ?? this.draft);
			} else {
				this.historyIndex = -1;
				this.setText(this.draft);
			}
			return;
		}

		const before = this.getText();
		super.handleInput(data);
		if (this.getText() !== before) {
			this.historyIndex = -1;
			this.draft = "";
		}
	}
}

export default function (pi: ExtensionAPI) {
	let history: string[] = [];

	const add = (text: string) => {
		const trimmed = text.trim();
		if (trimmed) history.unshift(trimmed);
	};

	pi.on("session_start", async (_event, ctx) => {
		const sessions = await SessionManager.list(
			ctx.cwd,
			ctx.sessionManager.getSessionDir(),
		);
		const messages: { text: string; time: number }[] = [];

		for (const session of sessions) {
			try {
				const manager = SessionManager.open(session.path);
				for (const entry of manager.getEntries()) {
					if (entry.type !== "message") continue;
					if (entry.message.role !== "user") continue;

					const text = messageText(entry.message.content);
					const time = new Date(entry.timestamp).getTime();
					if (text) messages.push({ text, time });
				}
			} catch {}
		}

		history = messages
			.sort((a, b) => b.time - a.time)
			.map((message) => message.text);

		ctx.ui.setEditorComponent((tui, theme, kb) =>
			new HistoryEditor(tui, theme, kb, () => history),
		);
	});

	pi.on("input", (event) => {
		if (event.source !== "extension") add(event.text);
	});
}
