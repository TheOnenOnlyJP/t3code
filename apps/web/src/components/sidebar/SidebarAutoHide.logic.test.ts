import { describe, expect, it } from "vite-plus/test";

import { shouldDismissAutoHiddenSidebar } from "./SidebarAutoHide.logic";

describe("auto-hidden sidebar dismissal", () => {
  it("stays open while the pointer remains inside the sidebar width", () => {
    expect(
      shouldDismissAutoHiddenSidebar({ clientX: 319, isResizing: false, sidebarRight: 320 }),
    ).toBe(false);
  });

  it("closes when the pointer reaches or crosses the sidebar's right edge", () => {
    expect(
      shouldDismissAutoHiddenSidebar({ clientX: 320, isResizing: false, sidebarRight: 320 }),
    ).toBe(true);
    expect(
      shouldDismissAutoHiddenSidebar({ clientX: 480, isResizing: false, sidebarRight: 320 }),
    ).toBe(true);
  });

  it("stays open while its resize rail owns the pointer", () => {
    expect(
      shouldDismissAutoHiddenSidebar({ clientX: 480, isResizing: true, sidebarRight: 320 }),
    ).toBe(false);
  });
});
