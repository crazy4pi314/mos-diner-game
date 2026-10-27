import { fileURLToPath } from "node:url";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { createDinerHost, inputSchema } from "./hosting.mjs";
const host = createDinerHost(fileURLToPath(new URL("../../../", import.meta.url)));
const session = await joinSession({
    canvases: [
        createCanvas({
            id: "mos-diner",
            displayName: "Mo's Diner",
            description: "Play Mo's Diner with local deterministic prompt interpretation.",
            inputSchema,
            open: async (ctx) => {
                try {
                    return { title: "Mo's Diner", url: await host.open(ctx.instanceId, ctx.input) };
                } catch (error) {
                    if (error instanceof TypeError) {
                        throw new CanvasError("canvas_input_invalid", error.message);
                    }
                    await session.log(`Mo's Diner could not open: ${error.message}`, { level: "error" });
                    throw new CanvasError("diner_host_failed", "Could not start the diner loopback server.");
                }
            },
            onClose: (ctx) => host.close(ctx.instanceId),
        }),
    ],
});

host.onError = (error) => session.log(`Mo's Diner asset server: ${error.message}`, { level: "error" });
async function shutdown() {
    try {
        await host.shutdown();
        process.exit(0);
    } catch (error) {
        console.error(`Mo's Diner shutdown failed: ${error.message}`);
        process.exit(1);
    }
}
// Chat completion is not provider exit: open canvases must remain usable between turns.
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
process.once("disconnect", shutdown);
