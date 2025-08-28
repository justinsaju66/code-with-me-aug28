# Change Log

All notable changes to the "code-with-me" extension will be documented in this file.

Check [Keep a Changelog](https://keepachangelog.com/) for recommendations on how to structure this file.

## [4.1.0] - 2024-08-06

### Added
- **User-Friendly Session Codes**: Replaced long, random session IDs with short, memorable codes (e.g., `ABC-DEF`) to make sharing easier.

### Improved
- **Join Session Flow**: Guests can now join a session by entering either the short code or the full session URL.
- **Share Session UI**: The host's "Share Link" dialog now prominently displays the short code and provides options to copy either the code or the full URL.

## [4.0.0] - 2024-08-05

### Major Refactor

#### Added
- **Live Share Style Architecture** - Complete rewrite
- **Session Management System** - Proper host/guest role management with permissions
- **Participant Management** - Track multiple participants with individual permissions
- **Permission System** - Granular permissions for editing, debugging, terminal access, file operations
- **Real-time Collaboration** - Enhanced file synchronization and cursor tracking
- **Participant Decorations** - Visual indicators for other participants' cursors and selections
- **Structured Session State** - Proper session lifecycle management
- **Enhanced WebSocket Communication** - Improved message handling and error recovery

#### Improved
- **Code Architecture** - Modular, maintainable codebase with clear separation of concerns
- **Type Safety** - Added comprehensive TypeScript interfaces for all data structures
- **Error Handling** - Better error recovery and user feedback
- **Performance** - Optimized synchronization with throttling and deduplication
- **User Experience** - Cleaner, more intuitive collaboration workflow
- **Documentation** - Better code documentation and structure

#### Changed
- **Breaking Change** - Complete API restructure (not backward compatible)
- **Focus Shift** - From screen sharing to pure collaborative editing like Live Share
- **Session Model** - New participant-based session management
- **Message Protocol** - Redesigned WebSocket message format
- **Permission Model** - Fine-grained permission system instead of binary host/guest

#### Technical Improvements
- **Session Interfaces** - `CollaborationSession`, `Participant`, `SessionPermissions`
- **State Management** - Centralized session state with proper lifecycle
- **Sync Guards** - Improved infinite loop prevention
- **Cursor Tracking** - Real-time cursor position sharing
- **File Operations** - Enhanced file synchronization with conflict resolution
- **WebSocket Reliability** - Better connection handling and reconnection logic

### Migration Notes
- Version 4.0.0 represents a complete architectural overhaul
- Previous session data and configurations are not compatible
- New permission system requires re-establishing collaboration preferences
- WebSocket server may need updates to support new message protocol

## [1.6.3] - 2024-08-04

### Added
- Manual workspace info request functionality for guests
- Enhanced debugging logs for tree view provider
- New "Request Workspace Info" option in quick pick menu
- Automatic workspace info request when showing "Code with me" view

### Improved
- Better error handling and user feedback for workspace info requests
- More detailed console logging for troubleshooting
- Host-side handler for workspace info requests

### Fixed
- Tree view not populating with host workspace data
- Missing workspace info transmission from host to guest
- Manual trigger for workspace info when "Code with me" view is focused

## [1.6.1] - 2024-08-01

### Fixed
- Fixed "Code with me" panel not appearing in VS Code Explorer
- Removed WebView dependency completely
- Fixed guest message handling errors
- Corrected file counting in workspace info

### Improved
- Tree view now displays properly without session conditions
- Better error handling for workspace info processing
- Cleaner message handling without WebView references

## [1.6.0] - 2024-08-01

### Added
- Custom "Code with me" view container in VS Code Explorer
- Tree view provider for host workspace display
- Native VS Code integration for file browsing
- Click-to-open functionality for host files

### Improved
- Host files now display in dedicated "Code with me" panel
- Better user experience with native VS Code UI
- Integrated file explorer similar to VS Code Pets
- Seamless file opening from tree view

## [1.5.7] - 2024-08-01

### Added
- Real-time editing synchronization between host and guest
- Removed WebView dependency for better performance
- Direct VS Code integration for file editing

### Improved
- Host and guest can now edit files simultaneously with real-time sync
- File changes appear instantly on both sides
- Better performance without WebView overhead
- Cleaner architecture with direct VS Code integration

## [1.5.6] - 2024-08-01

### Fixed
- Fixed message structure issue preventing guest file opening
- Corrected filePath parameter handling in request-file-content messages
- Guest can now successfully open files in VS Code editor

## [1.5.5] - 2024-08-01

### Fixed
- Guest can now open files independently in their VS Code editor
- Fixed file opening workflow for guest users
- Improved file content handling between host and guest
- Better separation between WebView and VS Code editor functionality

### Improved
- Guest file opening now works properly without host intervention
- Files open directly in guest's VS Code editor when clicked
- Clearer messaging when files are opened in VS Code

## [1.5.4] - 2024-08-01

### Improved
- Removed confusing "Requesting file content" notifications
- Better user experience when opening files in guest editor
- Cleaner file opening workflow without unnecessary messages
- Files now open silently in VS Code editor with success confirmation

## [1.5.3] - 2024-08-01

### Added
- Direct file opening in guest's VS Code editor
- `openFileInGuestEditor` function for guest file requests
- `openFileContentInGuestEditor` function for opening files in guest editor

### Improved
- Guest can now open files directly in their VS Code editor
- Files open in separate tabs in guest's VS Code
- Better user experience with direct file access

## [1.5.2] - 2024-08-01

### Added
- Direct file access for guests without host permission
- New `request-file-content` message type for direct file requests
- `sendFileContentToGuestByPath` function for direct file reading

### Improved
- Guest can now open files directly without requesting host to open them
- Better file access workflow for collaborative editing
- Reduced dependency on host actions for file viewing

## [1.5.1] - 2024-08-01

### Fixed
- Fixed TypeError when displaying workspace info in guest console
- Updated workspace info handling to work with new tree structure
- Proper file counting in workspace display

## [1.5.0] - 2024-08-01

### Added
- Enhanced file explorer display with complete workspace tree
- File count display showing total number of files
- Improved visual styling with hover effects and better icons
- Automatic workspace info request when guest connects
- Better file filtering (skips hidden files, build directories, large files)
- File selection highlighting in the guest interface
- Sorted file/folder display (folders first, then files alphabetically)

### Improved
- Guest WebView interface with better UX
- Workspace loading with loading indicators
- Error handling for workspace info requests
- File explorer width increased to 350px for better visibility
- Filename display (shows just filename instead of full path)

### Fixed
- Guest now properly displays complete host workspace structure
- Workspace tree rendering issues resolved
- Better handling of workspace info requests

## [1.4.44] - 2024-08-01

- Initial release with basic collaboration features