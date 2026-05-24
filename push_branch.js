const { execSync } = require('child_process');
try {
  const output = execSync('git push -u origin HEAD', { cwd: '/app', encoding: 'utf-8', timeout: 30000 });
  console.log(output);
} catch (error) {
  console.log('Error:', error.message);
  console.log('Stdout:', error.stdout);
  console.log('Stderr:', error.stderr);
}
