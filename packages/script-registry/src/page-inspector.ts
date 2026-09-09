import type { ScriptContext, ScriptInput } from "@clawler/script-sdk";

export async function inspectPage(ctx: ScriptContext, input: ScriptInput) {
  await ctx.step("navigate", async () => {
    await ctx.browser.navigate(input.url, ctx.signal);
  });

  return ctx.step("inspect", async () => {
    return ctx.browser.inspect(ctx.signal);
  });
}
