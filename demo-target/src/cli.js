'use strict';

const { formatUser } = require('./util');

function helpText() {
  return [
    'demo-target CLI',
    '',
    'Usage:',
    '  node src/cli.js greet <name>   Print a greeting for <name>',
    '  node src/cli.js --help         Show this help',
    '',
    'Flags:',
    '  --help   Show this help',
    '',
  ].join('\n');
}

// Greet a user by name. No --json flag exists yet (demo task T3 adds
// one), and no name validation happens here yet (demo task T4 adds it):
// an empty or over-long name is currently formatted as-is.
function greet(name) {
  return formatUser(name);
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return helpText();
  }
  if (args[0] === 'greet') {
    return greet(args[1] !== undefined ? args[1] : '');
  }
  return `Unknown command: ${args[0]}\n${helpText()}`;
}

if (require.main === module) {
  process.stdout.write(`${main(process.argv)}\n`);
}

module.exports = { greet, helpText, main };
