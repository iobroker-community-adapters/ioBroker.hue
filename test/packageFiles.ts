import path from 'path';
import { tests } from '@iobroker/testing';

// Run tests
tests.packageFiles(path.join(__dirname, '..'));
