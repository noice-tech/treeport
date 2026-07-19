import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("configuration", () => {
  it("defaults to loopback and XDG data locations", () => {
    const config = loadConfig({
      XDG_DATA_HOME: "/tmp/data home",
      XDG_RUNTIME_DIR: "/tmp/run",
      SHELL: "/bin/zsh",
    });
    expect(config.host).toBe("127.0.0.1");
    expect(config.databasePath).toBe("/tmp/data home/wtr/wtr.db");
    expect(config.shell).toBe("/bin/zsh");
  });

  it("refuses non-loopback binding without authentication", () => {
    expect(() => loadConfig({ WTR_HOST: "0.0.0.0" })).toThrow(/without WTR_AUTH_TOKEN/);
    expect(loadConfig({ WTR_HOST: "0.0.0.0", WTR_AUTH_TOKEN: "secret" }).authToken).toBe("secret");
  });
});
