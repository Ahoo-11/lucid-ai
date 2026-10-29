import { describe, expect, it } from "vitest";
import { cost } from "../src/format";
import { argSummary } from "../src/story";

describe("cost", () => {
  it("shows sub-cent costs instead of hiding them", () => {
    expect(cost(0.0025407452)).toBe("$0.0025");
    expect(cost(0.00049)).toBe("$0.00049");
    expect(cost(0.00002)).toBe("<$0.0001");
    expect(cost(7.054)).toBe("$7.05");
    expect(cost(null)).toBe("—");
  });
});

describe("argSummary", () => {
  it("skips uninformative values like path '.'", () => {
    expect(argSummary({ inputPreview: '{"pattern":"*","target":"files","path":"."}' })).toBe("*");
    expect(argSummary({ inputPreview: '{"path":"notes.txt"}' })).toBe("notes.txt");
  });

  it("reads clipped previews that are not valid JSON", () => {
    expect(argSummary({ inputPreview: '{"command":"npm test -- --run","description":"Run the te…' })).toBe("npm test -- --run");
    expect(argSummary({ inputPreview: '{"path":".","pattern":"TODO","limit":5' })).toBe("TODO");
  });

  it("shortens long paths to their last two parts", () => {
    expect(argSummary({ inputPreview: '{"file_path":"D:\\\\repo\\\\src\\\\pages\\\\Run.tsx"}' })).toBe("…/pages/Run.tsx");
  });
});
