# ioBroker Hue Adapter

ioBroker Hue Adapter is a TypeScript Node.js adapter for the ioBroker home automation platform that connects Philips Hue LED bulbs, Friends of Hue LED lamps, stripes, and other SmartLink compatible devices via Philips Hue Bridges.

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