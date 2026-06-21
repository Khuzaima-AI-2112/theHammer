const fs = require('fs');

const path = 'c:\\Users\\chris\\Desktop\\theHammer\\backend\\src\\routes\\admin\\projects.js';
let content = fs.readFileSync(path, 'utf8');

// Replace .add({ with .add({ workspaceId: req.hammerUser.workspaceId,
content = content.replace(/\.add\(\{/g, ".add({\n      workspaceId: req.hammerUser.workspaceId,");

// Replace orderBy('createdAt', 'desc') with .where('workspaceId', '==', req.hammerUser.workspaceId).orderBy('createdAt', 'desc')
content = content.replace(/\.orderBy\('createdAt', 'desc'\)/g, ".where('workspaceId', '==', req.hammerUser.workspaceId).orderBy('createdAt', 'desc')");

// We also need to check if the project belongs to the workspace in GET /projects/:id, PATCH, DELETE.
// The easiest way is to add a check after getting the snap.
const checkWorkspaceId = `    if (!snap.exists) return res.status(404).json({ error: 'project not found' });
    if (snap.data().workspaceId !== req.hammerUser.workspaceId) {
      return res.status(403).json({ error: 'forbidden: project belongs to another workspace' });
    }`;

content = content.replace(/    if \(\!snap\.exists\) return res\.status\(404\)\.json\(\{ error: 'project not found' \}\);/g, checkWorkspaceId);

fs.writeFileSync(path, content);
console.log('Fixed projects.js');
