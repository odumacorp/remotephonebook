import { TEST_ENV } from './testEnv.js';
// Override anything from .env so tests never touch the development database.
Object.assign(process.env, TEST_ENV);
