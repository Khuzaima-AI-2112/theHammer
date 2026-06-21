const fs = require('fs');
const path = require('path');

const routesDir = path.join(__dirname, 'backend', 'src', 'routes', 'admin');
const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));

for (const file of files) {
  const filePath = path.join(routesDir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  content = content.replace(/require\('\.\.\/\.\.\/middleware\/requireAdmin'\)/g, "require('../../middleware/requireAuth')");
  // Some files import { extractIAPEmail, requireAdmin }. Let's handle extractIAPEmail removal later, or just replace requireAdmin.
  content = content.replace(/extractIAPEmail, /g, "");
  fs.writeFileSync(filePath, content);
}
console.log('Replaced requireAdmin imports.');
