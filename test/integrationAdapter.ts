import path from 'path';
import { tests } from '@iobroker/testing';

// Run tests
tests.integration(path.join(__dirname, `..`));
