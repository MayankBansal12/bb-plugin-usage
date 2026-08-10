import { describe, expect, it } from "vitest";
import { paginateItems } from "./pagination";

describe("paginateItems", () => {
  const items = Array.from({ length: 27 }, (_, index) => index + 1);

  it("returns ten items and disables the previous action on the first page", () => {
    const result = paginateItems(items, 1, 10);
    expect(result).toMatchObject({ rangeStart: 1, rangeEnd: 10, totalItems: 27, canPrevious: false, canNext: true });
    expect(result.items).toEqual(items.slice(0, 10));
  });

  it("returns a shortened final page and disables the next action", () => {
    const result = paginateItems(items, 3, 10);
    expect(result).toMatchObject({ rangeStart: 21, rangeEnd: 27, totalItems: 27, canPrevious: true, canNext: false });
    expect(result.items).toEqual(items.slice(20));
  });

  it("clamps a stale page after the item count shrinks", () => {
    const result = paginateItems(items.slice(0, 7), 3, 10);
    expect(result).toMatchObject({ page: 1, rangeStart: 1, rangeEnd: 7, canPrevious: false, canNext: false });
  });
});
