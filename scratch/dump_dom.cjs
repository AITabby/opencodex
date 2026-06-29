const WebSocket = require('ws');

fetch("http://127.0.0.1:8315/json")
  .then(res => res.json())
  .then((targets) => {
    const pageTarget = targets.find(t => t.type === "page" && t.url.includes("index.html") && !t.url.includes("avatar-overlay") && !t.url.includes("initialRoute"));
    if (!pageTarget) {
      console.log("No main page target found.");
      return;
    }
    console.log("Target found:", pageTarget.webSocketDebuggerUrl);
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    ws.on('open', () => {
      // Find all buttons and get their text/attributes
      const evalScript = `
        (async () => {
          try {
            const els = Array.from(document.querySelectorAll('*'));
            const modelEl = els.find(el => {
              const text = el.innerText || '';
              return text.includes('5.5') && el.children.length === 0;
            });
            if (!modelEl) return { error: 'Model text element (5.5) not found' };
            
            // Traverse up to find container
            let container = modelEl;
            for (let i = 0; i < 4; i++) {
              if (container.parentElement) container = container.parentElement;
            }
            return {
              text: modelEl.innerText,
              tagName: modelEl.tagName,
              outerHTML: container.outerHTML
            };
          } catch (e) {
            return { error: e.message, stack: e.stack };
          }
        })()
      `;
      ws.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression: evalScript,
          returnByValue: true,
          awaitPromise: true
        }
      }));
    });
    ws.on('message', (data) => {
      const res = JSON.parse(data.toString());
      if (res.id === 1) {
        console.log(JSON.stringify(res.result, null, 2));
        ws.close();
      }
    });
  });
