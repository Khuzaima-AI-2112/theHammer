// content.js — injected into all http/https pages (tasks 1.6, 1.7, 1.10)
// Injects a floating capture button and relays the CAPTURE message
// to the service worker via a long-lived port to keep it alive.

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
        console.log('[Hammer content] captured OK, length:', response.length);
        // Brief visual confirmation
        btn.innerHTML = '✅';
        setTimeout(() => { btn.innerHTML = '🔨'; }, 1200);
      } else {
        console.error('[Hammer content] capture failed:', response?.error);
        btn.innerHTML = '❌';
        setTimeout(() => { btn.innerHTML = '🔨'; }, 1500);
      }
    });
  });
})();
