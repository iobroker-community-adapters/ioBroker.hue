// ioBroker eslint template configuration file for js and ts files
import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        languageOptions: {
            parserOptions: {
                projectService: {
                    allowDefaultProject: ['*.mjs'],
                },
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        // these types mirror the official Hue API v2, which is documented by Signify
        files: ['src/lib/hue/types.ts'],
        rules: {
            'jsdoc/require-jsdoc': 'off',
        },
    },
    {
        ignores: ['build/', 'admin/', '.dev-server/', 'node_modules/', 'test/**/*.js'],
    },
];
