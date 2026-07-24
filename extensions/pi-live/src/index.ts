/**
 * pi-live extension — a small skeleton showing the common pi extension patterns.
 *
 * Install locally (one of):
 *   - `pi install ./extensions/pi-live`        (treats this dir as a pi package)
 *   - copy/symlink this directory into `.pi/extensions/` and run `/reload`
 *   - quick test: `pi -e ./src/index.ts`
 *
 * See CONTRIBUTING.md and ./README.md for the local development loop.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * A minimal custom tool the LLM can call. Replace this with your own.
 */
const helloTool = defineTool({
	name: "hello",
	label: "Hello",
	description: "Greet someone by name. A demo tool for the pi-live skeleton.",
	parameters: Type.Object({
		name: Type.String({ description: "Name to greet" }),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		return {
			content: [{ type: "text", text: `Hello, ${params.name}!` }],
			details: { greeted: params.name },
		};
	},
});

export default function (pi: ExtensionAPI) {
	// Surface a small note when a session starts so you can see the extension load.
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.notify("pi-live extension loaded", "info");
	});

	// Register the demo tool so the LLM can call it.
	pi.registerTool(helloTool);

	// Register a slash command for quick manual testing.
	pi.registerCommand("hello", {
		description: "Say hello (pi-live demo)",
		handler: async (args, ctx) => {
			ctx.ui.notify(`Hello ${args || "world"}!`, "info");
		},
	});
}
