export function shouldDismissAutoHiddenSidebar(input: {
  clientX: number;
  isResizing: boolean;
  sidebarRight: number;
}): boolean {
  return !input.isResizing && input.clientX >= input.sidebarRight;
}
