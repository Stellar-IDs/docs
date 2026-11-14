import { describe, expect, it } from "vitest";
import config from "../docusaurus.config";
import sidebars from "../sidebars";

describe("docusaurus config", () => {
  it("defines the site title", () => {
    expect(config.title).toBe("Stellar Identity Suite");
  });

  it("fails the build on broken links", () => {
    expect(config.onBrokenLinks).toBe("throw");
  });

  it("targets testnet-era documentation only", () => {
    expect(config.tagline).toMatch(/testnet|Stellar/i);
  });

  it("is served from the GitHub Pages project path", () => {
    expect(config.url).toBe("https://stellar-ids.github.io");
    expect(config.baseUrl).toBe("/docs/");
  });

  it("wires the React integration guide into the main sidebar", () => {
    expect(JSON.stringify(sidebars.docsSidebar)).toContain("guides/react-integration");
  });
});
