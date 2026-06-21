// content.js — injected into all http/https pages (tasks 1.6, 1.7, 1.10)
// Injects a floating capture button and relays the CAPTURE message
// to the service worker via a long-lived port to keep it alive.
//
// CAPTURE response contract (defined in service-worker.js):
// { ok: boolean, path?: string, reason?: string, error?: string }
// Update this file whenever the contract in service-worker.js changes.

(function () {
  // Skip if already injected (re-injection guard — task 1.7)
  if (document.getElementById('thehammer-float-btn')) return;

  // ── Inject floating button (task 1.7) ──
  const btn = document.createElement('button');
  btn.id = 'thehammer-float-btn';
  btn.title = 'Capture screenshot (The Hammer)';
  btn.innerHTML = '🔨';
  btn.setAttribute('aria-label', 'Capture screenshot');

  Object.assign(btn.style, {
    position:        'fixed',
    bottom:          '20px',
    right:           '20px',
    zIndex:          '2147483647',   // max z-index (task 1.7)
    width:           '44px',
    height:          '44px',
    borderRadius:    '50%',
    background:      '#01696f',
    color:           '#fff',
    fontSize:        '20px',
    border:          'none',
    cursor:          'pointer',
    boxShadow:       '0 2px 8px rgba(0,0,0,0.25)',
    display:         'flex',
    alignItems:      'center',
    justifyContent:  'center',
    lineHeight:      '1',
    transition:      'background 140ms ease, transform 100ms ease'
  });

  btn.addEventListener('mouseenter', () => { btn.style.background = '#0c4e54'; });
  btn.addEventListener('mouseleave', () => { btn.style.background = '#01696f'; });
  btn.addEventListener('mousedown',  () => { btn.style.transform = 'scale(0.92)'; });
  btn.addEventListener('mouseup',    () => { btn.style.transform = 'scale(1)'; });

  document.body.appendChild(btn);

  // ── Click handler: open port then send CAPTURE (tasks 1.6, 1.10) ──
  btn.addEventListener('click', () => {
    btn.style.background = '#0f3638';
    btn.innerHTML = '⏳';

    // Long-lived port keeps the service worker alive for the duration (task 1.10)
    const port = chrome.runtime.connect({ name: 'capture-port' });

    chrome.runtime.sendMessage({ type: 'CAPTURE' }, (response) => {
      port.disconnect(); // release the worker

      btn.style.background = '#01696f';
      btn.innerHTML = '🔨';

      if (chrome.runtime.lastError) {
        console.error('[Hammer content] capture error:', chrome.runtime.lastError.message);
        return;
      }
      if (response?.ok) {
        // Item 1 fix (lessons_learned.md): log response.path, not response.length.
        // response.length was a Sprint 1 field; the contract now uses { ok, path }.
        console.log('[Hammer content] captured OK, path:', response.path);
        btn.innerHTML = '✅';
        setTimeout(() => { btn.innerHTML = '🔨'; }, 1200);
      } else {
        console.error('[Hammer content] capture failed:', response?.error ?? response?.reason);
        btn.innerHTML = '❌';
        setTimeout(() => { btn.innerHTML = '🔨'; }, 1500);
      }
    });
  });

  // ── 10.2: Track last right-clicked element ──
  let lastRightClickedElement = null;
  document.addEventListener('contextmenu', (e) => {
    lastRightClickedElement = e.target;
  }, true);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'CAPTURE_ELEMENT') {
      if (lastRightClickedElement) {
        const rect = lastRightClickedElement.getBoundingClientRect();
        sendResponse({
          ok: true,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          dpr: window.devicePixelRatio
        });
      } else {
        sendResponse({ ok: false, error: 'No element selected' });
      }
      return false; // Sync response
    }
    if (msg.type === 'BLUR_SCREENSHOT') {
      showBlurOverlay(msg.dataUrl).then(dataUrl => {
        sendResponse({ dataUrl });
      });
      return true; // async
    }
    if (msg.type === 'START_FULLPAGE_CAPTURE') {
      doFullPageCapture().then(dataUrl => sendResponse({ ok: true, dataUrl })).catch(e => sendResponse({ ok: false, error: e.message }));
      return true; // async
    }
    if (msg.type === 'EXTRACT_SEMANTIC_DATA') {
      sendResponse({ data: extractSemanticData() });
      return false; // Sync response
    }
  });

  function extractSemanticData() {
    const data = {
      inputs: [],
      selection: window.getSelection().toString().trim()
    };
    
    const elements = document.querySelectorAll('input, select, textarea, [contenteditable="true"], [role="checkbox"], [role="switch"], [role="radio"], [role="combobox"], [role="listbox"]');
    
    elements.forEach(el => {
      const rect = el.getBoundingClientRect();
      // Ignore visibly hidden elements
      if (rect.width === 0 && rect.height === 0) return;
      
      // Attempt to find an associated label
      let labelText = '';
      if (el.id) {
        const label = document.querySelector(`label[for="${el.id}"]`);
        if (label) labelText = label.innerText.trim();
      }
      if (!labelText) {
        labelText = el.getAttribute('aria-label') || el.name || el.id || '';
      }
      
      const item = {
        tag: el.tagName.toLowerCase(),
        type: el.type || el.getAttribute('role') || 'text',
        name: labelText,
        value: el.value !== undefined ? el.value : (el.innerText || '').trim(),
        checked: el.checked || el.getAttribute('aria-checked') === 'true',
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
      };
      
      data.inputs.push(item);
    });
    
    return data;
  }

  async function doFullPageCapture() {
    const totalWidth = document.documentElement.scrollWidth;
    const totalHeight = document.documentElement.scrollHeight;
    const viewWidth = window.innerWidth;
    const viewHeight = window.innerHeight;
    
    // Save original scroll and styles
    const origX = window.scrollX;
    const origY = window.scrollY;
    const origOverflow = document.body.style.overflow;
    
    // Hide scrollbars during capture
    document.body.style.overflow = 'hidden';
    
    const parts = [];
    const dpr = window.devicePixelRatio;

    for (let y = 0; y < totalHeight; y += viewHeight) {
      for (let x = 0; x < totalWidth; x += viewWidth) {
        window.scrollTo(x, y);
        // Wait for scroll and rendering
        await new Promise(r => setTimeout(r, 400)); 
        
        const res = await new Promise(r => chrome.runtime.sendMessage({ type: 'CAPTURE_TAB_PORTION' }, r));
        if (res && res.dataUrl) {
          parts.push({
            dataUrl: res.dataUrl,
            x: window.scrollX * dpr,
            y: window.scrollY * dpr
          });
        }
      }
    }
    
    // Restore
    document.body.style.overflow = origOverflow;
    window.scrollTo(origX, origY);
    
    const res = await new Promise(r => chrome.runtime.sendMessage({ 
      type: 'STITCH_IMAGES', 
      parts, 
      width: totalWidth * dpr, 
      height: totalHeight * dpr 
    }, r));
    
    if (res && res.ok) {
      return res.dataUrl;
    }
    throw new Error(res?.error || 'Stitching failed');
  }

  function showBlurOverlay(dataUrl) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.position = 'fixed';
      overlay.style.top = '0'; overlay.style.left = '0';
      overlay.style.width = '100vw'; overlay.style.height = '100vh';
      overlay.style.zIndex = '2147483647';
      overlay.style.background = 'rgba(0,0,0,0.8)';
      overlay.style.display = 'flex';
      overlay.style.flexDirection = 'column';
      overlay.style.alignItems = 'center';
      overlay.style.justifyContent = 'center';

      const canvas = document.createElement('canvas');
      canvas.style.maxWidth = '90vw';
      canvas.style.maxHeight = '80vh';
      canvas.style.border = '2px solid #fff';
      canvas.style.cursor = 'crosshair';
      
      const img = new Image();
      img.onload = () => {
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
      };
      img.src = dataUrl;

      let isDrawing = false;
      let startX, startY;

      canvas.addEventListener('mousedown', (e) => {
        isDrawing = true;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        startX = (e.clientX - rect.left) * scaleX;
        startY = (e.clientY - rect.top) * scaleY;
      });

      canvas.addEventListener('mouseup', (e) => {
        if (!isDrawing) return;
        isDrawing = false;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const endX = (e.clientX - rect.left) * scaleX;
        const endY = (e.clientY - rect.top) * scaleY;

        const x = Math.min(startX, endX);
        const y = Math.min(startY, endY);
        const w = Math.abs(endX - startX);
        const h = Math.abs(endY - startY);

        if (w > 5 && h > 5) {
          const ctx = canvas.getContext('2d');
          ctx.filter = 'blur(10px)';
          ctx.drawImage(canvas, x, y, w, h, x, y, w, h);
          ctx.filter = 'none';
        }
      });

      const btnRow = document.createElement('div');
      btnRow.style.marginTop = '20px';
      btnRow.style.display = 'flex';
      btnRow.style.gap = '10px';

      const uploadBtn = document.createElement('button');
      uploadBtn.textContent = 'Upload Now';
      uploadBtn.style.padding = '10px 20px';
      uploadBtn.style.fontSize = '16px';
      uploadBtn.style.cursor = 'pointer';

      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel Capture';
      cancelBtn.style.padding = '10px 20px';
      cancelBtn.style.fontSize = '16px';
      cancelBtn.style.cursor = 'pointer';

      let timer;

      function finish(useDataUrl) {
        clearTimeout(timer);
        overlay.remove();
        resolve(useDataUrl);
      }

      uploadBtn.onclick = () => finish(canvas.toDataURL('image/png'));
      cancelBtn.onclick = () => finish(null);

      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(uploadBtn);

      overlay.appendChild(canvas);
      overlay.appendChild(btnRow);
      document.body.appendChild(overlay);

      // Auto upload after 3 seconds of NO interaction
      timer = setTimeout(() => {
        finish(canvas.toDataURL('image/png'));
      }, 3000);
      
      canvas.addEventListener('mousedown', () => {
        clearTimeout(timer); // disable auto-upload if they start interacting
      });
    });
  }

})();
