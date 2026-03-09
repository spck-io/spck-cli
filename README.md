# Spck CLI

CLI tool for [Spck Editor](https://spck.io) - provides remote filesystem, git, and terminal access over WebSocket.

Connect your local development environment to Spck Editor mobile app and access local files, git operations, and terminal sessions remotely.

## Features

- 🗂️ **Remote Filesystem** - Access local files from Spck Editor mobile app
- 🔄 **Git Integration** - Full git operations over the network connection (requires Git 2.20.0+)
- 💻 **Terminal Access** - Interactive terminal sessions with xterm.js
- 🔍 **Fast Search** - Optimized file search with automatic ripgrep detection (100x faster when installed)
- 🔒 **Secure** - Cryptographically signed requests with optional Firebase authentication

## Requirements

### Required

- **Node.js**: 18.0.0 or higher
- **Operating System**: Linux, macOS, or Windows
- **Spck Editor Account**: Premium subscription required
- **Spck Editor Mobile App**: Required for QR code connection (Android/iOS)

### Optional (Recommended)

- **Git**: 2.20.0 or higher - Required for git integration features (commit, push, pull, branch management)
  - Check version: `git --version`
  - Install:
    - **macOS**: `brew install git` (via Homebrew)
    - **Ubuntu/Debian**: `sudo apt-get install git`
    - **Windows**: Download from [git-scm.com](https://git-scm.com)

- **ripgrep**: 15.0.0 or higher - Dramatically improves search performance (100x faster than default search)
  - Check version: `rg --version`
  - Install:
    - **macOS**: `brew install ripgrep`
    - **Ubuntu/Debian**: `sudo apt-get install ripgrep`
    - **Windows**: `choco install ripgrep` (via Chocolatey) or download from [GitHub releases](https://github.com/BurntSushi/ripgrep/releases)
  - **Note**: The CLI will automatically detect and use ripgrep if available, falling back to Node.js search if not installed

## Installation

### Run Directly with npx

No installation required - run directly using npx:

```bash
npx spck
```

### Global Installation

Install the CLI globally to use it from anywhere:

```bash
npm install -g spck
spck
```

## Getting Started

### 1. First Run

On first run, the CLI will guide you through:

1. **Firebase Authentication** - Sign in with your Spck Editor account
2. **Configuration Setup** - Choose root directory and settings
3. **Git Configuration** (Advanced) - Optionally add `.spck-editor/` to `.gitignore`

The setup wizard will:
- Detect if a `.gitignore` file exists in your project
- Prompt you to automatically add `.spck-editor/` to prevent committing the symlink
- Create or update `.gitignore` with proper comments

### 2. Interactive Setup

To reconfigure or run the setup wizard manually:

```bash
spck --setup
```

### 3. Connect to Spck Editor

Once running, the CLI displays a QR code and connection details.

#### Option A: QR Code (Mobile Only)

**IMPORTANT**: The Spck Editor mobile app must be installed BEFORE scanning the QR code. The QR code contains a custom `spck://` deep link that only works with the app installed.

**On Android:**
1. **Install Spck Editor** from Google Play Store if not already installed
2. Use your device's **built-in QR scanner**:
   - Open the **Camera app** and point it at the QR code, OR
   - Swipe down from the top and tap the **QR code scanner** in Quick Settings
3. When the QR code is detected, Android will show a notification to **open with Spck Editor**
4. Tap the notification to open Spck Editor
5. The app will automatically parse the connection details and connect

**On iOS:**
1. **Install Spck Editor** from the App Store if not already installed
2. Use your device's **built-in QR scanner**:
   - Open the **Camera app** and point it at the QR code, OR
   - Open **Control Center** and tap the **QR code scanner** icon
3. When the QR code is detected, iOS will show a notification to **open with Spck Editor**
4. Tap the notification to open Spck Editor
5. The app will automatically parse the connection details and connect

**Note**: Spck Editor does NOT have a built-in QR scanner. You must use your device's native QR scanning capability (camera or system scanner).

#### Option B: Manual Entry (Fallback)

If the QR code doesn't work or you prefer manual entry:

1. Open **Spck Editor** mobile app
2. Tap **Projects** → **New Project** → **Link Remote Server**
3. Enter the **Client ID** and **Secret** shown below the QR code in your terminal
4. Select a Relay server, must match what is shown in the terminal.
5. Tap **Connect**

Once connected, you can browse and edit your local files from the mobile app!

## CLI Options

### Basic Commands

```bash
# Start the CLI with default settings
spck

# Run interactive setup wizard
spck --setup

# Show account information
spck --account

# Logout and clear credentials
spck --logout

# Show help
spck --help

# Show version
spck --version
```

### Advanced Options

```bash
# Use custom configuration file
spck --config /path/to/config.json
spck -c /path/to/config.json

# Override root directory
spck --root /path/to/project
spck -r /path/to/project
```

## Configuration

### Configuration File

The configuration is stored in `.spck-editor/config/spck-cli.config.json` in your project directory.

**Important**: `.spck-editor/config` is a **symlink** to `~/.spck-editor/projects/{project_id}/`, which keeps your secrets outside the project directory and prevents accidental git commits. Other files like logs and temporary data are stored locally in `.spck-editor/.tmp`, `.spck-editor/.trash`, and `.spck-editor/logs`.

**Default Configuration:**

```json
{
  "version": 1,
  "root": "/path/to/your/project",
  "name": "My Project",
  "terminal": {
    "enabled": true,
    "maxBufferedLines": 5000,
    "maxTerminals": 10
  },
  "security": {
    "userAuthenticationEnabled": false
  },
  "filesystem": {
    "maxFileSize": "10MB",
    "watchIgnorePatterns": [
      "**/.git/**",
      "**/.spck-editor/**",
      "**/node_modules/**",
      "**/*.log",
      "**/.DS_Store",
      "**/dist/**",
      "**/build/**"
    ]
  }
}
```

### Configuration Options

#### Terminal Settings

- **`terminal.enabled`** (boolean): Enable/disable terminal access
  - Default: `true`
- **`terminal.maxBufferedLines`** (number): Maximum scrollback buffer lines
  - Default: `10000`
- **`terminal.maxTerminals`** (number): Maximum concurrent terminal sessions
  - Default: `10`

#### Security Settings

- **`security.userAuthenticationEnabled`** (boolean): Enable Firebase user authentication
  - Default: `false`
  - When `true`: Requires Firebase account login (adds user identity verification, adds latency (2-20s) to initial connection)
  - When `false`: Requests still protected by secret signing key (lower latency, compatible with Spck Editor Lite)
  - **Note**: All requests are always cryptographically signed regardless of this setting

#### Filesystem Settings

- **`filesystem.maxFileSize`** (string): Maximum file size for read/write operations
  - Default: `"10MB"`
  - Accepts: `"5MB"`, `"50MB"`, etc.
- **`filesystem.watchIgnorePatterns`** (string[]): Glob patterns to ignore when watching files
  - Default: Ignores `node_modules`, `.git`, `dist`, `build`

### Credentials Storage

The CLI uses a secure storage system that prevents accidentally committing secrets to git:

- **User Credentials** (Global): `~/.spck-editor/.credentials.json`
  - Contains: Firebase refresh token and user ID
  - Persisted across all projects
  - Stored securely in your home directory

- **Project Data** (Per-Project): `~/.spck-editor/projects/{project_id}/`
  - Contains: Configuration and connection settings for each project
  - Each project gets a unique ID based on its path
  - Stored securely outside your project directory

- **Project Directory**: `.spck-editor` in your project directory
  - Regular directory containing local data (`.tmp`, `.trash`, `logs`)
  - The `config` subdirectory is a **symbolic link** pointing to `~/.spck-editor/projects/{project_id}/`
  - Automatically created by the CLI
  - Prevents secrets from being committed to git

**Files stored in the symlinked config directory** (`.spck-editor/config/`):
- `spck-cli.config.json` - Project configuration
- `connection-settings.json` - Server token, client ID, and secret signing key

**Files stored locally** (`.spck-editor/`):
- `.tmp/` - Temporary files
- `.trash/` - Deleted files
- `logs/` - CLI operation logs

## Connection Limits

The maximum number of simultaneous CLI connections depends on your account type. When the limit is reached, you'll see:

```
⚠️  Maximum of X CLI connections reached.
Close other CLI instances and try again.
```

**Note**: Only one Spck Editor mobile app can connect to a CLI instance at a time. Each CLI instance uses one connection slot.

To manage multiple projects simultaneously, run separate CLI instances (up to your account limit).

## Security

Spck CLI is designed with security as a priority. Multiple layers of protection ensure your local files and development environment remain secure.

### Encrypted Connections

All communication between the CLI and Spck Editor mobile app is encrypted:

- **WSS (WebSocket Secure)**: All WebSocket connections use TLS/SSL encryption
- **HTTPS**: All HTTP requests to the proxy server use HTTPS

### Request Signing and Authentication

Spck CLI uses a two-layer security model:

#### 1. Secret Signing Key (Always Active)

**All requests are cryptographically signed** using a secret signing key:

- **Never Transmitted**: The secret key is generated locally and never sent over the network
- **Local Signing**: Every request is signed locally before transmission
- **Signature Verification**: The server verifies the signature to ensure requests are authentic
- **Per-Connection Secret**: Each CLI connection generates a unique cryptographically secure random secret

This base layer ensures that even without user authentication, only someone with access to the secret can make requests to your CLI instance.

#### 2. Firebase User Authentication (Optional)

User authentication provides an additional layer of identity verification:

**Configuration Option:**

```json
{
  "security": {
    "userAuthenticationEnabled": true
  }
}
```

**When Enabled:**
- You must sign in with your Spck Editor account
- Connections use Firebase ID tokens that expire after 1 hour
- Expired tokens are automatically refreshed using secure refresh tokens
- Adds verification that the connecting user is using the same account as the CLI

**Trade-offs:**
- **Pros**: Adds user identity verification, prevents unauthorized access even if secret is compromised
- **Cons**: Adds latency to initial connection due to Firebase authentication
- **Compatibility**: Not supported by Spck Editor Lite

**When Disabled:**
- Requests are still protected by the secret signing key
- No additional latency from Firebase authentication
- Compatible with Spck Editor Lite
- Recommended for local development or when latency is a concern

**Note**: Even with user authentication disabled, all requests remain cryptographically signed and protected.

### Connection Security

Each CLI connection has unique security credentials:

- **Client ID**: Unique identifier for each CLI instance (keep this secret for anonymity, attacker must be able to guess your Client ID to connect)
- **Secret**: Cryptographically secure random secret (generated per connection, never transmitted through the internet)
- **Server Token**: Time-limited token that expires after 24 hours

The Client ID and Secret are stored in `.spck-editor/config/connection-settings.json` and should never be shared publicly. Anyone with access to these credentials can connect to your CLI instance if `userAuthenticationEnabled` is also disabled.

### Terminal Access Control

Terminal access can be disabled entirely if you only need filesystem and git operations:

**Configuration Option:**

```json
{
  "terminal": {
    "enabled": false
  }
}
```

When `terminal.enabled` is set to `false`:
- No terminal sessions can be created
- The CLI will not spawn any shell processes
- Only filesystem and git operations are available

This reduces the attack surface if you don't need terminal functionality.

### Best Practices

1. **Protect Connection Credentials**
   - **Automatic Git Protection**: The setup wizard will detect `.gitignore` and offer to add `.spck-editor/` automatically
   - If you skipped the setup prompt, manually add to `.gitignore`:
     ```
     .spck-editor/
     ```
   - **Security by Design**: Project secrets are stored in `~/.spck-editor/projects/{project_id}/` via the `.spck-editor/config` symlink
   - Never share or commit files from `~/.spck-editor/` (contains secret signing keys and tokens)
   - If user authentication is enabled, keep `~/.spck-editor/.credentials.json` private

2. **Logout on Shared Machines**
   - Always run `spck --logout` when done on shared computers
   - This clears all authentication tokens and connection settings

3. **Review Active Connections**
   - Use `spck --account` to view active connections
   - Close unused CLI instances to free connection slots

4. **Limit Exposed Directories**
   - Use `--root` to specify the minimum necessary directory
   - Don't expose your entire home directory or system root

5. **Monitor Terminal Sessions**
   - Be aware of which terminal sessions are active
   - Close unused terminals when done
   - Configure `terminal.maxTerminals` to limit concurrent sessions

6. **Firewall Configuration**
   - Ensure WebSocket connections (WSS) are allowed through your firewall
   - The CLI connects to a regional relay server over WSS (port 443)

### File Access Permissions

The CLI operates with your local user permissions:
- Files are read/written with your user's file system permissions
- Terminal sessions run with your user account privileges
- No privilege escalation occurs

### What Data Is Transmitted

The CLI only transmits data explicitly requested by Spck Editor app:

- **File Operations**: File contents only when you open/save files
- **Git Operations**: Git metadata and repository data during git commands
- **Terminal I/O**: Terminal input/output during active sessions
- **File Watching**: File change notifications (paths only, not contents)


## Troubleshooting

### Root Directory Not Found

If the root directory doesn't exist:

```bash
# Reconfigure with correct path
spck --setup
```

Or manually specify the path:

```bash
spck --root /correct/path/to/project
```

### Corrupted Configuration

If configuration files are corrupted:

```bash
# Clear settings and start fresh
spck --logout
spck --setup
```

### Connection Issues

If the CLI cannot connect to the proxy server:

1. **Check internet connection**
2. **Try logging out and reconnecting**:
   ```bash
   spck --logout
   spck
   ```
3. **Check firewall settings** - ensure WebSocket connections are allowed

### Git Operations Not Working

If git operations (commit, push, pull, etc.) are not working:

1. **Verify Git is installed**:
   ```bash
   git --version
   ```
   - Required: Git 2.20.0 or higher
   - If not installed, see installation instructions in the [Requirements](#optional-recommended) section

2. **Check repository initialization**:
   ```bash
   cd /path/to/project
   git status
   ```
   - If not a git repository, initialize it: `git init`

### Slow Search Performance

If file search is slow:

1. **Install ripgrep for 100x faster search**:
   ```bash
   # macOS
   brew install ripgrep

   # Ubuntu/Debian
   sudo apt-get install ripgrep

   # Windows (Chocolatey)
   choco install ripgrep
   ```

2. **Verify installation**:
   ```bash
   rg --version
   ```
   - The CLI will automatically detect and use ripgrep if available

### Git Ignore Issues

**Add .spck-editor/ to .gitignore manually:**

If you skipped the setup wizard prompt or need to add it manually:

```bash
# Append to .gitignore
echo ".spck-editor/" >> .gitignore
```

Or add it with a comment for clarity:

```bash
cat >> .gitignore << 'EOF'

# Spck CLI project data
.spck-editor/
EOF
```

**Re-run setup to trigger .gitignore prompt:**

```bash
spck --setup
```

The setup wizard will detect your `.gitignore` and offer to add the entry automatically.


## Examples

### Basic Usage

```bash
# Start in current directory
cd /path/to/project
spck

# Start with specific root directory
spck --root /path/to/project
```

### Multiple Projects

```bash
# Terminal 1: Project A
cd /path/to/projectA
spck

# Terminal 2: Project B
cd /path/to/projectB
spck
```

Each project maintains its own configuration and connection.

### Custom Configuration

```bash
# Use custom config file
spck --config ~/my-custom-config.json

# Override root directory
spck --root ~/projects/myapp
```

## Development

### Building from Source

```bash
# Clone the repository
cd cli
npm install
npm run build
```

### Running Tests

```bash
npm test
npm run test:coverage
```

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Links

- **Website**: [https://spck.io](https://spck.io)
- **Download**: [Spck Editor on Google Play](https://play.google.com/store/apps/details?id=io.spck) | [Spck Editor on App Store](https://apps.apple.com/us/app/spck-editor/id1507309511)

## Support

For help and support, visit [spck.io](https://spck.io) or contact support through the mobile app.

---

Made with ❤️ by the Spck Editor team
