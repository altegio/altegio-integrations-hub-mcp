#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

loadEnv({ quiet: true });
const server = createServer(loadConfig());
await server.connect(new StdioServerTransport());
