chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'WRITE_CLIPBOARD') {
    writeToClipboard(msg.text).then(sendResponse);
    return true;
  }
  if (msg.type === 'CROP_IMAGE') {
    cropImage(msg.dataUrl, msg.rect, msg.dpr).then(sendResponse);
    return true;
  }
  if (msg.type === 'STITCH_IMAGES_OFFSCREEN') {
    stitchImages(msg.parts, msg.width, msg.height).then(sendResponse);
    return true;
  }
});

async function stitchImages(parts, width, height) {
  return new Promise(async (resolve) => {
    try {
      const canvas = document.getElementById('canvas');
      const MAX_DIM = 16000;
      if (width > MAX_DIM || height > MAX_DIM) {
         resolve({ ok: false, error: 'Page too large to stitch' });
         return;
      }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      
      for (const part of parts) {
        const img = await new Promise((res, rej) => {
          const i = new Image();
          i.onload = () => res(i);
          i.onerror = rej;
          i.src = part.dataUrl;
        });
        ctx.drawImage(img, part.x, part.y);
      }
      
      resolve({ ok: true, dataUrl: canvas.toDataURL('image/png') });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

async function writeToClipboard(text) {
  try {
    // Focus the document to allow clipboard write
    window.focus();
    await navigator.clipboard.writeText(text);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function cropImage(dataUrl, rect, dpr) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.getElementById('canvas');
      const ctx = canvas.getContext('2d');
      const sx = rect.x * dpr;
      const sy = rect.y * dpr;
      const sw = rect.width * dpr;
      const sh = rect.height * dpr;
      
      canvas.width = sw;
      canvas.height = sh;
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      resolve({ ok: true, dataUrl: canvas.toDataURL('image/png') });
    };
    img.onerror = () => resolve({ ok: false, error: 'Failed to load image in offscreen' });
    img.src = dataUrl;
  });
}
