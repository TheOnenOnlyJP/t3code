# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
`mod+shift+p` pins or unpins the thread you have open. Pinned threads are shown independently of
their project, including when you connect to more than one environment.

Pinned threads still move to **Settled** when they become inactive. They also move when their pull
request merges if **Auto-settle merged threads** is enabled.

When you un-settle a thread, it returns to the top of the active list so you can find it right
away. Its timestamps do not change. Other threads keep their positions.

Right-click a pull request link in a thread and choose **Link to thread** to show that pull request
in the sidebar. The thread settles when the linked pull request merges if **Auto-settle merged
threads** is enabled. Right-click the same link and choose **Unlink from thread** to remove it.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

## Order active threads

Open **Settings → General → Thread order** to choose how active thread cards are arranged:

- **Recent activity** moves a thread to the top when you send it a new message.
- **Newest created** keeps threads in creation order.
- **Manual** keeps your drag-and-drop order. Dragging an active thread automatically selects this
  mode. New threads appear above the remembered manual order until you place them.

Manual active-thread order is stored on this client. Pinned order remains server-backed and syncs
across connected devices.

## Auto-hide the sidebar

On desktop or in a desktop browser, open **Settings → Appearance → Sidebar mode** and choose
**Auto-hide**. The sidebar stops taking up workspace width and opens when the pointer reaches the
left edge of the window. Move the pointer past the sidebar's right edge to close it again.

The sidebar shortcut and titlebar button still open or close it without using the edge trigger.
Choose **Docked** to restore the normal layout.

Use **Settings → Appearance → Sidebar slide speed** to control the slide-in and slide-out
duration. Move the slider left for faster motion or right for slower motion. The range runs from
**Instant** to **500 ms** and defaults to **150 ms**.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.
