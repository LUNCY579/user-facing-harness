#!/usr/bin/env node
/**
 * preflight.mjs — check a demo bundle folder before zipping.
 *
 * Stdlib-only Node. No install, no dependencies, no model calls, and it
 * never reads anything outside the bundle folder it is given.
 *
 * Usage:
 *   node demo-pack/preflight.mjs --bundle <TASK>-control [--task <TASK>]
 *
 * Expected bundle (exactly these three files; extra files are errors
 * unless they are the preflight report itself):
 *   session-export.zip   — the unmodified /export download
 *   run-sheet.md         — every field filled, no <...> placeholder left
 *   demo-target-diff.txt — git diff + git status after the run
 *
 * Checks:
 *   - all three files exist and are non-empty (diff may be empty only
 *     for a run that changed nothing at all; an empty diff is a warning,
 *     not an error, because T1's FINDINGS.md shows up in status, not diff)
 *   - run-sheet has every required field, with a non-blank value, and
 *     success is exactly "pass" or "fail"
 *   - run-sheet task matches --task when given
 *   - no <...> placeholder remains anywhere in run-sheet.md
 *   - session-export.zip starts with the ZIP magic (PK\x03\x04) and is
 *     not empty; its entry names are listed when they can be parsed
 *   - no forbidden file in the bundle (.env, *.pem, *.key, credentials*)
 *   - run-sheet and diff contain no obvious secret pattern
 *     (sk- / sk_live, "api_key =", "token =", "password =")
 *
 * LIMITATIONS, stated plainly: this script cannot see inside the ZIP
 * (compressed content cannot be searched by reading the ZIP bytes), so
 * a clean preflight does NOT prove the export is secret-free. The
 * participant must still list the ZIP contents and search the unzipped
 * export by hand, per PARTICIPANT_CHECKLIST.md, before sending.
 * Exit 0 = pass (warnings still printed, read them). Exit 1 = errors.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

const REQUIRED_FIELDS = [
  'Participant code', 'Task', 'Arm', 'Model id', 'UTC start', 'UTC end',
  'Permission mode', 'Output ceiling', 'TestingPlatform commit',
  'Demo-target pristine check', 'Demo-target reset before this run',
  'Success', 'Criteria check', 'Notes', 'Bundle files', 'Preflight result',
];
const FORBIDDEN_NAMES = [/^\.env/i, /\.pem$/i, /\.key$/i, /^credentials/i, /\.p12$/i];
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{8,}/,
  /sk_live_[A-Za-z0-9]+/,
  /api[_-]?key\s*[:=]\s*\S+/i,
  /(^|[^A-Za-z])token\s*[:=]\s*\S+/i,
  /password\s*[:=]\s*\S+/i,
];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      args[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    }
  }
  return args;
}

// Minimal ZIP central-directory listing: find the End Of Central Directory
// record, then read entry names. Returns [] when the structure cannot be
// parsed (the magic-byte check has already passed, so this is a warning).
function zipEntries(buf) {
  const names = [];
  try {
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i -= 1) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return names;
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    for (let n = 0; n < count; n += 1) {
      if (buf.readUInt32LE(off) !== 0x02014b50) break;
      const nameLen = buf.readUInt16LE(off + 28);
      const extraLen = buf.readUInt16LE(off + 30);
      const commentLen = buf.readUInt16LE(off + 32);
      names.push(buf.toString('utf8', off + 46, off + 46 + nameLen));
      off += 46 + nameLen + extraLen + commentLen;
    }
  } catch { /* unparseable: caller warns */ }
  return names;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const errors = [];
  const warnings = [];
  if (!args.bundle) {
    console.error('Usage: node preflight.mjs --bundle <dir> [--task <TASK>]');
    process.exit(2);
  }
  const dir = args.bundle;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`error: bundle directory not found: ${dir}`);
    process.exit(2);
  }
  const files = readdirSync(dir);
  for (const name of files) {
    if (FORBIDDEN_NAMES.some((re) => re.test(name))) {
      errors.push(`forbidden file in bundle: ${name} (never send keys or credentials)`);
    }
  }
  const expected = ['session-export.zip', 'run-sheet.md', 'demo-target-diff.txt'];
  for (const name of expected) {
    const p = join(dir, name);
    if (!existsSync(p)) errors.push(`missing file: ${name}`);
    else if (statSync(p).size === 0 && name !== 'demo-target-diff.txt') {
      errors.push(`empty file: ${name}`);
    }
  }
  if (expected.some((n) => !existsSync(join(dir, n)))) {
    // Do not continue into content checks for missing files.
  } else {
    // --- run-sheet checks ---
    const sheet = readFileSync(join(dir, 'run-sheet.md'), 'utf8');
    if (/<[^>]+>/.test(sheet)) {
      errors.push('run-sheet.md still contains a <...> placeholder; fill in every field');
    }
    for (const field of REQUIRED_FIELDS) {
      // Allow a parenthetical or trailing qualifier before the colon,
      // e.g. "Model id (exact, as reported by the route):" and
      // "Demo-target pristine check before this run:".
      const re = new RegExp(`^\\s*-\\s*${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[^:]*:\\s*(\\S.*)?$`, 'm');
      const m = sheet.match(re);
      if (!m) errors.push(`run-sheet.md is missing field: ${field}`);
      else if (!m[1] || !m[1].trim()) errors.push(`run-sheet.md field is blank: ${field}`);
    }
    const successMatch = sheet.match(/^\s*-\s*Success[^:]*:\s*(\S+)/m);
    if (successMatch && !/^(pass|fail)$/i.test(successMatch[1])) {
      errors.push(`run-sheet.md Success must be exactly "pass" or "fail", got: ${successMatch[1]}`);
    }
    if (args.task) {
      const taskMatch = sheet.match(/^\s*-\s*Task\s*:\s*(\S+)/m);
      if (taskMatch && taskMatch[1] !== args.task) {
        errors.push(`run-sheet.md Task (${taskMatch[1]}) does not match --task ${args.task}`);
      }
    }
    // --- diff checks ---
    const diff = readFileSync(join(dir, 'demo-target-diff.txt'), 'utf8');
    if (diff.trim().length === 0) {
      warnings.push('demo-target-diff.txt is empty: expected git diff + git status output (T1 status lines show FINDINGS.md)');
    }
    // --- secret-pattern scan over the two text files only ---
    for (const [label, text] of [['run-sheet.md', sheet], ['demo-target-diff.txt', diff]]) {
      for (const re of SECRET_PATTERNS) {
        if (re.test(text)) errors.push(`${label} matches a secret pattern (${re}); remove it before sending`);
      }
    }
    // --- export ZIP checks ---
    const zipPath = join(dir, 'session-export.zip');
    const zip = readFileSync(zipPath);
    if (zip.length < 4 || zip[0] !== 0x50 || zip[1] !== 0x4b) {
      errors.push('session-export.zip does not start with the ZIP magic (PK); it may not be a ZIP file');
    } else {
      const entries = zipEntries(zip);
      if (entries.length === 0) {
        warnings.push('could not list session-export.zip entries; confirm it unzips before sending');
      } else {
        console.log(`export entries (${entries.length}):`);
        for (const e of entries) console.log(`  ${e}`);
        const outside = entries.filter((e) => !e.includes('demo-target') && !/session|export|events/i.test(e));
        if (outside.length > 0) {
          warnings.push(`export entries that do not obviously belong to a demo-target session: ${outside.slice(0, 5).join(', ')} — check the manual scrub`);
        }
      }
    }
    // --- unexpected files ---
    for (const name of files) {
      if (!expected.includes(name) && name !== 'preflight-report.txt') {
        warnings.push(`unexpected file in bundle (will be zipped if you zip the whole folder): ${name}`);
      }
    }
  }

  for (const w of warnings) console.log(`warning: ${w}`);
  if (errors.length > 0) {
    for (const e of errors) console.log(`error: ${e}`);
    console.log(`preflight FAILED: ${errors.length} error(s), ${warnings.length} warning(s)`);
    process.exit(1);
  }
  console.log(`preflight PASSED: ${warnings.length} warning(s). Remember: preflight cannot see inside the ZIP — do the manual scrub before sending.`);
}

main();
