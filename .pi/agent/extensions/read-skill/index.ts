import {
	createReadTool,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ReadSkillParams = Type.Object({
	path: Type.String({
		description: "Path to the skill file to read, relative or absolute",
	}),
}, {
	additionalProperties: false,
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "read-skill",
		label: "Read Skill",
		description:
			"Read an entire pi skill file. Wraps the built-in read tool, " +
			"but only accepts a path and never accepts offset or limit.",
		promptSnippet:
			"Read an entire pi skill file without offset or limit arguments",
		promptGuidelines: [
			"Use read-skill instead of read when reading SKILL.md files.",
		],
		parameters: ReadSkillParams,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const readTool = createReadTool(ctx.cwd);
			return readTool.execute(toolCallId, params, signal, onUpdate);
		},
	});
}
