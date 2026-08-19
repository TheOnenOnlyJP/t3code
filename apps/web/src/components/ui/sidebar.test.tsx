import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuSubButton,
  Sidebar,
  SidebarContent,
  SidebarProvider,
  SidebarTrigger,
} from "./sidebar";
import { resolveSidebarState } from "./sidebarState";

function renderSidebarButton(className?: string) {
  return renderToStaticMarkup(
    <SidebarProvider>
      <SidebarMenuButton className={className}>Projects</SidebarMenuButton>
    </SidebarProvider>,
  );
}

describe("sidebar interactive cursors", () => {
  it("uses mobile sheet visibility for the shared responsive state", () => {
    expect(resolveSidebarState({ isMobile: true, open: true, openMobile: false })).toBe(
      "collapsed",
    );
    expect(resolveSidebarState({ isMobile: true, open: false, openMobile: true })).toBe("expanded");
    expect(resolveSidebarState({ isMobile: false, open: true, openMobile: false })).toBe(
      "expanded",
    );
  });

  it("exposes collapsed state for shared titlebar inset styling", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider defaultOpen={false}>
        <div />
      </SidebarProvider>,
    );

    expect(html).toContain('data-sidebar-state="collapsed"');
  });

  it("keeps overlay sidebars out of the desktop layout gap", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <Sidebar desktopLayout="overlay" desktopOverlayTransitionDurationMs={275}>
          <SidebarContent>Projects</SidebarContent>
        </Sidebar>
      </SidebarProvider>,
    );

    expect(html).toContain('data-desktop-layout="overlay"');
    expect(html).toContain("group-data-[desktop-layout=overlay]:w-0");
    expect(html).toContain("--sidebar-overlay-transition-duration:275ms");
    expect(html).toContain("duration-[var(--sidebar-overlay-transition-duration)]");
    expect(html).toContain("transition-transform");
    expect(html).toContain("group-data-[collapsible=offcanvas]:-translate-x-full");
    expect(html).toContain("transform-gpu");
    expect(html).toContain("will-change-transform");
    expect(html).toContain("pointer-events-auto");
    expect(html).toContain("z-40");
    expect(html).toContain("motion-reduce:duration-0");
    expect(html).toContain("shadow-xl/10");
    expect(html).toContain('data-slot="scroll-area-viewport"');
    expect(html).toContain("overflow-auto");
  });

  it("leaves docked sidebar positioning and stacking unchanged", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <Sidebar>Projects</Sidebar>
      </SidebarProvider>,
    );

    expect(html).toContain("z-10");
    expect(html).toContain("transition-[left,right,width]");
    expect(html).toContain(
      "group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]",
    );
    expect(html).not.toContain("transform-gpu");
    expect(html).not.toContain("z-40");
  });

  it("keeps the sidebar trigger interactive inside Electron drag regions", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarTrigger />
      </SidebarProvider>,
    );

    expect(html).toContain("[-webkit-app-region:no-drag]");
    expect(html).toContain("size-[var(--workspace-titlebar-control-size)]!");
  });

  it("uses shared geometry and icon constraints for menu buttons by default", () => {
    const html = renderSidebarButton();

    expect(html).toContain('data-slot="sidebar-menu-button"');
    expect(html).toContain("h-8");
    expect(html).toContain("rounded-[var(--control-radius)]");
    expect(html).toContain("px-[var(--sidebar-row-content-inset)]");
    expect(html).toContain("py-1.5");
    expect(html).toContain("]:size-4");
    expect(html).toContain("]:shrink-0");
    expect(html).toContain("cursor-pointer");
    expect(html).toContain("gap-[var(--sidebar-control-gap)]");
    expect(html).toContain("text-[var(--sidebar-icon-color)]");
    expect(html).not.toContain("[&amp;&gt;svg]:opacity-60");
  });

  it("applies the shared default treatment to icon-only menu buttons", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <SidebarMenuButton size="icon">
          <span>+</span>
        </SidebarMenuButton>
      </SidebarProvider>,
    );

    expect(html).toContain("size-8");
    expect(html).toContain("justify-center");
    expect(html).toContain("p-0");
    expect(html).toContain("font-medium");
    expect(html).toContain("text-sidebar-muted-foreground/80");
  });

  it("lets project drag handles override the default pointer cursor", () => {
    const html = renderSidebarButton("cursor-grab");

    expect(html).toContain("cursor-grab");
    expect(html).not.toContain("cursor-pointer");
  });

  it("uses a pointer cursor for menu actions", () => {
    const html = renderToStaticMarkup(
      <SidebarMenuAction aria-label="Create thread">
        <span>+</span>
      </SidebarMenuAction>,
    );

    expect(html).toContain('data-slot="sidebar-menu-action"');
    expect(html).toContain("cursor-pointer");
  });

  it("uses a pointer cursor for submenu buttons", () => {
    const html = renderToStaticMarkup(
      <SidebarMenuSubButton render={<button type="button" />}>Show more</SidebarMenuSubButton>,
    );

    expect(html).toContain('data-slot="sidebar-menu-sub-button"');
    expect(html).toContain("cursor-pointer");
  });
});
