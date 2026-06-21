const fs = require('fs');
const p = 'c:\\Users\\chris\\Desktop\\theHammer\\backend\\src\\index.js';
let content = fs.readFileSync(p, 'utf8');
content = content.replace(/app\.post\('\/session-events', requireApiKey/g, "app.post('/session-events', requireAuth('user')");

// Also replace the try catch block for rawKey
const rawKeyBlock = `    let resolvedUserId = null;
    try {
      const rawKey = req.headers['x-api-key'];
      if (rawKey) {
        const keyHash = sha256(rawKey);
        const keySnap = await db.collection('api_keys').where('keyHash', '==', keyHash).where('isActive', '==', true).limit(1).get();
        if (!keySnap.empty) {
          resolvedUserId = keySnap.docs[0].data().userId;
        }
      }
    } catch(err) {}`;

content = content.replace(rawKeyBlock, "const resolvedUserId = req.hammerUser.uid;");
fs.writeFileSync(p, content);
console.log('Fixed index.js');
