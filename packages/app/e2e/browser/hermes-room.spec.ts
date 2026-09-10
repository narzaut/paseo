import { metroTest as test, expect } from "../support/fixtures";
import { buildHermesRoute } from "../../src/utils/host-routes";
import { connectSeedClient } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

test.setTimeout(120_000);

test("Hermes room loads history and sends a message", async ({ page }) => {
  const client = await connectSeedClient();
  try {
    const created = await client.createChatRoom({ name: "Hermes" });
    const room = created.room!;
    await client.postChatMessage({ room: room.id, body: "seeded hello", authorAgentId: "hermes" });

    await page.goto(buildHermesRoute(getServerId()), {
      waitUntil: "domcontentloaded",
      timeout: 120_000,
    });
    await expect(page.getByText("Hermes")).toBeVisible();
    await expect(page.getByText("seeded hello")).toBeVisible({ timeout: 30_000 });

    await page.getByPlaceholder("Message Hermes").fill("hello from browser");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("hello from browser")).toBeVisible({ timeout: 30_000 });
  } finally {
    await client.close();
  }
});
