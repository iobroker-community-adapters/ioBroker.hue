# ioBroker Hue Adapter Development with GitHub Copilot

**Version:** 0.4.0
**Template Source:** https://github.com/DrozmotiX/ioBroker-Copilot-Instructions

This file contains instructions and best practices for GitHub Copilot when working on ioBroker adapter development.

## Project Context

You are working on an ioBroker adapter. ioBroker is an integration platform for the Internet of Things, focused on building smart home and industrial IoT solutions. Adapters are plugins that connect ioBroker to external systems, devices, or services.

### ioBroker Hue Adapter Specifics

This is the ioBroker Hue Adapter - a TypeScript Node.js adapter for the ioBroker home automation platform that connects Philips Hue LED bulbs, Friends of Hue LED lamps, stripes, and other SmartLink compatible devices via Philips Hue Bridges.

**Key Features:**
- Connects to Philips Hue Bridge devices via REST API
- Supports both Hue API v1 and v2 protocols
- Manages LED bulbs, lamps, stripes, motion sensors, and buttons
- Real-time status synchronization with push notifications
- TypeScript implementation with comprehensive error handling

Always reference these instructions first and fallback to search or bash commands only when you encounter unexpected information that does not match the info here.

## Working Effectively

- **Bootstrap and build the repository:**
  - `npm ci` -- installs dependencies exactly as specified in package-lock.json. Takes ~3-25 seconds. NEVER CANCEL.
  - `npm run build` -- compiles TypeScript to JavaScript. Takes ~30 seconds. NEVER CANCEL.
- **Run tests:**
  - `npm run test:package` -- validates package.json and io-package.json files. Takes ~2 seconds.
  - `npm run test:integration` -- runs adapter integration tests in a sandbox ioBroker environment. Takes ~30 seconds. NEVER CANCEL.
  - `npm test` -- runs all tests (package + integration). Takes ~30 seconds. NEVER CANCEL.
- **Code quality and linting:**
  - `npx eslint src test --ext .ts --fix` -- runs ESLint on source and test files. Takes ~4 seconds.
  - `npx prettier --check src test` -- checks code formatting. Takes ~2 seconds.
  - `npx prettier --write src test` -- formats code. Takes ~2 seconds.

## Project Structure

- **Key source files:**
  - `src/main.ts` -- main adapter entry point (121KB, core business logic)
  - `src/lib/hueHelper.ts` -- Hue bridge helper functions
  - `src/lib/v2/v2-client.ts` -- Hue API v2 client implementation
  - `src/lib/constants.ts` -- constants and configuration values
  - `admin/jsonConfig.json` -- web UI configuration for adapter settings
  - `io-package.json` -- ioBroker adapter metadata and configuration
- **Build output:** `build/` directory contains compiled JavaScript files
- **Configuration files:**
  - `tsconfig.json` -- TypeScript configuration for development
  - `tsconfig.build.json` -- specialized TypeScript build configuration
  - `.eslintrc.json` -- ESLint rules and configuration
  - `.prettierrc.json` -- Prettier formatting rules

## Validation

- **ALWAYS run these commands before committing changes:**
  - `npm run build` -- ensure TypeScript compiles without errors
  - `npx eslint src test --ext .ts --fix` -- fix linting issues
  - `npm test` -- ensure all tests pass
- **Integration testing:** The adapter can be tested via `npm run test:integration` which spins up a complete ioBroker environment in `/tmp/test-iobroker.hue/`
- **Manual validation:** This is an ioBroker adapter, so it requires a full ioBroker installation to run manually. The integration tests provide the best validation method.
- **CI requirements:** The GitHub Actions workflow (.github/workflows/test-and-release.yml) runs:
  - Package validation on Node.js 20.x
  - Integration tests on Node.js 18.x, 20.x, 22.x across Ubuntu, Windows, and macOS

## Common Tasks

### Building and Testing
```bash
# Full development cycle
npm ci                                    # Install dependencies
npm run build                            # Build TypeScript (~30s)
npx eslint src test --ext .ts --fix      # Lint and fix (~4s)
npm test                                 # Run all tests (~30s)
```

### Development Workflow
```bash
# After making code changes
npm run build                            # Compile changes
npm run test:integration                 # Test adapter functionality (~30s)
npx eslint src test --ext .ts --fix      # Fix any linting issues
```

### Release Process
- Uses `@alcalzone/release-script` for automated releases
- Available scripts: `npm run release`, `npm run release-patch`, `npm run release-minor`, `npm run release-major`
- Releases are automatically published to NPM and GitHub when tagged

## Important Notes

- **Timeout Requirements:** Set timeouts to 90+ minutes for builds and 60+ minutes for tests. NEVER CANCEL long-running operations.
- **TypeScript Version Warning:** The project uses TypeScript 5.8.3, which may show warnings with the current ESLint TypeScript plugin. These warnings are non-critical.
- **Build Dependencies:** The gulpfile.js exists but gulp tasks don't work due to missing gulptools.js file. Use npm scripts instead.
- **ESLint Configuration:** Don't run ESLint on the `build/` directory as it will fail. Only lint `src` and `test` directories.
- **ioBroker Context:** This is an ioBroker adapter, not a standalone application. It requires the ioBroker platform to run in production.

## Directory Structure

```
/home/runner/work/ioBroker.hue/ioBroker.hue/
├── README.md                 # Documentation
├── package.json              # Dependencies and npm scripts
├── io-package.json          # ioBroker adapter configuration
├── tsconfig.json            # TypeScript configuration
├── .eslintrc.json           # ESLint configuration
├── .github/                 # GitHub workflows and configurations
├── admin/                   # Web UI configuration and assets
├── src/                     # TypeScript source code
│   ├── main.ts             # Main adapter logic
│   └── lib/                # Helper libraries
├── build/                   # Compiled JavaScript output
└── test/                    # Test files
```

## Dependencies

- **Node.js:** Requires Node.js >=18 (as specified in package.json engines)
- **ioBroker:** Requires js-controller >=5.0.0
- **Key packages:** @iobroker/adapter-core, node-hue-api, hue-push-client, axios

## Common Issues

- **ESLint Errors on Build Directory:** Normal - don't run ESLint on build/ directory
- **Missing js-controller Error:** Expected when running the adapter outside ioBroker - use integration tests instead
- **TypeScript Version Warnings:** Non-critical - the build still works correctly
- **Gulp Tasks Failing:** Expected - use npm scripts instead of gulp

## Testing Best Practices

### Integration Testing
**IMPORTANT**: Use the official `@iobroker/testing` framework for all integration tests. This is the ONLY correct way to test ioBroker adapters.

**Official Documentation**: https://github.com/ioBroker/testing

#### Framework Structure
Integration tests MUST follow this exact pattern:

```javascript
const path = require('path');
const { tests } = require('@iobroker/testing');

// Use tests.integration() with defineAdditionalTests
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Test adapter with specific configuration', (getHarness) => {
            let harness;
            
            before(async () => {
                harness = getHarness();
                await harness.startAdapter();
                await harness.changeAdapterConfig('hue', {
                    // Hue-specific test configuration
                    bridge1: '127.0.0.1',
                    user1: 'testuser',
                    polling: true,
                    pollingS: 2
                });
            });
            
            it('Should create expected states', async () => {
                // Test state creation and values
                const state = await harness.states.getStateAsync('hue.0.Bridge_1.info.connection');
                expect(state).to.exist;
            });
        });
    }
});
```

### API Testing with Credentials
For Hue bridge connectivity testing, implement secure credential handling:

```javascript
// Use encrypted demo credentials for CI/CD testing
const DEMO_CONFIG = {
    bridge: process.env.HUE_TEST_BRIDGE || '192.168.1.100',
    username: process.env.HUE_TEST_USER || 'demo_user_encrypted',
    polling: true,
    pollingS: 5
};
```

## Error Handling Best Practices

### Adapter Error Patterns
Always implement proper error handling for Hue API communications:

```typescript
try {
    const bridgeInfo = await this.hueApi.configuration.get();
    this.log.info(`Connected to bridge: ${bridgeInfo.name}`);
} catch (error) {
    this.log.error(`Failed to connect to Hue bridge: ${error.message}`);
    if (error.getHueErrorType() === 1) {
        this.log.error('Unauthorized user - please press bridge button and restart adapter');
    }
    return;
}
```

### Timer and Resource Cleanup
Ensure proper cleanup in the unload() method:

```typescript
private async unload(callback: () => void): Promise<void> {
    try {
        // Clear all timers
        if (this.pollingTimer) {
            this.clearTimeout(this.pollingTimer);
            this.pollingTimer = null;
        }
        
        // Close WebSocket connections
        if (this.pushClient) {
            await this.pushClient.stop();
            this.pushClient = null;
        }
        
        // Clear intervals
        if (this.reconnectInterval) {
            this.clearInterval(this.reconnectInterval);
            this.reconnectInterval = null;
        }
        
        this.log.info('Adapter stopped cleanly');
        callback();
    } catch (e) {
        this.log.error(`Error during unload: ${e.message}`);
        callback();
    }
}
```

## Code Style and Standards

### TypeScript Configuration
- Follow strict TypeScript configuration as defined in `tsconfig.json`
- Use proper typing for all Hue API responses and internal data structures
- Implement interfaces for configuration objects and state definitions

### ESLint and Prettier
- Always run `npx eslint src test --ext .ts --fix` before committing
- Use `npx prettier --write src test` to maintain consistent formatting
- Address all linting warnings related to the changes being made

## Changelog Management

### Format Requirements
Follow the established changelog format in README.md:

```markdown
## Changelog

### **WORK IN PROGRESS**
- (author) Description of changes

### 3.16.2 (2023-12-01)
- (hobbyquaker) do not try to use v2 functionality on legacy Hue bridges
```

### Change Entry Format
- Use format: `- (author) description`
- Keep descriptions concise but descriptive
- Group related changes together
- Always update "WORK IN PROGRESS" section for new changes

## CI/CD Integration

### GitHub Actions Workflow
The repository uses `.github/workflows/test-and-release.yml` which:
- Runs package validation on Node.js 20.x
- Executes integration tests on Node.js 18.x, 20.x, 22.x
- Tests across Ubuntu, Windows, and macOS platforms
- Automatically releases when version tags are pushed

### Release Process
- Uses `@alcalzone/release-script` for automated releases
- Available commands: `npm run release`, `npm run release-patch`, `npm run release-minor`, `npm run release-major`
- Updates both `package.json` and `io-package.json` versions automatically
- Generates GitHub releases and publishes to NPM registry