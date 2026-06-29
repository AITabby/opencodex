const WebSocket = require('ws');

fetch("http://127.0.0.1:8315/json")
  .then(res => res.json())
  .then((targets) => {
    const pageTarget = targets.find(t => t.type === "page" && t.url.includes("index.html") && !t.url.includes("avatar-overlay") && !t.url.includes("initialRoute"));
    if (!pageTarget) {
      console.log("No main page target found.");
      return;
    }
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    ws.on('open', () => {
      const evalScript = `
        (() => {
          const els = Array.from(document.querySelectorAll('span'));
          const modelSpan = els.find(el => el.innerText === '5.5' && el.className.includes('truncate'));
          if (!modelSpan) return { error: 'Model span (5.5) not found' };
          
          let trigger = modelSpan;
          while (trigger && trigger.tagName !== 'SPAN' || !trigger.id.startsWith('radix-')) {
            trigger = trigger.parentElement;
          }
          if (!trigger) return { error: 'Radix trigger SPAN not found' };
          
          const siblings = Array.from(trigger.parentElement.parentElement.children);
          return siblings.map(sib => ({
            tag: sib.tagName,
            id: sib.id,
            className: sib.className,
            outerHTML: sib.outerHTML.slice(0, 300)
          }));
        })()
      `;
      ws.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression: evalScript,
          returnByValue: true
        }
      }));
    });
    ws.on('message', (data) => {
      const res = JSON.parse(data.toString());
      if (res.id === 1) {
        console.log(JSON.stringify(res.result.result.value, null, 2));
        ws.close();
      }
    });
  });
