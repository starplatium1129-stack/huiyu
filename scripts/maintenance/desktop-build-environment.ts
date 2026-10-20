import environment = require('../lib/desktop-build-environment');

if (require.main === module) {
  const report = environment.inspectDesktopBuildEnvironment();
  console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : report.checks.map(check => `${check.ready ? 'OK' : 'MISSING'} ${check.name}: ${check.detail || check.help}`).join('\n'));
  process.exitCode = report.ready ? 0 : 1;
}
