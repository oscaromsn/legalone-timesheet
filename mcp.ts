#!/usr/bin/env node
/*
 * The Legal One MCP server, over stdio.
 *
 * Nothing is written to stdout but protocol traffic — a stray console.log here
 * corrupts the stream and the client disconnects with no useful error. Diagnostics
 * go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './src/mcp/server.ts';

const server = buildServer();
await server.connect(new StdioServerTransport());
process.stderr.write('legalone-timesheet MCP server ready\n');
