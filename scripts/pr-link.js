#!/usr/bin/env node
// @ts-check
'use strict';
// Prints the GitHub link that opens a pull request for a pushed branch, title and body filled in.
// For a machine without `gh`: push the branch, print the link, open it to create the PR.
//
//   npm run pr-link -- <branch> "<title>" [body.md] [--base main]
//
// The repository comes from the `origin` remote. Exit 0, or 2 on a usage error.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const argv = process.argv.slice(2);
const baseAt = argv.indexOf('--base');
const base = baseAt >= 0 ? argv.splice(baseAt, 2)[1] : 'main';
const [branch, title, bodyFile] = argv;
if (!branch || !title || !base) { console.error('usage: npm run pr-link -- <branch> "<title>" [body.md] [--base main]'); process.exit(2); }

const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
const m = /github\.com[:/](.+?)(?:\.git)?$/.exec(remote);
if (!m) { console.error(`pr-link: origin is not a GitHub remote (${remote})`); process.exit(2); }
const params = new URLSearchParams({ expand: '1', title });
if (bodyFile) params.set('body', fs.readFileSync(bodyFile, 'utf8'));
console.log(`https://github.com/${m[1]}/compare/${encodeURI(base)}...${encodeURI(branch)}?${params}`);
