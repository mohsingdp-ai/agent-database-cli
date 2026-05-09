import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DaemonConfigManager } from "../../src/daemon/config-manager.js";

describe("daemon config manager", () => {
  it("配置文件内容变化后重新加载 manager", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-database-cli-config-"));
    const configPath = join(dir, "config.json");
    await writeConfig(configPath, "one");

    const manager = new DaemonConfigManager();
    const first = await manager.getManager(configPath);
    expect(await manager.getManager(configPath)).toBe(first);

    await delay(5);
    await writeConfig(configPath, "two");

    const second = await manager.getManager(configPath);
    expect(second).not.toBe(first);
    expect(await manager.getManager(configPath)).toBe(second);
  });
});

async function writeConfig(path: string, name: string): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      databases: {
        [name]: {
          type: "mysql",
          url: "mysql://u:p@localhost/db"
        }
      }
    }),
    "utf8"
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
