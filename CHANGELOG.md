# Changelog

## v1.0.3

### Added

- The chat sidebar has an **Archived** tab for chats archived in Telegram. Those chats stay out of **All** and the chat-type tabs. The archive remains reachable in the compact sidebar.

### Fixed

- Adaptive downloads keep at least two chunk workers while enough work remains and the configured limit allows it. A worker retired during a throughput test can start again on a later test. The last chunk can still finish on one worker.
- Completed transfers stay in **Transfers** when you switch views or restart TeleWire. **Clear finished** removes the entries and leaves downloaded files on disk. This applies to downloads completed with this release or later.
