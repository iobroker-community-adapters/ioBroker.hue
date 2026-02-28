# ioBroker Hue Adapter Development with GitHub Copilot

**Version:** 0.5.7
**Template Source:** https://github.com/DrozmotiX/ioBroker-Copilot-Instructions

This file contains instructions and best practices for GitHub Copilot when working on ioBroker adapter development.

---

## 📑 Table of Contents

1. [Project Context](#project-context)
2. [Working Effectively](#working-effectively)
3. [Project Structure](#project-structure)
4. [Code Quality & Standards](#code-quality--standards)
   - [Code Style Guidelines](#code-style-guidelines)
   - [ESLint Configuration](#eslint-configuration)
5. [Testing](#testing)
   - [Unit Testing](#unit-testing)
   - [Integration Testing](#integration-testing)
   - [API Testing with Credentials](#api-testing-with-credentials)
6. [Development Best Practices](#development-best-practices)
   - [Dependency Management](#dependency-management)
   - [HTTP Client Libraries](#http-client-libraries)
   - [Error Handling](#error-handling)
7. [Admin UI Configuration](#admin-ui-configuration)
   - [JSON-Config Setup](#json-config-setup)
   - [Translation Management](#translation-management)
8. [Documentation](#documentation)
   - [README Updates](#readme-updates)
   - [Changelog Management](#changelog-management)
9. [CI/CD & GitHub Actions](#cicd--github-actions)
   - [Workflow Configuration](#workflow-configuration)
   - [Testing Integration](#testing-integration)
10. [Important Notes](#important-notes)

---

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

---

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

### Common Tasks

#### Building and Testing
```bash
# Full development cycle
npm ci                                    # Install dependencies
npm run build                            # Build TypeScript (~30s)
npx eslint src test --ext .ts --fix      # Lint and fix (~4s)
npm test                                 # Run all tests (~30s)
```

#### Development Workflow
```bash
# After making code changes
npm run build                            # Compile changes
npm run test:integration                 # Test adapter functionality (~30s)
npx eslint src test --ext .ts --fix      # Fix any linting issues
```

#### Release Process
- Uses `@alcalzone/release-script` for automated releases
- Available scripts: `npm run release`, `npm run release-patch`, `npm run release-minor`, `npm run release-major`
- Releases are automatically published to NPM and GitHub when tagged

---

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

```
ioBroker.hue/
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

**Dependencies:**
- **Node.js:** Requires Node.js >=18 (as specified in package.json engines)
- **ioBroker:** Requires js-controller >=6.0.11
- **Key packages:** @iobroker/adapter-core, node-hue-api, hue-push-client, axios

---

## Code Quality & Standards

### Code Style Guidelines

- Follow JavaScript/TypeScript best practices
- Use async/await for asynchronous operations
- Implement proper resource cleanup in `unload()` method
- Use semantic versioning for adapter releases
- Include proper JSDoc comments for public methods
- Follow strict TypeScript configuration as defined in `tsconfig.json`
- Use proper typing for all Hue API responses and internal data structures
- Implement interfaces for configuration objects and state definitions

**Timer and Resource Cleanup Example:**
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

### ESLint Configuration

**CRITICAL:** ESLint validation must run FIRST in your CI/CD pipeline, before any other tests. This "lint-first" approach catches code quality issues early.

#### Setup
```bash
npx eslint src test --ext .ts --fix
```

#### Best Practices
1. ✅ Run ESLint before committing — fix ALL warnings, not just errors
2. ✅ Use `--fix` for auto-fixable issues
3. ✅ Don't disable rules without documentation
4. ✅ Lint `src` and `test` directories only — **do NOT run ESLint on `build/`**
5. ✅ Keep ESLint config up to date

#### Common Issues
- **Unused variables**: Remove or prefix with underscore (`_variable`)
- **Missing semicolons**: Run `npx eslint src test --ext .ts --fix`
- **Indentation**: Use 4 spaces (ioBroker standard)
- **console.log**: Replace with `adapter.log.debug()` or remove

---

## Testing

### Unit Testing

- Use Jest or Mocha as the primary testing framework
- Create tests for all adapter main functions and helper methods
- Test error handling scenarios and edge cases
- Mock external API calls and hardware dependencies
- For adapters connecting to APIs/devices not reachable by internet, provide example data files

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

#### Testing Success AND Failure Scenarios

**IMPORTANT:** For every "it works" test, implement corresponding "it fails gracefully" tests.

#### Key Rules

1. ✅ Use `@iobroker/testing` framework
2. ✅ Configure via `harness.objects.setObject()`
3. ✅ Start via `harness.startAdapterAndWait()`
4. ✅ Verify states via `harness.states.getState()`
5. ✅ Allow proper timeouts for async operations
6. ❌ NEVER test API URLs directly
7. ❌ NEVER bypass the harness system

#### Workflow Dependencies

Integration tests should run ONLY after lint and adapter tests pass:

```yaml
integration-tests:
  needs: [check-and-lint, adapter-tests]
  runs-on: ubuntu-22.04
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

---

## Development Best Practices

### Dependency Management

- Always use `npm` for dependency management
- Use `npm ci` for installing existing dependencies (respects package-lock.json)
- Use `npm install` only when adding or updating dependencies
- Keep dependencies minimal and focused
- Only update dependencies in separate Pull Requests

**When modifying package.json:**
1. Run `npm install` to sync package-lock.json
2. Commit both package.json and package-lock.json together

**Best Practices:**
- Prefer built-in Node.js modules when possible
- Use `@iobroker/adapter-core` for adapter base functionality
- Avoid deprecated packages
- Document specific version requirements

### HTTP Client Libraries

- **Note:** This adapter uses `axios` for HTTP communication with the Hue bridge API — keep using it for consistency
- **Preferred for new code:** Use native `fetch` API (Node.js 20+ required) unless `axios`-specific features are needed

**Other Recommendations:**
- **Logging:** Use adapter built-in logging (`this.log.*`)
- **Scheduling:** Use adapter built-in timers and intervals
- **File operations:** Use Node.js `fs/promises`
- **Configuration:** Use adapter config system

### Error Handling

- Always catch and log errors appropriately
- Use adapter log levels (error, warn, info, debug)
- Provide meaningful, user-friendly error messages
- Handle network failures gracefully
- Implement retry mechanisms where appropriate
- Always clean up timers, intervals, and resources in `unload()` method

**Hue API Error Handling Example:**
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

---

## Admin UI Configuration

### JSON-Config Setup

Use JSON-Config format for modern ioBroker admin interfaces.

**Guidelines:**
- ✅ Use consistent naming conventions
- ✅ Provide sensible default values
- ✅ Include validation for required fields
- ✅ Add tooltips for complex options
- ✅ Ensure translations for all supported languages (minimum English and German)
- ✅ Write end-user friendly labels, avoid technical jargon

### Translation Management

**CRITICAL:** Translation files must stay synchronized with `admin/jsonConfig.json`. Orphaned keys or missing translations cause UI issues and PR review delays.

#### Overview
- **Location:** `admin/i18n/{lang}/translations.json` for 11 languages (de, en, es, fr, it, nl, pl, pt, ru, uk, zh-cn)
- **Source of truth:** `admin/jsonConfig.json` - all `label` and `help` properties must have translations
- **Command:** `npm run translate` - auto-generates translations but does NOT remove orphaned keys
- **Formatting:** English uses tabs, other languages use 4 spaces

#### Critical Rules
1. ✅ Keys must match exactly with jsonConfig.json
2. ✅ No orphaned keys in translation files
3. ✅ All translations must be in native language (no English fallbacks)
4. ✅ Keys must be sorted alphabetically

#### Translation Checklist

Before committing changes to admin UI or translations:
1. ✅ No orphaned keys in any translation file
2. ✅ All translations in native language
3. ✅ Keys alphabetically sorted
4. ✅ `npx eslint src test --ext .ts --fix` passes
5. ✅ `npm test` passes

---

## Documentation

### README Updates

#### Required Sections
1. **Installation** - Clear npm/ioBroker admin installation steps
2. **Configuration** - Detailed configuration options with examples
3. **Usage** - Practical examples and use cases
4. **Changelog** - Version history (use "## **WORK IN PROGRESS**" for ongoing changes)
5. **License** - License information (Apache-2.0 for this adapter)
6. **Support** - Links to issues, discussions, community support

#### Documentation Standards
- Use clear, concise language
- Include code examples for configuration
- Maintain multilingual support (minimum English and German)
- Always reference issues in commits and PRs (e.g., "fixes #xx")

### Changelog Management

Follow the established changelog format in README.md:

```markdown
## Changelog

### **WORK IN PROGRESS**
- (author) Description of changes

### 3.16.2 (2023-12-01)
- (hobbyquaker) do not try to use v2 functionality on legacy Hue bridges
```

#### Change Entry Format
- Use format: `- (author) description`
- Keep descriptions concise but descriptive
- Group related changes together
- Always update "WORK IN PROGRESS" section for new changes

---

## CI/CD & GitHub Actions

### Workflow Configuration

The repository uses `.github/workflows/test-and-release.yml` which:
- Runs package validation on Node.js 20.x
- Executes integration tests on Node.js 18.x, 20.x, 22.x
- Tests across Ubuntu, Windows, and macOS platforms
- Automatically releases when version tags are pushed

#### Critical: Lint-First Validation

**ALWAYS run ESLint checks BEFORE other tests.** The `check-and-lint` job has NO dependencies — it runs first, and all other test jobs must list it in their `needs` array.

### Testing Integration

#### Testing Best Practices
- Run credential tests separately from main test suite
- Don't make credential tests required for deployment
- Provide clear failure messages for API issues
- Use appropriate timeouts for external calls (120+ seconds)

### Release Process
- Uses `@alcalzone/release-script` for automated releases
- Available commands: `npm run release`, `npm run release-patch`, `npm run release-minor`, `npm run release-major`
- Updates both `package.json` and `io-package.json` versions automatically
- Generates GitHub releases and publishes to NPM registry

---

## Important Notes

- **Timeout Requirements:** Set timeouts to 90+ minutes for builds and 60+ minutes for tests. NEVER CANCEL long-running operations.
- **TypeScript Version Warning:** The project uses TypeScript 5.8.3, which may show warnings with the current ESLint TypeScript plugin. These warnings are non-critical.
- **Build Dependencies:** The gulpfile.js exists but gulp tasks don't work due to missing gulptools.js file. Use npm scripts instead.
- **ESLint Configuration:** Don't run ESLint on the `build/` directory as it will fail. Only lint `src` and `test` directories.
- **ioBroker Context:** This is an ioBroker adapter, not a standalone application. It requires the ioBroker platform to run in production.
- **Missing js-controller Error:** Expected when running the adapter outside ioBroker - use integration tests instead.